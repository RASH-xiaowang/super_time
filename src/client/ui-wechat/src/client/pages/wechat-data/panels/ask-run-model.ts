/**
 * 问答运行视图的纯模型：把流式阶段、最终状态与耗时收敛成一套展示语义。
 *
 * 这里是「生命周期」和「结果状态」的唯一解释层。React 组件只消费它，避免
 * Ask / SessionAsk 各自推断状态文案。生命周期表示系统此刻在做什么，结果状态
 * 表示这一轮最终成不成立；二者不能互相覆盖（例如 degraded 仍然是 completed）。
 *
 * @module panels/ask-run-model
 */
import {
  appendAskStage,
  toolStages,
  type AskStage,
} from './ask-stage-merge.ts'

/** 本轮此刻处于哪个生命周期阶段。 */
export type AskRunPhase =
  | 'queued'
  | 'thinking'
  | 'tool_calling'
  | 'preparing'
  | 'generating'
  | 'verifying'
  | 'completed'
  | 'stopped'
  | 'failed'

/** 本轮最终结果。与生命周期分开，避免把「降级完成」显示成失败。 */
export type AskRunOutcome =
  | 'ok'
  | 'degraded'
  | 'insufficient'
  | 'needs_clarification'
  | 'blocked'
  | 'stopped'
  | 'failed'
  | 'unknown'

/** 单个思考/工具/流水线/核对节点的展示状态。 */
export type AskNodeStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'warning'
  | 'error'
  | 'timeout'
  | 'skipped'
  | 'aborted'

export type AskRunTone = 'neutral' | 'active' | 'success' | 'warning' | 'danger'

/** 一轮问答可展示的真实耗时；缺失字段保持 undefined，不补零。 */
export interface AskRunMetrics {
  startedAt: number
  completedAt?: number
  totalMs?: number
  firstTokenMs?: number
  reasoningMs?: number
  toolMs?: number
}

/** 客户端流式事件记录到的时间点；缺失字段保持缺失。 */
export interface AskRunTiming {
  startedAt: number
  firstTokenAt?: number
  firstReasoningAt?: number
  reasoningEndedAt?: number
  /**
   * 已结算的思考时长累计（毫秒）。
   *
   * 一次问答会跨多轮模型调用：每轮先思考、再调工具。只记「首次思考 → 最后
   * 一次思考」的墙钟跨度会把工具执行和等待时间也算成思考（实测 72s 的一轮被
   * 写成「思考 53s」）。这里按区间累计：工具开始或正文到达即结算一段。
   */
  reasoningMs?: number
  /** 当前尚未结算的思考区间起点；undefined = 不在思考中。 */
  reasoningOpenAt?: number
}

const PHASE_LABEL: Readonly<Record<AskRunPhase, string>> = {
  queued: '已提交',
  thinking: '思考中',
  tool_calling: '调用工具',
  preparing: '准备回答',
  generating: '生成回答',
  verifying: '核对结果',
  completed: '已完成',
  stopped: '已停止',
  failed: '执行异常',
}

const OUTCOME_LABEL: Readonly<Record<AskRunOutcome, string>> = {
  ok: '已完成',
  degraded: '已完成 · 已降级',
  insufficient: '证据不足',
  needs_clarification: '需要澄清',
  blocked: '已阻止',
  stopped: '已停止',
  failed: '执行失败',
  unknown: '状态未知',
}

const OUTCOME_TONE: Readonly<Record<AskRunOutcome, AskRunTone>> = {
  ok: 'success',
  degraded: 'warning',
  insufficient: 'warning',
  needs_clarification: 'warning',
  blocked: 'danger',
  stopped: 'neutral',
  failed: 'danger',
  unknown: 'warning',
}

const VALID_OUTCOMES = new Set<AskRunOutcome>([
  'ok',
  'degraded',
  'insufficient',
  'needs_clarification',
  'blocked',
  'stopped',
  'failed',
  'unknown',
])

/** 是否是后端已知的结果状态；未知值不能被静默当成成功。 */
export function isAskRunOutcome(value: unknown): value is AskRunOutcome {
  return typeof value === 'string' && VALID_OUTCOMES.has(value as AskRunOutcome)
}

/** 生命周期 → 中文短标签。 */
export function askRunPhaseLabel(phase: AskRunPhase): string {
  return PHASE_LABEL[phase]
}

/** 最终结果 → 中文短标签。 */
export function askRunOutcomeLabel(outcome: AskRunOutcome): string {
  return OUTCOME_LABEL[outcome]
}

/** 最终结果 → 视觉 tone。 */
export function askRunOutcomeTone(outcome: AskRunOutcome): AskRunTone {
  return OUTCOME_TONE[outcome]
}

/**
 * 把后端六态与前端兜底字段收敛成统一 outcome。
 *
 * 优先级刻意如此：用户停止优先体现为 stopped；未知/缺省状态才根据 withheld /
 * insufficient 推断。这样旧后端仍能显示准确语义，新后端也不会被旧布尔字段覆盖。
 */
export function resolveAskRunOutcome(input: {
  status?: string
  stopped?: boolean
  withheld?: boolean
  insufficient?: boolean
  hasAnswer?: boolean
}): AskRunOutcome {
  if (input.stopped === true) return 'stopped'
  if (isAskRunOutcome(input.status)) return input.status
  if (input.withheld === true || input.insufficient === true) return 'insufficient'
  if (typeof input.status === 'string' && input.status.trim() !== '') return 'unknown'
  return input.hasAnswer === true ? 'ok' : 'unknown'
}

function isVerificationStage(stage: AskStage): boolean {
  const text = `${stage.key} ${stage.label}`.toLowerCase()
  return /核对|校验|接地|verify|ground/.test(text)
}

/** 综合生成阶段：模型正在把工具结果写成正文，不能继续显示「思考中」。 */
function isSynthesisStage(stage: AskStage): boolean {
  return stage.key === 'answer:synthesize'
    || stage.key === 'answer:synthesis'
    || stage.label === '综合生成'
}

/** 找出正在运行的阶段；工具卡优先于普通流水线。 */
export function runningAskStage(stages: readonly AskStage[] | undefined): AskStage | undefined {
  const list = stages ?? []
  return [...list].reverse().find(stage => stage.status === 'running')
}

/**
 * 流式阶段 → 生命周期。
 *
 * 文本已经出现时优先显示 generating，即使迟到的工具 running 事件刚到也不能把
 * 界面倒回「调用工具」。核对阶段优先于生成，因为它是用户最后看到的真实动作。
 */
export function deriveLiveAskPhase(input: {
  text?: string
  reasoning?: string
  stages?: AskStage[]
}): AskRunPhase {
  const stages = input.stages ?? []
  const running = runningAskStage(stages)
  if (running !== undefined && isVerificationStage(running)) return 'verifying'
  if ((input.text ?? '').trim() !== '') return 'generating'
  if (running !== undefined && isSynthesisStage(running)) return 'preparing'
  if (running !== undefined && (running.toolName !== undefined || running.callId !== undefined)) {
    return 'tool_calling'
  }
  if (running !== undefined) {
    return isVerificationStage(running) ? 'verifying' : 'thinking'
  }
  if ((input.reasoning ?? '').trim() !== '') return 'thinking'
  if (toolStages(stages).length > 0 || stages.some(isVerificationStage)) return 'preparing'
  return 'queued'
}

/** 已完成轮次的生命周期（与 outcome 分开）。 */
export function completedAskRunPhase(outcome: AskRunOutcome): AskRunPhase {
  if (outcome === 'stopped') return 'stopped'
  if (outcome === 'failed') return 'failed'
  return 'completed'
}

/** 统一识别超时信号，兼容 deadlineExceeded、errorClass 与 ETIMEDOUT。 */
export function isAskTimeoutSignal(input: {
  deadlineExceeded?: boolean
  errorClass?: string
  errorCode?: string
}): boolean {
  if (input.deadlineExceeded === true) return true
  const text = `${input.errorClass ?? ''} ${input.errorCode ?? ''}`
  return /timeout|timed.?out|deadline|etimedout/i.test(text)
}

/** 阶段节点的稳定展示状态。 */
export function askNodeStatusOf(stage: AskStage): AskNodeStatus {
  if (stage.status === 'skipped') return 'skipped'
  // done 是权威终态。后端即使复用了同一条 stage 并留下上一轮尝试的
  // errorClass/deadlineExceeded，也不能把最终成功的节点重绘成超时。
  if (stage.status === 'done') return 'success'
  // retry 事件同样是 running，但它是“正在重试”而不是上一尝试的超时终态。
  if (stage.status === 'running') return 'running'
  if (isAskTimeoutSignal(stage)) return 'timeout'
  if (stage.status === 'failed') return 'error'
  return 'success'
}

/** 工具总数、失败数与累计耗时。 */
export function askToolStats(stages: readonly AskStage[] | undefined): {
  total: number
  failed: number
  elapsedMs?: number
} {
  // 后端快照保留每次 called/retry/terminal 事件；统计必须先按 callId 收敛，
  // 否则重试会让工具数、耗时和异常数被重复累计。
  const merged = (stages ?? []).reduce<AskStage[]>(
    (out, stage) => appendAskStage(out, stage),
    [],
  )
  const tools = toolStages(merged)
  let elapsedMs = 0
  let hasElapsed = false
  for (const stage of tools) {
    if (stage.elapsedMs === undefined || !Number.isFinite(stage.elapsedMs)) continue
    elapsedMs += Math.max(0, stage.elapsedMs)
    hasElapsed = true
  }
  return {
    total: tools.length,
    failed: tools.filter(stage => stage.status === 'failed' || isAskTimeoutSignal(stage)).length,
    ...(hasElapsed ? { elapsedMs } : {}),
  }
}

/**
 * 本轮真实耗时。后端总耗时优先；旧后端才回退客户端墙钟时间。
 * 缺失的思考/首字/工具耗时保持 undefined，不补成 0。
 */
export function buildAskRunMetrics(
  timing: AskRunTiming,
  completedAt: number,
  stages: readonly AskStage[],
  serverDurationMs?: number,
): AskRunMetrics {
  const startedAt = timing.startedAt > 0 ? timing.startedAt : completedAt
  const wallMs = timing.startedAt > 0 ? Math.max(0, completedAt - startedAt) : undefined
  const totalMs = typeof serverDurationMs === 'number' && Number.isFinite(serverDurationMs) && serverDurationMs >= 0
    ? Math.round(serverDurationMs)
    : wallMs
  const firstTokenMs = timing.firstTokenAt === undefined
    ? undefined
    : Math.max(0, timing.firstTokenAt - startedAt)
  // 优先用按区间累计的思考时长：它排除了工具执行与轮间等待。
  // 未结算的区间（运行中/刚好完成）按 completedAt 收口；旧数据没有累计值
  // 时才退回「首次思考 → 结束」的跨度，保持向后兼容。
  const reasoningEndedAt = timing.reasoningEndedAt ?? completedAt
  const reasoningMs = timing.firstReasoningAt === undefined
    ? undefined
    : timing.reasoningMs !== undefined
      ? Math.max(0, timing.reasoningMs + (timing.reasoningOpenAt === undefined ? 0 : completedAt - timing.reasoningOpenAt))
      : Math.max(0, reasoningEndedAt - timing.firstReasoningAt)
  const tool = askToolStats(stages)
  return {
    startedAt,
    completedAt,
    ...(totalMs === undefined ? {} : { totalMs }),
    ...(firstTokenMs === undefined ? {} : { firstTokenMs }),
    ...(reasoningMs === undefined ? {} : { reasoningMs }),
    ...(tool.elapsedMs === undefined ? {} : { toolMs: tool.elapsedMs }),
  }
}

/**
 * 紧凑耗时。
 *
 * 10 秒以内保留一位小数，之后取整；不足一秒显示 ms，避免把 0.1s 写成伪精度。
 */
export function formatAskRunDuration(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return undefined
  if (ms < 1000) return `${String(Math.round(ms))}ms`
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`
  return `${String(Math.round(ms / 1000))}s`
}

/** 运行中的计时文案统一带一位小数，完成后沿用紧凑格式。 */
export function formatLiveAskDuration(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return undefined
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`
  return `${String(Math.round(ms / 1000))}s`
}
