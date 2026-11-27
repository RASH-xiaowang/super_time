/** Three read-only cards, isolated from the overview's core queries and caches. */
import { useEffect, useState } from 'react'
import { apiListEnabledChatAiReplyStates } from '../api-chat-ai-reply.ts'
import { apiListMessageListRecords } from '../api-message-list.ts'
import { runtimeCapabilities } from '../api-core.ts'
import { DATA_IDENTITY_CHANGED_EVENT } from '../cache.ts'
import { MESSAGE_LIST_UPDATED_EVENT } from '../message-list-events.ts'
import { OvSection } from './overview-parts.tsx'
import { beginOverviewRefresh, failOverviewRefresh, summarizeAiReplyRuntime, summarizeAiReplies, type OverviewSourceSnapshot, type RuntimeOverview, type ReplyOverview } from './overview-operations.ts'
import css from './overview.module.css'
import kitCss from '../ui/kit.module.css'

type Snapshot<T> = OverviewSourceSnapshot<T>
const loading = { status: 'loading', data: null } as const
const unavailable = { status: 'unavailable', data: null } as const
const UNKNOWN = '—'
export const OVERVIEW_MESSAGE_REFRESH_DEBOUNCE_MS = 300

/** One pair of existing read IPCs per overview refresh trigger, not per card. lastUpdated is only a refresh key, never the cards' freshness. */
export function useOverviewOperations(refreshKey: number | null) {
  const desktop = runtimeCapabilities().isDesktop
  const [runtime, setRuntime] = useState<Snapshot<RuntimeOverview>>(loading)
  const [replies, setReplies] = useState<Snapshot<ReplyOverview>>(loading)
  const [retryKey, setRetryKey] = useState(0)
  useEffect(() => {
    let active = true
    let replyInFlight = false
    let replyDirty = false
    let timer: number | undefined
    // Events share one in-flight read and at most one debounced follow-up.
    const readReplies = async (): Promise<void> => {
      if (!active) return
      if (replyInFlight) { replyDirty = true; return }
      replyInFlight = true
      replyDirty = false
      setReplies(beginOverviewRefresh)
      try {
        const snapshot = await apiListMessageListRecords({ source: 'ai_reply', limit: 100 })
        // 读失败与「确实没有记录」是两件事：快照带 readError 时不能画成空卡片
        // （`readErrorVisibility` 的全局守卫也要求调用方显式处理它）。
        if (snapshot.readError !== undefined && snapshot.readError !== '') {
          throw new Error(snapshot.readError)
        }
        const data = summarizeAiReplies(snapshot, Date.now())
        if (active && !replyDirty) setReplies({ status: 'ready', data })
      } catch {
        if (active && !replyDirty) setReplies(failOverviewRefresh)
      } finally {
        replyInFlight = false
        if (active && replyDirty && timer === undefined) void readReplies()
      }
    }
    const messageListUpdated = (): void => {
      replyDirty = true
      if (timer !== undefined) window.clearTimeout(timer)
      timer = window.setTimeout(() => { timer = undefined; void readReplies() }, OVERVIEW_MESSAGE_REFRESH_DEBOUNCE_MS)
    }
    setRuntime(previous => desktop ? beginOverviewRefresh(previous) : unavailable)
    setReplies(previous => desktop ? beginOverviewRefresh(previous) : unavailable)
    // With no cached overview, wait for core statistics instead of querying twice on first load.
    if (desktop && (refreshKey !== null || retryKey > 0)) {
      // No mutation/probe/scan/dispatch. Project immediately; do not retain private text.
      void apiListEnabledChatAiReplyStates().then(value => summarizeAiReplyRuntime(value, Date.now()))
        .then(data => { if (active) setRuntime({ status: 'ready', data }) })
        .catch(() => { if (active) setRuntime(failOverviewRefresh) })
      void readReplies()
    }
    const identityChanged = () => {
      active = false
      if (timer !== undefined) window.clearTimeout(timer)
      setRuntime(desktop ? loading : unavailable)
      setReplies(desktop ? loading : unavailable)
      setRetryKey(key => key + 1)
    }
    window.addEventListener(DATA_IDENTITY_CHANGED_EVENT, identityChanged)
    if (desktop) window.addEventListener(MESSAGE_LIST_UPDATED_EVENT, messageListUpdated)
    return () => {
      active = false
      if (timer !== undefined) window.clearTimeout(timer)
      window.removeEventListener(DATA_IDENTITY_CHANGED_EVENT, identityChanged)
      window.removeEventListener(MESSAGE_LIST_UPDATED_EVENT, messageListUpdated)
    }
  }, [desktop, refreshKey, retryKey])
  return { runtime, replies, desktop, retry: () => { setRetryKey(key => key + 1) } }
}
export type OverviewOperations = ReturnType<typeof useOverviewOperations>

function Metric({ label, value }: { label: string; value: number | string }) {
  return <div className={css.metric}><span className={css.metricValue}>{value}</span><span className={kitCss.textCaption}>{label}</span></div>
}
/** One compact line in every card; no private error text or large explanatory captions. */
function ReadStatus({ snapshot, desktop, replyScope = false }: { snapshot: Snapshot<{ sampledAt: number }>; desktop: boolean; replyScope?: boolean }) {
  const label = !desktop ? '不可用' : snapshot.status === 'stale' ? '旧值' : snapshot.status === 'unavailable' ? '读取失败'
    : snapshot.status === 'loading' ? '未知' : snapshot.status === 'refreshing' ? '刷新中' : '已读取'
  const detail = !desktop ? '当前环境不支持读取' : snapshot.status === 'stale' ? '刷新失败，显示上次成功数据'
    : snapshot.status === 'loading' ? '首次读取尚未完成，数值未知' : label
  const stamp = snapshot.data ? '；上次成功读取 ' + new Date(snapshot.data.sampledAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + ' 北京时间' : ''
  const tone = snapshot.status === 'stale' ? 'amber' : snapshot.status === 'unavailable' ? 'red' : 'default'
  return <div className={kitCss.textCaption}>
    <span role="status" aria-live="polite" aria-atomic="true" aria-label={detail + stamp} title={detail + stamp} className={kitCss.badge} data-tone={tone} data-state={snapshot.status}>{label}</span>{' '}
    {replyScope && <span className={kitCss.badge} data-tone="default" aria-label="AI 回复记录最近最多100条，按记录统计，非全量统计">最近100条</span>}
  </div>
}
function Actions({ ops, onGo }: { ops: OverviewOperations; onGo: (tab: string) => void }) {
  const label = ops.desktop && (ops.replies.status === 'unavailable' || ops.replies.status === 'stale') ? '重试读取' : '刷新'
  return <><button type="button" className={css.panelGo} disabled={!ops.desktop || (ops.replies.status === 'loading' || ops.replies.refreshing === true)} onClick={ops.retry} aria-label={label}>{label}</button>{' '}<button type="button" className={css.panelGo} onClick={() => { onGo('messagelist') }} aria-label="消息列表">消息列表 →</button></>
}

export function AiPendingSection({ ops, onGo }: { ops: OverviewOperations; onGo: (tab: string) => void }): React.JSX.Element {
  const data = ops.replies.data
  return <OvSection canvasId="ov-ai-pending" zone="行动与维护" icon="health" title="AI 待处理事项" action={<Actions ops={ops} onGo={onGo} />} >
    <ReadStatus snapshot={ops.replies} desktop={ops.desktop} replyScope />
    <div className={`${css.metricGrid} ${css.opsMetricGrid}`}>
      <Metric label="待确认草稿" value={data ? data.held : UNKNOWN} />
      <Metric label="待处理 / 在途" value={data ? data.inFlight : UNKNOWN} />
      <Metric label="已发出未确认" value={data ? data.unconfirmed : UNKNOWN} />
    </div>
  </OvSection>
}

export function AiReplyOutcomeSection({ ops, onGo }: { ops: OverviewOperations; onGo: (tab: string) => void }): React.JSX.Element {
  const data = ops.replies.data
  return <OvSection canvasId="ov-ai-reply-outcome" zone="行动与维护" icon="trend" title="AI 回复投递快照" action={<Actions ops={ops} onGo={onGo} />} >
    <ReadStatus snapshot={ops.replies} desktop={ops.desktop} replyScope />
    <div className={`${css.metricGrid} ${css.opsMetricGrid}`}>
      <Metric label="本地成功" value={data ? data.success : UNKNOWN} />
      <Metric label="投递失败" value={data ? data.sendFailed : UNKNOWN} />
      <Metric label="生成失败" value={data ? data.generationFailed : UNKNOWN} />
      <Metric label="暂存草稿" value={data ? data.held : UNKNOWN} />
      <Metric label="待处理 / 在途" value={data ? data.inFlight : UNKNOWN} />
      <Metric label="已发出未确认" value={data ? data.unconfirmed : UNKNOWN} />
    </div>
  </OvSection>
}

export function AiReplyRuntimeSection({ ops }: { ops: OverviewOperations }): React.JSX.Element {
  const data = ops.runtime.data
  return <OvSection canvasId="ov-ai-runtime" zone="行动与维护" icon="health" title="AI 自动回复会话">
    <ReadStatus snapshot={ops.runtime} desktop={ops.desktop} />
    <div className={`${css.metricGrid} ${css.opsMetricGrid}`}>
      <Metric label="已开启会话" value={data ? data.enabled : UNKNOWN} />
      <Metric label="已开启群聊" value={data ? data.groups : UNKNOWN} />
      <Metric label="已开启单聊" value={data ? data.direct : UNKNOWN} />
    </div>
  </OvSection>
}
