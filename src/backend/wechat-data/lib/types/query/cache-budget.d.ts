/**
 * 进程内缓存的通用容量工具：同时限制条数、总大小与单条大小。
 *
 * 这里只管计数与淘汰，不关心“大小”是字符数还是字节数，也不碰文件/网络。
 */
export interface BoundedCacheOptions<V> {
    /** 注册表里的名字；给了才会出现在 `cacheBudgetSnapshot()`（运行时内存观测）里。 */
    label?: string;
    maxEntries: number;
    maxTotal: number;
    sizeOf: (value: V) => number;
    maxEntry?: number;
}
export interface BoundedCache<K, V> {
    get: (key: K) => V | undefined;
    set: (key: K, value: V) => void;
    delete: (key: K) => boolean;
    clear: () => void;
    size: () => number;
    total: () => number;
    keys: () => IterableIterator<K>;
}
/** 一条受控缓存的运行时占用（给内存哨兵/诊断日志用）。 */
export interface CacheBudgetUsage {
    label: string;
    entries: number;
    bytes: number;
    maxEntries: number;
    maxTotal: number;
    maxEntry?: number;
}
/** 当前进程内所有带 label 的有界缓存占用快照（顺序 = 注册顺序）。 */
export declare function cacheBudgetSnapshot(): CacheBudgetUsage[];
/** 清空注册表（仅测试：避免用例之间互相看见对方的缓存）。 */
export declare function resetCacheBudgetRegistryForTest(): void;
export declare function createBoundedCache<K, V>(opts: BoundedCacheOptions<V>): BoundedCache<K, V>;
