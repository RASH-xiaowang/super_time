/**
 * 流式问答的**单飞闸**（M13）。
 *
 * 为什么不是用 `useState` 的 `asking` 当闸门：React 的状态更新是**异步**的，
 * 快速连点两次时第二次点击可能落在「`setAsking(true)` 已调用、但组件还没重渲染」的窗口里 ——
 * 那时 `ask` 闭包里捕获的 `asking` 仍是 `false`，两次调用双双通过，于是并发产生两轮，
 * 而先返回的那轮在 `finally` 里无条件 `setAsking(false)`，把仍在生成的另一轮标记成已结束。
 *
 * 闸门状态放在 ref 里（同步、不受渲染时机影响），并且**认领轮次 id**：
 * 只有「当前轮」才能释放闸门 / 清掉流式缓冲，迟到的旧轮不许截断新轮。
 *
 * 抽成独立模块是为了**能测**：use-ask.ts 是 React hook，仓库里没有 hook 测试环境，
 * 而这里要守的恰恰是并发语义。
 */
export interface AskGate {
  /**
   * 尝试开始一轮。已在跑 → 返回 null（调用方直接忽略这次点击）。
   * @returns 本轮 id；未开始则为 null。
   */
  tryStart(): string | null
  /**
   * 某轮是否仍是「当前轮」。旧轮迟到的回调据此放弃写状态。
   * @param id - 轮次 id。
   * @returns 是当前轮则为 true。
   */
  isCurrent(id: string): boolean
  /**
   * 结束某轮并（仅当它仍是当前轮时）释放闸门。
   * @param id - 轮次 id。
   * @returns 真的释放了闸门则为 true；说明它是过期轮次、不该动 state。
   */
  finish(id: string): boolean
  /** 当前是否有轮次在跑。 */
  running(): boolean
}

/**
 * 造一个单飞闸。
 * @param makeId - id 生成器（默认 时间戳+随机；测试可注入固定值）。
 * @returns 闸门实例。
 */
export function createAskGate(makeId: () => string = () => `ask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`): AskGate {
  let current: string | null = null
  return {
    tryStart(): string | null {
      if (current !== null) return null
      current = makeId()
      return current
    },
    isCurrent(id: string): boolean {
      return current !== null && current === id
    },
    finish(id: string): boolean {
      if (current !== id) return false
      current = null
      return true
    },
    running(): boolean {
      return current !== null
    },
  }
}
