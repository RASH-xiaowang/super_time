/**
 * ClawBot 单条自动回复的运行详情。
 *
 * 自动回复此前只在进程级统计里留下 lastError，用户看到一条回复后无法判断：
 * 用了哪个工具、命中了哪些知识库片段、为什么没有发送。这里把持久化到
 * `clawbot_reply_run.result_json` 的摘要映射成与「微信问答」一致的状态、
 * 工具、证据、引用和资源展示。
 *
 * 组件对旧数据保持宽容：`run` 缺失、字段类型不对或只有部分字段时，只渲染
 * 能证明的部分，不补造状态，也不把内部 key 当文案。
 *
 * @module panels/clawbot-run-detail
 */
import type { ClawbotMessage } from '@deepseek-ai/dsh-wechat-data/types'
import type {
  AnswerRuntimeResourceCitation,
  AskTurn,
  EvidenceBundle,
  ToolCallTrace,
} from './use-ask.ts'
import { AskResources, AskRuntimeMeta } from './AskRuntimeMeta.tsx'
import css from './clawbot.module.css'

/** 发送门禁结果；兼容对象与旧版字符串两种持久化形态。 */
export type ClawbotSendDecisionLike =
  | { send?: boolean; detail?: string; error?: string; reason?: string }
  | 'sent'
  | 'not_sent'
  | 'blocked'
  | 'skipped'

/**
 * 可序列化的自动回复运行摘要。
 *
 * 后端类型定义在 `ClawbotReplyRunDetail`；前端这里保留结构类型，避免生成声明
 * 落后一个构建周期时整块详情无法渲染。字段只读，不参与任何请求。
 */
export interface ClawbotRunDetailLike {
  runId?: number
  status?: string
  statusReason?: string
  synthesisError?: string
  toolCalls?: ToolCallTrace[]
  evidence?: EvidenceBundle
  citations?: NonNullable<AskTurn['citations']>
  resources?: AnswerRuntimeResourceCitation[]
  grounding?: AskTurn['grounding']
  sendDecision?: ClawbotSendDecisionLike
  errorCode?: string
  error?: string
}

type MessageWithRun = ClawbotMessage & { run?: ClawbotRunDetailLike | null }

/**
 * 从消息行取运行详情。
 *
 * 后端可能把同一条 run 同时附在入站目标消息和出站分段上；调用方按 runId
 * 去重，避免同一份详情在对话流里出现两次。
 * @param row - 接入会话消息。
 * @returns 运行详情；旧消息或字段缺失时为 null。
 */
export function autoReplyRunOf(row: ClawbotMessage): ClawbotRunDetailLike | null {
  const run = (row as MessageWithRun).run
  if (!run || typeof run !== 'object') return null
  if (typeof run.runId === 'number' && Number.isFinite(run.runId) && run.runId <= 0) return null
  return run
}

function sendStateOf(decision: ClawbotSendDecisionLike | undefined): 'sent' | 'blocked' | 'unknown' {
  if (decision === 'sent') return 'sent'
  if (decision === 'not_sent' || decision === 'blocked' || decision === 'skipped') return 'blocked'
  if (decision && typeof decision === 'object' && typeof decision.send === 'boolean') {
    return decision.send ? 'sent' : 'blocked'
  }
  return 'unknown'
}

function sendReasonOf(decision: ClawbotSendDecisionLike | undefined): string {
  if (!decision || typeof decision === 'string') return ''
  return (decision.error ?? decision.reason ?? decision.detail ?? '').trim()
}

/**
 * 把运行状态映射到统一的回答状态。
 *
 * `done` 只在发送门禁明确放行时算 `ok`；否则它是「生成完成但未发送」，
 * 必须显示成阻断，避免用户误以为联系人收到了消息。
 */
function answerStatusOf(detail: ClawbotRunDetailLike): AskTurn['status'] {
  const status = typeof detail.status === 'string' ? detail.status : ''
  const send = sendStateOf(detail.sendDecision)
  if (status === 'done') return send === 'sent' ? 'ok' : 'blocked'
  if (status === 'failed') return 'failed'
  if (status === 'skipped') return 'blocked'
  if (status === 'ok' || status === 'degraded' || status === 'insufficient'
    || status === 'needs_clarification' || status === 'blocked') {
    return status
  }
  return send === 'blocked' ? 'blocked' : undefined
}

function statusText(detail: ClawbotRunDetailLike): string {
  const status = typeof detail.status === 'string' ? detail.status : ''
  if (status === 'done' || status === 'ok') return '已生成'
  if (status === 'failed') return '生成失败'
  if (status === 'skipped') return '已跳过'
  if (status === 'degraded') return '已降级'
  if (status === 'insufficient') return '证据不足'
  if (status === 'blocked') return '已阻止'
  return status || '运行记录'
}

function countOf<T>(value: readonly T[] | undefined): number {
  return Array.isArray(value) ? value.length : 0
}

function toolCount(detail: ClawbotRunDetailLike): number {
  return countOf(detail.toolCalls)
}

function evidenceCount(detail: ClawbotRunDetailLike): number {
  return countOf(detail.evidence?.items)
}

function citationName(citation: NonNullable<AskTurn['citations']>[number]): string {
  const kb = citation.source === 'kb' ? citation.kb : undefined
  return kb?.fileName || citation.name || '未命名来源'
}

function citationMeta(citation: NonNullable<AskTurn['citations']>[number]): string {
  const kb = citation.source === 'kb' ? citation.kb : undefined
  if (kb) {
    return [
      kb.page > 0 ? `第 ${String(kb.page)} 页` : '',
      kb.heading,
      typeof kb.chunkId === 'number' ? `片段 ${String(kb.chunkId)}` : '',
    ].filter(Boolean).join(' · ')
  }
  return [citation.time, citation.username].filter(Boolean).join(' · ')
}

function asAskTurn(detail: ClawbotRunDetailLike): AskTurn {
  const status = answerStatusOf(detail)
  return {
    role: 'assistant',
    text: '',
    ...(status ? { status } : {}),
    ...(detail.statusReason ? { statusReason: detail.statusReason } : {}),
    ...(detail.synthesisError ? { synthesisError: detail.synthesisError } : {}),
    ...(Array.isArray(detail.toolCalls) ? { toolCalls: detail.toolCalls } : {}),
    ...(detail.evidence && typeof detail.evidence === 'object' ? { evidence: detail.evidence } : {}),
    ...(Array.isArray(detail.resources) ? { resources: detail.resources } : {}),
    ...(detail.grounding && typeof detail.grounding === 'object' ? { grounding: detail.grounding } : {}),
    ...(detail.errorCode ? { errorCode: detail.errorCode } : {}),
  }
}

/**
 * 一条自动回复的详情卡。
 *
 * @param props.detail - 持久化的运行摘要。
 * @returns 可折叠详情；没有任何可展示字段时返回 null。
 */
export function ClawbotRunDetail({ detail }: {
  detail: ClawbotRunDetailLike
}): React.JSX.Element | null {
  const turn = asAskTurn(detail)
  const citations = Array.isArray(detail.citations)
    ? detail.citations.filter(citation => citation && typeof citation === 'object')
    : []
  const resources = Array.isArray(detail.resources) ? detail.resources : []
  const sendState = sendStateOf(detail.sendDecision)
  const sendReason = sendReasonOf(detail.sendDecision)
  const error = (detail.error ?? '').trim()
  const hasRuntime = turn.status !== undefined
    || toolCount(detail) > 0
    || evidenceCount(detail) > 0
    || citations.length > 0
    || resources.length > 0
  if (!hasRuntime && error === '' && sendReason === '') return null

  const bits = [
    statusText(detail),
    toolCount(detail) > 0 ? `工具 ${String(toolCount(detail))}` : '',
    citations.length > 0 ? `引用 ${String(citations.length)}` : '',
    evidenceCount(detail) > 0 ? `证据 ${String(evidenceCount(detail))}` : '',
  ].filter(Boolean)

  return (
    <details className={css.runDetail} data-send={sendState}>
      <summary className={css.runSummary}>
        <span className={css.runBadge} data-send={sendState}>
          {sendState === 'sent' ? '已发送' : sendState === 'blocked' ? '未发送' : '运行详情'}
        </span>
        <span className={css.runSummaryText}>{bits.join(' · ')}</span>
        <span className={css.runSummaryHint}>展开</span>
      </summary>
      <div className={css.runBody}>
        {sendState === 'blocked' && (
          <div className={css.runNotice} data-tone="warning" role="status">
            未发送：{sendReason || detail.statusReason || '发送门禁未放行'}
          </div>
        )}
        {(detail.statusReason || detail.synthesisError || detail.errorCode || error) && (
          <div className={css.runDiagnostic}>
            {detail.statusReason && <span>{detail.statusReason}</span>}
            {detail.synthesisError && <span>综合生成失败：{detail.synthesisError}</span>}
            {detail.errorCode && <code>{detail.errorCode}</code>}
            {error && <span>{error}</span>}
          </div>
        )}
        <AskRuntimeMeta turn={turn} placement="meta" />
        {citations.length > 0 && (
          <section className={css.runCitations} aria-label="本轮知识库引用">
            <div className={css.runSectionTitle}>知识库引用</div>
            <ol className={css.runCitationList}>
              {citations.map((citation, index) => (
                <li key={citation.evidenceId || `${index}`} className={css.runCitation}>
                  <span className={css.runCitationIndex}>[{String(citation.index ?? index + 1)}]</span>
                  <div className={css.runCitationBody}>
                    <div className={css.runCitationHead}>
                      <span className={css.runCitationName} title={citationName(citation)}>
                        {citationName(citation)}
                      </span>
                      <span className={css.runCitationMeta}>{citationMeta(citation)}</span>
                    </div>
                    {citation.snippet && (
                      <div className={css.runCitationSnippet} title={citation.snippet}>
                        {citation.snippet}
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </section>
        )}
        {resources.length > 0 && <AskResources turn={turn} />}
      </div>
    </details>
  )
}
