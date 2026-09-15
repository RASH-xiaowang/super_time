/**
 * L8 / L20 的时间语义：可重启定时器（`finished` 合并触发）+ 提示语控制器（自动消失）。
 *
 * 这两个原语是纯逻辑（不 import react），所以能用**假时钟**把交错精确钉住：
 * 「动画期间每帧 finished 只排一次任务」「连出两条提示时旧的定时器不能提前清掉新的」
 * 「卸载后不再写 state」—— 这些在真实浏览器里靠肉眼分辨不出来（尤其是第二条：
 * 界面只表现为第二条提示少显示一会儿）。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_NOTICE_MS, createNoticeController, createRestartableTimer, type TimerPort } from './timers.ts'

/** 假时钟：手动推进，任务按到期时间执行。 */
function fakeClock(): TimerPort & { advance(ms: number): void; pendingCount(): number } {
  let now = 0
  let seq = 0
  const tasks = new Map<number, { at: number; fn: () => void }>()
  return {
    set(fn, ms) {
      seq += 1
      tasks.set(seq, { at: now + Math.max(0, ms), fn })
      return seq
    },
    clear(handle) {
      tasks.delete(handle as number)
    },
    advance(ms) {
      const target = now + ms
      for (;;) {
        const due = [...tasks.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)
        const next = due[0]
        if (!next) break
        tasks.delete(next[0])
        now = next[1].at
        next[1].fn()
      }
      now = target
    },
    pendingCount: () => tasks.size,
  }
}

describe('L8 createRestartableTimer：静默期合并', () => {
  it('重复 restart 只在最后一次之后执行一次（动画期间每帧调用也只落一次）', () => {
    const clock = fakeClock()
    let runs = 0
    const t = createRestartableTimer({ run: () => { runs += 1 }, delayMs: 300, timer: clock })
    for (let i = 0; i < 60; i += 1) { t.restart(); clock.advance(16) } // 约 1 秒的动画，每帧一次
    expect(runs).toBe(0) // 期间一次都不执行（正是要避免的「逐帧重算小地图 + 写 localStorage」）
    clock.advance(300)
    expect(runs).toBe(1) // 停下后补一次，保证最终态被捕获
    expect(clock.pendingCount()).toBe(0)
  })

  it('间隔超过静默期的连续调用会各执行一次（长时间动画仍会周期性刷新）', () => {
    const clock = fakeClock()
    let runs = 0
    const t = createRestartableTimer({ run: () => { runs += 1 }, delayMs: 300, timer: clock })
    t.restart()
    clock.advance(1000)
    t.restart()
    clock.advance(1000)
    expect(runs).toBe(2)
  })

  it('cancel 丢弃待执行任务；pending 反映真实状态', () => {
    const clock = fakeClock()
    let runs = 0
    const t = createRestartableTimer({ run: () => { runs += 1 }, delayMs: 300, timer: clock })
    expect(t.pending()).toBe(false)
    t.restart()
    expect(t.pending()).toBe(true)
    t.cancel()
    expect(t.pending()).toBe(false)
    clock.advance(1000)
    expect(runs).toBe(0)
  })

  it('dispose 后 restart 无效（卸载后不再往已销毁的图上写）', () => {
    const clock = fakeClock()
    let runs = 0
    const t = createRestartableTimer({ run: () => { runs += 1 }, delayMs: 300, timer: clock })
    t.restart()
    t.dispose()
    expect(clock.pendingCount()).toBe(0)
    t.restart()
    clock.advance(1000)
    expect(runs).toBe(0)
    expect(t.pending()).toBe(false)
  })

  it('非法时长回退到给定静默期，不会「立刻执行」或「排不上」', () => {
    const clock = fakeClock()
    let runs = 0
    const t = createRestartableTimer({ run: () => { runs += 1 }, delayMs: 300, timer: clock })
    t.restart(Number.NaN)
    clock.advance(299)
    expect(runs).toBe(0)
    clock.advance(1)
    expect(runs).toBe(1)
  })
})

describe('L20 createNoticeController：提示自动消失', () => {
  function controller(durationMs = 3000) {
    const applied: Array<string | null> = []
    const clock = fakeClock()
    const c = createNoticeController<string>({ apply: v => { applied.push(v) }, durationMs, timer: clock })
    return { c, applied, clock }
  }

  it('到点自动清空', () => {
    const { c, applied, clock } = controller()
    c.flash('已记录')
    expect(applied).toEqual(['已记录'])
    clock.advance(2999)
    expect(applied).toEqual(['已记录'])
    clock.advance(1)
    expect(applied).toEqual(['已记录', null])
  })

  it('连续两条提示：旧的定时器不能把新的提前清掉（各处手写 setTimeout 的真实缺陷）', () => {
    const { c, applied, clock } = controller()
    c.flash('第一条')
    clock.advance(2000)
    c.flash('第二条') // 旧写法在这里排第二个定时器，1000ms 后会把「第二条」清掉
    clock.advance(1000)
    expect(applied).toEqual(['第一条', '第二条']) // 仍在显示
    clock.advance(2000)
    expect(applied).toEqual(['第一条', '第二条', null]) // 第二条活满了自己的 3000ms
  })

  it('每次 flash 可指定时长（同文件里 12s / 2.5s 混用的情形）', () => {
    const { c, applied, clock } = controller(3000)
    c.flash('长提示', 6000)
    clock.advance(3000)
    expect(applied).toEqual(['长提示'])
    clock.advance(3000)
    expect(applied).toEqual(['长提示', null])

    c.flash('短提示', 2500)
    clock.advance(2500)
    expect(applied).toEqual(['长提示', null, '短提示', null])
  })

  it('clear 立刻清空并取消计时', () => {
    const { c, applied, clock } = controller()
    c.flash('x')
    c.clear()
    expect(applied).toEqual(['x', null])
    clock.advance(10_000)
    expect(applied).toEqual(['x', null])
  })

  it('dispose 后 flash/clear 都不再写 state', () => {
    const { c, applied, clock } = controller()
    c.flash('x')
    c.dispose()
    expect(clock.pendingCount()).toBe(0)
    c.flash('y')
    c.clear()
    clock.advance(10_000)
    expect(applied).toEqual(['x'])
  })

  it('hold 常驻：不许被上一条 flash 的定时器清掉（失败提示改前就是常驻的）', () => {
    const { c, applied, clock } = controller()
    c.flash('已导出报告') // 成功提示：2.5s 后消失
    clock.advance(1000)
    c.hold('导出失败: EPERM') // 失败提示：改前一直留到下一次写入
    expect(applied).toEqual(['已导出报告', '导出失败: EPERM'])
    clock.advance(10_000)
    // flash 剩下的 2s 计时必须已被 hold 取消，否则常驻提示会被静默清掉
    expect(applied).toEqual(['已导出报告', '导出失败: EPERM'])
  })

  it('hold 之后 dispose 仍不写 state', () => {
    const { c, applied, clock } = controller()
    c.hold('常驻')
    c.dispose()
    c.hold('不该出现')
    clock.advance(10_000)
    expect(applied).toEqual(['常驻'])
  })

  it('非法时长（0 / 负数 / NaN）回退到默认 3000ms，而不是永不消失', () => {
    const { c, applied, clock } = controller(3000)
    c.flash('a', 0)
    c.flash('b', -5)
    c.flash('c', Number.NaN)
    clock.advance(DEFAULT_NOTICE_MS)
    expect(applied.slice(-1)).toEqual([null])
  })
})
