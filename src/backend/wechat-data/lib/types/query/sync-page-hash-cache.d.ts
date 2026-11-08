export interface PageHashCacheEntry {
    sig: string;
    hashes: Buffer[];
}
/**
 * 主库页指纹缓存：`源签名 → 指纹列表`。
 *
 * 每个分片每页固定 32B，300+ 分片时原先的无界 Map 可积累数百 MB。超界后只是
 * 退化为下一轮全量重扫，不影响同步正确性。
 */
export declare const pageHashCache: import("./cache-budget.ts").BoundedCache<string, PageHashCacheEntry>;
/** 页指纹缓存的单测把手；不暴露内部缓存对象。 */
export declare function pageHashCacheHandles(): {
    stats: () => {
        count: number;
        total: number;
    };
    clear: () => void;
    putForTest: (key: string, entry: PageHashCacheEntry) => void;
};
