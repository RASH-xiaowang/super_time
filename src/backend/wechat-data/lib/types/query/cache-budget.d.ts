/**
 * 进程内缓存的通用容量工具：同时限制条数、总大小与单条大小。
 *
 * 这里只管计数与淘汰，不关心“大小”是字符数还是字节数，也不碰文件/网络。
 */
export interface BoundedCacheOptions<V> {
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
export declare function createBoundedCache<K, V>(opts: BoundedCacheOptions<V>): BoundedCache<K, V>;
