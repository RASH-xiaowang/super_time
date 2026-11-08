import type { AnswerReasoningMeta, AnswerReasoningSegment } from '../query/answer-runtime/types.ts';
type EmitReasoning = (text: string, meta?: AnswerReasoningMeta) => void;
export interface AskReasoningCollector {
    readonly segments: AnswerReasoningSegment[];
    onReasoning: EmitReasoning;
    text(): string;
    snapshot(): AnswerReasoningSegment[];
}
/** 把模型增量整理成稳定分段，并让实时事件与最终结果复用同一份快照。 */
export declare function createAskReasoningCollector(emitReasoning?: EmitReasoning): AskReasoningCollector;
export {};
