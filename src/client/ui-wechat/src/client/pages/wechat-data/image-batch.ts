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

interface QueueWaiter<Result> {
  resolve: (result: Result) => void
  reject: (error: unknown) => void
}

interface QueueEntry<Key, Result> {
  key: Key
  keyId: string
  waiters: Array<QueueWaiter<Result>>
}

interface QueueRetryOptions {
  /** 首次失败后的额外尝试次数。 */
  retries: number
  shouldRetry: (error: unknown) => boolean
  /** 第 index 次重试前的等待（从 0 开始）；返回 0 表示立即重试。 */
  delayMs: (index: number, error: unknown) => number
}

/**
 * 造一个取图合并队列。
 * @param options.flush - 真正发出批量调用的函数；返回数组必须**按入参顺序**对应。
 * @param options.chunkSize - 一次 flush 最多几个 key（超出分多次）；默认 200。
 * @param options.schedule - 冲刷调度器（默认 `queueMicrotask`，可注入同步实现做单测）。
 * @param options.onMissing - flush 返回条数不足时，缺失那条的兜底结果（不该发生，但不能静默）。
 * @param options.keyOf - 去重键；默认使用 `String(key)`。对象 key 必须显式提供。
 * @param options.maxInFlight - 同时执行的 chunk 数；不传则保持旧行为（不设内部上限）。
 * @param options.retry - 对整块失败做有限重试；是否可重试由调用方按错误码判断。
 * @returns 队列对象。
 */
export function createImageLoadQueue<Key, Result>(options: {
  flush: (batch: readonly Key[]) => Promise<readonly Result[]>
  chunkSize?: number
  schedule?: (run: () => void) => void
  onMissing: (key: Key) => Result
  keyOf?: (key: Key) => string
  maxInFlight?: number
  retry?: QueueRetryOptions
}): ImageLoadQueue<Key, Result> {
  const chunkSize = Math.max(1, Math.floor(options.chunkSize ?? 200))
  const schedule = options.schedule ?? ((run: () => void) => { queueMicrotask(run) })
  const keyOf = options.keyOf ?? ((key: Key) => String(key))
  const configuredMaxInFlight = Number(options.maxInFlight)
  const maxInFlight = Number.isFinite(configuredMaxInFlight) && configuredMaxInFlight > 0
    ? Math.max(1, Math.floor(configuredMaxInFlight))
    : Number.POSITIVE_INFINITY
  const retry = options.retry === undefined
    ? null
    : {
        ...options.retry,
        retries: Math.max(0, Math.floor(options.retry.retries)),
      }
  const pending = new Map<string, QueueEntry<Key, Result>>()
  const inFlight = new Map<string, QueueEntry<Key, Result>>()
  const dispatchQueue: Array<Array<QueueEntry<Key, Result>>> = []
  let scheduled = false
  let activeChunks = 0

  const wait = (ms: number): Promise<void> => {
    if (!(ms > 0)) return Promise.resolve()
    return new Promise((resolve) => { setTimeout(resolve, ms) })
  }

  const releaseFlight = (chunk: ReadonlyArray<QueueEntry<Key, Result>>): void => {
    for (const entry of chunk) {
      if (inFlight.get(entry.keyId) === entry) inFlight.delete(entry.keyId)
    }
  }

  const settleChunk = (
    chunk: ReadonlyArray<QueueEntry<Key, Result>>,
    results: readonly Result[] | null,
    error?: unknown,
  ): void => {
    releaseFlight(chunk)
    chunk.forEach((entry, index) => {
      for (const waiter of entry.waiters) {
        if (error !== undefined) waiter.reject(error)
        else waiter.resolve(results?.[index] ?? options.onMissing(entry.key))
      }
    })
  }

  const executeChunk = async (chunk: Array<QueueEntry<Key, Result>>): Promise<void> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const results = await options.flush(chunk.map((entry) => entry.key))
        settleChunk(chunk, results)
        return
      } catch (error) {
        const canRetry = retry !== null && attempt < retry.retries && retry.shouldRetry(error)
        if (!canRetry) {
          settleChunk(chunk, null, error)
          return
        }
        await wait(retry.delayMs(attempt, error))
      }
    }
  }

  const pump = (): void => {
    while (activeChunks < maxInFlight) {
      const chunk = dispatchQueue.shift()
      if (chunk === undefined) return
      activeChunks += 1
      void executeChunk(chunk).finally(() => {
        activeChunks -= 1
        pump()
      })
    }
  }

  const flushNow = (): void => {
    scheduled = false
    if (pending.size === 0) return
    const batch = [...pending.values()]
    pending.clear()
    for (let i = 0; i < batch.length; i += chunkSize) {
      const chunk = batch.slice(i, i + chunkSize)
      for (const entry of chunk) inFlight.set(entry.keyId, entry)
      dispatchQueue.push(chunk)
    }
    pump()
  }

  return {
    enqueue(key: Key): Promise<Result> {
      const keyId = keyOf(key)
      const existing = inFlight.get(keyId) ?? pending.get(keyId)
      if (existing !== undefined) {
        return new Promise<Result>((resolve, reject) => {
          existing.waiters.push({ resolve, reject })
        })
      }
      return new Promise<Result>((resolve, reject) => {
        pending.set(keyId, { key, keyId, waiters: [{ resolve, reject }] })
        if (scheduled) return
        scheduled = true
        schedule(flushNow)
      })
    },
  }
}
