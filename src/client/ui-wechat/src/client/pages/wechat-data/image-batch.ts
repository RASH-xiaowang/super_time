/**
 * 「同一 tick 内的多次取图合并成一次批量调用」的纯逻辑队列（N16）。
 *
 * 为什么单独一个模块：合并语义（何时冲刷、怎么分块、结果怎么回填、失败怎么传播）是**可测的
 * 纯逻辑**，而 api.ts 是 1900 行的大文件（M21 正在往下降）—— 把这段放进去会让它重新长胖。
 * 这里不 import react、不碰 remote，`flush` 由调用方注入（api.ts 注入的就是批量取图 RPC）。
 *
 * 为什么需要合并：列表型取图的面板是「一屏挂 N 个组件、每个组件各自取图」。一屏 30 张图
 * 就是 30 次 RPC，而每次 RPC 内部都要扫一遍 `image_hardlink_info_v4`（实测 20 万行
 * 17.27ms/次 ≈518ms）。攒到同一 tick 里整批发出去，就只剩一次 `IN (...)`。
 */
export interface ImageLoadQueue<Key, Result> {
  /**
   * 入队一次请求。
   * @param key - 请求标识（批量调用里的一项）。
   * @returns 整批返回后回填的 Promise；整批失败时 reject（与逐次调用同语义）。
   */
  enqueue(key: Key): Promise<Result>
}

/**
 * 造一个取图合并队列。
 * @param options.flush - 真正发出批量调用的函数；返回数组必须**按入参顺序**对应。
 * @param options.chunkSize - 一次 flush 最多几个 key（超出分多次）；默认 200。
 * @param options.schedule - 冲刷调度器（默认 `queueMicrotask`，可注入同步实现做单测）。
 * @param options.onMissing - flush 返回条数不足时，缺失那条的兜底结果（不该发生，但不能静默）。
 * @returns 队列对象。
 */
export function createImageLoadQueue<Key, Result>(options: {
  flush: (batch: readonly Key[]) => Promise<readonly Result[]>
  chunkSize?: number
  schedule?: (run: () => void) => void
  onMissing: (key: Key) => Result
}): ImageLoadQueue<Key, Result> {
  const chunkSize = Math.max(1, Math.floor(options.chunkSize ?? 200))
  const schedule = options.schedule ?? ((run: () => void) => { queueMicrotask(run) })
  let pending: Array<{ key: Key; resolve: (r: Result) => void; reject: (e: unknown) => void }> = []
  let scheduled = false

  const flushNow = (): void => {
    scheduled = false
    const batch = pending
    pending = []
    for (let i = 0; i < batch.length; i += chunkSize) {
      const chunk = batch.slice(i, i + chunkSize)
      void Promise.resolve()
        .then(() => options.flush(chunk.map(c => c.key)))
        .then(
          (results) => {
            chunk.forEach((c, idx) => { c.resolve(results[idx] ?? options.onMissing(c.key)) })
          },
          (e: unknown) => {
            // 整块失败：逐条 reject —— 让每个调用点各自走它原来的错误分支（面板里是占位图），
            // 而不是把一批错误悄悄变成「空图」。
            for (const c of chunk) c.reject(e)
          },
        )
    }
  }

  return {
    enqueue(key: Key): Promise<Result> {
      return new Promise<Result>((resolve, reject) => {
        pending.push({ key, resolve, reject })
        if (scheduled) return
        scheduled = true
        schedule(flushNow)
      })
    },
  }
}
