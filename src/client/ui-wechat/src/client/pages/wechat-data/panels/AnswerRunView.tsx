/**
 * Shared answer-run view for WeChat Q&A and session-level AI Q&A.
 *
 * Information order is intentional: a compact live/final status is always
 * visible, followed by the full reasoning/tool/evidence trace and then the
 * formal answer. The trace can default open while there is no answer yet, but
 * it collapses once generation starts so it cannot bury the formal response.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  askToolLabel,
  formatStageElapsed,
  type AskStage,
} from './ask-stage-merge.ts'
import {
  askRunOutcomeTone,
  completedAskRunPhase,
  deriveLiveAskPhase,
  formatAskRunDuration,
  formatLiveAskDuration,
  resolveAskRunOutcome,
  type AskRunOutcome,
} from './ask-run-model.ts'
import {
  durationBetween,
  evidenceRowsOf,
  formatToolResultDetail,
  iconKindForOutcome,
  iconKindForPhase,
  mergeStages,
  nodeStatusOf,
  processSummary,
  stageEventStatus,
  stageEventStatusLabel,
  statusTitle,
  toolStatus,
  toolStatusLabel,
  toolViewStats,
  toolViewsOf,
  uniqueText,
  type EvidenceRow,
  type IconKind,
  type ToolView,
} from './answer-run-view-model.ts'
import { AnswerBody } from './AnswerBody.tsx'
import { RunTraceTimeline } from './AnswerRunTrace.tsx'
import {
  reasoningSegmentsOf,
  liveReasoningKeyOf,
  traceGroupsOf,
  type AskReasoningSegment,
} from './answer-run-trace.ts'
import { withEnterprise } from './enterprise-identity.ts'
import { IdentityName } from './identity.tsx'
import type {
  AskGrounding,
  AskTurn,
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
  reasoningSegments?: AskReasoningSegment[]
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
  const autoOpen = status === 'warning'
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
  reasoning: readonly AskReasoningSegment[]
  liveReasoningKey?: string
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
  const [issueAutoOpen, setIssueAutoOpen] = useState(false)
  const issueSeen = useRef(false)
  const firstIssueEffect = useRef(true)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const headRef = useRef<HTMLButtonElement | null>(null)
  const focusWithinRef = useRef(false)
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
  const traceGroups = traceGroupsOf({
    stages: input.stages,
    tools: input.tools,
    reasoning: input.reasoning,
  })
  const exists = input.thinking !== ''
    || traceGroups.length > 0
    || input.tools.length > 0
    || input.evidence.length > 0
    || hasPlan
    || input.metrics.length > 0
  useEffect(() => {
    if (hasIssue && !issueSeen.current) {
      // A completed error can remount this inspector after the user already
      // chose to keep the trace closed. In that case the parent-supplied fold
      // state is authoritative; otherwise a newly arriving issue opens once.
      const savedChoiceOnMount = firstIssueEffect.current && input.processOpen !== undefined
      if (!savedChoiceOnMount) {
        setIssueAutoOpen(true)
        setManualOpen(null)
      }
    } else if (!hasIssue) {
      setIssueAutoOpen(false)
    }
    issueSeen.current = hasIssue
    firstIssueEffect.current = false
  }, [hasIssue, input.processOpen])
  const autoOpen = hasIssue || (input.streaming && input.answerText.trim() === '')
  const open = manualOpen ?? (issueAutoOpen ? true : input.processOpen ?? autoOpen)
  useEffect(() => {
    if (!open) {
      focusWithinRef.current = false
      return
    }
    const onFocusIn = (event: FocusEvent): void => {
      focusWithinRef.current = bodyRef.current?.contains(event.target as Node) ?? false
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (!bodyRef.current?.contains(event.target as Node)) focusWithinRef.current = false
    }
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [open])
  useLayoutEffect(() => {
    if (open) return
    // Hiding the body while a child still owns focus would drop keyboard users
    // back to document.body. Browsers may clear focus before this layout effect,
    // so remember that the body owned focus instead of relying on activeElement.
    const ownedFocus = focusWithinRef.current
      || bodyRef.current?.contains(document.activeElement) === true
    if (!ownedFocus) return
    focusWithinRef.current = false
    headRef.current?.focus()
  }, [open])
  if (!exists) return null
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
        ref={headRef}
        type="button"
        className={css.processHead}
        onClick={() => {
          const next = !open
          setManualOpen(next)
          setIssueAutoOpen(false)
          input.onProcessOpenChange?.(next)
        }}
        title={open ? '收起执行轨迹' : '展开执行轨迹'}
        aria-expanded={open}
        aria-controls={bodyId}
      >
        <svg className={css.processChevron} viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
        <span className={css.processTitle}>执行轨迹</span>
        <span className={css.processMeta}>{summary}</span>
      </button>
      <div
        ref={bodyRef}
        id={bodyId}
        className={css.processBody}
        hidden={!open}
      >
        {input.metrics.length > 0 && (
          <div className={processCss.metricsRow} role="group" aria-label="本轮运行指标">
            {input.metrics.map(item => (
              <span key={item}>{item}</span>
            ))}
          </div>
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
        <RunTraceTimeline
          groups={traceGroups}
          streaming={input.streaming}
          answerText={input.answerText}
          {...(input.liveReasoningKey !== undefined
            ? { liveReasoningKey: input.liveReasoningKey }
            : {})}
          renderTool={tool => (
            <ToolCard key={tool.key} tool={tool} closed={!input.streaming} />
          )}
        />
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
  const normalize = (value: string | undefined): string | undefined => {
    const text = (value ?? '').trim()
    if (text === '') return undefined
    if (/operation was aborted due to timeout|signal timed out|timed out/i.test(text)) {
      return '模型响应超时：供应商长时间没有返回新内容。请稍后重试，或调高「模型请求超时」。'
    }
    return text
  }
  const reasonText = normalize(reason)
  const synthesisText = normalize(synthesisError)
  const notices = uniqueText([
    outcome !== 'ok' ? reasonText : undefined,
    withheld ? 'AI 回答未通过原文核对，因此未予采用。' : undefined,
    synthesisText !== undefined && synthesisText !== reasonText
      ? `回答生成异常：${synthesisText}`
      : undefined,
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
  const legacyThinking = (turn?.reasoning ?? props.reasoning ?? '').trim()
  const reasoningSegments = reasoningSegmentsOf(
    turn?.reasoningSegments ?? props.reasoningSegments,
    legacyThinking,
  )
  const thinking = legacyThinking || reasoningSegments
    .map(segment => segment.text.trim())
    .filter(Boolean)
    .join('\n\n')
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
  const liveReasoningKey = streaming
    ? liveReasoningKeyOf(reasoningSegments, stages)
    : undefined
  const phaseFailure = !streaming && (outcome === 'failed' || outcome === 'blocked')
  const planNode = props.planNode
  const retrievalNode = props.retrievalNode
  const hasTraceContent = reasoningSegments.length > 0
    || stages.length > 0
    || toolViews.length > 0
    || evidence.length > 0
    || planNode !== undefined
    || retrievalNode !== undefined
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
          reasoning={reasoningSegments}
          {...(liveReasoningKey !== undefined ? { liveReasoningKey } : {})}
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
        {streaming && !hasAnswer && !hasTraceContent && (
          <div className={css.pendingAnswer} aria-hidden="true">
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
