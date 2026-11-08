import {
  appendAskStage,
  askToolLabel,
  askToolStatusLabel,
  toolStages,
  type AskStage,
} from './ask-stage-merge.ts'
import {
  askNodeStatusOf,
  askRunOutcomeLabel,
  askRunPhaseLabel,
  formatAskRunDuration,
  isAskTimeoutSignal,
  runningAskStage,
  type AskNodeStatus,
  type AskRunOutcome,
  type AskRunPhase,
} from './ask-run-model.ts'
import type {
  EvidenceBundle,
  EvidenceItem,
  ToolCallTrace,
} from './use-ask.ts'

export type IconKind =
  | 'queued'
  | 'thinking'
  | 'tool'
  | 'generating'
  | 'verifying'
  | 'success'
  | 'warning'
  | 'danger'
  | 'stopped'

export interface ToolView {
  key: string
  name: string
  stage?: AskStage
  trace?: ToolCallTrace
  /** 后端阶段快照中的原始事件，用于还原每次尝试而不是只留合并摘要。 */
  stageEvents: AskStage[]
}

export interface EvidenceRow {
  key: string
  source: string
  name: string
  username?: string
  enterpriseName?: string
  time: string
  sender?: string
  senderEnterpriseName?: string
  snippet: string
  tools: string[]
  truncated: boolean
}

const SOURCE_LABEL: Readonly<Record<string, string>> = {
  msg: '消息',
  kb: '知识库',
  agg: '统计事实',
  resource: '资源',
}

export function uniqueText(values: readonly (string | undefined)[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const text = (value ?? '').trim()
    if (text === '' || seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out
}

export function formatToolResultDetail(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

export function mergeStages(stages: readonly AskStage[] | undefined): AskStage[] {
  return (stages ?? []).reduce<AskStage[]>((out, stage) => appendAskStage(out, stage), [])
}

export function durationBetween(startedAt: number, completedAt: number | undefined): number | undefined {
  if (startedAt <= 0 || completedAt === undefined || completedAt < startedAt) return undefined
  return completedAt - startedAt
}

export function iconKindForPhase(phase: AskRunPhase): IconKind {
  if (phase === 'thinking') return 'thinking'
  if (phase === 'tool_calling') return 'tool'
  if (phase === 'generating') return 'generating'
  if (phase === 'verifying') return 'verifying'
  if (phase === 'completed') return 'success'
  if (phase === 'stopped') return 'stopped'
  if (phase === 'failed') return 'danger'
  return 'queued'
}

export function iconKindForOutcome(outcome: AskRunOutcome): IconKind {
  if (outcome === 'ok') return 'success'
  if (outcome === 'failed' || outcome === 'blocked') return 'danger'
  if (outcome === 'stopped') return 'stopped'
  if (outcome === 'unknown') return 'warning'
  return 'warning'
}

export function statusTitle(input: {
  streaming: boolean
  phase: AskRunPhase
  outcome: AskRunOutcome
  stages: readonly AskStage[]
}): string {
  if (!input.streaming) return askRunOutcomeLabel(input.outcome)
  const running = runningAskStage(input.stages)
  if (input.phase === 'tool_calling' && running !== undefined) {
    return `${askRunPhaseLabel(input.phase)} · ${askToolLabel(running)}`
  }
  return askRunPhaseLabel(input.phase)
}

export function processSummary(input: {
  tools: readonly ToolView[]
  thinking: string
  thinkingDuration?: number
  evidence: readonly EvidenceRow[]
  hasPlan: boolean
  streaming: boolean
}): string {
  const failed = input.tools.filter(tool => {
    const status = toolStatus(tool, !input.streaming)
    return status === 'error' || status === 'timeout'
  }).length
  const thinkingDuration = formatAskRunDuration(input.thinkingDuration)
  const parts = [
    input.tools.length > 0 ? `${String(input.tools.length)} 个工具` : '',
    input.thinking !== ''
      ? thinkingDuration !== undefined ? `思考 ${thinkingDuration}` : '思考记录'
      : '',
  ].filter(Boolean)
  if (parts.length === 0 && input.evidence.length > 0) {
    parts.push(`${String(input.evidence.length)} 条证据`)
  }
  if (parts.length === 0 && input.hasPlan) parts.push('检索规划')
  if (failed > 0) parts.push(`${String(failed)} 项异常`)
  return parts.length > 0 ? parts.join(' · ') : '暂无过程记录'
}

export function toolStatus(tool: ToolView, closed: boolean): AskNodeStatus {
  const trace = tool.trace
  if (trace !== undefined) {
    if (trace.skipped === true) return 'skipped'
    // 成功 trace 是最终事实。先于 error/deadline 判断，避免旧阶段或兼容字段
    // 把已经成功的重试重新标成超时/失败。
    if (trace.ok === true) return 'success'
    if (isAskTimeoutSignal(trace)) return 'timeout'
    if (trace.ok === false) return 'error'
  }
  if (tool.stage !== undefined) return nodeStatusOf(tool.stage, closed)
  return trace === undefined ? 'pending' : 'success'
}

export function nodeStatusLabel(status: AskNodeStatus): string {
  if (status === 'running') return '进行中'
  if (status === 'success') return '完成'
  if (status === 'warning') return '需注意'
  if (status === 'error') return '失败'
  if (status === 'timeout') return '超时'
  if (status === 'skipped') return '已跳过'
  if (status === 'aborted') return '已中止'
  return '待执行'
}

export function toolStatusLabel(tool: ToolView, closed: boolean): string {
  const status = toolStatus(tool, closed)
  if (status === 'running' && tool.stage !== undefined) return askToolStatusLabel(tool.stage)
  return nodeStatusLabel(status)
}

export function nodeStatusOf(stage: AskStage, closed: boolean): AskNodeStatus {
  const status = askNodeStatusOf(stage)
  return closed && status === 'running' ? 'aborted' : status
}

export function toolViewStats(tools: readonly ToolView[], closed: boolean): {
  total: number
  failed: number
  elapsedMs?: number
} {
  let elapsedMs = 0
  let hasElapsed = false
  let failed = 0
  for (const tool of tools) {
    const status = toolStatus(tool, closed)
    if (status === 'error' || status === 'timeout') failed += 1
    const elapsed = tool.stage?.elapsedMs ?? tool.trace?.elapsedMs
    if (elapsed === undefined || !Number.isFinite(elapsed)) continue
    elapsedMs += Math.max(0, elapsed)
    hasElapsed = true
  }
  return {
    total: tools.length,
    failed,
    ...(hasElapsed ? { elapsedMs } : {}),
  }
}

export function toolViewsOf(
  stages: readonly AskStage[],
  traces: readonly ToolCallTrace[],
  stageEvents: readonly AskStage[],
): ToolView[] {
  const views: ToolView[] = toolStages(stages).map((stage, index) => ({
    key: stage.callId !== undefined ? `call:${stage.callId}` : `stage:${stage.key}:${String(index)}`,
    name: askToolLabel(stage),
    stage,
    stageEvents: [],
  }))
  const findView = (stage: AskStage): ToolView | undefined => {
    if (stage.callId !== undefined && stage.callId !== '') {
      return views.find(view => view.stage?.callId === stage.callId)
    }
    return views.find(view => view.stage?.key === stage.key)
  }
  for (const event of stageEvents) {
    if (event.toolName === undefined && event.callId === undefined) continue
    const matched = findView(event)
    if (matched !== undefined) matched.stageEvents.push(event)
  }
  for (const view of views) {
    if (view.stageEvents.length === 0 && view.stage !== undefined) {
      view.stageEvents.push(view.stage)
    }
  }
  traces.forEach((trace, index) => {
    const matched = trace.callId === ''
      ? undefined
      : views.find(view => view.stage?.callId === trace.callId)
    if (matched !== undefined) {
      matched.trace = trace
      return
    }
    views.push({
      key: trace.callId !== '' ? `trace:${trace.callId}` : `trace:${String(index)}`,
      name: askToolLabel({ toolName: trace.name, label: trace.name }),
      trace,
      stageEvents: [],
    })
  })
  return views
}

export function evidenceRowsOf(evidence: EvidenceBundle | undefined): EvidenceRow[] {
  const rows: EvidenceRow[] = []
  const seenFacts = new Set<string>()
  const items = Array.isArray(evidence?.items)
    ? evidence.items.filter((item): item is EvidenceItem => Boolean(item) && typeof item === 'object')
    : []
  items.filter(item => item.source !== 'resource').forEach((item, index) => {
    if (item.kind === 'fact') seenFacts.add(`${item.name}\u0000${item.snippet}`)
    const username = item.source !== 'kb' && item.locator.type === 'message' ? item.locator.username : ''
    rows.push({
      key: item.evidenceId || `evidence:${String(index)}`,
      source: SOURCE_LABEL[item.source] ?? item.source ?? '证据',
      name: item.name || '未命名来源',
      ...(username ? { username } : {}),
      ...(item.enterpriseName ? { enterpriseName: item.enterpriseName } : {}),
      time: item.time || '',
      ...(item.sender ? { sender: item.sender } : {}),
      ...(item.senderEnterpriseName ? { senderEnterpriseName: item.senderEnterpriseName } : {}),
      snippet: item.snippet || '',
      tools: Array.isArray(item.tools) ? item.tools : (item.tool ? [item.tool] : []),
      truncated: item.truncated === true,
    })
  })
  const facts = Array.isArray(evidence?.facts) ? evidence.facts : []
  facts.forEach((fact, index) => {
    const identity = `${fact.title}\u0000${fact.body}`
    if (seenFacts.has(identity)) return
    seenFacts.add(identity)
    rows.push({
      key: `fact:${String(index)}:${fact.title}`,
      source: '统计事实',
      name: fact.title || `事实 ${String(index + 1)}`,
      time: '',
      snippet: fact.body || '',
      tools: [],
      truncated: false,
    })
  })
  return rows
}

export function stageEventStatus(event: AskStage): AskNodeStatus {
  const status = askNodeStatusOf(event)
  if (status !== 'running') return status
  return event.phase === 'retry' || (event.attempt ?? 0) > 1 ? 'running' : status
}

export function stageEventStatusLabel(event: AskStage): string {
  const status = stageEventStatus(event)
  return status === 'running' ? askToolStatusLabel(event) : nodeStatusLabel(status)
}
