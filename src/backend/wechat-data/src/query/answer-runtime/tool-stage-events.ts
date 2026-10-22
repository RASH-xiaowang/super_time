/**
 * 工具阶段事件的发射接缝。
 *
 * 过程展示是旁路能力，任何监听器异常都不能影响问答；同时只发送白名单字段，
 * 避免完整参数或错误正文进入 UI 事件。
 *
 * @module query/answer-runtime/tool-stage-events
 */
import type { ToolErrorClass } from './errors.ts'
import type { AnswerRuntimeEmitStage, AnswerRuntimeStage } from './types.ts'

export interface ToolStageInput {
  key: string
  label: string
  status: AnswerRuntimeStage['status']
  callId: string
  toolName: string
  argumentsSummary: string
  phase: NonNullable<AnswerRuntimeStage['phase']>
  attempt?: number
  maxAttempts?: number
  elapsedMs?: number
  errorClass?: ToolErrorClass
  deadlineExceeded?: boolean
  hits?: number
  facts?: number
  detail?: string
}

/** 发射阶段事件；监听器抛错时静默忽略。 */
export function safeEmit(
  emit: AnswerRuntimeEmitStage | undefined,
  stage: AnswerRuntimeStage,
): void {
  if (!emit) return
  try {
    emit(stage)
  } catch {
    // 过程展示是旁路，不能影响问答。
  }
}

/** 发射普通流水线阶段。 */
export function emitStage(
  emit: AnswerRuntimeEmitStage | undefined,
  key: string,
  label: string,
  status: AnswerRuntimeStage['status'],
  detail?: string,
): void {
  safeEmit(emit, { key, label, status, ...(detail === undefined ? {} : { detail }) })
}

/** 发射工具阶段；只组装结构化白名单字段。 */
export function emitToolStage(
  emit: AnswerRuntimeEmitStage | undefined,
  input: ToolStageInput,
): void {
  safeEmit(emit, {
    key: input.key,
    label: input.label,
    status: input.status,
    phase: input.phase,
    callId: input.callId,
    toolName: input.toolName,
    argumentsSummary: input.argumentsSummary,
    ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
    ...(input.maxAttempts === undefined ? {} : { maxAttempts: input.maxAttempts }),
    ...(input.elapsedMs === undefined ? {} : { elapsedMs: input.elapsedMs }),
    ...(input.errorClass === undefined ? {} : { errorClass: input.errorClass }),
    ...(input.deadlineExceeded === true ? { deadlineExceeded: true } : {}),
    ...(input.hits === undefined ? {} : { hits: input.hits }),
    ...(input.facts === undefined ? {} : { facts: input.facts }),
    ...(input.detail === undefined ? {} : { detail: input.detail }),
  })
}
