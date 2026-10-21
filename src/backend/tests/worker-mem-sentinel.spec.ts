// @vitest-environment node
/**
 * W3-1.2：worker 内存哨兵 —— **只告警，不重启**。
 *
 * ## 为什么值得单立一条
 *
 * 后端 worker 是独立进程（`utilityProcess.fork`，见 main.js 的 `spawnBackendProcess`）。
 * 内存悄悄涨上去时主进程毫无信号：面板转圈、日志里全是超时，而「RSS 1.4GB」
 * 要等用户自己开任务管理器才发现。哨兵每 60 秒往诊断日志打一行
 * `rss/heapUsed/heapTotal/external`，把「进程还活着吗、内存多少」变成可回看的事实。
 *
 * ## 四条必须钉住的设计约束
 *
 *   ① **只告警，不重启**。涨的原因可能是一次性的全量年报，也可能是缓存泄漏，
 *      两者处置完全不同；而自动重启会打断用户正在等的导出/解密。所以本模块
 *      **没有任何进程操作**（这条用例直接断言：剥掉注释后，源码里没有
 *      `process.exit/kill/abort`，也不出现 `utilityProcess`）。
 *   ② **连续 3 次超限才告警**。单次峰值不叫。
 *   ③ **同一轮连续超限只告警一次**：否则每 60 秒重复一句，日志反而没人看。
 *   ④ 掉回限以下 ⇒ 计数归零，要重新连续三次。
 *
 * 时钟、`memoryUsage`、定时器全部注入 —— 否则这条逻辑一天都测试不了
 * （单测里既不能等 60 秒，也不能真把自己吃到 1.2GB）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

// CommonJS 模块：它要被 wechat-worker.js 这个 CJS 直接 require。
const require = createRequire(import.meta.url)
const { createMemSentinel, fmtBytes, DEFAULT_INTERVAL_MS, DEFAULT_RSS_LIMIT_BYTES, DEFAULT_STRIKES } =
  require('../worker-mem-sentinel.js')

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, '..', 'worker-mem-sentinel.js'), 'utf8')

/**
 * 一个可拨的假环境：log 收行、内存读数可换、定时器手动触发。
 *
 * ⚠️ `start()` 里**必须**调模块的 `start()`：它负责「立刻采一次 + 注册定时器」。
 * 只调 `createMemSentinel` 而不调 `start()` 的话一行都不会采 —— 本文第一版
 * 就是这么写的，注释里说着「采一次」，实际一次都没采。
 */
function harness(extra?: () => string): {
  lines: Array<{ level: string; text: string }>
  setRss: (v: number) => void
  start: () => { stop: () => void }
  tick: () => void
} {
  const lines: Array<{ level: string; text: string }> = []
  let t = 0
  const mem = { rss: 100 * 1024 * 1024, heapUsed: 50 * 1024 * 1024, heapTotal: 60 * 1024 * 1024, external: 1024, arrayBuffers: 2 * 1024 * 1024 }
  let fn: (() => void) | null = null
  const start = (): { stop: () => void } => {
    const s = createMemSentinel({
      log: (level: string, args: unknown[]) => { lines.push({ level, text: String(args[0]) }) },
      now: () => (t += 1000),
      memoryUsage: () => mem,
      intervalMs: 60_000,
      rssLimitBytes: DEFAULT_RSS_LIMIT_BYTES,
      setIntervalFn: (f: () => void) => { fn = f; return 1 },
      clearIntervalFn: () => { fn = null },
      ...(extra ? { extra } : {}),
    })
    s.start()
    return { stop: s.stop }
  }
  return { lines, setRss: (v: number) => { mem.rss = v }, start, tick: () => { fn?.() } }
}

/** 超过默认限（1.2GB）的一个读数。 */
const OVER = 3 * 1024 * 1024 * 1024
/** 远低于限的一个读数。 */
const UNDER = 10 * 1024 * 1024

describe('W3-1.2：内存哨兵', () => {
  it('每次采样都打一行 rss/heap/external（含 limit 与连续计数）', () => {
    const j = harness()
    j.start()
    expect(j.lines.length, '一次都没采 ⇒ 哨兵没接线').toBeGreaterThanOrEqual(1)
    const first = j.lines[0]!
    expect(first.level).toBe('mem')
    expect(first.text).toContain('rss=')
    expect(first.text).toContain('heapUsed=')
    expect(first.text).toContain('heapTotal=')
    expect(first.text).toContain('external=')
    expect(first.text, 'arrayBuffers 是 Buffer 内存的主要读数（RSS 归因用）').toContain('arrayBuffers=')
    expect(first.text).toContain('limit=')
    expect(first.text, '读数要能看出「超没超、连续几次」').toMatch(/over=(yes|no) \(limit=.*, \d+\/\d+\)/)
  })

  it('超限但**不连续**三次 ⇒ 不告警（单次峰值不叫）', () => {
    const j = harness()
    j.start()
    j.setRss(OVER); j.tick() // 1
    j.setRss(UNDER); j.tick() // 归零
    j.setRss(OVER); j.tick() // 又是 1
    expect(j.lines.filter((l) => l.level === 'mem-warn').length,
      '单次峰值不该告警（一次性全量年报也会这样）').toBe(0)
  })

  it('连续三次超限 ⇒ 告警一次，且之后不再重复', () => {
    const j = harness()
    j.start()
    j.setRss(OVER); j.tick(); j.tick(); j.tick()
    expect(j.lines.filter((l) => l.level === 'mem-warn').length, '连续 3 次必须告警').toBe(1)
    for (let i = 0; i < 10; i += 1) j.tick()
    expect(j.lines.filter((l) => l.level === 'mem-warn').length,
      '重复告警会让日志退化（每 60 秒一句没人看）').toBe(1)
  })

  it('掉回限以下 ⇒ 计数归零，下一次要重新连续三次', () => {
    const j = harness()
    j.start()
    j.setRss(OVER); j.tick(); j.tick()
    j.setRss(UNDER); j.tick()
    j.setRss(OVER); j.tick(); j.tick()
    expect(j.lines.filter((l) => l.level === 'mem-warn').length, '归零后只连续 2 次，不该叫').toBe(0)
    j.tick()
    expect(j.lines.filter((l) => l.level === 'mem-warn').length, '重新连续 3 次必须再叫').toBe(1)
  })

  it('告警文案说清「只告警不重启」', () => {
    const j = harness()
    j.start()
    j.setRss(OVER); j.tick(); j.tick(); j.tick()
    const w = j.lines.find((l) => l.level === 'mem-warn')
    expect(w?.text, '没说清不重启 ⇒ 用户会以为它自己会处理').toContain('不重启')
  })

  it('源码里没有任何进程操作（想加自动重启的人会在这里被拦下）', () => {
    // 头注里提到 main.js 的 utilityProcess.fork 是**说明**不是代码，所以先剥注释。
    const codeOnly = SRC.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(codeOnly, '哨兵不许碰进程生命周期：重启会打断用户正在等的导出/解密')
      .not.toMatch(/process\.(exit|kill|abort)/)
    expect(codeOnly, '哨兵不该知道 utilityProcess 的存在（它只管打印）').not.toMatch(/utilityProcess/)
  })

  it('生产接线把真实定时器传给哨兵（缺了它只会采一次）', () => {
    // 单测里的假定时器保证「逻辑对」；这一条守的是**调用点有没有把真实定时器接上**。
    // 2026-10-21 基线实测：80s 运行只有 1 条 `[mem]`（启动那次），就是缺了下面两行。
    const workerSrc = readFileSync(join(HERE, '..', 'wechat-worker.js'), 'utf8')
    const m = /createMemSentinel\(\{([\s\S]*?)\}\)/.exec(workerSrc)
    expect(m, '找不到 createMemSentinel 调用点').not.toBeNull()
    const block = m?.[1] ?? ''
    expect(block, '缺 setIntervalFn ⇒ 生产只会在 start() 采一次，没有时间序列')
      .toMatch(/setIntervalFn:\s*setInterval\b/)
    expect(block, '缺 clearIntervalFn ⇒ stop() 摘不掉真实定时器')
      .toMatch(/clearIntervalFn:\s*clearInterval\b/)
  })

  it('fmtBytes 两档可读（MB / GB），不输出一串原始字节', () => {
    expect(fmtBytes(812 * 1024 * 1024)).toBe('812MB')
    expect(fmtBytes(1.2 * 1024 * 1024 * 1024)).toBe('1.20GB')
    expect(fmtBytes(0)).toBe('0MB')
  })

  it('常量本身有分工（60s / 1.2GB / 3 次）', () => {
    expect(DEFAULT_INTERVAL_MS).toBe(60_000)
    expect(DEFAULT_RSS_LIMIT_BYTES).toBe(1.2 * 1024 * 1024 * 1024)
    expect(DEFAULT_STRIKES).toBe(3)
  })

  it('extra 把受控缓存占用拼进 [mem] 行（运行时可见，不再只有单测能看）', () => {
    const j = harness(() => 'caches=remote-image=31.5MB/32.0MB,sns-keystream=15.0MB/16.0MB')
    j.start()
    expect(j.lines[0]!.text, '缓存占用要跟在内存读数同一行，否则时间序列对不上').toContain('caches=remote-image=31.5MB/32.0MB')
    expect(j.lines[0]!.text).toMatch(/rss=/)
  })

  it('extra 抛错不影响内存采样本身（附加信息不能拖垮观测）', () => {
    const j = harness(() => { throw new Error('extra boom') })
    j.start()
    expect(j.lines[0]!.level, 'extra 失败也必须照常采到 [mem]').toBe('mem')
    expect(j.lines[0]!.text).not.toContain('caches=')
    expect(j.lines[0]!.text).toContain('rss=')
  })

  it('生产接线把缓存占用 provider 传给哨兵', () => {
    const workerSrc = readFileSync(join(HERE, '..', 'wechat-worker.js'), 'utf8')
    const block = /createMemSentinel\(\{([\s\S]*?)\}\)/.exec(workerSrc)?.[1] ?? ''
    expect(block, '缺 extra ⇒ [mem] 行永远不会带缓存的当前/上限').toMatch(/extra:\s*\(\)\s*=>/)
    expect(block, '缓存行必须来自 host 的 cacheStatsLine').toContain('cacheStatsLine')
  })
})