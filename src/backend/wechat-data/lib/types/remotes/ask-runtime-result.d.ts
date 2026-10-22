import type { AnswerRuntimeCitation, AnswerRuntimeResult } from '../query/answer-runtime/types.ts';
import type { AnswerStatus, EvidenceBundle, EvidenceLocator } from '../query/answer-runtime/evidence.ts';
import type { ThreadState } from '../query/answer-runtime/thread-state.ts';
import type { AnswerProfileId } from '../query/tools/profiles.ts';
import { type AskDataScope, type AskScope } from './ask-runtime-prompt.ts';
import type { AskCitation, AskResult } from '../types.ts';
/** 与旧引用同形，并把运行时的证据定位信息一并带回（旧客户端会忽略多出来的字段）。 */
export interface AskCitationWithTrace extends AskCitation {
    index: number;
    evidenceId: string;
    locator: EvidenceLocator;
}
/** 生产编排结果：旧字段保持不变，新增字段用于过程解释与反馈归因。 */
export interface AskRuntimeResult extends AskResult {
    status: AnswerStatus;
    evidence?: EvidenceBundle;
    toolCalls?: AnswerRuntimeResultLike['toolCalls'];
    resources?: AnswerRuntimeResultLike['resources'];
    statusReason?: string;
    threadState?: ThreadState;
    /** 本轮实际采用的继承/递进范围（便于诊断为什么查到这些数据）。 */
    appliedThreadState?: {
        session?: string;
        from?: string;
        to?: string;
        reason: string[];
    };
}
type AnswerRuntimeResultLike = AnswerRuntimeResult;
/** 综合生成后的接地快照；用于最终状态降级与审计展示。 */
export interface GroundingSnapshot {
    citedIndexes: number[];
    withheld: boolean;
    grounding?: {
        checked: number;
        unsupported: Array<{
            value: string;
        }>;
    };
    repaired: boolean;
    evidenceUsed?: boolean;
}
export declare function toTraceCitation(citation: AnswerRuntimeCitation): AskCitationWithTrace;
/** 综合阶段按证据顺序重新编号，避免模型看到旧编号造成错配。 */
export declare function reindexCitations(evidence: EvidenceBundle): AnswerRuntimeCitation[];
/** 把运行时结果映射回旧 `AskResult`（新增字段只附加，不改旧字段语义）。 */
export declare function askResultFromRuntime(input: {
    runtime: AnswerRuntimeResult;
    profile: AnswerProfileId;
    dataScope?: AskDataScope;
    scope: AskScope;
    question: string;
    grounded?: GroundingSnapshot;
    threadState?: ThreadState;
}): AskRuntimeResult;
export {};
