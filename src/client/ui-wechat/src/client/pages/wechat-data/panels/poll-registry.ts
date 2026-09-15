/**
 * M15：面板内轮询的登记表 —— 所有 interval 都登记，组件卸载时统一清掉。
 *
 * 为什么要这一层：`Settings.tsx` 里四处轮询（whisper 模型下载 / 引擎安装 / 批量转写 / 解密）
 * 都是「创建 interval → await 一个长任务 → finally 里 clear」的结构。下载/转写可能跑几分钟，
 * 而 `finally` 只在那个 await **落定之后**才执行 —— 用户中途切走面板（组件卸载）时，
 * interval 仍在每 400~500ms 打一次 IPC，并在已卸载的组件上 setState。
 * 把创建收口到一个登记表里，卸载时一次清干净。
 *
 * 抽成独立模块是为了**能测**：仓库没有 hook/DOM 测试环境（见 M13 的复审结论），
 * 而这里要守的正是「卸载后不再回调」这个语义。
 */
export interface PollRegistry {
  /**
   * 起一个轮询并登记。
   * @param fn - 每次触发做的事。
   * @param ms - 周期间隔。
   * @returns 停止本轮的函数（幂等）。
   */
  start(fn: () => void, ms: number): () => void
  /** 停掉全部轮询（卸载时调用；幂等）。 */
  stopAll(): void
  /** 当前登记的轮询数量（诊断/测试用）。 */
  size(): number
}

/** 造一个登记表。 */
export function createPollRegistry(): PollRegistry {
  const ids = new Set<ReturnType<typeof setInterval>>()
  return {
    start(fn: () => void, ms: number): () => void {
      const id = setInterval(fn, ms)
      ids.add(id)
      return () => {
        if (!ids.delete(id)) return // 已被 stopAll 清掉：不要重复 clear
        clearInterval(id)
      }
    },
    stopAll(): void {
      for (const id of ids) clearInterval(id)
      ids.clear()
    },
    size(): number {
      return ids.size
    },
  }
}
