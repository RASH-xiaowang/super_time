import type { AnswerIntentDecision } from './intent.ts';
import { type AnswerDataDomain } from './required-domains.ts';
import type { EvidenceBundle } from './evidence.ts';
import type { AnswerProfile } from '../tools/profiles.ts';
import type { RetrievalTool, ToolContext, ToolResult } from '../tools/types.ts';
import type { AnswerRuntimeInput, ToolLoopResult } from './types.ts';
interface DomainSupplement {
    loop: ToolLoopResult;
    domain: AnswerDataDomain;
    tool: string;
}
/** 计算缺失域并执行至多一次专用补查；返回 null 表示无需补查。 */
export declare function supplementMissingDomain(input: {
    runtime: AnswerRuntimeInput;
    profile: AnswerProfile;
    tools: readonly RetrievalTool[];
    context: ToolContext;
    intent: AnswerIntentDecision;
    evidence: EvidenceBundle;
    results: readonly ToolResult[];
    traceCount: number;
    roundBase: number;
}): Promise<DomainSupplement | null>;
export {};
