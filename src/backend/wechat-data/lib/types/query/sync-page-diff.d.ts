/** 每扫描/补丁这么多页让出一次事件循环（与 query-yield-discipline 同一口径）。 */
export declare const PAGE_DIFF_YIELD_PAGES = 512;
/** 变化页占比超过它就退回全量。 */
export declare const DIFF_MAX_CHANGED_RATIO = 0.2;
/**
 * 逐页扫描主库的指纹列表（带让出；空文件返回空表）。
 * @param path - 原始加密主库路径。
 * @returns 每页 32 字节指纹。
 */
export declare function pageHashesOf(path: string): Promise<Buffer[]>;
/**
 * 只扫 `[startPage, startPage + count)` 区间的指纹（尾部增量成功后补记新页用）。
 */
export declare function pageHashesRange(path: string, startPage: number, count: number): Promise<Buffer[]>;
/**
 * 纯判定：两张指纹列表的差异页下标（含新增页）。
 */
export declare function diffPageIndexes(prev: readonly Buffer[], cur: readonly Buffer[]): number[];
/**
 * 只解密主库里**指定页**并写进 staging 快照的对应页槽。
 * @param rawDb - 原始加密主库。
 * @param stagingDb - staging 快照（旧快照的副本，r+ 打开）。
 * @param indexes - 要解密的页下标（0 起）。
 * @param encKey - 派生密钥。
 * @returns 实际写回的页数。
 */
export declare function patchChangedPages(rawDb: string, stagingDb: string, indexes: readonly number[], encKey: Buffer): Promise<number>;
