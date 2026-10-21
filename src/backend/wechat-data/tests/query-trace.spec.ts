/**
 * 首屏查询分段打点（2026-10-21 性能专项）。
 *
 * 判据只有两条：默认**零日志**（不能污染生产诊断日志），显式 env 时输出
 * `[query-trace] <name>.<label> t=<ms>`（`t` 从 begin 起算、可选 n=计数）。
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  delete process.env.SUPERTIME_QUERY_TRACE
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('query-trace', () => {
  it('未设 SUPERTIME_QUERY_TRACE ⇒ 一条日志都不打（默认零开销）', async () => {
    delete process.env.SUPERTIME_QUERY_TRACE
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const m = await import('../src/query/query-trace.ts')
    m.queryTraceBegin('overview')
    m.queryTraceMark('overview', 'contacts', 12)
    expect(log).not.toHaveBeenCalled()
  })

  it('设置 env ⇒ begin/mark 输出，t 从 begin 起算、n 可选', async () => {
    process.env.SUPERTIME_QUERY_TRACE = '1'
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')) })
    const m = await import('../src/query/query-trace.ts')
    m.queryTraceBegin('overview')
    m.queryTraceMark('overview', 'shards', 3)
    expect(lines[0]).toContain('[query-trace] overview.begin t=0')
    expect(lines[1]).toMatch(/\[query-trace\] overview\.shards t=\d+/)
    expect(lines[1]).toContain('n=3')
  })

  it('打点抛错不影响查询（console 被替换成会抛的怪东西也不能炸）', async () => {
    process.env.SUPERTIME_QUERY_TRACE = '1'
    const m = await import('../src/query/query-trace.ts')
    vi.spyOn(console, 'log').mockImplementation(() => { throw new Error('log boom') })
    expect(() => { m.queryTraceBegin('overview'); m.queryTraceMark('overview', 'x') }).not.toThrow()
  })
})
