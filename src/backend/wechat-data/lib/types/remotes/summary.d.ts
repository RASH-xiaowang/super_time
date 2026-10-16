import { OperationCategory, OperationStatus, SummaryTaskInput, SummaryTaskMutationResult, SummaryTaskRunResult, SummaryTaskSnapshot } from '../types.ts';
import type { Context } from '@deepseek-ai/cordis';
import type { PrivacyGateFn } from '../gateway-privacy.ts';
export interface createSummaryRemotesInputs {
    dirs: () => {
        decrypted: string;
        decoded: string;
    };
    op: (category: OperationCategory, action: string, status: OperationStatus, target?: string, detail?: string) => void;
    ctx: () => Context;
    privacyGate: PrivacyGateFn;
}
export declare function createSummaryRemotes(rc: createSummaryRemotesInputs): {
    listSummaryTasks(): SummaryTaskSnapshot;
    saveSummaryTask(options: {
        task: SummaryTaskInput;
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
