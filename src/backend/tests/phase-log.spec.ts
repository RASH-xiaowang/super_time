/**
 * `tests/helpers/phase-log.ts` 的应用例 —— 它是 N36 口径 ② 的自证入口，不能是「只能靠真跑一次慢用例才知道坏了」的东西。
 *
 * **这里一律用假时钟**（`vi.spyOn(performance, 'now')`）：段长本来就是墙钟，可判据要的是
 * 「每一段只从上一段的终点算起」这个**结构**。用忙等去量的话断言就得给调度抖动留容错 ——
 * 第一版正是那么写的，在全量套件并行跑到一半时真的红过一次（代码没坏，是判据脆）。
 * 假时钟一次解决两件事：断言精确到毫秒，而且「忘了推起点」这类错一定抓得住。
 *
 * @module tests/phase-log
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createPhaseLog } from './helpers/phase-log.ts'
import { at } from './helpers/strict-index.ts'

/**
 * 把 `performance.now()` 冻在给定的读数序列上（用完就一直返回最后一个）。
 *
 * 记号：`createPhaseLog` 自己读第 1 次，之后每个 `mark` 读一次 —— 所以
 * `values = [t0, t1, t2]` 配一个 `mark` 得到的段长是 `t1 - t0`。
 * @param values - 时钟读数序列。
 * @returns 抓到的 `console.log` 行。
 */
function freezeClock (values: readonly number[]): { lines: string[] } {
  let i = 0
  vi.spyOn(performance, 'now').mockImplementation(() => {
    const v = at(values, Math.min(i, values.length - 1), '时钟序列')
    i += 1
    return v
  })
  const lines: string[] = []
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]): void => { lines.push(String(args[0])) })
  return { lines }
}

afterEach(() => { vi.restoreAllMocks() })

describe('阶段墙钟：每段只从上一段的终点算起（假时钟，断言精确到毫秒）', () => {
  it('三段 0→5、5→17、17→17 就是 5ms、12ms、0ms', () => {
    const clock = freezeClock([0, 5, 17, 17])
    const ph = createPhaseLog('test｜甲')
    ph.mark('一段')
    ph.mark('二段')
    ph.mark('三段')
    ph.report()
    expect(at(clock.lines, 0, '那一行'), '第三段中间没有工作 ⇒ 必须 0ms；若它与第二段一样大，就是记完没把起点推过来')
      .toBe('[阶段|test｜甲] 一段=5ms 二段=12ms 三段=0ms')
    expect(ph.spans, '记了三段就该报三段').toBe(3)
  })

  it('亚毫秒按四舍五入落到整数（10→22.6 记成 13ms）', () => {
    const clock = freezeClock([10, 10, 22.6])
    const ph = createPhaseLog('test｜乙')
    ph.mark('一段')
    ph.mark('二段')
    ph.report()
    expect(at(clock.lines, 0, '那一行')).toBe('[阶段|test｜乙] 一段=0ms 二段=13ms')
  })

  it('一段都没记时那行自己说不作数（空行会被读成「这一段几乎不花时间」）', () => {
    const clock = freezeClock([0, 1])
    createPhaseLog('test｜丙').report()
    expect(at(clock.lines, 0, '那一行')).toContain('一段都没记')
    expect(at(clock.lines, 0, '那一行')).not.toMatch(/=/)
  })

  it('行形状是机检过的：`[阶段|<label>] 名=整数ms` 空格分隔（CI 日志那边照这个解析）', () => {
    const clock = freezeClock([0, 12, 40])
    const ph = createPhaseLog('test｜丁')
    ph.mark('开库')
    ph.mark('插入')
    ph.report()
    const line = at(clock.lines, 0, '那一行')
    expect(line).toMatch(/^\[阶段\|test｜丁] 开库=\d+ms 插入=\d+ms$/)
    expect(Number(/插入=(\d+)ms/.exec(line)?.[1]), '12→40 那段应该是 28ms').toBe(28)
  })
})
