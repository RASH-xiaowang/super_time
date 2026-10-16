/** 一次建索引的结果。 */
export interface EnsureSortIndexResult {
    /** 本次真的建了几条。 */
    created: number;
    /** 扫描过的 `Msg_*` 表数。 */
    tables: number;
    /** 建不出来的表（缺列 / 库读不动 / 被占用），逐条说明。 */
    skipped: Array<{
        table: string;
        reason: string;
    }>;
}
/**
 * 这个分片上**还缺**排序索引的 `Msg_*` 表（只读探测，不写）。
 *
 * 已有索引时它是纯只读的（一条 `sqlite_master` 查询 + 一次表名枚举），
 * 这条路径在**每次**分页前都会走 —— 它必须是廉价且绝不会失败的。
 * @param file - 分片数据库路径。
 * @returns 缺索引的表名；读不动时返回空数组（调用方据此什么都不做）。
 */
export declare function missingSortIndexTables(file: string): string[];
/**
 * 给一个分片补齐排序索引（幂等）。**必须在打开任何只读连接之前调用。**
 * @param file - 分片数据库路径。
 * @returns 建了多少条 / 扫了多少表 / 哪些跳过了。
 */
export declare function ensureSortIndexes(file: string): EnsureSortIndexResult;
/**
 * 读路径上的惰性补齐入口（同步，见文件头为什么不能后台）。
 * @param file - 分片数据库路径。
 * @returns 本次补齐的结果；**已经是最新**时 `created:0 / tables:0`，且全程只读。
 */
export declare function ensureSortIndexIfMissing(file: string): EnsureSortIndexResult;
/** 测试接缝：本模块没有进程内状态，这个函数只为让「无残留」这件事可断言。 */
export declare function sortIndexGateIsEmpty(): boolean;
