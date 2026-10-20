/**
 * `sync-trigger.ts` 的行为守卫（2026-10-18）。
 *
 * 这一族只有一个职责：**tick 运行期间到达的 WAL 触发不许丢**。所以判据全部围绕
 * 「run 的调用次数 / 是否并发 / 定时器有没有被清」这三件**可观测**的事，不读实现形状。
 */
import { describe, expect, it, vi } from 'vitest'
import { createSyncTrigger, SYNC_TRAILING_DELAY_MS } from '../src/query/sync-trigger.ts'

interface Scheduled { fn: () => void; ms: number; cancelled: boolean }

function makeHarness(): {
  scheduled: Scheduled[]
  fire(index?: number): void
  deps: { schedule: (fn: () => void, ms: number) => unknown; cancel: (h: unknown) => void }
} {
  const scheduled: Scheduled[] = []
  return {
    scheduled,
    fire(index = scheduled.length - 1) {
      const h = scheduled[index]
      if (h === undefined) throw new Error('没有排队的补拍')
      h.fn()
    },
    deps: {
      schedule(fn, ms) {
        const h: Scheduled = { fn, ms, cancelled: false }
        scheduled.push(h)
        return h
      },
      cancel(h) {
        ;(h as Scheduled).cancelled = true
      },
    },
  }
}

/** 可控 resolve 的 run。 */
function gate(): { run: () => Promise<void>; resolve: () => void; calls: () => number } {
  let resolve: (() => void) | null = null
  let calls = 0
  return {
    calls: () => calls,
    resolve: () => { resolve?.() },
    run: () => {
      calls += 1
      return new Promise<void>((r) => { resolve = r })
    },
  }
}

/** 让微任务跑干净（execute 的 await 链）。 */
const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve() }

describe('空闲触发：立刻跑一拍，不排定时器', () => {
  it('trigger 之后 run 立即开始；resolve 后回到 idle', async () => {
    const h = makeHarness()
    const run = vi.fn(async () => { /* 立刻完成 */ })
    const trig = createSyncTrigger({ run }, h.deps)
    trig.trigger()
    expect(run).toHaveBeenCalledTimes(1)
    expect(trig.idle(), 'run 在途时不能自称 idle').toBe(false)
    await flush()
    expect(trig.idle()).toBe(true)
    expect(h.scheduled).toHaveLength(0)
  })
})

describe('运行期触发：不丢、不并发、合并成一拍补跑', () => {
  it('tick 在跑时连来三次触发 ⇒ 只有一次补拍，且补拍延迟是 SYNC_TRAILING_DELAY_MS', async () => {
    const h = makeHarness()
    const g = gate()
    const trig = createSyncTrigger({ run: g.run }, h.deps)
    trig.trigger()
    expect(g.calls()).toBe(1)

    trig.trigger()
    trig.trigger()
    trig.trigger()
    expect(g.calls(), '运行期间不许并发开第二拍').toBe(1)
    expect(h.scheduled, '要记 pending，但不能每次触发排一个定时器').toHaveLength(0)

    g.resolve()
    await flush()
    expect(g.calls()).toBe(1)
    expect(h.scheduled, '跑完必须补一拍（原来的实现这里直接丢，要等 10s 兜底）').toHaveLength(1)
    expect(h.scheduled[0]?.ms).toBe(SYNC_TRAILING_DELAY_MS)

    h.fire()
    expect(g.calls(), '补拍必须真的跑').toBe(2)
  })

  it('补拍定时器已排、还没触发时又来触发 ⇒ 合并进 pending，不提前开跑', async () => {
    const h = makeHarness()
    const g = gate()
    const trig = createSyncTrigger({ run: g.run }, h.deps)
    trig.trigger()
    trig.trigger()
    g.resolve()
    await flush()
    expect(h.scheduled).toHaveLength(1)

    trig.trigger()
    expect(g.calls(), '定时器还挂着时不许绕过它直接开跑').toBe(1)
    h.fire()
    expect(g.calls()).toBe(2)

    // 补拍跑完会再排一次（因为它跑期间/之前还有 pending 语义），但不会并发。
    expect(h.scheduled.length).toBeLessThanOrEqual(2)
  })

  it('run 抛错不能把合并器卡死：下一次触发照常跑', async () => {
    const h = makeHarness()
    const run = vi.fn()
      .mockRejectedValueOnce(new Error('decrypt invalid'))
      .mockResolvedValueOnce(undefined)
    const trig = createSyncTrigger({ run }, h.deps)
    trig.trigger()
    await flush()
    expect(run).toHaveBeenCalledTimes(1)
    trig.trigger()
    expect(run).toHaveBeenCalledTimes(2)
  })
})

describe('stop：静默，不再产生新拍', () => {
  it('stop 清掉已排的补拍；之后的触发一律忽略', async () => {
    const h = makeHarness()
    const g = gate()
    const trig = createSyncTrigger({ run: g.run }, h.deps)
    trig.trigger()
    trig.trigger()
    g.resolve()
    await flush()
    expect(h.scheduled).toHaveLength(1)

    trig.stop()
    expect(h.scheduled[0]?.cancelled, 'stop 必须清掉已排的补拍定时器').toBe(true)
    trig.trigger()
    expect(g.calls(), 'stop 之后不许再产生新拍').toBe(1)
  })
})
