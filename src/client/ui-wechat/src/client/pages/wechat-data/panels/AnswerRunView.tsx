/**
 * Shared answer-run view for WeChat Q&A and session-level AI Q&A.
 *
 * Information order is intentional: a compact live/final status is always
 * visible, followed by the full reasoning/tool/evidence trace and then the
 * formal answer. The trace can default open while there is no answer yet, but
 * it collapses once generation starts so it cannot bury the formal response.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  appendAskStage,
  askToolLabel,
  askToolStatusLabel,
  formatStageElapsed,
  toolStages,
  type AskStage,
} from './ask-stage-merge.ts'
import {
  askNodeStatusOf,
  askRunOutcomeLabel,
  askRunOutcomeTone,
  askRunPhaseLabel,
  completedAskRunPhase,
  deriveLiveAskPhase,
  formatAskRunDuration,
  formatLiveAskDuration,
  isAskTimeoutSignal,
  resolveAskRunOutcome,
  runningAskStage,
  type AskNodeStatus,
  type AskRunOutcome,
  type AskRunPhase,
} from './ask-run-model.ts'
import { AnswerBody } from './AnswerBody.tsx'
import { ThinkingSection } from './AnswerRunThinking.tsx'
import { withEnterprise } from './enterprise-identity.ts'
import { IdentityName } from './identity.tsx'
import type {
  AskGrounding,
  AskTurn,
  EvidenceBundle,
  EvidenceItem,
  ToolCallTrace,
} from './use-ask.ts'
import css from './answer-run.module.css'
import processCss from './answer-run-process.module.css'

const EVIDENCE_PREVIEW = 6

export interface AnswerRunViewProps {
  /** Completed or failed assistant turn. Omit for the live pending turn. */
  turn?: AskTurn
  /** Compact assistant identity shown above the run status. */
  agentLabel?: string
  text?: string
  reasoning?: string
  stages?: AskStage[]
  streaming?: boolean
  runStartedAt?: number
  /** Stable client run identity used to preserve manual fold choice after completion. */
  runId?: string
  processOpen?: boolean
  onProcessOpenChange?: (open: boolean) => void
  citations?: AskTurn['citations']
  onOpenCite?: (n: number) => void
  activeCite?: number
  onStop?: () => void
  onRetry?: () => void
  retryDisabled?: boolean
  /** Optional prebuilt plan/retrieval nodes; rendered inside the process trace. */
  planNode?: ReactNode
  retrievalNode?: ReactNode
}

/**
 * Preserve a user's fold choice while the same run moves from the live view to
 * the completed thread entry. Historical turns without a runId remain local.
 */
export function useAnswerRunProcessState(): (
  runId: string | undefined,
) => Pick<AnswerRunViewProps, 'processOpen' | 'onProcessOpenChange'> {
  const [openByRun, setOpenByRun] = useState<Record<string, boolean>>({})
  return useCallback((runId) => {
    if (runId === undefined || runId === '') return {}
    return {
      ...(openByRun[runId] !== undefined ? { processOpen: openByRun[runId] } : {}),
      onProcessOpenChange: (open: boolean) => {
        setOpenByRun(current => ({ ...current, [runId]: open }))
      },
    }
  }, [openByRun])
}

type IconKind =
  | 'queued'
  | 'thinking'
  | 'tool'
  | 'generating'
  | 'verifying'
  | 'success'
  | 'warning'
  | 'danger'
  | 'stopped'

interface ToolView {
  key: string
  name: string
  stage?: AskStage
  trace?: ToolCallTrace
  /** 后端阶段快照中的原始事件，用于还原每次尝试而不是只留合并摘要。 */
  stageEvents: AskStage[]
}

interface EvidenceRow {
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

function uniqueText(values: readonly (string | undefined)[]): string[] {
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

function formatToolResultDetail(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

function PipelineStageDetail({ text }: { text: string }): React.JSX.Element {
  if (text.length <= 480 && text.split('\n').length <= 8) {
    return <div className={processCss.toolBody}>{text}</div>
  }
  return (
    <details className={processCss.stageDetails}>
      <summary>查看完整步骤说明（{String(text.length)} 字）</summary>
      <div className={processCss.stageDetailText}>{text}</div>
    </details>
  )
}

function mergeStages(stages: readonly AskStage[] | undefined): AskStage[] {
  return (stages ?? []).reduce<AskStage[]>((out, stage) => appendAskStage(out, stage), [])
}

function durationBetween(startedAt: number, completedAt: number | undefined): number | undefined {
  if (startedAt <= 0 || completedAt === undefined || completedAt < startedAt) return undefined
  return completedAt - startedAt
}

function iconKindForPhase(phase: AskRunPhase): IconKind {
  if (phase === 'thinking') return 'thinking'
  if (phase === 'tool_calling') return 'tool'
  if (phase === 'generating') return 'generating'
  if (phase === 'verifying') return 'verifying'
  if (phase === 'completed') return 'success'
  if (phase === 'stopped') return 'stopped'
  if (phase === 'failed') return 'danger'
  return 'queued'
}

function iconKindForOutcome(outcome: AskRunOutcome): IconKind {
  if (outcome === 'ok') return 'success'
  if (outcome === 'failed' || outcome === 'blocked') return 'danger'
  if (outcome === 'stopped') return 'stopped'
  if (outcome === 'unknown') return 'warning'
  return 'warning'
}

function StatusIcon({ kind }: { kind: IconKind }): React.JSX.Element {
  const common = {
    viewBox: '0 0 24 24',
    width: 14,
    height: 14,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  }
  if (kind === 'success') {
    return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="m8 12 2.7 2.7L16.5 9" /></svg>
  }
  if (kind === 'danger') {
    return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="m9 9 6 6M15 9l-6 6" /></svg>
  }
  if (kind === 'warning') {
    return <svg {...common}><path d="M10.3 3.8 2.9 17a2 2 0 0 0 1.7 3h14.8a2 2 0 0 0 1.7-3L13.7 3.8a2 2 0 0 0-3.4 0Z" /><path d="M12 8v5M12 17h.01" /></svg>
  }
  if (kind === 'tool') {
    return <svg {...common}><path d="M14.7 6.3a4 4 0 0 0-5 5L4 17l3 3 5.7-5.7a4 4 0 0 0 5-5l-2.4 2.4-2.8-.2-.2-2.8 2.4-2.4Z" /></svg>
  }
  if (kind === 'generating') {
    return <svg {...common}><path d="m4 20 4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L4 20Z" /><path d="m13.8 7.5 3 3" /></svg>
  }
  if (kind === 'verifying') {
    return <svg {...common}><path d="M12 3 5 6v5c0 4.6 2.8 8.1 7 10 4.2-1.9 7-5.4 7-10V6l-7-3Z" /><path d="m9 12 2 2 4-4" /></svg>
  }
  if (kind === 'thinking') {
    return <svg {...common}><path d="M8 18h8M9 21h6" /><path d="M8.5 14.5A6 6 0 1 1 15.5 14.5c-.9.7-1.5 1.4-1.5 2.5h-4c0-1.1-.6-1.8-1.5-2.5Z" /></svg>
  }
  if (kind === 'stopped') {
    return <svg {...common}><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
  }
  return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
}

function statusTitle(input: {
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

function processSummary(input: {
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
    input.thinking !== ''
      ? thinkingDuration !== undefined ? `思考 ${thinkingDuration}` : '思考记录'
      : '',
    input.tools.length > 0 ? `${String(input.tools.length)} 个工具` : '',
  ].filter(Boolean)
  if (parts.length === 0 && input.evidence.length > 0) {
    parts.push(`${String(input.evidence.length)} 条证据`)
  }
  if (parts.length === 0 && input.hasPlan) parts.push('检索规划')
  if (failed > 0) parts.push(`${String(failed)} 项异常`)
  return parts.length > 0 ? parts.join(' · ') : '暂无过程记录'
}

function toolStatus(tool: ToolView, closed: boolean): AskNodeStatus {
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

function nodeStatusLabel(status: AskNodeStatus): string {
  if (status === 'running') return '进行中'
  if (status === 'success') return '完成'
  if (status === 'warning') return '需注意'
  if (status === 'error') return '失败'
  if (status === 'timeout') return '超时'
  if (status === 'skipped') return '已跳过'
  if (status === 'aborted') return '已中止'
  return '待执行'
}

function toolStatusLabel(tool: ToolView, closed: boolean): string {
  const status = toolStatus(tool, closed)
  if (status === 'running' && tool.stage !== undefined) return askToolStatusLabel(tool.stage)
  return nodeStatusLabel(status)
}

function nodeStatusOf(stage: AskStage, closed: boolean): AskNodeStatus {
  const status = askNodeStatusOf(stage)
  return closed && status === 'running' ? 'aborted' : status
}

function toolViewStats(tools: readonly ToolView[], closed: boolean): {
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

function toolViewsOf(
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

function evidenceRowsOf(evidence: EvidenceBundle | undefined): EvidenceRow[] {
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

function stageEventStatus(event: AskStage): AskNodeStatus {
  const status = askNodeStatusOf(event)
  if (status !== 'running') return status
  return event.phase === 'retry' || (event.attempt ?? 0) > 1 ? 'running' : status
}

function stageEventStatusLabel(event: AskStage): string {
  const status = stageEventStatus(event)
  return status === 'running' ? askToolStatusLabel(event) : nodeStatusLabel(status)
}

function StageAttemptHistory({ tool }: { tool: ToolView }): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  if (tool.stageEvents.length < 2) return null
  return (
    <div className={processCss.attempts}>
      <button
        type="button"
        className={processCss.attemptToggle}
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => { setOpen(value => !value) }}
      >
        {open ? '收起尝试记录' : `查看尝试记录（${String(tool.stageEvents.length)} 条）`}
      </button>
      {open && (
        <ol id={bodyId} className={processCss.attemptList}>
          {tool.stageEvents.map((event, index) => {
            const attempt = event.attempt !== undefined && event.attempt > 0
              ? `第 ${String(event.attempt)} 次`
              : '调用'
            const elapsed = formatStageElapsed(event.elapsedMs)
            const result = uniqueText([
              event.detail,
              event.hits !== undefined ? `命中 ${String(event.hits)} 条` : undefined,
              event.facts !== undefined && event.facts > 0 ? `事实 ${String(event.facts)} 条` : undefined,
            ])
            const diagnostics = uniqueText([
              event.errorClass,
              event.deadlineExceeded === true ? 'deadline' : undefined,
            ]).join(' · ')
            return (
              <li
                key={`${tool.key}:attempt:${String(index)}`}
                className={processCss.attemptItem}
                data-status={stageEventStatus(event)}
              >
                <div className={processCss.attemptHead}>
                  <span className={processCss.attemptTitle}>{attempt}</span>
                  <span className={processCss.attemptStatus}>{stageEventStatusLabel(event)}</span>
                  {elapsed !== undefined && (
                    <span className={processCss.attemptMeta}>累计 {elapsed}</span>
                  )}
                </div>
                {result.map((line, lineIndex) => (
                  <div key={`${tool.key}:attempt:${String(index)}:result:${String(lineIndex)}`}>
                    {line}
                  </div>
                ))}
                {diagnostics !== '' && (
                  <div className={processCss.attemptDiagnostic}>诊断：{diagnostics}</div>
                )}
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}

function ToolCard({ tool, closed }: { tool: ToolView; closed: boolean }): React.JSX.Element {
  const [manualOpen, setManualOpen] = useState<boolean | null>(null)
  const issueSeen = useRef(false)
  const bodyId = useId()
  const status = toolStatus(tool, closed)
  const stage = tool.stage
  const trace = tool.trace
  const elapsed = stage?.elapsedMs ?? trace?.elapsedMs
  const hits = stage?.hits ?? trace?.hits
  const facts = stage?.facts ?? trace?.facts
  const args = stage?.argumentsSummary ?? trace?.argumentsSummary ?? ''
  const elapsedText = formatStageElapsed(elapsed)
  const resultSummary = status === 'success'
    ? trace?.resultSummary ?? stage?.detail ?? ''
    : ''
  const resultDetail = trace?.resultDetail ?? ''
  const inlineMeta = [
    elapsedText !== undefined ? `耗时 ${elapsedText}` : '',
    hits !== undefined ? `命中 ${String(hits)}` : '',
    facts !== undefined && facts > 0 ? `事实 ${String(facts)}` : '',
  ].filter(Boolean)
  const detailMeta = [
    trace !== undefined ? `第 ${String(trace.round)} 轮` : '',
    stage?.attempt !== undefined
      ? stage.maxAttempts !== undefined && stage.maxAttempts > 0
        ? `尝试 ${String(stage.attempt)}/${String(stage.maxAttempts)}`
        : `尝试 ${String(stage.attempt)} 次`
      : trace !== undefined && trace.attempts > 1 ? `尝试 ${String(trace.attempts)} 次` : '',
    trace !== undefined && trace.retries > 0 ? `重试 ${String(trace.retries)} 次` : '',
    trace?.deduplicated === true ? '复用缓存' : '',
  ].filter(Boolean)
  const details = uniqueText([resultSummary, trace?.note])
  const errorMessage = uniqueText([trace?.errorMessage])
  const diagnostics = uniqueText([stage?.errorClass, trace?.errorCode, trace?.errorClass]).join(' · ')
  const showError = status === 'error' || status === 'timeout' || errorMessage.length > 0
  const hasIssue = status === 'warning' || status === 'timeout' || status === 'error'
  const autoOpen = status === 'running'
    || status === 'warning'
    || status === 'timeout'
    || status === 'error'
  useEffect(() => {
    if (hasIssue && !issueSeen.current) setManualOpen(true)
    issueSeen.current = hasIssue
  }, [hasIssue])
  const open = manualOpen ?? autoOpen
  return (
    <li className={processCss.toolItem} data-status={status}>
      <button
        type="button"
        className={processCss.toolHead}
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => { setManualOpen(value => !(value ?? autoOpen)) }}
        title={open ? `收起「${tool.name}」调用详情` : `展开「${tool.name}」调用详情`}
      >
        <span className={processCss.toolName}>{tool.name}</span>
        <span className={processCss.toolStatus}>{toolStatusLabel(tool, closed)}</span>
        {inlineMeta.length > 0 && (
          <span className={processCss.toolInlineMeta}>{inlineMeta.join(' · ')}</span>
        )}
        <svg className={processCss.toolChevron} viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m9 6 6 6-6 6" />
        </svg>
      </button>
      {open && (
        <div id={bodyId} className={processCss.toolBody}>
          {detailMeta.length > 0 && (
            <div className={processCss.toolMeta}>{detailMeta.join(' · ')}</div>
          )}
          <div>
            <span className={processCss.fieldLabel}>调用参数</span>
            <span className={processCss.toolArgs}>{args || '未提供参数摘要'}</span>
          </div>
          <div>
            <span className={processCss.fieldLabel}>结果摘要</span>
            {details.length > 0
              ? details.map((detail, index) => (
                <div key={`${tool.key}:detail:${String(index)}`} className={processCss.toolResult}>{detail}</div>
              ))
              : <div className={processCss.toolResult}>
                {status === 'running'
                  ? '等待工具返回…'
                  : status === 'aborted'
                    ? '本轮已结束，调用未返回最终结果'
                  : status === 'skipped'
                    ? '本次调用已跳过'
                    : status === 'error' || status === 'timeout'
                      ? '调用失败，错误详情见下方'
                      : '工具已返回，未提供额外摘要'}
              </div>}
            {resultSummary === '' && hits !== undefined && (
              <div className={processCss.toolResult}>命中 {String(hits)} 条</div>
            )}
            {resultSummary === '' && facts !== undefined && facts > 0 && (
              <div className={processCss.toolResult}>生成事实 {String(facts)} 条</div>
            )}
          </div>
          {resultDetail !== '' && (
            <details className={processCss.resultDetails}>
              <summary>
                {trace?.resultTruncated === true
                  ? '查看结构化结果（已按条数或长度截断）'
                  : '查看结构化结果'}
              </summary>
              <pre>{formatToolResultDetail(resultDetail)}</pre>
            </details>
          )}
          <StageAttemptHistory tool={tool} />
          {showError && (
            <div
              className={processCss.toolError}
              data-status={status}
              role="group"
              aria-label="工具错误详情"
            >
              <span className={processCss.fieldLabel}>错误详情</span>
              {errorMessage.map((message, index) => (
                <div key={`${tool.key}:error:${String(index)}`}>{message}</div>
              ))}
              {diagnostics !== '' && <div className={processCss.toolErrorMeta}>诊断：{diagnostics}</div>}
            </div>
          )}
        </div>
      )}
    </li>
  )
}

function EvidenceSection({ rows, grounding }: {
  rows: readonly EvidenceRow[]
  grounding?: AskGrounding
}): React.JSX.Element | null {
  const [showAll, setShowAll] = useState(false)
  const listId = useId()
  if (rows.length === 0) return null
  const shown = showAll ? rows : rows.slice(0, EVIDENCE_PREVIEW)
  const checked = grounding?.checked ?? 0
  const cited = grounding?.cited ?? 0
  const unsupported = Array.isArray(grounding?.unsupported) ? grounding.unsupported : []
  return (
    <section className={processCss.section} data-status={unsupported.length > 0 ? 'warning' : undefined}>
      <div className={processCss.sectionHead}>
        <span className={processCss.sectionTitle}>证据记录</span>
        <span className={processCss.sectionSummary}>
          {[
            `${String(rows.length)} 条`,
            checked > 0 ? `核对 ${String(checked)} 项` : '',
            cited > 0 ? `引用 ${String(cited)} 条` : '',
            grounding?.repaired === true ? '已自动修订' : '',
            unsupported.length > 0 ? `${String(unsupported.length)} 项未找到原文` : '',
          ].filter(Boolean).join(' · ')}
        </span>
      </div>
      <div className={processCss.sectionBody}>
        <ul id={listId} className={processCss.evidenceList}>
          {shown.map(row => (
            <li key={row.key} className={processCss.evidenceItem}>
              <div className={processCss.evidenceHead}>
                {row.username
                  ? (
                      <IdentityName className={processCss.evidenceName} name={row.name} username={row.username} size={18}>
                        {row.source} · {withEnterprise(row.name, row.enterpriseName)}
                      </IdentityName>
                    )
                  : (
                      <span className={processCss.evidenceName}>
                        {row.source} · {withEnterprise(row.name, row.enterpriseName)}
                      </span>
                    )}
                {row.time && <span className={processCss.evidenceTime}>{row.time}</span>}
              </div>
              {row.sender && (
                <div className={processCss.toolMeta}>
                  {withEnterprise(row.sender, row.senderEnterpriseName)}
                </div>
              )}
              <div
                className={processCss.evidenceSnippet}
                data-clamp={!showAll && row.snippet.length > 240 ? true : undefined}
                title={row.snippet || undefined}
              >
                {row.snippet || '无摘要'}
              </div>
              <div className={processCss.toolMeta}>
                {[
                  row.tools.length > 0 ? row.tools.map(tool => askToolLabel({ toolName: tool, label: tool })).join(' / ') : '',
                  row.truncated ? '后端摘要已截断' : '',
                ].filter(Boolean).join(' · ')}
              </div>
            </li>
          ))}
        </ul>
        {rows.length > EVIDENCE_PREVIEW && (
          <button
            type="button"
            className={css.moreButton}
            onClick={() => { setShowAll(value => !value) }}
            aria-expanded={showAll}
            aria-controls={listId}
          >
            {showAll ? '收起多余证据' : `显示全部 ${String(rows.length)} 条证据`}
          </button>
        )}
        {unsupported.length > 0 && (
          <div className={`${css.notice} ${css.noticeWarn}`}>
            <StatusIcon kind="warning" />
            <span>
              <span className={processCss.fieldLabel}>未在原文找到</span>
              {unsupported.join('、')}
            </span>
          </div>
        )}
      </div>
    </section>
  )
}

function ProcessInspector(input: {
  answerText: string
  streaming: boolean
  stages: readonly AskStage[]
  tools: readonly ToolView[]
  thinking: string
  evidence: readonly EvidenceRow[]
  grounding?: AskGrounding
  outcome: AskRunOutcome
  synthesisError?: string
  metrics: readonly string[]
  thinkingDuration?: number
  planNode?: ReactNode
  retrievalNode?: ReactNode
  processOpen?: boolean
  onProcessOpenChange?: (open: boolean) => void
}): React.JSX.Element | null {
  const [manualOpen, setManualOpen] = useState<boolean | null>(null)
  const issueSeen = useRef(false)
  const bodyId = useId()
  const pipeline = input.stages.filter(stage => stage.toolName === undefined && stage.callId === undefined)
  const toolIssue = input.tools.some(tool => {
    const status = toolStatus(tool, !input.streaming)
    return status === 'error' || status === 'timeout'
  })
  const pipelineIssue = pipeline.some(stage => {
    const status = nodeStatusOf(stage, !input.streaming)
    return status === 'error' || status === 'timeout'
  })
  const hardFailure = input.outcome === 'failed' || input.outcome === 'blocked'
  const hasIssue = hardFailure || toolIssue || pipelineIssue || input.synthesisError !== undefined
  const hasPlan = input.planNode !== undefined || input.retrievalNode !== undefined
  const exists = input.thinking !== ''
    || pipeline.length > 0
    || input.tools.length > 0
    || input.evidence.length > 0
    || hasPlan
    || input.metrics.length > 0
  useEffect(() => {
    if (hasIssue && !issueSeen.current) setManualOpen(true)
    issueSeen.current = hasIssue
  }, [hasIssue])
  if (!exists) return null
  const autoOpen = hasIssue || (input.streaming && input.answerText.trim() === '')
  const open = manualOpen ?? input.processOpen ?? autoOpen
  const summary = processSummary({
    tools: input.tools,
    thinking: input.thinking,
    ...(input.thinkingDuration !== undefined ? { thinkingDuration: input.thinkingDuration } : {}),
    evidence: input.evidence,
    hasPlan,
    streaming: input.streaming,
  })
  return (
    <section
      className={css.process}
      data-active={open || undefined}
      data-streaming={input.streaming || undefined}
    >
      <button
        type="button"
        className={css.processHead}
        onClick={() => {
          const next = !open
          setManualOpen(next)
          input.onProcessOpenChange?.(next)
        }}
        title={open ? '收起思考与执行过程' : '展开思考与执行过程'}
        aria-expanded={open}
        aria-controls={bodyId}
      >
        <svg className={css.processChevron} viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
        <span className={css.processTitle}>思考与执行过程</span>
        <span className={css.processMeta}>{summary}</span>
      </button>
      <div
        id={bodyId}
        className={css.processBody}
        hidden={!open}
      >
        {input.metrics.length > 0 && (
          <div className={processCss.metricsRow} aria-label="本轮运行指标">
            {input.metrics.map(item => (
              <span key={item}>{item}</span>
            ))}
          </div>
        )}
        {input.thinking !== '' && (
          <ThinkingSection
            text={input.thinking}
            live={input.streaming && input.answerText.trim() === ''}
            {...(input.thinkingDuration !== undefined ? { duration: input.thinkingDuration } : {})}
          />
        )}
        {(input.planNode !== undefined || input.retrievalNode !== undefined) && (
          <section className={processCss.section}>
            <div className={processCss.sectionHead}>
              <span className={processCss.sectionTitle}>检索规划与召回</span>
            </div>
            <div className={processCss.sectionBody}>
              {input.planNode}
              {input.retrievalNode}
            </div>
          </section>
        )}
        {pipeline.length > 0 && (
          <section className={processCss.section}>
            <div className={processCss.sectionHead}>
              <span className={processCss.sectionTitle}>执行步骤</span>
              <span className={processCss.sectionSummary}>{String(pipeline.length)} 个阶段</span>
            </div>
            <ol className={processCss.toolList}>
              {pipeline.map(stage => {
                const status = nodeStatusOf(stage, !input.streaming)
                return (
                  <li key={stage.key} className={processCss.toolItem} data-status={status}>
                    <div className={processCss.toolHead}>
                      <span className={processCss.toolName}>{stage.label}</span>
                      <span className={processCss.toolStatus}>{nodeStatusLabel(status)}</span>
                    </div>
                    {stage.detail !== undefined && (
                      <PipelineStageDetail text={stage.detail} />
                    )}
                  </li>
                )
              })}
            </ol>
          </section>
        )}
        {input.tools.length > 0 && (
          <section className={processCss.section}>
            <div className={processCss.sectionHead}>
              <span className={processCss.sectionTitle}>工具调用</span>
              <span className={processCss.sectionSummary}>{String(input.tools.length)} 个工具</span>
            </div>
            <ol className={processCss.toolList}>
              {input.tools.map(tool => (
                <ToolCard key={tool.key} tool={tool} closed={!input.streaming} />
              ))}
            </ol>
          </section>
        )}
        <EvidenceSection rows={input.evidence} {...(input.grounding ? { grounding: input.grounding } : {})} />
      </div>
    </section>
  )
}

function RunNotices({ outcome, reason, withheld, synthesisError, grounding, errorCode, onRetry, retryDisabled }: {
  outcome: AskRunOutcome
  reason?: string
  withheld: boolean
  synthesisError?: string
  grounding?: AskGrounding
  errorCode?: string
  onRetry?: () => void
  retryDisabled?: boolean
}): React.JSX.Element | null {
  const unsupported = Array.isArray(grounding?.unsupported) ? grounding.unsupported : []
  const notices = uniqueText([
    outcome !== 'ok' ? reason : undefined,
    withheld ? 'AI 回答未通过原文核对，因此未予采用。' : undefined,
    synthesisError !== undefined ? `回答生成异常：${synthesisError}` : undefined,
    unsupported.length > 0 ? `${String(unsupported.length)} 个数值未在原文中找到。` : undefined,
  ])
  const danger = outcome === 'failed' || outcome === 'blocked'
  const showRetry = outcome === 'failed' && onRetry !== undefined
  if (notices.length === 0 && !showRetry && errorCode === undefined) return null
  return (
    <div className={css.notices} role={danger ? 'alert' : undefined}>
      {notices.map((notice, index) => (
        <div
          key={`${String(index)}:${notice}`}
          className={`${css.notice} ${danger ? css.noticeDanger : css.noticeWarn}`}
        >
          <StatusIcon kind={danger ? 'danger' : 'warning'} />
          <span>{notice}</span>
        </div>
      ))}
      {(showRetry || errorCode !== undefined) && (
        <div className={processCss.toolMeta}>
          {showRetry && (
            <button
              type="button"
              className={css.retryBtn}
              onClick={onRetry}
              disabled={retryDisabled === true}
              title={retryDisabled === true ? '当前回答仍在生成，请完成或停止后再重试' : '重新执行这一轮'}
            >
              重试这一轮
            </button>
          )}
          {errorCode !== undefined && <span>错误码：{errorCode}</span>}
        </div>
      )}
    </div>
  )
}

/**
 * Render a live or completed answer run with a consistent status/process/answer order.
 */
export function AnswerRunView(props: AnswerRunViewProps): React.JSX.Element {
  const streaming = props.streaming === true
  const turn = props.turn
  const text = turn?.text ?? props.text ?? ''
  const thinking = (turn?.reasoning ?? props.reasoning ?? '').trim()
  const sourceStages = turn?.stages ?? props.stages ?? []
  const stages = useMemo(
    () => mergeStages(sourceStages),
    [sourceStages],
  )
  const hasAnswer = text.trim() !== ''
  const outcome = resolveAskRunOutcome({
    ...(turn?.status !== undefined ? { status: turn.status } : {}),
    stopped: turn?.stopped === true,
    withheld: turn?.withheld === true,
    insufficient: turn?.insufficient === true,
    hasAnswer,
  })
  const phase = streaming
    ? deriveLiveAskPhase({ text, reasoning: thinking, stages })
    : completedAskRunPhase(outcome)
  const toolViews = toolViewsOf(stages, turn?.toolCalls ?? [], sourceStages)
  const evidence = evidenceRowsOf(turn?.evidence)
  const toolStats = toolViewStats(toolViews, !streaming)
  const [mountedAt] = useState(() => Date.now())
  const [now, setNow] = useState(() => Date.now())
  const [reasoningStartedAt, setReasoningStartedAt] = useState<number | null>(null)
  const startedAt = props.runStartedAt !== undefined && props.runStartedAt > 0
    ? props.runStartedAt
    : mountedAt
  useEffect(() => {
    if (!streaming) return
    setNow(Date.now())
    const timer = window.setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { window.clearInterval(timer) }
  }, [streaming])
  useEffect(() => {
    if (!streaming) {
      setReasoningStartedAt(null)
      return
    }
    if (thinking !== '' && reasoningStartedAt === null) {
      const started = Date.now()
      setReasoningStartedAt(started)
      setNow(started)
    }
  }, [reasoningStartedAt, streaming, thinking])
  const totalMs = turn?.metrics?.totalMs
    ?? (turn?.metrics !== undefined
      ? durationBetween(turn.metrics.startedAt, turn.metrics.completedAt)
      : undefined)
  const liveElapsed = streaming ? Math.max(0, now - startedAt) : undefined
  const statusMeta = [
    streaming
      ? `已用 ${formatLiveAskDuration(liveElapsed) ?? '—'}`
      : totalMs !== undefined ? `总耗时 ${formatAskRunDuration(totalMs) ?? '—'}` : '',
    toolStats.failed > 0 ? `${String(toolStats.failed)} 个异常` : '',
  ].filter(Boolean)
  const processMetrics = [
    turn?.metrics?.firstTokenMs !== undefined
      ? `首字 ${formatAskRunDuration(turn.metrics.firstTokenMs) ?? '—'}`
      : '',
    (turn?.metrics?.toolMs ?? toolStats.elapsedMs) !== undefined
      ? `工具耗时 ${formatAskRunDuration(turn?.metrics?.toolMs ?? toolStats.elapsedMs) ?? '—'}`
      : '',
  ].filter(Boolean)
  const liveThinkingMs = streaming && reasoningStartedAt !== null
    ? Math.max(0, now - reasoningStartedAt)
    : undefined
  const phaseFailure = !streaming && (outcome === 'failed' || outcome === 'blocked')
  const planNode = props.planNode
  const retrievalNode = props.retrievalNode
  const runId = turn?.runId ?? props.runId
  return (
    <div
      className={css.run}
      data-answer-run=""
      data-run-id={runId || undefined}
      data-phase={phase}
      data-outcome={!streaming ? outcome : undefined}
      data-live={streaming || undefined}
    >
      <div className={css.runHead}>
        <span className={css.agentMark} data-live={streaming || undefined} aria-hidden="true">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3.5 13.7 9l5.5 1.7-5.5 1.7L12 18l-1.7-5.6L4.8 10.7 10.3 9 12 3.5Z" />
            <path d="m18.5 16 .8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z" />
          </svg>
        </span>
        <div
          className={css.statusBar}
          data-status={streaming ? phase : outcome}
          role={phaseFailure ? undefined : 'status'}
          aria-live={phaseFailure ? undefined : 'polite'}
        >
          <span className={css.agentName}>{props.agentLabel ?? 'AI 助手'}</span>
          <span
            className={css.statusPill}
            data-status={streaming ? phase : outcome}
            data-tone={streaming ? undefined : askRunOutcomeTone(outcome)}
          >
            <span className={css.statusIcon} aria-hidden="true">
              <StatusIcon kind={streaming ? iconKindForPhase(phase) : iconKindForOutcome(outcome)} />
            </span>
            <span className={css.statusText}>
              {statusTitle({ streaming, phase, outcome, stages })}
            </span>
          </span>
          {statusMeta.length > 0 && (
            <span className={css.statusMeta} aria-live="off">
              {statusMeta.map((item, index) => (
                <span key={`${String(index)}:${item}`}>{item}</span>
              ))}
            </span>
          )}
          {streaming && props.onStop !== undefined && (
            <button
              type="button"
              className={css.statusAction}
              onClick={props.onStop}
              title="停止本轮回答，已生成内容会保留"
            >
              停止
            </button>
          )}
        </div>
      </div>
      <div className={css.runBody}>
        <ProcessInspector
          answerText={text}
          streaming={streaming}
          stages={stages}
          tools={toolViews}
          thinking={thinking}
          evidence={evidence}
          {...(turn?.grounding !== undefined ? { grounding: turn.grounding } : {})}
          outcome={outcome}
          metrics={processMetrics}
          {...(turn?.metrics?.reasoningMs !== undefined
            ? { thinkingDuration: turn.metrics.reasoningMs }
            : liveThinkingMs !== undefined ? { thinkingDuration: liveThinkingMs } : {})}
          {...(turn?.synthesisError !== undefined ? { synthesisError: turn.synthesisError } : {})}
          {...(planNode !== undefined ? { planNode } : {})}
          {...(retrievalNode !== undefined ? { retrievalNode } : {})}
          {...(props.processOpen !== undefined ? { processOpen: props.processOpen } : {})}
          {...(props.onProcessOpenChange !== undefined
            ? { onProcessOpenChange: props.onProcessOpenChange }
            : {})}
        />
        {hasAnswer && (
          <section
            className={css.answerCard}
            data-live={streaming || undefined}
            aria-label="AI 回答"
            aria-busy={streaming || undefined}
          >
            <AnswerBody
              text={text}
              streaming={streaming}
              {...((turn?.citations ?? props.citations) ? { citations: turn?.citations ?? props.citations } : {})}
              {...(props.onOpenCite !== undefined ? { onOpenCite: props.onOpenCite } : {})}
              {...(props.activeCite !== undefined ? { activeCite: props.activeCite } : {})}
            />
          </section>
        )}
        {streaming && !hasAnswer && (
          <div className={css.pendingAnswer} role="status" aria-busy="true">
            <span className={css.pendingBars} aria-hidden="true">
              <span className={css.pendingBar} />
              <span className={css.pendingBar} />
              <span className={css.pendingBar} />
            </span>
            <span>
              {phase === 'thinking'
                ? '正在整理思路…'
                : phase === 'tool_calling'
                  ? '正在调用工具检索原文…'
                  : phase === 'verifying'
                    ? '正在核对回答与原文…'
                    : '正在准备回答…'}
            </span>
          </div>
        )}
        {!streaming && !hasAnswer && (
          <div className={css.emptyAnswerState} role="status">
            <StatusIcon kind={phaseFailure ? 'danger' : 'warning'} />
            <span>
              {phaseFailure
                ? '本轮未生成回答，请查看原因后重试。'
                : '本轮没有生成可展示的回答。'}
            </span>
          </div>
        )}
        <RunNotices
          outcome={outcome}
          {...(turn?.statusReason !== undefined ? { reason: turn.statusReason } : {})}
          withheld={turn?.withheld === true}
          {...(turn?.synthesisError !== undefined ? { synthesisError: turn.synthesisError } : {})}
          {...(turn?.grounding !== undefined ? { grounding: turn.grounding } : {})}
          {...(turn?.errorCode !== undefined ? { errorCode: turn.errorCode } : {})}
          {...(props.onRetry !== undefined ? { onRetry: props.onRetry } : {})}
          {...(props.retryDisabled !== undefined ? { retryDisabled: props.retryDisabled } : {})}
        />
      </div>
    </div>
  )
}
