/**
 * WechatDataGateway 方法面 · 导出与备份链路的 @Remote 壳（导出 / 备份域）。
 *
 * 与其它 gateway-* 壳共同构成继承链；装饰器标记会落到最派生原型上，
 * 因此协议层枚举到的方法面与拆分前逐名相同（守卫：gateway-remote-surface.spec.ts）。
 */
import type { BackupMutationResult, BackupPreviewSnapshot, BackupSnapshot, ExportResult, ExportHistoryDeleteResult, ExportHistoryQuery, ExportHistorySnapshot, ExportHistoryPruneOptions, BackupRestoreResult } from './types.ts';
import { GatewayMediaOps } from './gateway-media-ops.ts';
export declare abstract class GatewayExportOps extends GatewayMediaOps {
    /**
     * Export a conversation messages to txt/csv/excel/html.
     *
     * M3：本入口改为 `async` 并走**流式**实现 —— 同步版必须「先把整份 xlsx 拼进内存」，
     * 行数一大峰值就与行数成正比；`exportSessionMessagesStreamed` 把 sheet 逐块写进 zip 条目
     * （峰值与行数无关）。契约没变：仍是 `Promise<ExportResult>`，客户端镜像无需改。
     * @param options - username, export format and optional message count.
     * @returns ExportResult: exported file path/count info.
     */
    exportSessionMessages(options: {
        username: string;
        format: string;
        count?: number;
        dir?: string;
        types?: number[];
        richTypes?: string[];
        from?: number;
        to?: number;
        filename?: string;
        zip?: boolean;
        /** 会话显示名，仅用于导出历史的可读说明（不参与导出本身）。 */
        sessionName?: string;
        /** 进度/取消的任务标识（M3）：传了才有 `wechat-export/progress`，也才谈得上「中止」。 */
        jobId?: string;
    }): Promise<ExportResult>;
    /**
     * List local WeChat backups.
     * @returns BackupSnapshot: backup entries (items + total).
     */
    listBackups(): BackupSnapshot;
    /**
     * Preview a backup's contents (bounded file list) before restore.
     * @param options - backup name.
     * @returns BackupPreviewSnapshot: items + total.
     */
    previewBackup(options: {
        name: string;
    }): BackupPreviewSnapshot;
    /**
     * Create a local backup snapshot.
     * @returns BackupMutationResult: ok + backup name, or error.
     */
    createBackup(): Promise<BackupMutationResult>;
    /**
     * Delete one backup by name.
     * @param options - name of the backup to delete.
     * @returns BackupMutationResult: ok, or error on failure.
     */
    deleteBackup(options: {
        name: string;
    }): BackupMutationResult;
    exportAnnualReport(options: {
        year: number;
        format: string;
        dir?: string;
        filename?: string;
        jobId?: string;
    }): Promise<ExportResult>;
    /**
     * Export ALL sessions as a single txt ZIP archive (账号归档).
     * @param options - optional dir/filename（+ 可选的 jobId：订阅 `wechat-export/progress` 进度并允许取消）.
     * @returns ExportResult: written zip path + total messages.
     */
    exportAllSessions(options?: {
        dir?: string;
        filename?: string;
        jobId?: string;
    }): Promise<ExportResult>;
    /**
     * Cancel one running export/backup job (M3).
     *
     * 渲染层点「取消」时调用：这里只唤醒 AbortController，真正的收尾（不留半成品）由
     * query 层在各耗时循环的检查点完成（`throwIfCancelled` + temp+rename）。
     * @param options - jobId the renderer passed to the export call.
     * @returns ok when a running job was aborted; error otherwise.
     */
    cancelExportJob(options: {
        jobId: string;
    }): {
        ok: boolean;
        error?: string;
    };
    /**
     * Poll one export/backup job's latest progress (M3).
     *
     * 为什么除了事件推送还要有这个轮询入口：进度事件要经过「宿主事件 → 渲染层」的中继，
     * 而中继只对白名单事件名生效（见 `ui-app/ui-entry.tsx`）。轮询不依赖中继，是
     * 「进度确实推得出去」的那条兜底路径。
     * @param options - jobId the renderer passed to the export call.
     * @returns 最近一次进度；`found:false` 表示 jobId 未知（如进程重启过）。
     */
    getExportProgress(options: {
        jobId: string;
    }): {
        found: boolean;
        phase: string;
        done: number;
        total: number;
        finished: boolean;
        error?: string;
    };
    /**
     * Export moments (朋友圈) with author + keyword + time filters.
     * @param options - format/username/authorName/q/from/to/dir/filename (+ 可选的 jobId 订阅进度/取消).
     * @returns ExportResult: written file path + count.
     */
    exportMoments(options?: {
        format?: string;
        username?: string;
        authorName?: string;
        q?: string;
        images?: boolean;
        media?: string;
        month?: string;
        mine?: string;
        zip?: boolean;
        from?: number;
        to?: number;
        dir?: string;
        filename?: string;
        jobId?: string;
    }): Promise<ExportResult>;
    /**
     * Export a CSV table.
     * @param options - `kind` (contacts/favorites/records/moments/privacy); `recordsKind`
     *   when kind=records; `dest` = the full target path the user picked in the save dialog
     *   (falls back to `<dataRoot>/exports/` when omitted); `category` narrows kind=contacts
     *   to one category so the file matches what the panel is showing.
     * @returns ExportResult (path + filename + row count).
     */
    exportCsv(options: {
        kind: string;
        recordsKind?: string;
        dest?: string;
        category?: string;
        jobId?: string;
    }): Promise<ExportResult>;
    /**
     * 读取导出历史（供「导出记录」弹窗）。
     * @param options - 搜索 / 种类筛选 / 状态筛选 / 时间范围 / 排序 / 分页。
     * @returns 一页条目 + 命中总数 + 各聚合计数。
     */
    getExportHistory(options?: ExportHistoryQuery): ExportHistorySnapshot;
    /**
     * 删除若干条导出历史记录。
     *
     * `deleteFiles` **默认为 false**：删记录与删文件是两件事，风险差一个量级，
     * 必须由界面显式选择（见 `query/export-history.ts` 的说明）。
     * @param options - ids + 是否连带删除磁盘文件。
     * @returns 删除计数与文件删除失败清单。
     */
    deleteExportHistory(options: {
        ids: number[];
        deleteFiles?: boolean;
    }): ExportHistoryDeleteResult;
    /**
     * 按策略清理导出历史（按天数 / 保留最近 N 条 / 只清失效记录）。
     * @param options - 清理策略；三项都缺省时**什么都不删**（安全闸）。
     * @returns 删除计数与文件删除失败清单。
     */
    pruneExportHistory(options?: ExportHistoryPruneOptions): ExportHistoryDeleteResult;
    createEncryptedBackup(options: {
        password: string;
        jobId?: string;
    }): Promise<BackupMutationResult>;
    restoreBackup(options: {
        name: string;
        password: string;
    }): BackupRestoreResult;
}
