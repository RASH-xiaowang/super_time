/** 磁盘缓存里的一条分片聚合（`agg` 的具体形状由调用方定义）。 */
export interface InsightsShardCacheEntry<T> {
    key: string;
    sig: string;
    agg: T;
}
/**
 * 分片聚合磁盘缓存的位置：`<数据根>/cache/insights-shards.v1.json`
 * （`dec` 是 `<数据根>/decrypted`）。
 * @param dec - 已解密数据根。
 * @returns 缓存文件绝对路径。
 */
export declare function insightsShardCachePath(dec: string): string;
/**
 * 读取磁盘缓存。任何异常都退化为空 Map。
 * @param path - `insightsShardCachePath()` 的返回值。
 * @returns key → 记录。
 */
export declare function loadInsightsShardCache<T>(path: string): Map<string, InsightsShardCacheEntry<T>>;
/**
 * 原子写入磁盘缓存。
 * @param path - `insightsShardCachePath()` 的返回值。
 * @param entries - 要持久化的记录（调用方已按 LRU 上限裁剪）。
 * @returns true = 写入成功（失败只返回 false，不抛）。
 */
export declare function saveInsightsShardCache<T>(path: string, entries: Array<InsightsShardCacheEntry<T>>): boolean;
