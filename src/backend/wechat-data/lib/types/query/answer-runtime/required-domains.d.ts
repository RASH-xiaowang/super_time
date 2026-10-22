/**
 * 按问题所需的「数据域」判断证据是否缺项，并给出至多一个专用补查工具。
 *
 * 泛化消息/混合检索命中后，模型经常直接结束，导致文件、账单、收藏等
 * 明确数据域一次都没查。这里只做确定性判断，不读库、不执行工具；执行仍由
 * runtime 走同一套 profile 白名单、参数修复、deadline 与重试。
 *
 * @module query/answer-runtime/required-domains
 */
import type { AnswerIntentDecision } from './intent.ts';
import type { EvidenceBundle } from './evidence.ts';
import { type AnswerProfile, type AnswerProfileId } from '../tools/profiles.ts';
import type { ToolName, ToolResult } from '../tools/types.ts';
/** 可被问题独立要求的检索数据域。 */
export type AnswerDataDomain = 'messages' | 'kb' | 'files' | 'favorites' | 'moments' | 'records' | 'contacts';
/** 数据域 → 专用工具。messages/kb 的兜底优先级最低。 */
export declare const DOMAIN_TOOL: Readonly<Record<AnswerDataDomain, ToolName>>;
/**
 * 计算本轮问题必须覆盖的数据域。
 *
 * 明确的资源词优先；意图只负责补上消息/知识库等基础域。profile 会在此处
 * 先裁剪一次，session-ask 不会因为问题里写了「文件」就产生跨边界补查。
 */
export declare function requiredDomainsFor(question: string, intent: AnswerIntentDecision, profile: AnswerProfile | AnswerProfileId, options?: {
    hasKb?: boolean;
    allowedTools?: ReadonlySet<string>;
}): AnswerDataDomain[];
/** 从证据包与原始工具结果统计已覆盖的数据域。 */
export declare function evidenceDomains(evidence: EvidenceBundle, results?: readonly ToolResult[]): Set<AnswerDataDomain>;
/** 返回尚未被证据或工具结果覆盖的必需域（保持必需域原顺序）。 */
export declare function missingDomains(required: readonly AnswerDataDomain[], evidence: EvidenceBundle, results?: readonly ToolResult[]): AnswerDataDomain[];
/** 至多选择一个缺失域及其专用工具；已尝试过的工具不重复补。 */
export declare function supplementCandidate(missing: readonly AnswerDataDomain[], availableTools: ReadonlySet<string>, attemptedTools?: ReadonlySet<string>): {
    domain: AnswerDataDomain;
    tool: ToolName;
} | undefined;
