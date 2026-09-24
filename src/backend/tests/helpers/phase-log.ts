/**
 * 「阶段墙钟」—— 把一个用例的时间切成几段，各段多少毫秒直接打进日志。
 *
 * ## 为什么要有（而且为什么是共享的）
 *
 * N36 的口径 ② 说「B 类越线必须能自证」，能自证靠的就是这句话：
 * **「那几十秒不在这几段里的任何一段」**。以前全仓库只有一处手写过分段
 * （`image-path-batch.spec.ts`），于是别的文件一旦越线依然什么都证明不了。
 * 提到这里来，任何慢文件埋点都是一行 import。
 *
 * ## 为什么用 `performance.now()` 而不是 `Date.now()`
 *
 * 段的长度是**毫秒级甚至亚毫秒**的（夹具生成的改动曾经就在 1.5 秒这一档），
 * `Date.now()` 的整毫秒截断会把「这段几乎不花时间」和「这段 0.4 毫秒」混成一回事。
 *
 * @module tests/helpers/phase-log
 */

/** 一个阶段计时器。 */
export interface PhaseLog {
  /** 记一段：从上一个记号到现在的毫秒数。 */
  mark: (name: string) => void
  /** 把所有段打成一行 `[阶段|<label>] a=12ms b=7ms …`。 */
  report: () => void
  /** 已经记了几段（给用例断言「埋点没白埋」）。 */
  readonly spans: number
}

/**
 * 开一个阶段计时器。
 * @param label - 打在行首的标识，通常带文件名（`[阶段|search-cursor]`）—— 一次 CI 运行里
 *                会有好几个文件各自打一行，没有标识就分不清是谁说的。
 * @returns 计时器。
 */
export function createPhaseLog(label: string): PhaseLog {
  const spans: Array<[string, number]> = []
  let last = performance.now()
  return {
    mark (name: string): void {
      const now = performance.now()
      spans.push([name, Math.round(now - last)])
      last = now
    },
    report (): void {
      if (spans.length === 0) {
        console.log(`[阶段|${label}] 一段都没记 —— 这一行不作数（埋点被删了或全被跳过了）`)
        return
      }
      console.log(`[阶段|${label}] ` + spans.map(([n, ms]) => `${n}=${String(ms)}ms`).join(' '))
    },
    get spans (): number { return spans.length },
  }
}
