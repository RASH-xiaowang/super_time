/**
 * `ask_history.runtime_trace` 的有界归一化。
 *
 * 历史轨迹只在本机保存，用于回看一次问答的工具轮次、分段思考与核对阶段。
 * 它不是审计日志，也不是完整的模型上下文：参数、工具结果正文和错误正文都不落库。
 *
 * 所有上限同时应用在写入与读取两侧。旧版本写入的 JSON、手工破坏的数据或未来
 * 版本多出来的字段，都只能收敛成这里定义的稳定形状；读取失败由调用方降级为
 * “没有轨迹”，不能影响问题、回答与引用等主字段。
 *
 * @module query/ask-history-trace
 */
import type {
  AskHistoryRuntimeTrace,
  AskHistoryToolCall,
} from '../types.ts'
import type {
  AnswerReasoningSegment,
  AnswerRuntimeStage,
} from './answer-runtime/types.ts'

const MAX_REASONING_SEGMENTS = 24
const MAX_REASONING_CHARS = 8_000
const MAX_REASONING_TOTAL_CHARS = 24_000
const MAX_STAGES = 120
const MAX_STAGE_DETAIL_CHARS = 800
const MAX_TOOL_CALLS = 24
const MAX_TRACE_JSON = 64_000

const STAGE_STATUSES = new Set<AnswerRuntimeStage['status']>([
  'running',
  'done',
  'failed',
  'skipped',
])
const TOOL_PHASES = new Set<NonNullable<AnswerRuntimeStage['phase']>>([
  'called',
  'completed',
  'failed',
  'retry',
])

/** 写入侧可提供的轨迹来源；除旧式 `reasoning` 外都与运行结果同形。 */
export interface AskHistoryTraceInput {
  reasoning?: unknown
  reasoningSegments?: unknown
  stages?: unknown
  toolCalls?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function clean(value: unknown, max: number): string {
  const raw = text(value).trim()
  return raw.length > max ? raw.slice(0, max) : raw
}

function rawText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function nonNegativeInt(value: unknown): number | undefined {
  const n = finite(value)
  return n === undefined ? undefined : Math.max(0, Math.floor(n))
}

function positiveInt(value: unknown): number | undefined {
  const n = nonNegativeInt(value)
  return n === undefined || n <= 0 ? undefined : n
}

function optionalText(value: unknown, max: number): string | undefined {
  const out = clean(value, max)
  return out === '' ? undefined : out
}

function reasoningSegmentOf(
  value: unknown,
  fallbackIndex: number,
): AnswerReasoningSegment | null {
  if (!isRecord(value)) return null
  const segmentText = rawText(value['segmentText'])
  const segment = segmentText.trim() === '' ? rawText(value['text']) : segmentText
  if (segment.trim() === '') return null
  const round = positiveInt(value['round'])
  const phase = value['phase'] === 'tool_selection' || value['phase'] === 'synthesis'
    ? value['phase']
    : round === undefined ? 'synthesis' : 'tool_selection'
  const fallbackKey = round === undefined
    ? `reasoning:${phase}:${String(fallbackIndex)}`
    : `reasoning:tool:${String(round)}:${String(fallbackIndex)}`
  const key = clean(value['key'] ?? value['segmentId'], 200) || fallbackKey
  const version = nonNegativeInt(value['version'])
  const seq = nonNegativeInt(value['seq'])
  return {
    key,
    phase,
    text: segment.length > MAX_REASONING_CHARS ? segment.slice(0, MAX_REASONING_CHARS) : segment,
    seq: seq ?? fallbackIndex + 1,
    ...(round === undefined ? {} : { round }),
    ...(version === undefined ? {} : { version }),
  }
}

function reasoningSegmentsOf(
  input: AskHistoryTraceInput,
): { segments: AnswerReasoningSegment[]; truncated: boolean } {
  const raw = Array.isArray(input.reasoningSegments) ? input.reasoningSegments : []
  let truncated = raw.length > MAX_REASONING_SEGMENTS
  const segments: AnswerReasoningSegment[] = []
  let totalChars = 0
  for (const value of raw) {
    if (segments.length >= MAX_REASONING_SEGMENTS) break
    const segment = reasoningSegmentOf(value, segments.length)
    if (segment === null) continue
    const remaining = MAX_REASONING_TOTAL_CHARS - totalChars
    if (remaining <= 0) {
      truncated = true
      break
    }
    const kept = segment.text.length > remaining ? segment.text.slice(0, remaining) : segment.text
    if (kept.length !== segment.text.length) truncated = true
    if (kept.trim() === '') continue
    segments.push({ ...segment, text: kept })
    totalChars += kept.length
  }
  if (segments.length > 0) return { segments, truncated }
  const legacy = rawText(input.reasoning)
  if (legacy.trim() === '') return { segments, truncated }
  const kept = legacy.slice(0, Math.min(MAX_REASONING_CHARS, MAX_REASONING_TOTAL_CHARS))
  return {
    segments: [{
      key: 'reasoning:legacy',
      phase: 'synthesis',
      text: kept,
      seq: 1,
    }],
    truncated: truncated || kept.length !== legacy.length,
  }
}

function stageOf(value: unknown): AnswerRuntimeStage | null {
  if (!isRecord(value)) return null
  const key = clean(value['key'], 180)
  const label = clean(value['label'], 240)
  const status = value['status']
  if (key === '' || label === '' || !STAGE_STATUSES.has(status as AnswerRuntimeStage['status'])) {
    return null
  }
  const detail = clean(value['detail'], MAX_STAGE_DETAIL_CHARS)
  const round = positiveInt(value['round'])
  const phase = TOOL_PHASES.has(value['phase'] as NonNullable<AnswerRuntimeStage['phase']>)
    ? value['phase'] as NonNullable<AnswerRuntimeStage['phase']>
    : undefined
  const callId = optionalText(value['callId'], 240)
  const toolName = optionalText(value['toolName'], 120)
  const attempt = positiveInt(value['attempt'])
  const maxAttempts = positiveInt(value['maxAttempts'])
  const elapsedMs = nonNegativeInt(value['elapsedMs'])
  const errorClass = optionalText(value['errorClass'], 80)
  const hits = nonNegativeInt(value['hits'])
  const facts = nonNegativeInt(value['facts'])
  return {
    key,
    label,
    status: status as AnswerRuntimeStage['status'],
    ...(detail === '' ? {} : { detail }),
    ...(round === undefined ? {} : { round }),
    ...(phase === undefined ? {} : { phase }),
    ...(callId === undefined ? {} : { callId }),
    ...(toolName === undefined ? {} : { toolName }),
    // argumentsSummary 是唯一明确拒绝的 stage 字段：参数可能含整段聊天或文件正文。
    ...(attempt === undefined ? {} : { attempt }),
    ...(maxAttempts === undefined ? {} : { maxAttempts }),
    ...(elapsedMs === undefined ? {} : { elapsedMs }),
    ...(errorClass === undefined ? {} : { errorClass: errorClass as AnswerRuntimeStage['errorClass'] }),
    ...(value['deadlineExceeded'] === true ? { deadlineExceeded: true } : {}),
    ...(hits === undefined ? {} : { hits }),
    ...(facts === undefined ? {} : { facts }),
  }
}

function stagesOf(input: AskHistoryTraceInput): {
  stages: AnswerRuntimeStage[]
  truncated: boolean
} {
  const raw = Array.isArray(input.stages) ? input.stages : []
  const stages: AnswerRuntimeStage[] = []
  for (const value of raw) {
    if (stages.length >= MAX_STAGES) break
    const stage = stageOf(value)
    if (stage !== null) stages.push(stage)
  }
  return { stages, truncated: raw.length > stages.length && raw.length > MAX_STAGES }
}

function toolCallOf(value: unknown): AskHistoryToolCall | null {
  if (!isRecord(value)) return null
  const name = clean(value['name'], 120)
  if (name === '') return null
  return {
    index: nonNegativeInt(value['index']) ?? 0,
    round: positiveInt(value['round']) ?? 0,
    callId: clean(value['callId'], 240),
    name,
    ok: value['ok'] === true,
    deduplicated: value['deduplicated'] === true,
    attempts: nonNegativeInt(value['attempts']) ?? 0,
    retries: nonNegativeInt(value['retries']) ?? 0,
    elapsedMs: nonNegativeInt(value['elapsedMs']) ?? 0,
    ...(optionalText(value['errorClass'], 80) === undefined
      ? {}
      : { errorClass: optionalText(value['errorClass'], 80) }),
    ...(optionalText(value['errorCode'], 120) === undefined
      ? {}
      : { errorCode: optionalText(value['errorCode'], 120) }),
    hits: nonNegativeInt(value['hits']) ?? 0,
    facts: nonNegativeInt(value['facts']) ?? 0,
    ...(value['skipped'] === true ? { skipped: true } : {}),
    ...(value['deadlineExceeded'] === true ? { deadlineExceeded: true } : {}),
  }
}

function toolCallsOf(input: AskHistoryTraceInput): {
  calls: AskHistoryToolCall[]
  total: number
  truncated: boolean
} {
  const raw = Array.isArray(input.toolCalls) ? input.toolCalls : []
  const calls: AskHistoryToolCall[] = []
  for (const value of raw) {
    if (calls.length >= MAX_TOOL_CALLS) break
    const call = toolCallOf(value)
    if (call !== null) calls.push(call)
  }
  return { calls, total: raw.length, truncated: raw.length > calls.length }
}

function jsonLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? Number.POSITIVE_INFINITY
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

/**
 * 逐级缩小轨迹直到 JSON 预算内。
 *
 * 优先删尾部阶段的详情，再删尾部阶段与工具摘要；只要还有思考，就至少保留第一段。
 * 阶段来自实际事件顺序，尾部通常是最不关键的收尾信息。
 */
function fitBudget(trace: AskHistoryRuntimeTrace): AskHistoryRuntimeTrace {
  if (jsonLength(trace) <= MAX_TRACE_JSON) return trace
  const next: AskHistoryRuntimeTrace = {
    ...trace,
    reasoningSegments: trace.reasoningSegments.slice(),
    stages: trace.stages.slice(),
    toolCalls: trace.toolCalls.slice(),
    truncated: true,
  }
  while (jsonLength(next) > MAX_TRACE_JSON) {
    let changed = false
    for (let index = next.stages.length - 1; index >= 0; index -= 1) {
      const stage = next.stages[index]
      if (stage !== undefined && stage.detail !== undefined) {
        const copy = { ...stage }
        delete copy.detail
        next.stages[index] = copy
        changed = true
        break
      }
    }
    if (changed) continue
    if (next.stages.length > 0) {
      next.stages.pop()
      continue
    }
    if (next.toolCalls.length > 0) {
      next.toolCalls.pop()
      continue
    }
    if (next.reasoningSegments.length > 1) {
      next.reasoningSegments.pop()
      continue
    }
    const first = next.reasoningSegments[0]
    if (first !== undefined && first.text.length > 1) {
      next.reasoningSegments[0] = {
        ...first,
        text: first.text.slice(0, Math.floor(first.text.length / 2)),
      }
      continue
    }
    break
  }
  return next
}

/**
 * 把运行结果或已落库 JSON 收敛成稳定的有界轨迹。
 * @param input - 运行结果字段或读取出的旧轨迹对象。
 * @returns 可展示轨迹；没有任何思考/阶段/工具时返回 undefined。
 */
export function normalizeHistoryRuntimeTrace(
  input: AskHistoryTraceInput | Record<string, unknown> | null | undefined,
): AskHistoryRuntimeTrace | undefined {
  if (!isRecord(input)) return undefined
  const reasoning = reasoningSegmentsOf(input)
  const stages = stagesOf(input)
  const tools = toolCallsOf(input)
  const storedTruncated = input['truncated'] === true
  const storedToolCallTotal = nonNegativeInt(input['toolCallTotal']) ?? 0
  const toolCallTotal = Math.max(tools.total, tools.calls.length, storedToolCallTotal)
  if (
    reasoning.segments.length === 0
    && stages.stages.length === 0
    && tools.calls.length === 0
  ) {
    return undefined
  }
  return fitBudget({
    version: 1,
    reasoningSegments: reasoning.segments,
    stages: stages.stages,
    toolCalls: tools.calls,
    toolCallTotal,
    truncated: storedTruncated
      || reasoning.truncated
      || stages.truncated
      || tools.truncated
      || toolCallTotal > tools.calls.length,
  })
}
