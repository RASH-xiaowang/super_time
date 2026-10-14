/**
 * 远程访问控制面（开关 / 轮换令牌）的判据。
 *
 * ## 为什么这一段值得单独立用例
 *
 * 它是用户**唯一**能改这个入站暴露面的入口，而它的两条纪律都很容易在重构中被顺手改掉：
 *
 *   ① **写配置必须走后端的 `saveWechatConfig`**，不能主进程自己写文件 ——
 *      后端那份实现负责原子写、写前备份、以及把 `api_token` 这类密钥字段分流进
 *      `secrets.json` 并收紧 ACL（`SECRET_FIELDS`）。自己写文件会把令牌留在
 *      `config.json` 里（那是「用户会手工编辑、出问题时会被整目录拷走」的文件，
 *      正是 H1/N6 那条泄漏路径的载体）。
 *   ② **轮换令牌必须让旧会话立刻失效**。轮换的唯一现实理由是「旧令牌可能已经泄漏」
 *      （手机丢了、二维码被拍过、屏幕共享时露过）。如果只换令牌不作废会话，
 *      已经拿到 Cookie 的设备在 12 小时内照样能进 —— 轮换就只是换了个字符串。
 *      实现上靠 `stop()`（内部 `revokeAll()`）+ `syncWithConfig()` 重起。
 *
 * 用例全部注入假 deps，不碰真后端、不绑真端口。
 *
 * @vitest-environment node
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const require = createRequire(import.meta.url)
const { createRemoteAccessControl } = require(join(ROOT, 'src', 'backend', 'http-control.js')) as {
  createRemoteAccessControl: (deps: Deps) => Control
}

interface Deps {
  backendCall: (method: string, args: unknown[]) => Promise<{ ok: boolean, value?: unknown, error?: unknown }>
  remoteAccess: {
    stop: () => Promise<unknown>
    syncWithConfig: () => Promise<unknown>
    getState: () => object
  }
}
interface Control {
  rotate: () => Promise<{ ok: boolean, token?: string, state?: unknown, error?: string }>
  setEnabled: (enabled: boolean) => Promise<{ ok: boolean, state?: unknown, error?: string }>
  state: () => unknown
}

/** 记录调用顺序的假 deps：顺序本身就是纪律（先存配置，再停服务，再对齐）。 */
function fake(opts: { saveOk?: boolean, saveThrows?: boolean } = {}) {
  const log: string[] = []
  let patches: Array<Record<string, unknown>> = []
  const deps: Deps = {
    backendCall: async (method, args) => {
      log.push(`call:${method}`)
      patches.push((args[0] as { patch: Record<string, unknown> })?.patch ?? {})
      if (opts.saveThrows) throw new Error('后端没就绪')
      return opts.saveOk === false
        ? { ok: false, error: { message: '写配置失败' } }
        : { ok: true, value: { ok: true } }
    },
    remoteAccess: {
      stop: async () => { log.push('stop'); return {} },
      syncWithConfig: async () => { log.push('sync'); return { running: true, port: 5032 } },
      getState: () => ({ running: false }),
    },
  }
  return { deps, log, patches: () => patches }
}

describe('rotate：生成令牌 + 打开开关 + 作废旧会话', () => {
  it('按「存配置 → 停服务 → 对齐」的顺序走，并把令牌原文只回给调用方一次', async () => {
    const f = fake()
    const r = await createRemoteAccessControl(f.deps).rotate()
    expect(r.ok).toBe(true)
    expect(f.log).toEqual(['call:saveWechatConfig', 'stop', 'sync'])
    // 配置写入必须走后端（原子写 + 备份 + 密钥分流进 secrets.json 全在那一份实现里）
    expect(f.patches()).toEqual([{ api_token: r.token, api_enabled: true }])
    expect(typeof r.token).toBe('string')
    expect((r.token ?? '').length).toBeGreaterThanOrEqual(32)
  })

  it('每次轮换的令牌都不同（否则「轮换」只是重放同一个凭据）', async () => {
    const c = createRemoteAccessControl(fake().deps)
    const a = await c.rotate()
    const b = await c.rotate()
    expect(a.token).toBeTruthy()
    expect(b.token).toBeTruthy()
    expect(a.token, '两次轮换拿到了同一个令牌').not.toBe(b.token)
  })

  it('必须先 stop 再 sync：只 sync 的话服务在「已经在跑」时不会重启，旧会话就还活着', async () => {
    const f = fake()
    await createRemoteAccessControl(f.deps).rotate()
    expect(f.log.indexOf('stop'), '轮换没有停服务 ⇒ 旧令牌换来的会话在 TTL 内仍然有效')
      .toBeLessThan(f.log.indexOf('sync'))
  })

  it('配置写失败时不动服务、不返回令牌（半开状态最危险：用户以为开了，其实没开）', async () => {
    const f = fake({ saveOk: false })
    const r = await createRemoteAccessControl(f.deps).rotate()
    expect(r.ok).toBe(false)
    expect(r.error).toContain('写配置失败')
    expect(r.token, '写失败还把令牌返回去了（界面上会出现一个扫了没用的二维码）').toBeUndefined()
    expect(f.log, '写失败却仍然停了服务/重绑').toEqual(['call:saveWechatConfig'])
  })

  it('后端抛错时收成 {ok:false}，不让异常冒到 IPC 边界', async () => {
    const f = fake({ saveThrows: true })
    const r = await createRemoteAccessControl(f.deps).rotate()
    expect(r.ok).toBe(false)
    expect(r.error).toContain('后端没就绪')
    expect(f.log).toEqual(['call:saveWechatConfig'])
  })
})

describe('setEnabled：开关', () => {
  it('打开：写 api_enabled=true 然后对齐（不需要 stop，服务本来就没在跑）', async () => {
    const f = fake()
    const r = await createRemoteAccessControl(f.deps).setEnabled(true)
    expect(r.ok).toBe(true)
    expect(f.patches()).toEqual([{ api_enabled: true }])
    expect(f.log).toEqual(['call:saveWechatConfig', 'sync'])
    expect(r.state).toEqual({ running: true, port: 5032 })
  })

  it('关闭：写 api_enabled=false，**并且停服务**（关了还连着就等于没关）', async () => {
    const f = fake()
    const r = await createRemoteAccessControl(f.deps).setEnabled(false)
    expect(r.ok).toBe(true)
    expect(f.patches()).toEqual([{ api_enabled: false }])
    expect(f.log, '关闭时没有停服务 ⇒ 在连的手机不会断开').toEqual(['call:saveWechatConfig', 'stop', 'sync'])
    expect(r.state).toBeTruthy()
  })

  it('关闭**不动令牌**（下次打开还是同一个，二维码不用重发）', async () => {
    const f = fake()
    await createRemoteAccessControl(f.deps).setEnabled(false)
    expect(Object.keys(f.patches()[0] ?? {}), '关闭时顺手改了别的字段').toEqual(['api_enabled'])
  })

  it('非布尔入参一律当 false（IPC 边界上的输入不可信）', async () => {
    const f = fake()
    await createRemoteAccessControl(f.deps).setEnabled('yes' as unknown as boolean)
    expect(f.patches()).toEqual([{ api_enabled: false }])
  })

  it('写失败时不动服务', async () => {
    const f = fake({ saveOk: false })
    const r = await createRemoteAccessControl(f.deps).setEnabled(false)
    expect(r.ok).toBe(false)
    expect(f.log).toEqual(['call:saveWechatConfig'])
  })
})

describe('state：只给状态，不给令牌原文', () => {
  it('透传服务的状态快照', () => {
    const c = createRemoteAccessControl(fake().deps)
    expect(c.state()).toEqual({ running: false })
  })
})
