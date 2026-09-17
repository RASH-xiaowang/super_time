import type { ExportHistoryDeleteResult, ExportHistoryPruneOptions, ExportHistoryQuery, ExportHistorySnapshot, ExportStatus } from '../types.ts';
/** 记录一次导出。入口都只需给「已经发生的事实」。 */
export interface RecordExportInput {
    kind: string;
    label?: string;
    format?: string;
    path: string;
    /** 未给时从 path 推导。 */
    filename?: string;
    sizeBytes?: number | null;
    rows?: number;
    status: ExportStatus;
    error?: string;
    /** 重新导出所需的原始入参（会被 JSON 序列化）。 */
    params?: unknown;
    ts?: number;
}
/**
 * 追加一条导出历史。best-effort：失败只留痕，绝不抛给调用方。
 * @param decryptedDir - 解密数据根（历史库位于其父目录）。
 * @param input - 本次导出的事实。
 * @returns 新记录 id；写入失败返回 null。
 */
export declare function recordExport(decryptedDir: string, input: RecordExportInput): number | null;
/**
 * 读取导出历史。
 * @param decryptedDir - 解密数据根。
 * @param query - 搜索/筛选/排序/分页条件。
 * @returns 一页条目 + 命中总数 + 各聚合计数。
 */
export declare function listExportHistory(decryptedDir: string, query?: ExportHistoryQuery): ExportHistorySnapshot;
/**
 * 删除若干条历史记录，可选连带删除磁盘文件。
 *
 * **默认不删文件**：删记录是「我不想再看到这条历史」，删文件是「我不要这个导出了」。
 * 两件事风险差一个量级，必须由界面显式选择，不能顺手做掉。
 *
 * @param decryptedDir - 解密数据根。
 * @param ids - 要删除的记录 id。
 * @param deleteFiles - 是否同时删除磁盘上的导出文件。
 * @returns 删除计数与文件删除失败清单。
 */
export declare function deleteExportHistory(decryptedDir: string, ids: readonly number[], deleteFiles?: boolean): ExportHistoryDeleteResult;
/**
 * 按策略清理导出历史。
 *
 * 安全闸：`olderThanDays` 与 `keepLatest` **都为 0/缺省**且未指定 `onlyMissing` 时
 * **什么都不删** —— 防止调用方传一个空对象就把用户的历史清空。
 *
 * @param decryptedDir - 解密数据根。
 * @param opts - 清理策略。
 * @returns 与 `deleteExportHistory` 同形的结果。
 */
export declare function pruneExportHistory(decryptedDir: string, opts?: ExportHistoryPruneOptions): ExportHistoryDeleteResult;
