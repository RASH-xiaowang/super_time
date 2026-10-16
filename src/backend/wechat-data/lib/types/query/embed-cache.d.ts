/**
 * 缓存库体积上限（字节）。
 *
 * env `DSH_WECHAT_EMBED_CACHE_MB` 覆盖，夹在 [1, 1024] MiB；非数值/≤0 回落默认。
 * 注意**没有「0 = 关闭」这一档**：想要真关掉，把上限设成 1 MiB 即可（缓存会持续被淘汰，
 * 等于没有），不必为它单开一条语义。
 * @returns 字节上限。
 */
export declare function embedCacheMaxBytes(): number;
/** 缓存库文件路径（与 `wechat_search.db` / `wechat_rag_vectors.db` 同级）。 */
export declare function embedCachePath(decryptedDir: string): string;
/**
 * 缓存键：`sha256(命名空间 ␀ 模型 ␀ 文本)`。
 *
 * 三段都必要：命名空间切分脱敏口径（见文件头），模型名切分模型（换模型后旧向量的
 * 维度与语义都不兼容），文本本身才是被缓存的东西。段间用 `\u0000` 分隔，
 * 免得 `ns='a'`+`model='bc'` 与 `ns='ab'`+`model='c'` 拼成同一串。
 * @param ns - 命名空间：`r` = 脱敏开，`p` = 脱敏关。
 * @param model - 向量模型名（空串表示由桥按默认发）。
 * @param text - 送出去的那份文本（脱敏开时已经是副本）。
 * @returns 十六进制键。
 */
export declare function embedCacheKey(ns: string, model: string, text: string): string;
/**
 * 查一批键，返回**全部命中**的向量。
 *
 * 只在整批都命中时给结果（`null` 表示「有未命中」）：批内文本本来就由调用方去重过，
 * 命中与否都要再走一次闸门写审计，做「一半命中一半出网」的分支只会让审计的
 * `messages` 数与实际出网量对不上 —— 宁可整批重来。
 * @param decryptedDir - 解密数据根。
 * @param keys - 与 `texts` 同序的键。
 * @returns 与 `keys` 同序的向量；有任何一条缺失、维度不齐或字节对不上就返回 null。
 */
export declare function lookupEmbedCache(decryptedDir: string, keys: string[]): number[][] | null;
/**
 * 写回一批向量（best-effort，失败只影响下次的命中率）。
 *
 * 只在**维度齐一**时写：同一批里混进两种维度说明上游返回了不一致的结果，那种情况下
 * 宁可一条都不缓存 —— 下次还会重算，而错配的维度会一路写进向量库。
 * @param decryptedDir - 解密数据根。
 * @param keys - 与 `vectors` 同序的键。
 * @param vectors - 与 `keys` 同序的向量。
 */
export declare function storeEmbedCache(decryptedDir: string, keys: string[], vectors: number[][]): void;
/** 删掉整个缓存库文件（「清除缓存」与用户手动清理用）。 */
export declare function dropEmbedCache(decryptedDir: string): void;
/** float32 → 小端字节序。 */
declare function vecToBlob(v: number[]): Uint8Array;
/** 小端字节序 → float 数组。 */
declare function blobToVec(b: Uint8Array, dim: number): number[];
/** 测试接缝：只放「真实入口拿不到」的纯函数。 */
export declare const __internals: {
    vecToBlob: typeof vecToBlob;
    blobToVec: typeof blobToVec;
};
export {};
