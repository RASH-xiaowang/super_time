import type { AnswerRuntimeInput, AnswerRuntimeStage } from './types.ts';
/** 过程展示是旁路；监听器异常不能中断问答主链路。 */
export declare function emitAnswerStage(input: AnswerRuntimeInput, key: string, label: string, status: AnswerRuntimeStage['status'], detail?: string, round?: number): void;
