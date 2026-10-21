/**
 * 「微信原图自动下载」守卫：把**会修改微信进程内存**的这个可选功能的边界钉死。
 *
 * 重点不是测 koffi / 真注入（那需要真实微信进程），而是：
 *   ① 平台/组件缺失时必须如实落到 `unsupported`，不能假装可用；
 *   ② 白名单的编码必须是上游组件要的 `a\0b\0\0`，空 = 全部（null）；
 *   ③ 崩溃后 marker 还在、微信没重启时**拒绝重复注入**（cleanupUnconfirmed）；
 *   ④ start/stop 的持久开关与提取/还原调用顺序正确（先落盘再注入；关时先还原再清开关）；
 *   ⑤ 微信没启动时进入 waiting_wechat 而不是崩掉。
 *
 * 全部通过 `__testing.setDeps` 注入假实现，不加载 koffi、不碰真实微信。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  __testing,
  BOOT_RESUME_DELAY_MS,
  buildWhitelistBuffer,
  getWechatImageAutoDownloadStatus,
  sanitizeWhitelist,
  startWechatImageAutoDownload,
  startWechatImageAutoDownloadOnBoot,
  stopWechatImageAutoDownload,
  wechatImageAutoDownload,
  type ImageAutoDownloadDeps,
} from '../src/query/wechat-image-autodownload.ts'

const scratch: string[] = []

afterEach(() => {
  __testing.reset()
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
})

/** 造一个临时数据根：`<tmp>/decrypted`（config 与 marker 都放在它的父目录）。 */
function makeRoot(): { root: string; decrypted: string } {
  const base = mkdtempSync(join(tmpdir(), 'wx-autodl-'))
  scratch.push(base)
  const decrypted = join(base, 'decrypted')
  mkdirSync(decrypted, { recursive: true })
  return { root: base, decrypted }
}

/** 一组可控的假依赖；`config` 由测试直接改。 */
function fakeDeps(options: {
  config: Record<string, unknown>
  calls: string[]
  pid?: () => number | null
  initOk?: boolean
  helperError?: string
}): Partial<ImageAutoDownloadDeps> {
  const { config, calls } = options
  const pid = options.pid ?? (() => 1234)
  const initOk = options.initOk ?? true
  return {
    platform: 'win32',
    arch: 'x64',
    resolveHelperPath: () => join(tmpdir(), 'wx-helper-in-test.dll'),
    loadHelper: async () => ({
      init: (target, whitelist) => {
        calls.push(`init:${String(target)}:${whitelist === null ? 'all' : whitelist.toString('utf8')}`)
        return initOk
      },
      uninstall: () => { calls.push('uninstall') },
      error: () => options.helperError ?? '',
    }),
    findPid: pid,
    readConfig: () => ({ ...config }),
    saveConfig: (_decryptedDir, patch) => {
      Object.assign(config, patch)
      calls.push(`save:${Object.keys(patch).join(',')}`)
      return { ok: true }
    },
    wechatVersion: () => '4.1.0.0',
    now: () => 1_000,
    setTimer: () => ({ fake: true }),
    clearTimer: () => { calls.push('clearTimer') },
    onExit: () => { calls.push('onExit') },
  }
}

describe('白名单编码（上游组件的协议细节）', () => {
  it('空列表 = 全部会话（null），不是空串', () => {
    expect(buildWhitelistBuffer([])).toBeNull()
  })

  it('列表 = NUL 分隔 + 双 NUL 结尾', () => {
    expect(buildWhitelistBuffer(['wxid_a', 'room@chatroom'])?.toString('utf8')).toBe('wxid_a\u0000room@chatroom\u0000\u0000')
  })

  it('净化：去空、去重、限长、非数组一律空', () => {
    expect(sanitizeWhitelist([' wxid_a ', '', 'wxid_a', 42, 'x'.repeat(300)])).toEqual(['wxid_a'])
    expect(sanitizeWhitelist('wxid_a')).toEqual([])
    expect(sanitizeWhitelist(undefined)).toEqual([])
  })
})

describe('状态机与生命周期', () => {
  it('平台不支持时如实返回 unsupported（不加载组件、不注入）', async () => {
    const { decrypted } = makeRoot()
    const calls: string[] = []
    __testing.setDeps({
      ...fakeDeps({ config: { wechat_image_autodownload_enabled: false }, calls }),
      platform: 'darwin',
    })
    const status = await startWechatImageAutoDownload(decrypted)
    expect(status.supported).toBe(false)
    expect(status.state).toBe('unsupported')
    expect(status.code).toBe('IMAGE_AUTODOWNLOAD_UNSUPPORTED')
    expect(calls.some((c) => c.startsWith('init:'))).toBe(false)
  })

  it('微信没启动 → waiting_wechat，然后按轮询接入', async () => {
    const { decrypted } = makeRoot()
    const calls: string[] = []
    let pid: number | null = null
    __testing.setDeps(fakeDeps({ config: { wechat_image_autodownload_enabled: false }, calls, pid: () => pid }))
    const waiting = await wechatImageAutoDownload(decrypted, 'start')
    expect(waiting.enabled).toBe(true)
    expect(waiting.watching).toBe(true)
    expect(waiting.state).toBe('waiting_wechat')
    // 微信启动：下一次 tick 自动接入
    pid = 4321
    await __testing.tick()
    const running = getWechatImageAutoDownloadStatus(decrypted)
    expect(running.hooked).toBe(true)
    expect(running.state).toBe('running')
    expect(running.pid).toBe(4321)
    expect(calls).toContain('init:4321:all')
  })

  it('start 先落盘开关再注入；stop 先还原再清开关并清 marker', async () => {
    const { root, decrypted } = makeRoot()
    const calls: string[] = []
    const config: Record<string, unknown> = { wechat_image_autodownload_enabled: false }
    __testing.setDeps(fakeDeps({ config, calls }))
    const started = await wechatImageAutoDownload(decrypted, 'start')
    expect(started.enabled).toBe(true)
    expect(started.hooked).toBe(true)
    expect(config['wechat_image_autodownload_enabled']).toBe(true)
    // 开关先于注入；marker 落在数据根
    expect(calls.findIndex((c) => c.startsWith('save:'))).toBeLessThan(calls.findIndex((c) => c.startsWith('init:')))
    expect(existsSync(join(root, 'wechat-image-autodownload.state.json'))).toBe(true)

    const stopped = await wechatImageAutoDownload(decrypted, 'stop')
    expect(stopped.enabled).toBe(false)
    expect(stopped.hooked).toBe(false)
    expect(stopped.state).toBe('idle')
    expect(config['wechat_image_autodownload_enabled']).toBe(false)
    expect(calls).toContain('uninstall')
    // 还原发生在保存「关闭」之后（保存 false → 调用 uninstall）：顺序断言防止将来写反
    expect(calls.lastIndexOf('uninstall')).toBeGreaterThan(calls.findIndex((c) => c.startsWith('save:')))
    expect(existsSync(join(root, 'wechat-image-autodownload.state.json'))).toBe(false)
  })

  it('注入失败 → failed + 错误码（不把开关当成已生效）', async () => {
    const { decrypted } = makeRoot()
    const calls: string[] = []
    __testing.setDeps(fakeDeps({
      config: { wechat_image_autodownload_enabled: false },
      calls,
      initOk: false,
      helperError: 'Target function not found',
    }))
    const status = await wechatImageAutoDownload(decrypted, 'start')
    expect(status.state).toBe('failed')
    expect(status.code).toBe('IMAGE_AUTODOWNLOAD_INIT_FAILED')
    expect(status.message).toBe('Target function not found')
    // 失败时尽力还原（避免留下半注入状态）
    expect(calls).toContain('uninstall')
  })

  it('上次未清理 + 微信未重启 → 拒绝重复注入（cleanupUnconfirmed）', async () => {
    const { root, decrypted } = makeRoot()
    writeFileSync(join(root, 'wechat-image-autodownload.state.json'), JSON.stringify({ pid: 4321, at: 1 }), 'utf8')
    const calls: string[] = []
    __testing.setDeps(fakeDeps({
      config: { wechat_image_autodownload_enabled: true },
      calls,
      pid: () => 4321, // 同一个微信进程：上次注入可能还在
    }))
    const status = await startWechatImageAutoDownload(decrypted)
    expect(status.cleanupUnconfirmed).toBe(true)
    expect(status.code).toBe('IMAGE_AUTODOWNLOAD_CLEANUP_UNCONFIRMED')
    expect(calls.some((c) => c.startsWith('init:'))).toBe(false)
  })

  it('上次未清理但微信已重启（pid 变了）→ 清 marker 后正常接入', async () => {
    const { root, decrypted } = makeRoot()
    writeFileSync(join(root, 'wechat-image-autodownload.state.json'), JSON.stringify({ pid: 1111, at: 1 }), 'utf8')
    const calls: string[] = []
    __testing.setDeps(fakeDeps({
      config: { wechat_image_autodownload_enabled: true },
      calls,
      pid: () => 2222,
    }))
    const status = await startWechatImageAutoDownload(decrypted)
    expect(status.cleanupUnconfirmed).toBe(false)
    expect(status.hooked).toBe(true)
    expect(calls).toContain('init:2222:all')
  })

  it('白名单会话数透出到状态（界面显示用）', () => {
    const { decrypted } = makeRoot()
    __testing.setDeps(fakeDeps({
      config: { wechat_image_autodownload_enabled: false, wechat_image_autodownload_whitelist: ['a', 'b'] },
      calls: [],
    }))
    expect(getWechatImageAutoDownloadStatus(decrypted).whitelistCount).toBe(2)
  })

  it('微信退出后 tick 进入 waiting_wechat 并清 marker（不把死进程当已接入）', async () => {
    const { root, decrypted } = makeRoot()
    const calls: string[] = []
    let pid: number | null = 1234
    __testing.setDeps(fakeDeps({ config: { wechat_image_autodownload_enabled: true }, calls, pid: () => pid }))
    await startWechatImageAutoDownload(decrypted)
    expect(getWechatImageAutoDownloadStatus(decrypted).hooked).toBe(true)
    pid = null
    await __testing.tick()
    const status = getWechatImageAutoDownloadStatus(decrypted)
    expect(status.hooked).toBe(false)
    expect(status.state).toBe('waiting_wechat')
    expect(existsSync(join(root, 'wechat-image-autodownload.state.json'))).toBe(false)
  })
})

/**
 * 启动恢复必须**不挡**后端 ready / 首屏（2026-10-21 性能专项）。
 *
 * 实测：旧实现里 `startWechatImageAutoDownloadOnBoot` 会同步走一轮
 * PowerShell/CIM 进程发现（217ms，主线程阻塞），把后端 ready 从 ~120ms 拖到 ~340ms。
 * 现在只判断开关与支持性，真正的恢复延后 `BOOT_RESUME_DELAY_MS`。
 */
describe('启动恢复延后：不阻塞 init，且取消后不再注入', () => {
  it('boot hook 里不同步找进程；到点后才恢复注入', async () => {
    vi.useFakeTimers()
    try {
      const { decrypted } = makeRoot()
      const calls: string[] = []
      let findCalls = 0
      __testing.setDeps(fakeDeps({
        config: { wechat_image_autodownload_enabled: true },
        calls,
        pid: () => { findCalls += 1; return 1234 },
      }))
      const boot = startWechatImageAutoDownloadOnBoot(decrypted)
      expect(boot?.enabled).toBe(true)
      expect(findCalls, 'boot hook 里同步找进程就是这 217ms 的来源').toBe(0)
      expect(calls.filter((c) => c.startsWith('init:')), '还没到点就注入 = 又把 ready 拖慢了').toEqual([])

      await vi.advanceTimersByTimeAsync(BOOT_RESUME_DELAY_MS)
      expect(findCalls).toBeGreaterThan(0)
      expect(calls).toContain('init:1234:all')
    } finally {
      vi.useRealTimers()
    }
  })

  it('延后窗口内 stop ⇒ 取消恢复，绝不在取消后注入', async () => {
    vi.useFakeTimers()
    try {
      const { decrypted } = makeRoot()
      const calls: string[] = []
      let findCalls = 0
      __testing.setDeps(fakeDeps({
        config: { wechat_image_autodownload_enabled: true },
        calls,
        pid: () => { findCalls += 1; return 1234 },
      }))
      const boot = startWechatImageAutoDownloadOnBoot(decrypted)
      expect(boot).not.toBeNull()
      boot!.stop()
      await vi.advanceTimersByTimeAsync(BOOT_RESUME_DELAY_MS * 2)
      expect(findCalls).toBe(0)
      expect(calls.filter((c) => c.startsWith('init:'))).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('开关关闭 / 平台不支持 ⇒ 直接返回 null（不排定时器）', () => {
    const off = makeRoot()
    __testing.setDeps(fakeDeps({ config: { wechat_image_autodownload_enabled: false }, calls: [] }))
    expect(startWechatImageAutoDownloadOnBoot(off.decrypted)).toBeNull()

    const unsupported = makeRoot()
    __testing.setDeps({
      ...fakeDeps({ config: { wechat_image_autodownload_enabled: true }, calls: [] }),
      platform: 'darwin',
    })
    expect(startWechatImageAutoDownloadOnBoot(unsupported.decrypted)).toBeNull()
  })
})
