import { OperationCategory, OperationStatus, SummaryTask, SummaryTaskMutationResult, SummaryTaskRunResult, SummaryTaskSnapshot } from '../types.ts';
import type { Context } from '@deepseek-ai/cordis';
export interface createSummaryRemotesInputs {
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
}
export declare function createSummaryRemotes(rc: createSummaryRemotesInputs): {
    listSummaryTasks(): SummaryTaskSnapshot;
    saveSummaryTask(options: {
        task: Omit<SummaryTask, "id" | "createdAt" | "updatedAt"> & {
            id?: number;
        };
    }): SummaryTaskMutationResult;
    deleteSummaryTask(options: {
        id: number;
    }): SummaryTaskMutationResult;
    toggleSummaryTask(options: {
        id: number;
        enabled: boolean;
    }): SummaryTaskMutationResult;
    runSummaryTask(options: {
        id: number;
    }): Promise<SummaryTaskRunResult>;
};
