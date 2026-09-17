/**
 * 折叠条状态机的行为锁定（`ui/fold-idle.ts`）。
 *
 * 这条组件的全部风险都在「什么时候该收起」：离开后多久收、期间回来了算不算、
 * 收起状态下再收到 leave 要不要重新计时、卸载后定时器还会不会写状态。
 * 用注入的假时钟把每一种交错钉住。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_FOLD_IDLE_MS, createFoldController, type FoldEvent } from './fold-idle.ts'
import type { TimerPort } from '../panels/timers.ts'

/** 假时钟：记录待执行任务，可手动推进。 */
function fakeClock(): TimerPort & { tick(ms: number): void; pending(): number } {
  let seq = 0
  const jobs = new Map<number, { at: number; fn: () => void }>()
  let now = 0
  return {
    set(fn, ms) {
      const id = ++seq
      jobs.set(id, { at: now + ms, fn })
      return id
    },
    clear(handle) { jobs.delete(handle as number) },
    pending: () => jobs.size,
    tick(ms) {
      now += ms
      const due = [...jobs.entries()].filter(([, j]) => j.at <= now).sort((a, b) => a[1].at - b[1].at)
      for (const [id, j] of due) { jobs.delete(id); j.fn() }
    },
  }
}

/** 造一个控制器并记录每次展开态变化。 */
function setup(idleMs = DEFAULT_FOLD_IDLE_MS) {
  const clock = fakeClock()
  const seen: boolean[] = []
  const c = createFoldController({ onChange: (o) => { seen.push(o) }, idleMs, timer: clock })
  return { c, clock, seen, fire: (ev: FoldEvent) => c.dispatch(ev) }
}

describe('折叠条状态机', () => {
  it('初始为折叠，且不触发 onChange', () => {
    const { c, seen } = setup()
    expect(c.isOpen()).toBe(false)
    expect(seen).toEqual([])
  })

  it('open 展开、collapse 收起，各回调一次', () => {
    const { c, seen, fire } = setup()
    expect(fire({ type: 'open' })).toBe(true)
    expect(c.isOpen()).toBe(true)
    expect(fire({ type: 'collapse' })).toBe(true)
    expect(c.isOpen()).toBe(false)
    expect(seen).toEqual([true, false])
  })

  it('重复 open / 重复 collapse 不重复回调（父组件不必无谓重渲染）', () => {
    const { c, seen, fire } = setup()
    fire({ type: 'open' })
    fire({ type: 'open' })
    fire({ type: 'collapse' })
    fire({ type: 'collapse' })
    expect(seen).toEqual([true, false])
  })

  it('折叠态下 pointer-leave 不启动计时（否则鼠标划过收起条就白排一次定时器）', () => {
    const { c, clock, fire } = setup()
    fire({ type: 'pointer-leave' })
    expect(clock.pending()).toBe(0)
    expect(c.isOpen()).toBe(false)
  })

  it('展开后 pointer-leave 启动计时，到点自动收起', () => {
    const { c, clock, seen, fire } = setup(10_000)
    fire({ type: 'open' })
    fire({ type: 'pointer-leave' })
    expect(clock.pending()).toBe(1)
    clock.tick(9_999)
    expect(c.isOpen()).toBe(true)
    expect(seen).toEqual([true])
    clock.tick(1)
    expect(c.isOpen()).toBe(false)
    expect(seen).toEqual([true, false])
  })

  it('离开期间指针回来 → 取消计时，不再自动收起', () => {
    const { c, clock, fire } = setup(10_000)
    fire({ type: 'open' })
    fire({ type: 'pointer-leave' })
    clock.tick(5_000)
    fire({ type: 'pointer-enter' })
    expect(clock.pending()).toBe(0)
    clock.tick(60_000)
    expect(c.isOpen()).toBe(true)
  })

  it('离开期间有交互（点击/键盘）→ 同样取消计时', () => {
    const { c, clock, fire } = setup(10_000)
    fire({ type: 'open' })
    fire({ type: 'pointer-leave' })
    clock.tick(3_000)
    fire({ type: 'interact' })
    expect(clock.pending()).toBe(0)
    clock.tick(60_000)
    expect(c.isOpen()).toBe(true)
  })

  it('反复离开会重启计时，而不是叠加成多个定时器（最后一次之后满 10 秒才收）', () => {
    const { c, clock, fire } = setup(10_000)
    fire({ type: 'open' })
    fire({ type: 'pointer-leave' })
    clock.tick(9_000)
    fire({ type: 'pointer-enter' })
    fire({ type: 'pointer-leave' })
    expect(clock.pending()).toBe(1)
    // 第二次离开后只过了 9 秒：不该收（第一次的 9 秒不能累计）
    clock.tick(9_000)
    expect(c.isOpen()).toBe(true)
    clock.tick(1_000)
    expect(c.isOpen()).toBe(false)
  })

  it('计时到点后 onChange 只回调一次，重复 tick 不再触发', () => {
    const { c, clock, seen, fire } = setup(1000)
    fire({ type: 'open' })
    fire({ type: 'pointer-leave' })
    clock.tick(1000)
    clock.tick(10_000)
    expect(seen).toEqual([true, false])
    expect(c.isOpen()).toBe(false)
  })

  it('空闲收起之后可以再次展开，且能重新计时', () => {
    const { c, clock, fire } = setup(1000)
    fire({ type: 'open' })
    fire({ type: 'pointer-leave' })
    clock.tick(1000)
    expect(c.isOpen()).toBe(false)
    fire({ type: 'open' })
    expect(c.isOpen()).toBe(true)
    fire({ type: 'pointer-leave' })
    clock.tick(1000)
    expect(c.isOpen()).toBe(false)
  })

  it('显式 collapse 会取消待执行的计时（别让它在收起后再跑一次 onChange）', () => {
    const { c, clock, seen, fire } = setup(1000)
    fire({ type: 'open' })
    fire({ type: 'pointer-leave' })
    fire({ type: 'collapse' })
    expect(clock.pending()).toBe(0)
    clock.tick(10_000)
    expect(seen).toEqual([true, false])
    expect(c.isOpen()).toBe(false)
  })

  it('dispose 之后一切无效：不再改状态、也不再回调', () => {
    const { c, clock, seen, fire } = setup(1000)
    fire({ type: 'open' })
    fire({ type: 'pointer-leave' })
    c.dispose()
    clock.tick(10_000)
    expect(c.isOpen()).toBe(true) // 定时器已停，不会被收起
    expect(fire({ type: 'collapse' })).toBe(false)
    expect(seen).toEqual([true])
  })

  it('dispatch 返回值只在展开态真的变化时为 true', () => {
    const { fire } = setup()
    expect(fire({ type: 'open' })).toBe(true)
    expect(fire({ type: 'pointer-leave' })).toBe(false)
    expect(fire({ type: 'pointer-enter' })).toBe(false)
    expect(fire({ type: 'interact' })).toBe(false)
    expect(fire({ type: 'collapse' })).toBe(true)
  })

  it('默认空闲时长是 10 秒', () => {
    expect(DEFAULT_FOLD_IDLE_MS).toBe(10_000)
  })
})
