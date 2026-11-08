import type { Context } from '@deepseek-ai/cordis';
import type { AnswerReasoningEmitter, AnswerRuntimeEmitStage } from './query/answer-runtime/types.ts';
export declare function makeAskDeltaEmitter(ctx: Context, streamId?: string): ((text: string) => void) | undefined;
export declare function makeAskReasoningEmitter(ctx: Context, streamId?: string): AnswerReasoningEmitter | undefined;
export declare function makeAskStageEmitter(ctx: Context, streamId?: string): AnswerRuntimeEmitStage | undefined;
