import { type AnswerStatus, type EvidenceBundle } from './evidence.ts';
import type { AnswerRuntimeCitation, AnswerRuntimeInput, AnswerRuntimeResourceCitation, AnswerRuntimeResult } from './types.ts';
import { type AnswerProfile } from '../tools/profiles.ts';
import type { ToolContext } from '../tools/types.ts';
/** 把三个入口的上下文边界收敛到执行层。 */
export interface ResolvedAnswerContext {
    profile: AnswerProfile;
    context: ToolContext;
    tools: AnswerRuntimeInput['profileTools'];
    blocked?: {
        status: AnswerStatus;
        reason: string;
    };
}
/**
 * 归一 profile 与工具上下文。
 *
 * session-ask 强制当前会话；clawbot-auto 强制关闭本机微信数据并要求 kbId。
 * 返回 blocked 而不是抛错，便于调用方把「缺会话 / 缺知识库」如实展示。
 * @param input - 运行时输入。
 * @returns 归一结果。
 */
export declare function resolveAnswerContext(input: AnswerRuntimeInput): ResolvedAnswerContext;
/** 证据包 → 可点击引用（保持 `AskCitation` 的核心字段）。 */
export declare function citationsFromEvidence(evidence: EvidenceBundle): AnswerRuntimeCitation[];
/** 资源类证据（文件/收藏/朋友圈等）保留独立定位，不伪装成消息引用。 */
export declare function resourcesFromEvidence(evidence: EvidenceBundle): AnswerRuntimeResourceCitation[];
/**
 * 运行一次完整问答。
 *
 * @param input - 见 {@link AnswerRuntimeInput}。
 * @returns 含状态、回答、证据、引用、工具 trace 的结果。
 */
export declare function runAnswerRuntime(input: AnswerRuntimeInput): Promise<AnswerRuntimeResult>;
