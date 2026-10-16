/**
 * 「有没有让出事件循环」的探针（P1-2 判据的公共零件）。
 *
 * ## 为什么用 tick 数而不是用时间
 *
 * 让出型查询的判据若写成「这段时间里别的任务动了多久」，在 CI 上必然假红 ——
 * runner 比本机慢一个量级（`vitest.config.ts` 的 `testTimeout` 就是因为这个从 30s 提到 180s）。
 *
 * ## 为什么这个数是**结构性**的
 *
 * 探针每轮只排**一个** `setImmediate`，而让出点用的也是 `setImmediate`
 * ⇒ 队列里最多压着探针的一个回调 ⇒ 「一次让出 = 一个 tick」，再加开始时的一个：
 * `ticks == 让出次数 + 1`。与机器快慢无关，所以断言下界可以直接取「预期让出次数 + 1」——
 * 少任何一处让出都会立刻掉下界（这一条是实测出来的：见 `query-yield-discipline.spec.ts` 的 `[算料|yield]`）。
 *
 * @module tests/helpers/tick-probe
 */

/**
 * 起一个与断言目标并发的 `setImmediate` 探针。
 * @returns `stop()`：停表并返回探针这段时间拿到的 tick 数（只会有一次有效结果）。
 */
export function startTickProbe(): () => number {
  let ticks = 0
  let running = true
  const loop = async (): Promise<void> => {
    while (running) {
      ticks += 1
      await new Promise<void>((r) => { setImmediate(r) })
    }
  }
  void loop()
  return () => {
    running = false
    return ticks
  }
}
