/**
 * 工具阶段事件的发射接缝。
 *
 * 过程展示是旁路能力，任何监听器异常都不能影响问答；同时只发送白名单字段，
 * 避免完整参数或错误正文进入 UI 事件。
 *
 * @module query/answer-runtime/tool-stage-events
 */
import type { ToolErrorClass } from './errors.ts';
import type { AnswerRuntimeEmitStage, AnswerRuntimeStage } from './types.ts';
export interface ToolStageInput {
    key: string;
    label: string;
    status: AnswerRuntimeStage['status'];
    callId: string;
    toolName: string;
    argumentsSummary: string;
    phase: NonNullable<AnswerRuntimeStage['phase']>;
    attempt?: number;
    maxAttempts?: number;
    elapsedMs?: number;
    errorClass?: ToolErrorClass;
    deadlineExceeded?: boolean;
    hits?: number;
    facts?: number;
    detail?: string;
}
/** 发射阶段事件；监听器抛错时静默忽略。 */
export declare function safeEmit(emit: AnswerRuntimeEmitStage | undefined, stage: AnswerRuntimeStage): void;
/** 发射普通流水线阶段。 */
export declare function emitStage(emit: AnswerRuntimeEmitStage | undefined, key: string, label: string, status: AnswerRuntimeStage['status'], detail?: string): void;
/** 发射工具阶段；只组装结构化白名单字段。 */
export declare function emitToolStage(emit: AnswerRuntimeEmitStage | undefined, input: ToolStageInput): void;
