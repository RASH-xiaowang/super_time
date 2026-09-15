/**
 * N4：没有真实微信数据时，后端启动不该往 **stderr** 打 `realtime sync paused` 告警。
 *
 * 为什么要锁住：这条告警在「未配置数据源」（全新安装、还没导入数据）这一**正常状态**下也会打，
 * 于是每次启动都往 stderr 写一行 —— 冒烟输出被弄脏，PowerShell 还会把 stderr 行升级成
 * NativeCommandError（看着像失败）。修法是把「没配置」与「配置了但读不到」分开：
 * 前者降级为一次性 stdout 提示（可诊断性保留），后者保持 stderr 告警（那才是真故障）。
 *
 * 用例断言的是**行为**（有没有往 stderr 写），不是源码里有没有某个字符串 —— 后者靠注释就能骗过。
 * 每条都顺带断言「tick 真的跑过」，否则「没打告警」可能只是循环压根没执行。
 * @vitest-environment node
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startRealtimeSync } from '../src/query/sync.ts'

const scratch: string[] = []
const stops: Array<() => void> = []
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function tempDir(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `wx-realtime-${tag}-`))
  scratch.push(dir)
  return dir
}

/** tick 会先 await 一次目录清扫再读配置：轮询到条件成立，避免用固定 sleep 赌时序。 */
async function waitFor(predicate: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return predicate()
}

/** 只在直接执行时起循环（disposer 由调用方登记，避免用例结束后还挂着 10s 定时器）。 */
function start(rawDir: () => string, dec: string): void {
  stops.push(startRealtimeSync(rawDir, () => dec))
}

describe('startRealtimeSync 的启动噪音（N4）', () => {
  it('未配置数据源：stderr 一条都不打，改为一次性 stdout 提示', async () => {
    const dec = tempDir('idle')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    start(() => '', dec)
    expect(await waitFor(() => log.mock.calls.length > 0), 'tick 必须真的跑过（防空转）').toBe(true)
    expect(warn.mock.calls.map((c) => String(c[0])), 'stderr 必须是干净的').toEqual([])
    expect(String(log.mock.calls[0]?.[0])).toContain('realtime sync idle')
  })

  it('配置了数据源但目录读不到：仍按真故障打一次 stderr 告警', async () => {
    const dec = tempDir('missing')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    start(() => join(dec, 'not-there', 'db_storage'), dec)
    expect(await waitFor(() => warn.mock.calls.length > 0), '真故障必须仍然可见').toBe(true)
    expect(String(warn.mock.calls[0]?.[0])).toContain('realtime sync paused')
  })

  it('decryptedDir 为空（后端尚未解析出目录）同样不打 stderr', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    start(() => '', '')
    expect(await waitFor(() => log.mock.calls.length > 0)).toBe(true)
    expect(warn.mock.calls.length).toBe(0)
  })
})
