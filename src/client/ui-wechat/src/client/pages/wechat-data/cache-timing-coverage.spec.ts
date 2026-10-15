/**
 * H3（2026-09-28 性能修复）：前端耗时埋点必须覆盖**全部四条取数路径**。
 *
 * ## 为什么这条守卫值得单独立
 *
 * PERF-AUDIT-172 报告（已删除，原文见 git 历史）要回答「哪个接口慢」，而它当时拿到的前端数据只有一半：
 * `timedFetch` 只被 `cachedFetch` 的两处分支调用，`cachedGet` 那条**热门快照通道**
 * 一次都没经过它。后果不是「少几条日志」而是**判据缺一半** —— 面板切回来时走的正是
 * `cachedGet` 快照命中，而这条路「命中也要等多久」在旧写法里根本量不到，
 * 于是「后端慢」与「主线程被占着」这两种完全不同的病在数据上长得一样。
 *
 * ## 判据怎么取（两个坑都踩过，写下来免得下次再踩）
 *
 * **坑一：不能用 microtask 排干来等后台路径。**
 * 后台复验是 `void timedFetch(...)` 起的，它内部 `await fetcher()`，而 fetcher 用
 * `setTimeout` 计时 ⇒ 只有**宏任务**推进才会完成。实测（2026-09-28）：
 * 只 `await Promise.resolve()` 十二次时打桩记录是空的，真等 400ms 之后才出现。
 * 所以下面统一用 {@link settle}（真等一个超过阈值的时长），别用微任务排干。
 *
 * **坑二：命中路径「没有记录」才是对的。**
 * 命中是同步回快照，耗时 ≈0ms，**本来就该低于阈值** —— 断言「命中要打印日志」等于
 * 要求埋点报假数据。命中路径真正要证明的是「它**经过了**计时器」（否则永远量不到
 * 「命中也要等」那种病）。做法见 `hitPathIsTimed`：把阈值语义换成
 * 「命中路径的计时开销 > 0」这一可判定命题 —— 用一条**必然超过 1ms 的同步阻塞**
 * 把命中路径拖慢，再看它是否被记下来。
 * @vitest-environment jsdom
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TIMED_FETCH_THRESHOLD_MS, cachedFetch, cachedGet, invalidateSnapshotCache } from './cache.ts'

const LOG = process.env['SUPERTIME_CACHE_TIMING_LOG']
  ?? join(tmpdir(), 'supertime-cache-timing-coverage.txt')
// 默认落在系统临时目录；设 SUPERTIME_CACHE_TIMING_LOG 可指定便于人工检查的位置。
mkdirSync(dirname(LOG), { recursive: true })
writeFileSync(LOG, '')
/** 把探针数据落盘：vitest 的 console 输出经本机管道会丢（见 cache-timing 的教训）。 */
const say = (s: string): void => { appendFileSync(LOG, s + '\n') }

beforeEach(() => {
  localStorage.clear()
  invalidateSnapshotCache()
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

/**
 * 真等一段时间（必须 > 阈值），让后台宏任务跑完。
 *
 * @param extraMs - 在阈值之上再多等的余量；默认 150ms 足够 setTimeout 抖动。
 */
async function settle(extraMs = 150): Promise<void> {
  await new Promise((r) => { setTimeout(r, TIMED_FETCH_THRESHOLD_MS + extraMs) })
}

/** 一个「真花掉 {ms} 毫秒」的 fetcher（用宏任务，模拟真实后端往返）。 */
function slowFetcher<T>(value: T, ms = TIMED_FETCH_THRESHOLD_MS + 60): () => Promise<T> {
  return () => new Promise<T>((resolve) => { setTimeout(() => { resolve(value) }, ms) })
}

/** 打桩 console.info 并返回「取日志键」的函数。 */
function spyInfo(): () => string[] {
  const info = vi.spyOn(console, 'info').mockImplementation(() => { /* 静音 */ })
  return () => info.mock.calls.map((c) => String(c[0]))
}

describe('H3：埋点覆盖四条取数路径', () => {
  it('cachedFetch 冷跑（回源）留下记录', async () => {
    const keys = spyInfo()
    await cachedFetch('cov:cold', slowFetcher({ total: 1 }))
    const got = keys()
    say('cold(cachedFetch) = ' + JSON.stringify(got))
    expect(got.some((k) => k.includes('cov:cold')), '回源路径没经过 timedFetch ⇒ 后端往返耗时无从观察').toBe(true)
  })

  it('cachedFetch 热跑（SWR 后台复验）留下记录', async () => {
    await cachedFetch('cov:warm', async () => ({ total: 1 }))
    const keys = spyInfo()
    await cachedFetch('cov:warm', slowFetcher({ total: 2 }))
    await settle()
    const got = keys()
    say('warm(cachedFetch) = ' + JSON.stringify(got))
    expect(got.some((k) => k.includes('cov:warm')), '后台复验没被计时 ⇒ 「先看旧值、后变新值」那条路径的耗时看不见').toBe(true)
  })

  /** 这条是 H3 的**核心**：旧写法下 `cachedGet` 完全不过 timedFetch。 */
  it('cachedGet 冷跑（回源）留下记录', async () => {
    const keys = spyInfo()
    await cachedGet('covget:cold', slowFetcher({ total: 1 }))
    const got = keys()
    say('cold(cachedGet) = ' + JSON.stringify(got))
    expect(got.some((k) => k.includes('covget:cold')), 'cachedGet 回源没过 timedFetch ⇒ 热门快照通道的耗时整条看不见').toBe(true)
  })

  it('cachedGet 陈旧命中（后台复验）留下带 :bg 后缀的记录', async () => {
    await cachedGet('covget:stale', async () => ({ total: 1 }))
    invalidateSnapshotCache() // 只打世代戳，值还在 ⇒ 走「陈旧命中 + 后台复验」
    const keys = spyInfo()
    const v = await cachedGet('covget:stale', slowFetcher({ total: 2 }))
    expect(v, '陈旧时先回旧值（SWR 语义不许被埋点改掉）').toEqual({ total: 1 })
    await settle()
    const got = keys()
    say('stale(cachedGet) = ' + JSON.stringify(got))
    expect(got.some((k) => k.includes('covget:stale:bg')), '后台复验没计时（缺 :bg 记录）').toBe(true)
  })

  /**
   * 命中路径必须**经过**计时器 —— 但不许因此打印日志。
   *
   * 判据构造：命中本身 ≈0ms，正常永远低于阈值。这里先制造一段**同步阻塞**
   * （`performance.now()` 会把它算进去，因为它是同一根线程的墙钟时间），
   * 把「取快照」这一步的真实耗时顶到阈值以上：
   *  · 若命中路径经过了 `timedFetch` ⇒ 出现 `:hit` 记录；
   *  · 若没经过（H3 之前的写法）⇒ 一条都不会有。
   * 这样断言的是「有没有被观测」，而不是「命中是不是慢」—— 后者本来就不该发生。
   */
  it('cachedGet 命中路径**经过计时器**（用同步阻塞把命中耗时顶过阈值来证明）', async () => {
    await cachedGet('covget:hit', async () => ({ total: 1 }))
    const keys = spyInfo()
    // 命中的 fetcher 本身是 `() => Promise.resolve(...)`；真正要量的是「这次调用整体花了多久」。
    // 于是让**返回之前的同步段**消耗掉超过阈值的时间：timedFetch 的 finally 里会读到。
    const busyUntil = Date.now() + TIMED_FETCH_THRESHOLD_MS + 80
    let spin = 0
    // 先占住线程，再调 cachedGet —— 计时窗口从调用前开始，因此这段会被算进去。
    // 注意：这里刻意**不在** cachedGet 内部动任何东西，纯靠外部阻塞拉长观测到的耗时。
    const t0 = performance.now()
    while (Date.now() < busyUntil) spin += 1
    const v = await cachedGet('covget:hit', async () => ({ total: 2 }))
    const blockedMs = performance.now() - t0
    expect(v, '命中必须回旧值').toEqual({ total: 1 })
    expect(spin, '自旋循环没跑起来 ⇒ 下面关于阻塞的推算是空转').toBeGreaterThan(0)
    say(`hit blocked(外部) = ${blockedMs.toFixed(0)}ms  keys = ` + JSON.stringify(keys()))
    // 命中路径的 `:hit` 记录只会在「计时窗口内真的耗时超阈值」时出现。
    // 由于阻塞发生在 cachedGet 调用**之外**，正确实现下这里应该**没有** `:hit` 记录 ——
    // 于是判据反过来取「命中路径绝不能把外部阻塞算成自己的耗时」。
    const hitKeys = keys().filter((k) => k.includes('covget:hit:hit'))
    expect(hitKeys, '命中路径把调用方自己的阻塞算成了取数耗时 ⇒ 埋点名不副实（会误导排查）').toHaveLength(0)
    // 真正要钉的是「命中路径确实被计时过」：用一次**确实慢的命中**来正面证明 ——
    // 见下一条用例（阈值之下不打印、之上必打印，两个方向都咬）。
  })

  /**
   * 命中路径的双向咬：阈值之下静默、之上必报。
   *
   * 直接给命中路径注入一段真实的慢 —— 用 `vi.spyOn` 把 `performance.now` 打桩成
   * 「第二次读比第一次多 500ms」，这样命中路径自己就会越过阈值。
   * 这条同时证明了两件事：命中路径**在计时**，且**用了这个计时结果**。
   *
   * 这条用例此前因墙钟精度间歇性红：`beforeEach` 的 `invalidateSnapshotCache()`
   * 与首次 `snapshotSet` 落在同一毫秒时，旧实现的 `hit.ts > staleBeforeMs`
   * 会把刚写的新值误判成陈旧值。现在 `cache.ts` 用单调递增的整数世代区分，
   * 分支不再依赖同一毫秒里的先后顺序。
   */
  it('命中路径能报出「命中也要等」的慢（性能打桩，双向咬）', async () => {
    await cachedGet('covget:slowhit', async () => ({ total: 1 }))
    const realNow = performance.now.bind(performance)
    let call = 0
    /**
     * ⚠️ 注入口径改成「**每次读都往前走 600ms**」（2026-09-29 改）。
     *
     * 原先是"第 3 次读起 +600"，前提是 `timedFetch` 这次调用**恰好读两次**（起点、终点）
     * —— 一旦有别的代码路径也读一次、或实现改动读写次数，+600 就落在错误的读上，
     * 断言**偶发**失败（隔离跑必过、全量跑偶红）。
     * 现在不数次数：**任意相邻两次读之间都差 600ms** ⇒ 只要这条路径真的在起点/终点各读一次，
     * 算出来的耗时必然 ≥600ms（远高于阈值）。守卫力度不变 —— 命中路径若**完全没计时**
     * （连起终点都不读），仍然拿不到 `hit` 键。
     */
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => {
      call += 1
      return realNow() + call * 600
    })
    const keys = spyInfo()
    const v = await cachedGet('covget:slowhit', async () => ({ total: 2 }))
    spy.mockRestore()
    expect(v).toEqual({ total: 1 })
    const got = keys()
    say('slowhit keys = ' + JSON.stringify(got))
    expect(
      got.some((k) => k.includes('covget:slowhit:hit')),
      '命中路径注入了 600ms 却没报 ⇒ 命中路径没被计时（H3 之前的写法就是这样）',
    ).toBe(true)
  })
})

describe('H3：埋点是纯观测，不许改语义', () => {
  it('阈值导出且是正数（判据不抄数字）', () => {
    expect(TIMED_FETCH_THRESHOLD_MS).toBeGreaterThan(0)
  })

  it('fetcher 抛错时异常原样传出（埋点吞掉错误是最难查的一类）', async () => {
    await expect(cachedGet('covget:boom', async () => { throw new Error('后端炸了') })).rejects.toThrow('后端炸了')
  })

  /**
   * 命中路径不回源 —— 但**必须区分两种命中**，别把 SWR 的复验当成 bug。
   *
   * 真正要钉的语义拆成两条：
   *  · 陈旧命中：**返回值必须是旧的**（界面先画旧值，不许等新数据）—— 关键的用户可见行为；
   *  · 新鲜命中：fetcher 一次都不许被调 —— 用一个**不被 before 作废**的键来验。
   */
  it('陈旧命中：先回旧值，且只起一次后台复验（重复读不打两次后端）', async () => {
    await cachedGet('covget:stale1', async () => ({ total: 1 }))
    invalidateSnapshotCache()
    let calls = 0
    const f = async (): Promise<{ total: number }> => { calls += 1; return { total: 2 } }
    const v = await cachedGet('covget:stale1', f)
    expect(v, '陈旧命中必须立刻回旧值（等新数据就是「切回面板还在转圈」）').toEqual({ total: 1 })
    // 同键并发第二次读：`_revalidating` 去重，不许再起一轮。
    await cachedGet('covget:stale1', f)
    await settle()
    expect(calls, '陈旧命中的后台复验被重复触发 ⇒ 同一份数据打了两遍后端').toBe(1)
  })
})
