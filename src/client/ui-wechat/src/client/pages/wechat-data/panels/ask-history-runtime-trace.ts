/**
 * 把持久化的历史轨迹转换成与实时问答一致的轮次视图。
 *
 * 历史读取到的数据同样是不可信输入：字段可能来自未来版本，也允许人工损坏。
 * 这里复用实时视图的归一化、轮次分组和工具合并规则，但不依赖 React，便于单测。
 */
import type {
  AskHistoryRuntimeTrace,
  AskHistoryToolCall,
} from '@deepseek-ai/dsh-wechat-data/types'
import {
  normalizeAskReasoningSegment,
  traceGroupsOf,
  type AskReasoningSegment,
  type AskTraceGroup,
} from './answer-run-trace.ts'
import {
  mergeStages,
  toolViewsOf,
  type ToolView,
} from './answer-run-view-model.ts'
import {
  normalizeAskStage,
  type AskStage,
} from './ask-stage-merge.ts'
import type { ToolCallTrace } from './ask-result-types.ts'

export interface AskHistoryTraceView {
  groups: AskTraceGroup[]
  tools: ToolView[]
  stages: AskStage[]
  reasoning: AskReasoningSegment[]
  toolCallTotal: number
  truncated: boolean
}

function toolTraceOf(call: AskHistoryToolCall): ToolCallTrace {
  return {
    index: call.index,
    round: call.round,
    callId: call.callId,
    name: call.name,
    argumentsSummary: '',
    ok: call.ok,
    deduplicated: call.deduplicated,
    attempts: call.attempts,
    retries: call.retries,
    elapsedMs: call.elapsedMs,
    hits: call.hits,
    facts: call.facts,
    ...(call.errorClass === undefined ? {} : { errorClass: call.errorClass }),
    ...(call.errorCode === undefined ? {} : { errorCode: call.errorCode }),
    ...(call.skipped === true ? { skipped: true } : {}),
    ...(call.deadlineExceeded === true ? { deadlineExceeded: true } : {}),
  }
}

/**
 * @param trace - 后端返回的有界历史轨迹。
 * @returns 可直接交给 `RunTraceTimeline` 的稳定视图；没有可展示内容时返回 null。
 */
export function askHistoryTraceViewOf(
  trace: AskHistoryRuntimeTrace | undefined,
): AskHistoryTraceView | null {
  if (trace === undefined) return null
  const stageEvents = trace.stages
    .map(normalizeAskStage)
    .filter((stage): stage is AskStage => stage !== null)
  const stages = mergeStages(stageEvents)
  const tools = toolViewsOf(stages, trace.toolCalls.map(toolTraceOf), stageEvents)
  const reasoning = trace.reasoningSegments
    .map(normalizeAskReasoningSegment)
    .filter((segment): segment is AskReasoningSegment => segment !== null)
  const groups = traceGroupsOf({ stages, tools, reasoning })
  if (groups.length === 0) return null
  return {
    groups,
    tools,
    stages,
    reasoning,
    toolCallTotal: Math.max(trace.toolCallTotal, trace.toolCalls.length),
    truncated: trace.truncated || trace.toolCallTotal > trace.toolCalls.length,
  }
}
