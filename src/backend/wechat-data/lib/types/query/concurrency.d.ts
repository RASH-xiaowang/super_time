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
export declare const IMAGE_BATCH_CONCURRENCY = 8;
/** Run async work with a fixed in-flight ceiling, preserving input order. */
export declare function mapWithConcurrency<T, R>(items: readonly T[], limit: number, mapper: (item: T, index: number) => Promise<R>): Promise<R[]>;
