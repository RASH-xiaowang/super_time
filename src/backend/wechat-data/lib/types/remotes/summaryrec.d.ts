import type { EmbedFn } from '../query/vector-math.ts';
import { DailySummaryResult, OperationCategory, OperationStatus, PeriodSummaryResult, ReplySuggestResult, SummaryTaskMutationResult, SummaryTaskRunResult } from '../types.ts';
import type { Context } from '@deepseek-ai/cordis';
import type { PrivacyGateFn } from '../gateway-privacy.ts';
export interface createSummaryRecordRemotesInputs {
    dirs: () => {
        decrypted: string;
        decoded: string;
    };
    op: (category: OperationCategory, action: string, status: OperationStatus, target?: string, detail?: string) => void;
    ctx: () => Context;
    privacyGate: PrivacyGateFn;
    runSummaryTask: (options: {
        id: number;
    }) => Promise<SummaryTaskRunResult>;
    selfUsername: () => string;
    getSchedBusy: () => boolean;
    setSchedBusy: (v: boolean) => void;
    makeEmbedFn: (model: string, feature?: 'ask_embed' | 'kb_embed' | 'kb_link_suggest') => EmbedFn | undefined;
    kbModel: (kbId: number, role: 'embed') => {
        model: string;
    };
}
export declare function createSummaryRecordRemotes(rc: createSummaryRecordRemotesInputs): {
    generateDailySummary(options: {
        date: string;
        provider?: string;
        model?: string;
        format?: string;
    }): Promise<DailySummaryResult>;
    deleteSummaryRecord(options: {
        id: number;
    }): SummaryTaskMutationResult;
    generatePeriodSummary(options: {
        from: string;
        to: string;
        provider?: string;
        model?: string;
        format?: string;
    }): Promise<PeriodSummaryResult>;
    suggestReplies(options: {
        username?: string;
        kbId?: number;
        count?: number;
        /** 分析面板当前选中的消息；缺省时仍按会话最新上下文推荐。 */
        targetLocalId?: number;
        /** 跳过缓存重新生成（界面的「换一批」用它）。 */
        force?: boolean;
    }): Promise<ReplySuggestResult>;
};
