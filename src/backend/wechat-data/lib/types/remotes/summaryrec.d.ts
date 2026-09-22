import { DailySummaryResult, OperationCategory, OperationStatus, PeriodSummaryResult, ReplySuggestResult, SummaryTaskMutationResult, SummaryTaskRunResult } from '../types.ts';
import type { Context } from '@deepseek-ai/cordis';
export interface createSummaryRecordRemotesInputs {
    dirs: () => {
        decrypted: string;
        decoded: string;
    };
    op: (category: OperationCategory, action: string, status: OperationStatus, target?: string, detail?: string) => void;
    ctx: () => Context;
    privacyBlocked: (feature: string, detail?: string) => string | null;
    privacyGate: (feature: string, stats: {
        sessions: number;
        messages: number;
    }, texts: string[]) => {
        ok: true;
        texts: string[];
    } | {
        ok: false;
        error: string;
    };
    runSummaryTask: (options: {
        id: number;
    }) => Promise<SummaryTaskRunResult>;
    selfUsername: () => string;
    getSchedBusy: () => boolean;
    setSchedBusy: (v: boolean) => void;
}
export declare function createSummaryRecordRemotes(rc: createSummaryRecordRemotesInputs): {
    generateDailySummary(options: {
        date: string;
        provider?: string;
        model?: string;
    }): Promise<DailySummaryResult>;
    deleteSummaryRecord(options: {
        id: number;
    }): SummaryTaskMutationResult;
    generatePeriodSummary(options: {
        from: string;
        to: string;
        provider?: string;
        model?: string;
    }): Promise<PeriodSummaryResult>;
    suggestReplies(options: {
        username?: string;
        kbId?: number;
        count?: number;
    }): Promise<ReplySuggestResult>;
};
