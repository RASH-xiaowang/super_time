import { StreamControl } from '../query/zip.ts';
import { ExportHistoryDeleteResult, ExportHistoryPruneOptions, ExportHistoryQuery, ExportHistorySnapshot, ExportResult, ExportStatus, OperationCategory, OperationStatus } from '../types.ts';
import type { StreamJob } from '../gateway.ts';
import type { Context } from '@deepseek-ai/cordis';
/** 处理器需要的宿主能力（由 `WechatDataGateway` 组装；getter 形式保证读到最新目录）。 */
export interface ExportRemoteCtx {
    /** jobId 归一（网关与这里都要用；留在网关按函数传进来）。 */
    normalizeJobId: (jobId?: unknown) => string;
    dirs: () => {
        decrypted: string;
        decoded: string;
    };
    ctx: () => Context;
    op: (category: OperationCategory, action: string, status: OperationStatus, target?: string, detail?: string) => void;
    recordExport: (input: {
        kind: string;
        label?: string;
        format?: string;
        path: string;
        rows?: number;
        status: ExportStatus;
        error?: string;
        params?: unknown;
    }) => void;
    streamControl: (jobId?: string) => StreamControl;
    finishStreamJob: (jobId: string, error?: string) => void;
    streamJobs: Map<string, StreamJob>;
}
export declare function createExportRemotes(rc: ExportRemoteCtx): {
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
    }): Promise<ExportResult>;
    exportAnnualReport(options: {
        year: number;
        format: string;
        dir?: string;
        filename?: string;
    }): ExportResult;
    exportAllSessions(options?: {
        dir?: string;
        filename?: string;
        jobId?: string;
    }): Promise<ExportResult>;
    cancelExportJob(options: {
        jobId: string;
    }): {
        ok: boolean;
        error?: string;
    };
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
    exportCsv(options: {
        kind: string;
        recordsKind?: string;
        dest?: string;
        category?: string;
    }): ExportResult;
    getExportHistory(options?: ExportHistoryQuery): ExportHistorySnapshot;
    deleteExportHistory(options: {
        ids: number[];
        deleteFiles?: boolean;
    }): ExportHistoryDeleteResult;
    pruneExportHistory(options?: ExportHistoryPruneOptions): ExportHistoryDeleteResult;
};
