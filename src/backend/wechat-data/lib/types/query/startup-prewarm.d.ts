/** 一次预热的结果（日志与单测都用它）。 */
export interface PrewarmReport {
    /** 分片目录：解析到几张分片（0 = 没解析到任何分片，可能数据根还没配）。 */
    shards: number;
    /** contact_fts 的状态。 */
    fts: 'ready' | 'busy' | 'unavailable' | 'no-index-db' | 'skipped';
    ftsError: string;
}
/**
 * 跑一次启动预热。
 *
 * 顺序有意：**先分片目录、后 contact_fts**。前者是纯读（不会失败到哪儿去），
 * 后者要写索引库；把便宜的放前面，失败的也先暴露出来。
 *
 * 不在本函数里建索引库：那会让启动多一次全量建索引的写入，而用户可能只是想让窗口
 * 赶紧出来。真要建时搜索路径自己会建（`searchGlobalMembers` → `ensureContactFts`）。
 *
 * @param decryptedDir - 已解密数据根。
 * @returns 报告（不抛）。
 */
export declare function prewarmAfterInit(decryptedDir: string): PrewarmReport;
/** 预热是否值得留痕（有内容 or 有异常）。 */
export declare function prewarmIsNotable(r: PrewarmReport): boolean;
