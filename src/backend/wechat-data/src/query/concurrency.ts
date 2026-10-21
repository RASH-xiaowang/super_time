/**
 * 有界并发工具（从 remotes/media.ts 拆出，满足「单文件 ≤1000 行」棘轮）。
 *
 * 为什么单独成文件：这两个符号只有「批量解码」一处使用，但被单测直接引用；
 * 拆出来既让 media.ts 回到行数上限内，也避免并发语义埋在 1000 行的远程方法面里。
 */

/**
 * Disk/CPU batch ceiling. Decoding returns large base64 strings, so 8 keeps the
 * peak memory bounded while still hiding file and SQLite latency.
 */
export const IMAGE_BATCH_CONCURRENCY = 8

/** Run async work with a fixed in-flight ceiling, preserving input order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return []
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length))
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (true) {
      const index = next
      next += 1
      if (index >= items.length) return
      out[index] = await mapper(items[index]!, index)
    }
  }
  await Promise.all(Array.from({ length: width }, worker))
  return out
}
