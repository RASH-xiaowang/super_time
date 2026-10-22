/**
 * 本轮问答的运行信息：状态、工具 trace、证据包、独立资源卡。
 *
 * 为什么独立成组件而不是继续塞进 Ask.tsx：问答面板已经接近单文件行数上限，
 * 而且“运行信息”与“正文 / 反馈 / 引用详情”是三种不同生命周期 —— 这里只做
 * 纯展示，不发起请求、不写线程状态，旧后端没有这些字段时整块不渲染。
 *
 * 三条展示纪律：
 *   ① 状态原因只在真实存在时显示，不把 `ok` 包装成一句噪声；
 *   ② 工具参数只显示后端给的脱敏摘要，绝不在前端重新拼接完整参数；
 *   ③ 文件/收藏/朋友圈是独立资源，不能混进消息证据，也不伪造可点击路径。
 *
 * 资源区默认放在回答正文之后（`AskResources`）；`AskRuntimeMeta` 的默认
 * 行为仍保留资源区，避免既有调用方升级后丢内容。
 *
 * @module panels/AskRuntimeMeta
 */
import { useState } from 'react'
import type {
  AnswerRuntimeResourceCitation,
  AskGrounding,
  AskTurn,
  EvidenceBundle,
  EvidenceBundleStats,
  EvidenceItem,
  ToolCallTrace,
} from './use-ask.ts'
import { ResourceCard } from './resource-card.tsx'
import css from './ask-runtime.module.css'

const STATUS_LABEL: Readonly<Record<string, string>> = {
  ok: '已完成',
  insufficient: '证据不足',
  needs_clarification: '需要澄清',
  degraded: '已降级',
  blocked: '已阻止',
  failed: '执行失败',
}

/** 意图枚举 → 给人看的中文。旧枚举继续保留；未知值原样显示。 */
export const INTENT_LABEL: Record<string, string> = {
  lookup: '查询',
  aggregate: '聚合统计',
  relation: '关系/对比',
  timeline: '时间线',
  content_media: '内容/媒体',
  open_qa: '开放问答',
  clarify: '需要澄清',
  recency_lookup: '最近查询',
  entity_lookup: '实体查询',
  time_range: '时间范围',
  aggregation: '聚合统计',
  comparison: '对比',
}

/**
 * 意图标签解析（`PlanLine` 与检索漏斗共用同一份映射）。
 * @param intent - 后端稳定枚举（可能为空）。
 * @returns 中文标签；未知枚举原样返回，空值返回 `—`。
 */
export function intentLabel(intent?: string): string {
  if (!intent) return '—'
  return INTENT_LABEL[intent] ?? intent
}

/** 工具名 → 中文动作；未知工具原样显示，避免把新工具藏起来。 */
const TOOL_LABEL: Record<string, string> = {
  search_messages: '消息检索',
  search_semantic: '语义检索',
  search_hybrid: '混合检索',
  aggregate_messages: '统计消息',
  list_sessions: '会话列表',
  get_session_messages: '读取会话消息',
  get_message_context: '展开消息上下文',
  search_contacts: '联系人检索',
  get_contact_detail: '联系人详情',
  search_moments: '朋友圈检索',
  search_favorites: '收藏检索',
  search_files: '文件检索',
  search_records: '转账/红包检索',
  search_kb: '知识库检索',
}

const SOURCE_LABEL: Record<string, string> = {
  msg: '消息',
  kb: '知识库',
  agg: '统计事实',
  resource: '资源',
}

function toolLabel(name: string | undefined): string {
  if (!name) return '未知工具'
  return TOOL_LABEL[name] ?? name
}

function safeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** 把耗时写成紧凑的毫秒 / 秒，过短不显示伪精度。 */
function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${String(Math.round(ms))}ms`
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
}

function statusLabel(status: string, withheld: boolean): string {
  if (withheld && (status === 'ok' || status === 'insufficient')) return '未采用 · 证据不足'
  return STATUS_LABEL[status] ?? `未知状态：${status || '—'}`
}

function evidenceItemsOf(evidence: EvidenceBundle | undefined): EvidenceItem[] {
  return Array.isArray(evidence?.items)
    ? evidence.items.filter((item): item is EvidenceItem => Boolean(item) && typeof item === 'object')
    : []
}

function evidenceSummary(evidence: EvidenceBundle | undefined, items: readonly EvidenceItem[]): string {
  const stats = evidence?.stats as Partial<EvidenceBundleStats> | undefined
  const messages = items.filter(item => item.source === 'msg').length || safeNumber(stats?.messages)
  const kb = items.filter(item => item.source === 'kb').length || safeNumber(stats?.kb)
  const factCount = items.filter(item => item.kind === 'fact').length || safeNumber(stats?.factCount)
  const count = items.length || safeNumber(stats?.count)
  return [
    `${String(count)} 条证据`,
    messages > 0 ? `消息 ${String(messages)}` : '',
    kb > 0 ? `知识库 ${String(kb)}` : '',
    factCount > 0 ? `事实 ${String(factCount)}` : '',
  ].filter(Boolean).join(' · ')
}

function evidenceHeading(item: EvidenceItem): string {
  const source = SOURCE_LABEL[item.source] ?? item.source ?? '证据'
  if (item.kind !== 'fact') return source
  // `agg` 已经是“统计事实”，不要再拼成“统计事实 · 统计事实”。
  return source === '统计事实' ? source : `统计事实 · ${source}`
}

/** 证据列表最多直接展开多少条；其余通过“显示全部”按钮放出，避免长回答被元信息顶下去。 */
const EVIDENCE_PREVIEW = 6
const RESOURCE_PREVIEW = 4

function StatusRow({ status, label, reason }: {
  status: string
  label: string
  reason?: string
}): React.JSX.Element {
  return (
    <div className={css.statusRow}>
      <span className={css.statusBadge} data-status={status}>{label}</span>
      {reason && <span className={css.statusReason} title={reason}>{reason}</span>}
    </div>
  )
}

function ToolRow({ call }: { call: ToolCallTrace }): React.JSX.Element {
  const failure = call.ok === false
  const meta = [
    `第 ${String(safeNumber(call.round))} 轮`,
    safeNumber(call.attempts) > 1 ? `尝试 ${String(call.attempts)} 次` : '',
    safeNumber(call.retries) > 0 ? `重试 ${String(call.retries)} 次` : '',
    formatMs(safeNumber(call.elapsedMs)),
    `命中 ${String(safeNumber(call.hits))}`,
    safeNumber(call.facts) > 0 ? `事实 ${String(call.facts)}` : '',
    call.deduplicated ? '复用缓存' : '',
    call.deadlineExceeded ? '超时' : '',
  ].filter(Boolean).join(' · ')
  const error = [call.errorCode, call.errorClass].filter(Boolean).join(' · ')
  return (
    <li className={css.toolRow} data-ok={failure ? false : undefined}>
      <div className={css.toolHead}>
        <span className={css.toolName}>{toolLabel(call.name)}</span>
        <span className={css.toolMark} data-ok={failure ? false : undefined}>
          {call.skipped ? '未执行' : failure ? '失败' : '成功'}
        </span>
      </div>
      <div className={css.toolMeta}>{meta}</div>
      {call.argumentsSummary && (
        <div className={css.toolArgs} title={call.argumentsSummary}>{call.argumentsSummary}</div>
      )}
      {(call.note || error) && (
        <div className={css.toolNote}>
          {error && <span className={css.errorCode}>{error}</span>}
          {error && call.note ? ' · ' : ''}
          {call.note}
        </div>
      )}
    </li>
  )
}

function EvidenceItemRow({ item }: { item: EvidenceItem }): React.JSX.Element {
  const tools = Array.isArray(item.tools) ? item.tools : item.tool ? [item.tool] : []
  return (
    <li className={css.evidenceRow}>
      <div className={css.evidenceHead}>
        <span className={css.evidenceKind}>{evidenceHeading(item)}</span>
        <span className={css.evidenceName} title={item.name}>{item.name || '未命名来源'}</span>
        {item.time && <span className={css.evidenceTime}>{item.time}</span>}
      </div>
      {item.sender && <div className={css.evidenceSender}>{item.sender}</div>}
      <div className={css.evidenceSnippet} title={item.snippet}>{item.snippet}</div>
      <div className={css.evidenceMeta}>
        {tools.map(tool => toolLabel(tool)).join(' / ')}
        {item.truncated ? ' · 摘要已截断' : ''}
      </div>
    </li>
  )
}

/**
 * 资源的展示身份键：只用于去重，不作为文本渲染。
 * 同时列入稳定的 locator 键、资源 key 与 evidenceId，任一相同都视为同一资源。
 */
function resourceIdentityKeys(resource: AnswerRuntimeResourceCitation): string[] {
  const locator = resource?.locator
  return [
    locator && locator.type === 'resource' ? locator.stableKey : '',
    locator && locator.type === 'resource' ? locator.key : '',
    resource?.key,
    resource?.evidenceId,
  ].filter((key): key is string => typeof key === 'string' && key.length > 0)
}

function resourceFromEvidence(item: EvidenceItem): AnswerRuntimeResourceCitation {
  return {
    evidenceId: item.evidenceId || '',
    tool: item.tool,
    key: item.key || '',
    name: item.name || '',
    time: item.time || '',
    snippet: item.snippet || '',
    locator: item.locator,
  }
}

/**
 * 收集本轮资源。优先使用后端独立的 `resources`，旧响应若只在证据包里
 * 返回资源，则把它转到资源区；两边同时存在时按稳定 locator 去重。
 */
function resourcesOf(turn: AskTurn): AnswerRuntimeResourceCitation[] {
  const declared = Array.isArray(turn.resources) ? turn.resources : []
  const fromEvidence = evidenceItemsOf(turn.evidence)
    .filter(item => item.source === 'resource')
    .map(resourceFromEvidence)
  const seen = new Set<string>()
  return [...declared, ...fromEvidence].filter(resource => {
    if (!resource || typeof resource !== 'object') return false
    const identities = resourceIdentityKeys(resource)
    if (identities.length === 0 || identities.some(identity => seen.has(identity))) return false
    for (const identity of identities) seen.add(identity)
    return true
  })
}

/**
 * 资源卡的辅助信息。
 *
 * 只消费 backend locator 中已脱敏的展示字段；`url/token/seed/md5/serverId/
 * sourceId` 属于打开资源所需的内部凭据，不在这里渲染，避免运行信息把凭据
 * 带进页面文本。`resource.key` 也只在去重时使用，不展示给用户。
 */
/**
 * 独立资源区。默认折叠，只露出一行数量和范围摘要；展开后才显示资源卡。
 * 资源卡放在正文之后渲染，避免窄面板里 4 张卡先把回答挤下去。
 */
export function AskResources({ turn, defaultOpen = false }: {
  turn: AskTurn
  defaultOpen?: boolean
}): React.JSX.Element | null {
  const [open, setOpen] = useState(defaultOpen)
  const [allResources, setAllResources] = useState(false)
  const resources = resourcesOf(turn)
  if (resources.length === 0) return null
  const shownResources = allResources ? resources : resources.slice(0, RESOURCE_PREVIEW)
  return (
    <section className={css.resourceSection} aria-label="本轮相关资源">
      <button
        type="button"
        className={css.sectionHead}
        onClick={() => { setOpen(value => !value) }}
        aria-expanded={open}
        title={open ? '收起相关资源' : '展开相关资源'}
      >
        <span className={css.chevron} aria-hidden="true">›</span>
        <span className={css.sectionTitle}>相关资源</span>
        <span className={css.sectionHint}>{String(resources.length)} 项 · 独立于消息引用</span>
        <span className={css.sectionHint}>{open ? '收起' : '展开'}</span>
      </button>
      {open && (
        <>
          <ul className={css.resourceList}>
            {shownResources.map(resource => (
              <ResourceCard
                key={resource.evidenceId || resourceIdentityKeys(resource)[0] || resource.name}
                resource={resource}
              />
            ))}
          </ul>
          {resources.length > RESOURCE_PREVIEW && (
            <button
              type="button"
              className={css.moreBtn}
              onClick={() => { setAllResources(value => !value) }}
            >
              {allResources ? '收起多余资源' : `显示全部 ${String(resources.length)} 项`}
            </button>
          )}
        </>
      )}
    </section>
  )
}

export type AskRuntimePlacement = 'all' | 'meta' | 'resources'

/**
 * 渲染一轮回答的运行时信息。
 * @param props.turn - 助手轮次（旧轮次没有新字段时整块返回 null）。
 * @param props.placement - `all` 兼容旧调用；`meta` 只渲染状态/工具/证据；
 *   `resources` 只渲染资源区，供正文之后的独立插槽使用。
 * @returns 状态 / 工具 / 证据 / 资源块。
 */
export function AskRuntimeMeta({ turn, placement = 'all', onRetry }: {
  turn: AskTurn
  placement?: AskRuntimePlacement
  /** 失败轮次的一键重试；不传时不显示按钮。 */
  onRetry?: () => void
}): React.JSX.Element | null {
  const [toolsOpen, setToolsOpen] = useState(false)
  const [evidenceOpen, setEvidenceOpen] = useState(false)
  const [allEvidence, setAllEvidence] = useState(false)

  const showMeta = placement !== 'resources'
  const showResources = placement !== 'meta'
  const withheld = showMeta && turn.withheld === true
  const rawStatus = showMeta && typeof turn.status === 'string' && turn.status.length > 0
    ? turn.status
    : undefined
  const status = showMeta
    ? withheld && (rawStatus === undefined || rawStatus === 'ok' || rawStatus === 'insufficient')
      ? 'insufficient'
      : rawStatus
    : undefined
  const tools = showMeta && Array.isArray(turn.toolCalls)
    ? turn.toolCalls.filter((call): call is ToolCallTrace => Boolean(call) && typeof call === 'object')
    : []
  const evidence = showMeta ? turn.evidence : undefined
  const evidenceItems = evidenceItemsOf(evidence).filter(item => item.source !== 'resource')
  const resources = showResources ? resourcesOf(turn) : []
  const grounding = showMeta && turn.grounding && typeof turn.grounding === 'object'
    ? turn.grounding
    : undefined
  const unsupported = Array.isArray(grounding?.unsupported) ? grounding.unsupported : []
  const synthesisError = showMeta && typeof turn.synthesisError === 'string'
    ? turn.synthesisError
    : ''
  const hasGrounding = Boolean(grounding) && (
    safeNumber(grounding?.checked) > 0
    || safeNumber(grounding?.cited) > 0
    || unsupported.length > 0
    || grounding?.repaired === true
  )
  const hasAnything = (showMeta && (
    status !== undefined
    || withheld
    || tools.length > 0
    || evidenceItems.length > 0
    || hasGrounding
    || Boolean(synthesisError)
  )) || (showResources && resources.length > 0)
  if (!hasAnything) return null

  const shownEvidence = allEvidence ? evidenceItems : evidenceItems.slice(0, EVIDENCE_PREVIEW)
  const failedTools = tools.filter(tool => tool.ok === false && tool.skipped !== true).length
  const reason = typeof turn.statusReason === 'string' ? turn.statusReason : undefined

  return (
    <div className={css.runtime}>
      {status && (
        <StatusRow
          status={status}
          label={statusLabel(status, withheld)}
          {...(reason ? { reason } : {})}
        />
      )}

      {status === 'failed' && onRetry !== undefined && (
        <div className={css.retryRow}>
          <button type="button" className={css.retryBtn} onClick={onRetry} title="用原问题重新生成回答">
            重试这一轮
          </button>
          {turn.errorCode && <span className={css.retryCode}>{turn.errorCode}</span>}
        </div>
      )}

      {(withheld || synthesisError || hasGrounding) && (
        <div className={css.notices}>
          {withheld && (
            <span className={css.notice} data-tone="warning">
              模型内容未通过接地核对，已不予采用
            </span>
          )}
          {synthesisError && (
            <span className={css.notice} data-tone="warning" title={synthesisError}>
              综合生成失败，已返回可核对的证据
            </span>
          )}
          {grounding?.repaired && <span className={css.notice}>接地核对后已自动修订</span>}
          {unsupported.length > 0 && (
            <span className={css.notice} data-tone="warning" title={unsupported.join('、')}>
              {String(unsupported.length)} 个数值未在原文中找到
            </span>
          )}
          {safeNumber(grounding?.checked) > 0 && (
            <span className={css.notice}>
              核对 {String(safeNumber(grounding?.checked))} 项 · 引用 {String(safeNumber(grounding?.cited))} 条
            </span>
          )}
        </div>
      )}

      {tools.length > 0 && (
        <section className={css.section}>
          <button
            type="button"
            className={css.sectionHead}
            onClick={() => { setToolsOpen(value => !value) }}
            aria-expanded={toolsOpen}
            title={toolsOpen ? '收起工具调用' : '展开工具调用'}
          >
            <span className={css.chevron} aria-hidden="true">›</span>
            <span className={css.sectionTitle}>工具调用 {String(tools.length)} 次</span>
            {failedTools > 0 && <span className={css.sectionWarn}>{String(failedTools)} 次失败</span>}
            <span className={css.sectionHint}>{toolsOpen ? '收起' : '展开'}</span>
          </button>
          {toolsOpen && (
            <ol className={css.toolList}>
              {tools.map((call, index) => (
                <ToolRow
                  key={`${String(call.index ?? index)}:${call.callId || String(index)}`}
                  call={call}
                />
              ))}
            </ol>
          )}
        </section>
      )}

      {evidenceItems.length > 0 && evidence && (
        <section className={css.section}>
          <button
            type="button"
            className={css.sectionHead}
            onClick={() => { setEvidenceOpen(value => !value) }}
            aria-expanded={evidenceOpen}
            title={evidenceOpen ? '收起证据包' : '展开证据包'}
          >
            <span className={css.chevron} aria-hidden="true">›</span>
            <span className={css.sectionTitle}>证据包</span>
            <span className={css.sectionHint}>{evidenceSummary(evidence, evidenceItems)}</span>
          </button>
          {evidenceOpen && (
            <>
              <ul className={css.evidenceList}>
                {shownEvidence.map((item, index) => (
                  <EvidenceItemRow key={item.evidenceId || `evidence-${String(index)}`} item={item} />
                ))}
              </ul>
              {evidenceItems.length > EVIDENCE_PREVIEW && (
                <button
                  type="button"
                  className={css.moreBtn}
                  onClick={() => { setAllEvidence(value => !value) }}
                >
                  {allEvidence ? '收起多余证据' : `显示全部 ${String(evidenceItems.length)} 条`}
                </button>
              )}
            </>
          )}
        </section>
      )}

      {showResources && <AskResources turn={turn} />}
    </div>
  )
}

export type { AskGrounding }
