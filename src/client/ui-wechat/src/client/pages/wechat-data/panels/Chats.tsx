/**
 * 聊天面板 —— React 版，忠实迁移 WeChatPanel 的 chats 页签核心：左侧会话
 * 列表（搜索/统计/置顶/批量导出），右侧消息流（分页加载 + 多类型消息渲染）。
 * 数据通过 DSH 后端 Remote（sessions + messages）。
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { LazyMount, ListSentinel, ListSkeleton, useLazySentinel, usePagedList, useProgressiveList } from './hooks.tsx'
import { SessionAsk } from './SessionAsk.tsx'
import { ReplySuggest } from './ReplySuggest.tsx'
import { clickableKey, DateRangeField, Dialog, SearchInput, Segmented, useDialogFocus, useEscapeToClose } from '../ui/kit.tsx'
import { useConfirm } from '../ui/confirm.tsx'
import { apiBuildSearchIndex, apiClearAllSessionDrafts, apiClearSessionDraft, apiEditChatMessage, apiExportSessionMessages, apiGetAvatar, apiGetAvatarsLocal, apiGetEmoticonDataUrl, apiGetGroupInfo, apiGetImageDataUrl, apiGetImageOriginal, apiGetMessageFile, apiGetMessages, apiGetNewMessages, apiGetSearchIndexStatus, apiGetSessions, apiGetVideoInfo, apiGetVoiceDataUrl, apiGetVoiceInfo, apiGetVoiceTranscript, apiListEditedMessages, apiOpenPath, apiResetEditedMessage, apiSearchMessages, apiTranscribeVoiceMessage, pickDirectory, readRenderCache, writeRenderCache } from '../api.ts'
import type { ChatlogRecord, EditedMessageRecord, GroupInfo, GroupMember, MessageRenderKind as RenderKind, MessageRich, SearchHit, WechatMessage, WechatSession } from '@deepseek-ai/dsh-wechat-data/types'
import {
  IconChevronLeftOutline14, IconChevronRightOutline14, IconCloseOutline16,
  IconDataOutline16, IconDownloadOutline16, IconEllipsisOutline16,
  IconFullscreenOutline16, IconLinkOutline14,
  IconPlayOutline16, IconPlusOutline16, IconSearchOutline16, IconTrashOutline16, IconUserOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { ChatsView } from './chats-view.tsx'
import { MSG_MENU_ITEM_HEIGHT, MSG_MENU_WIDTH, type MsgMenuAnchor } from './chats-msg-menu.tsx'
import { useChatsMenuAction, useChatsMessageTools } from './chats-message-tools.tsx'
import { useChatsThread } from './chats-thread.tsx'
import { resetSessionOverlays } from './chats-session-scope.ts'
import type { ChatNavigationTarget } from './chats-target.ts'
import { useChatsMsgSearch } from './chats-msg-search.tsx'
import { useChatsGroupInfo } from './chats-group-info.tsx'
import { useChatsEdit } from './chats-edit.tsx'
import { useChatsCalendar } from './chats-calendar.ts'
import { useChatsExport } from './chats-export.tsx'
import { useChatsAiReplyControls } from './use-chats-ai-reply-controls.ts'
import { sessionHasAiReply, sessionIsConversational } from './use-chat-ai-reply-enabled.ts'
// 类型与值要分开转发：`ChatView`/`ViewerImage` 是 type，Rollup 找不到运行期导出会直接构建失败
export type { ChatView } from './chats-support.tsx'
export { isEnterpriseChat } from './chats-support.tsx'
import { SESSIONS_REFRESH_MIN_INTERVAL_MS } from './chats-support.tsx'
export type { ViewerImage } from './chats-media.tsx'
import type { ChatView } from './chats-support.tsx'
import { AVATAR_CACHE_MAX, IconCalendar, IconCallMissedOutline, IconCallOutline, IconImage, IconMinus, POLL_HIDDEN_MS, POLL_VISIBLE_MS, avatarCache, buildMsgMenu, copyTextWithNotice, decodeEntities, isEnterpriseChat, isKefuSession, liveStatusText, openLink, sessionInView } from './chats-support.tsx'
import { IconQuoteCard, IconVideoCallOutline, IconVoiceWaves, ImageViewer, MessageCall, MessageContact, MessageEmoticon, MessageImage, MessageImageGroup, MessageLocation, MessageSystem, MessageThumb, MessageVideo, MessageVoice, ViewerImage, fmtCallDuration, quoteKindIcon, stopCurrentVoice, voiceWidth } from './chats-media.tsx'
import { CARD_KINDS, LabeledCard, LinkCard, MediaCoverCard, MessageBody, MpNewsCard, OpenFileCard, RichCard, mpArticlesOf } from './chats-cards.tsx'
import { CardFoot } from './chats-card-foot.tsx'
import { cacheBounded, copyTextToClipboard } from '../utils/misc.ts'
import { MessageText } from '../utils/message-text.tsx'
import { renderKindOf, type MessageRenderItem } from '../utils/message-items.ts'
import { useActionNotice } from './use-action-notice.tsx'
import { proxyableSrc } from '../utils/url.ts'
import kitCss from '../ui/kit.module.css'
import css from './chats.module.css'
import csscards from './chats-cards.module.css'
import { avatarColors, fmtBytes, fmtDateTimeSec, fmtMsgClockSec, fmtSessionTimeSec } from '../utils/format.ts'
import type { AnalysisTargetState } from './analysis-selection.ts'
import { ChatsSessionRow } from './chats-session-row.tsx'
import { mergeSessionHead } from './session-list.ts'
import { useChatsMessageVirtualizer } from './chats-message-virtualizer.ts'
import { useChatsMessageLocate } from './chats-message-locate.ts'
import { centeredWindow, VIEWER_MAX_SOURCES } from '../media-viewer/viewer-model.ts'
import { useKeepAliveActive } from './keep-alive.tsx'
import { useMessageFileSaveTask } from './message-file-save.ts'

/** Match visible name, enterprise, and summary in the session list. */
function sessionMatchesSearch(session: WechatSession, query: string): boolean {
  return (session.displayName || session.username).toLowerCase().includes(query)
    || (session.enterpriseName || '').toLowerCase().includes(query)
    || (session.summary || '').toLowerCase().includes(query)
}




















































/** External navigation target: open a session and (optionally) locate a message. */
export type ChatTarget = ChatNavigationTarget

/** Session/message state owned by the chats panel. */
function useChatsPanelState(initialView: ChatView) {
  const keepAliveActive = useKeepAliveActive()
  const [view, setView] = useState<ChatView>(() => initialView)
  const [sessions, setSessions] = useState<readonly WechatSession[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [curSession, setCurSession] = useState<WechatSession | null>(null)
  /** 单聊「聊天信息」抽屉（P2-6）：与 groupInfoOpen 对称的 private-only 状态。 */
  const [contactInfoOpen, setContactInfoOpen] = useState(false)
  const [messages, setMessages] = useState<readonly WechatMessage[]>([])
  const [msgLoading, setMsgLoading] = useState(false)
  const [msgError, setMsgError] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [cursor, setCursor] = useState(0)
  /** 复合游标的第二段（上一页最后一行的 local_id）；必须与 cursor 成对回传。 */
  const [cursorLocalId, setCursorLocalId] = useState<number | undefined>(undefined)
  /** 头部「更多」溢出菜单（导出/已编辑/清空草稿）。 */
  const [moreOpen, setMoreOpen] = useState(false)
  /** Highest sort_seq already loaded; the incremental-poll watermark. */
  const watermarkRef = useRef(0)
  /** 与 watermarkRef 成对的 local_id：sort_seq 重复时靠它继续向后读。 */
  const watermarkLocalIdRef = useRef(0)
  const inFlightRef = useRef(false)
  /** 会话归属令牌：挡住在途请求把上一位聊天对象的消息写进当前会话。 */
  const sessionEpochRef = useRef(0)
  const [sessionEpoch, setSessionEpoch] = useState(0)
  const messagesTalkerRef = useRef<string | null>(null)
  /**
   * 右栏「回复助手」是否打开。
   *
   * 2026-11-18 起右栏只有**一个**面板：里面同时有「这条消息怎么理解」（分析）与
   * 「可以这样回」（候选回复）。此前是两个布尔开关（推荐 / 分析）互相排斥，
   * 用户要来回开菜单才知道另一块在哪，窄屏下还互相挤压。
   */
  const [analysisPaneOpen, setAnalysisPaneOpen] = useState(false)
  const [analysisTarget, setAnalysisTarget] = useState<AnalysisTargetState | null>(null)
  const [aiOpen, setAiOpen] = useState(false)
  const [aiFull, setAiFull] = useState(false)
  const [pollStatus, setPollStatus] = useState<string>('')
  const [selfWxid, setSelfWxid] = useState('')
  const [typeStats, setTypeStats] = useState<readonly { type: number; label: string; count: number }[]>([])
  const msgEndRef = useRef<HTMLDivElement>(null)
  const [viewer, setViewer] = useState<{ images: ViewerImage[]; index: number } | null>(null)
  const [pinnedCollapsed, setPinnedCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem('wc_pinned_collapsed') === '1' } catch { return false }
  })

  const setWatermarkFrom = (list: readonly WechatMessage[]): void => {
    let watermark = watermarkRef.current
    // watermarkRef 归零 = 刚开始读一个新会话，上一会话的第二段游标必须一起归零。
    let localId = watermark === 0 ? 0 : watermarkLocalIdRef.current
    for (const message of list) {
      const seq = message.sortSeq ?? 0
      if (seq > watermark) {
        watermark = seq
        localId = message.localId
      } else if (seq === watermark && message.localId > localId) {
        localId = message.localId
      }
    }
    watermarkRef.current = watermark
    watermarkLocalIdRef.current = localId
  }

  const sessionAlive = (epoch: number, talker: string): boolean => (
    sessionEpochRef.current === epoch && messagesTalkerRef.current === talker
  )

  /**
   * 会话归属令牌的「渲染期镜像」。
   *
   * `sessionEpoch` 是状态，`sessionEpochRef` 是同步令牌：`beginSession` 先推进 ref、
   * 再通过 `onSessionBegin` 推状态。两者之间如果发生一次渲染，`curSession` 已经是
   * 新会话、`messages` 还是上一个会话的那一份 —— 消息流会以「新会话的标题 + 旧会话的
   * 消息」画出一帧，正是用户看到的「原界面的消息被带到了第二个界面」。
   * 用 ref 记下当前 epoch，让 `messagesMatchSession` 在状态追上之前一律判为不匹配。
   */
  const messagesEpochRef = useRef(0)
  const onSessionBegin = useCallback((epoch: number): void => {
    messagesEpochRef.current = epoch
    setSessionEpoch(epoch)
  }, [])

  /** 当前消息列表是否属于正在显示的会话（身份 + 纪元；定义理由见 `messagesEpochRef`）。 */
  const messagesMatchSession = curSession !== null
    && messagesTalkerRef.current === curSession.username
    && messagesEpochRef.current === sessionEpoch

  const closeCurrentSession = useCallback((): void => {
    sessionEpochRef.current += 1
    messagesEpochRef.current = sessionEpochRef.current
    setSessionEpoch(sessionEpochRef.current)
    messagesTalkerRef.current = null
    inFlightRef.current = false
    watermarkRef.current = 0
    watermarkLocalIdRef.current = 0
    setCurSession(null)
    setMessages([])
    setHasMore(false)
    setCursor(0)
    setCursorLocalId(undefined)
    setTypeStats([])
    setMsgError(null)
    setMsgLoading(false)
    setSelfWxid('')
    setPollStatus('')
    setViewer(null)
    stopCurrentVoice()
  }, [])

  // 隐藏的 keep-alive 面板不能继续持有全屏查看器或已解码音频。
  useEffect(() => {
    if (keepAliveActive) return
    setViewer(null)
    stopCurrentVoice()
  }, [keepAliveActive])

  const openViewer = useCallback((message: WechatMessage): void => {
    const imageMessages = messages.filter((item) => item.type === 3)
    const clicked = imageMessages.findIndex((item) => item.localId === message.localId)
    if (clicked < 0) return
    const range = centeredWindow(imageMessages.length, clicked, Math.floor((VIEWER_MAX_SOURCES - 1) / 2))
    const images: ViewerImage[] = imageMessages
      .slice(range.start, range.end)
      .map((item) => ({ username: curSession?.username ?? '', localId: item.localId }))
    setViewer({ images, index: range.index })
  }, [messages, curSession])

  return {
    view, setView, sessions, setSessions, search, setSearch, loading, setLoading, error, setError,
    curSession, setCurSession, contactInfoOpen, setContactInfoOpen, messages, setMessages,
    msgLoading, setMsgLoading, msgError, setMsgError, hasMore, setHasMore, cursor, setCursor,
    cursorLocalId, setCursorLocalId, moreOpen, setMoreOpen, watermarkRef, watermarkLocalIdRef, inFlightRef,
    messagesMatchSession,
    sessionEpochRef, sessionEpoch, setSessionEpoch, messagesTalkerRef, messagesEpochRef, onSessionBegin,
    analysisPaneOpen, setAnalysisPaneOpen, analysisTarget, setAnalysisTarget, aiOpen, setAiOpen,
    aiFull, setAiFull, pollStatus, setPollStatus, selfWxid, setSelfWxid, typeStats, setTypeStats,
    msgEndRef, viewer, setViewer, pinnedCollapsed, setPinnedCollapsed, setWatermarkFrom,
    sessionAlive, closeCurrentSession, openViewer,
  }
}

const EXPO_TYPES: ReadonlyArray<{ key: string; label: string; types?: readonly number[]; rich?: readonly string[] }> = [
  { key: 'text', label: '文本', types: [1] },
  { key: 'image', label: '图片', types: [3] },
  { key: 'emoji', label: '表情', types: [47] },
  { key: 'video', label: '视频', types: [43] },
  { key: 'voice', label: '语音', types: [34] },
  { key: 'chatlog', label: '聊天记录', rich: ['chatlog'] },
  { key: 'transfer', label: '转账', rich: ['transfer'] },
  { key: 'redpacket', label: '红包', rich: ['redpacket'] },
  { key: 'file', label: '文件', rich: ['file'] },
  { key: 'link', label: '链接', rich: ['link'] },
  { key: 'quote', label: '引用', rich: ['quote'] },
  { key: 'system', label: '系统', types: [10000, 10002] },
  { key: 'call', label: '通话', types: [50] },
]

interface ChatsSessionEffectOptions {
  sessionSearch: string
  sessionSearching: boolean
  sessionsPager: ReturnType<typeof usePagedList<WechatSession>>
  setSessions: React.Dispatch<React.SetStateAction<readonly WechatSession[]>>
  setLoading: React.Dispatch<React.SetStateAction<boolean>>
  setError: React.Dispatch<React.SetStateAction<string | null>>
}

function useChatsSessionEffects({
  sessionSearch,
  sessionSearching,
  sessionsPager,
  setSessions,
  setLoading,
  setError,
}: ChatsSessionEffectOptions): void {
  useEffect(() => {
    setError(null)
    if (sessionSearching) {
      let cancelled = false
      // 列表本身已按关键词本地过滤，服务端检索只用于补全「已加载 500 条之外」的结果。
      // 每个按键都发一次 = 输入 “abc” 白跑 3 次 500 条查询；250ms 合并成一次。
      const timer = setTimeout(() => {
        setLoading(true)
        void apiGetSessions({ keyword: sessionSearch.trim(), limit: 500 })
          .then((env) => {
            if (!cancelled) setSessions(env.sessions)
          })
          .catch((error: unknown) => { if (!cancelled) setError((error as Error).message) })
          .finally(() => { if (!cancelled) setLoading(false) })
      }, 250)
      return () => { cancelled = true; clearTimeout(timer) }
    }
    sessionsPager.reset()
    return undefined
  }, [sessionSearching, sessionSearch, sessionsPager.reset])

  useEffect(() => {
    if (sessionSearching) return
    setSessions(sessionsPager.items)
    setLoading(sessionsPager.loading)
    setError(sessionsPager.error)
  }, [sessionSearching, sessionsPager.items, sessionsPager.loading, sessionsPager.error])

}

function useChatsSessionDerived(
  sessions: readonly WechatSession[],
  search: string,
  view: ChatView,
  aiOnly: boolean,
  aiReplyEnabledUsernames: ReadonlySet<string>,
) {
  const filtered = useMemo(() => {
    const base = view === 'chats' ? sessions : sessions.filter((session) => sessionInView(session, view))
    const scoped = aiOnly
      // 与 chip 计数、行内徽标共用同一个判据（`sessionHasAiReply`），
      // 避免「筛选结果比显示的数字多」这类不一致。
      ? base.filter((session) => sessionHasAiReply(session, aiReplyEnabledUsernames))
      : base
    const query = search.trim().toLowerCase()
    if (!query) return scoped
    return scoped.filter((session) => sessionMatchesSearch(session, query))
  }, [aiOnly, aiReplyEnabledUsernames, sessions, search, view])

  const { pinnedList, normalList } = useMemo(() => {
    const pinned: WechatSession[] = []
    const normal: WechatSession[] = []
    for (const session of filtered) {
      if (session.pinned) pinned.push(session)
      else normal.push(session)
    }
    return { pinnedList: pinned, normalList: normal }
  }, [filtered])

  const stats = useMemo(() => ({
    friends: sessions.filter((session) => session.type === 'private').length,
    groups: sessions.filter((session) => session.type === 'group').length,
    unread: sessions.reduce((total, session) => total + (session.unreadCount || 0), 0),
  }), [sessions])

  return { filtered, pinnedList, normalList, stats }
}

function useChatsAvatarPrefetch(
  sessions: readonly WechatSession[],
  messages: readonly WechatMessage[],
  curSession: WechatSession | null,
  setAvatarVersion: React.Dispatch<React.SetStateAction<number>>,
): void {
  useEffect(() => {
    // 只扫最近一小段消息：更早消息的发送者在它们首次出现的那些拍里已经预取过，
    // 每拍都把整段已加载历史（可能几千条）平铺一遍纯属重复劳动。
    const recent = messages.length > 200 ? messages.slice(-200) : messages
    const keys = [
      ...sessions.map((session) => session.username),
      ...recent.map((message) => message.sender ?? ''),
      ...(curSession ? [curSession.username] : []),
    ]
    const unique = [...new Set(keys.filter(Boolean))].filter((username) => avatarCache.get(username) === undefined)
    if (unique.length === 0) return
    const batch = unique.slice(0, 60)
    void apiGetAvatarsLocal({ usernames: batch })
      .then((map) => {
        let changed = false
        for (const username of batch) {
          if (!avatarCache.has(username)) {
            cacheBounded(avatarCache, username, map[username] ?? null, AVATAR_CACHE_MAX)
            changed = true
          }
        }
        if (changed) setAvatarVersion((version) => version + 1)
      })
      .catch(() => { /* individual Avatar fallback covers misses */ })
  }, [sessions, messages, curSession])
}

/** Sessions list paging and its refresh callback, kept together with the page loader. */
function useChatsSessionsPager() {
  const sessionsPager = usePagedList<WechatSession>({
    pageSize: 120,
    maxItems: 600,
    refreshMinIntervalMs: SESSIONS_REFRESH_MIN_INTERVAL_MS,
    // 宿主事件已经由后端按 WAL 写簇合并；这里不再叠加 50ms 窗口。
    refreshDebounceMs: 0,
    // 实时刷新只取最新一页再原地合并，避免 600 条时重拉 5 页、整表换对象。
    refreshPageLimit: 120,
    mergeItems: mergeSessionHead,
    fetchPage: async (offset, limit) => {
      // 事件驱动路径必须绕过 30 秒 persistent cache；后端自己的按文件签名缓存仍会兜底。
      const env = await apiGetSessions({ limit, offset, fresh: true })
      return { items: env.sessions, total: env.total }
    },
  })

  /**
   * Refresh the visible list without resetting it to the loading skeleton.
   * Filter/category changes intentionally use the pager's `reset()` path instead.
   */
  const reloadSessionsList = useCallback((): void => {
    sessionsPager.refresh()
  }, [sessionsPager.refresh])

  return { sessionsPager, reloadSessionsList }
}

interface ChatsSessionRowRendererDeps {
  curSession: WechatSession | null
  batchMode: boolean
  selected: ReadonlySet<string>
  selfWxid: string
  aiReplyEnabledUsernames: ReadonlySet<string>
  openSession: (session: WechatSession) => Promise<void>
  toggleSelect: (username: string) => void
}

/** Build the session-row renderer from the panel's current selection state. */
function makeChatsSessionRowRenderer(deps: ChatsSessionRowRendererDeps): (session: WechatSession, itemIndex?: number) => React.JSX.Element {
  const { curSession, batchMode, selected, selfWxid, aiReplyEnabledUsernames, openSession, toggleSelect } = deps
  return (session, itemIndex) => (
    <ChatsSessionRow
      key={session.username}
      session={session}
      itemIndex={itemIndex}
      active={curSession?.username === session.username}
      batchMode={batchMode}
      selected={selected.has(session.username)}
      selfWxid={selfWxid}
      aiReplyEnabled={sessionHasAiReply(session, aiReplyEnabledUsernames)}
      onOpen={(next) => { void openSession(next) }}
      onToggle={toggleSelect}
    />
  )
}








/**
 * Render the chats panel.
 * @param props - optional view filter for subscription tabs and an external
 *   navigation target (records/privacy/ask jump into a session + message).
 * @returns the chats element tree.
 */
export function ChatsPanel({ initialView = 'chats', initialTarget, onInitialTargetHandled }: {
  initialView?: ChatView
  initialTarget?: ChatTarget | null
  onInitialTargetHandled?: (nonce: number) => void
}): React.JSX.Element {
  /** 应用内确认框（替代原生 window.confirm）。 */
  const confirm = useConfirm()
  const {
    view, setView, sessions, setSessions, search, setSearch, loading, setLoading, error, setError,
    curSession, setCurSession, contactInfoOpen, setContactInfoOpen, messages, setMessages,
    msgLoading, setMsgLoading, msgError, setMsgError, hasMore, setHasMore, cursor, setCursor,
    cursorLocalId, setCursorLocalId, moreOpen, setMoreOpen, watermarkRef, watermarkLocalIdRef, inFlightRef,
    messagesMatchSession,
    sessionEpochRef, sessionEpoch, messagesTalkerRef, messagesEpochRef, onSessionBegin,
    analysisPaneOpen, setAnalysisPaneOpen, analysisTarget, setAnalysisTarget, aiOpen, setAiOpen,
    aiFull, setAiFull, pollStatus, setPollStatus, selfWxid, setSelfWxid, typeStats, setTypeStats,
    msgEndRef, viewer, setViewer, pinnedCollapsed, setPinnedCollapsed, setWatermarkFrom,
    sessionAlive, closeCurrentSession, openViewer,
  } = useChatsPanelState(initialView)

  const { sessionsPager, reloadSessionsList } = useChatsSessionsPager()

  /** Clear the current session's draft (only the local decrypted copy). */
  const { clearAllDrafts, clearDraft, copyMsgJson, doReset, editNotice, editedIds, editedOpen, editing, edits, flashEditNotice, loadEdits, msgMenu, openEdits, reloadCurrent, searchMode, sessionListRef, setEditedOpen, setMsgMenu, setSearchMode } = useChatsEdit({ confirm, curSession, reloadSessionsList, selfWxid, sessionAlive, sessionEpochRef, setCursor, setCursorLocalId, setHasMore, setMessages, setSelfWxid, setTypeStats, setWatermarkFrom })
  const msgMenuTriggerRef = useRef<HTMLElement | null>(null)
  const msgMenuRestoreFocusRef = useRef(false)
  const { controller: messageTools, poster: messagePoster, openInfo, openEditor, openPoster, openSource } = useChatsMessageTools({ curSession, flash: flashEditNotice, reloadCurrent, loadEdits })
  const { notice: actionNotice, flash: flashActionNotice } = useActionNotice()
  const messageFileSave = useMessageFileSaveTask(flashActionNotice, curSession?.username)

  // ── group chat info panel (群聊信息) ──
  const { annExpanded, chatlogStack, filteredMembers, groupInfo, groupInfoErr, groupInfoLoading, groupInfoOpen, groupInfoTitleId, hideMemberProfile, memberExpanded, memberLimit, memberQuery, memberSearch, memberTotal, profileMember, profilePos, setAnnExpanded, setChatlogStack, setGroupInfo, setGroupInfoErr, setGroupInfoLoading, setGroupInfoOpen, setMemberExpanded, setMemberSearch, setProfileMember, showMemberProfile, shownMembers } = useChatsGroupInfo({ talkerRef: messagesTalkerRef, sessionAlive, sessionEpochRef })
  const [annCanExpand, setAnnCanExpand] = useState(false)
  const annRef = useRef<HTMLDivElement | null>(null)
  const [chatlogResolving, setChatlogResolving] = useState(false)
  const { EXPO_FORMATS, batchExportState, batchExporting, batchFinishing, batchMode, cancelBatchExport, cancelExport, chooseExportDir, expCount, expDir, expFilename, expFormat, expFrom, expTo, expTypes, expZip, exportBatch, exportMsg, exportOpen, exportSession, exportState, finishing, openNestedChatlog, pickingDir, selected, setAvatarVersion, setBatchMode, setExpCount, setExpFilename, setExpFormat, setExpFrom, setExpTo, setExpTypes, setExpZip, setExportOpen, setSelected, togglePinned, toggleSelect } = useChatsExport({ EXPO_TYPES, chatlogResolving, curSession, setChatlogResolving, setChatlogStack, setPinnedCollapsed })
  const { buildIndex, cancelIndexBuild, cancelMsgSearch, indexProgress, calOpen, checkIndexStatus, indexBuilding, msgHits, msgIndexed, msgSearchError, msgSearchLoading, msgSearched, onSearchInput, setCalOpen } = useChatsMsgSearch({ notify: flashActionNotice, chatlogStack, editedOpen, exportOpen, setChatlogStack, setEditedOpen, setExportOpen })
  const chatlogOpen = chatlogStack.at(-1) ?? null
  const sessionSearch = searchMode === 'session' ? search : ''
  const sessionSearching = sessionSearch.trim() !== ''
  useChatsSessionEffects({
    sessionSearch,
    sessionSearching,
    sessionsPager,
    setSessions,
    setLoading,
    setError,
  })

  const sessionsLoadMoreRef = useLazySentinel(() => { if (sessionsPager.hasMore && !sessionsPager.loadingMore) sessionsPager.loadMore() }, '600px 0px', () => sessionListRef.current, sessionsPager.items.length)

  // 搜索索引状态只在用户切到「消息搜索」时检查，进入页签不再触发。
  useEffect(() => { if (searchMode === 'message') void checkIndexStatus() }, [searchMode, checkIndexStatus])
  // 已编辑消息列表仅在打开某个会话时按需加载，避免进入页签就拉全量已编辑记录。
  // 会话内「已编辑」徽标仍会在进入会话后正常出现。
  useEffect(() => { if (curSession) void loadEdits() }, [curSession, loadEdits])

  useChatsAvatarPrefetch(sessions, messages, curSession, setAvatarVersion)

  const aiReplyControls = useChatsAiReplyControls({
    view,
    sessions,
    curSession,
    selfWxid,
    sessionEpoch,
    alive: sessionAlive,
    onNotice: flashActionNotice,
  })
  const { filtered, pinnedList, normalList, stats } = useChatsSessionDerived(
    sessions,
    search,
    view,
    aiReplyControls.aiOnly,
    aiReplyControls.enabledUsernames,
  )

  /**
   * AI 入口的可见性：单聊与群聊才有「这段聊天」的语义；
   * 公众号/服务号/客服是单向广播，问答没有意义，不给入口。
   */
  const aiEligible = curSession !== null && sessionIsConversational(curSession)

  /**
   * AI 面板的读取范围：**就是当前打开的会话**。
   * 不给下拉选择——面板与右侧消息流是同一个会话，两者范围必须一致，
   * 否则会出现「看着 A 的聊天、问的却是 B」这种无法自证的错位。
   */
  const aiTarget = curSession

  const {
    start: sessStart,
    count: sessCount,
    beforeHeight: sessBeforeHeight,
    sentinelRef: sessSentinel,
    topSentinelRef: sessTopSentinel,
  } = useProgressiveList(normalList.length, 120, {
    maxCount: 300,
    resetKey: `${view}\u0000${search}`,
    listRef: sessionListRef,
  })

  /**
   * 消息流的滚动容器与**虚拟化**（N18）。
   *
   * 为什么改：原先是「渐进窗口」（`useProgressiveList(count, 120)`，向上滚动只增不减）——
   * 把一段历史滚过一遍之后，DOM 会把整段都留着（实测 1 万条消息 = **9,700** 个节点，
   * `scripts/longlist-virtualization-e2e.mjs` 的基线就是这么量的）。现在按视口渲染：
   * 只挂载可见范围 + overscan，节点数与历史长度解耦；`#msg-<localId>` 锚点、跳到某条消息、
   * 回到底部这些既有交互分别由 `locateMessage` 与末尾哨兵保持可用。
   */
  const msgScrollRef = useRef<HTMLDivElement | null>(null)
  const msgVirtualListRef = useRef<HTMLDivElement | null>(null)
  /** 虚拟列表前面还有“加载更多”等正常流内容；TanStack 需要这段偏移量。 */
  const msgVirtualScope = (curSession?.username ?? '') + '\u0000' + String(sessionEpoch)
  const { msgItems, msgScrollMargin, msgVirtualizer } = useChatsMessageVirtualizer({
    messages,
    scopeKey: msgVirtualScope,
    scrollRef: msgScrollRef,
    listRef: msgVirtualListRef,
    layoutVersion: { messagesMatchSession, hasMore, msgError, msgLoading },
  })
  /**
   * Queue a locate request instead of resolving it against the current
   * `msgItems`. Async session loaders call this before React has rendered the
   * newly loaded window; the effect below consumes it with the latest
   * virtualizer and item list.
   * @param localId - target message local_id.
   * @param scopeKey - optional session scope (`username + epoch`).
   */
  const locateMessage = useChatsMessageLocate({
    items: msgItems,
    scopeKey: msgVirtualScope,
    virtualizer: msgVirtualizer,
  })

  const copyMsgText = useCallback((t: string): void => { copyTextWithNotice(t, flashActionNotice) }, [flashActionNotice])

  /**
   * 在光标处打开消息菜单：桌面端右键、手机端长按（两个入口共用，见 MsgMenuAnchor）。
   * 坐标夹进视口（留 8px 余量）。高度按条目数估算：估大了只是留白，估小了最后一条
   * 会被挤出视口，所以按菜单常量逐条累加，菜单本体另有 max-height + overflow 兜底。
   * ≤560 那档坐标不算数：菜单是贴底 sheet（44px 触摸目标会让桌面档的估算偏小）。
   * @param ev - 右键或长按事件（只取坐标与 preventDefault）。
   * @param m - the target message.
   * @param kind - its render kind.
   */
  const openMsgMenu = useCallback((ev: MsgMenuAnchor, m: WechatMessage, kind: RenderKind): void => {
    ev.preventDefault()
    msgMenuTriggerRef.current = ev.currentTarget instanceof HTMLElement ? ev.currentTarget : null
    msgMenuRestoreFocusRef.current = false
    const estH = buildMsgMenu(m, kind).length * MSG_MENU_ITEM_HEIGHT + 10
    const x = Math.max(8, Math.min(ev.clientX, window.innerWidth - MSG_MENU_WIDTH - 8))
    const y = Math.max(8, Math.min(ev.clientY, window.innerHeight - estH - 8))
    setMsgMenu({ x, y, m, kind })
  }, [])

  /**
   * Esc/点空白关闭消息菜单：记录归还焦点意图并卸载菜单，下一帧再聚焦触发消息行。
   * 菜单项动作走 `onClose`，不恢复焦点，避免抢走动作刚打开的新界面。
   */
  const dismissMsgMenu = useCallback((): void => {
    msgMenuRestoreFocusRef.current = true
    setMsgMenu(null)
  }, [setMsgMenu])

  /** 菜单项分发：把「声明式条目」落到具体的面板动作上。 */
  const { changeView, jumpToLatest, loadMore, newMsgCount, openChatlog, openGroupInfo, openSession, openSessionAndLocate, renderMsgItem } = useChatsThread({ annExpanded, annRef, closeCurrentSession, curSession, cursor, cursorLocalId, editedIds, groupInfo, groupInfoOpen, hasMore, inFlightRef, initialTarget, initialView, locateMessage, messages, messagesTalkerRef, moreOpen, msgListRef: msgVirtualListRef, msgLoading, msgScrollRef, openMsgMenu, openViewer, selfWxid, sessionAlive, sessionEpochRef, sessions, setAnnCanExpand, setAnnExpanded, setChatlogStack, setCurSession, setCursor, setCursorLocalId, setGroupInfo, setGroupInfoErr, setGroupInfoLoading, setGroupInfoOpen, setHasMore, setMemberExpanded, setMemberSearch, setMessages, setMoreOpen, setMsgError, setMsgLoading, setMsgMenu, setPollStatus, setProfileMember, setSelfWxid, setTypeStats, setView, setWatermarkFrom, view, watermarkRef, watermarkLocalIdRef, onInitialTargetHandled, onSessionBegin })
const {
    calActiveDays, calAvg, calCounts, calDays, calFirstDow, calHeat, calLoading, calMonth, calTop, calTotal, calYear,
    jumpToDay, openCalendar, refreshCurrentMonth, switchCalMonth,
  } = useChatsCalendar({ curSession, openSessionAndLocate, setCalOpen, setMsgError })
  const runMenuAction = useChatsMenuAction({ copyText: copyMsgText, copyJson: copyMsgJson, openLink, openViewer, openFile: messageFileSave.open, openChatlog: m => { if (m.rich) openChatlog(m.rich) }, openPoster, openSource, openInfo, openEditor })

  /** 菜单打开期间：滚动、改窗口大小关闭它；Esc/外点由菜单组件统一处理。 */
  useEffect(() => {
    if (!msgMenu) return
    const close = (): void => { setMsgMenu(null) }
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [msgMenu])

  // 菜单从 DOM 移除后的下一帧再聚焦：外点自己的默认聚焦发生在本轮事件末尾，
  // 同步 focus 仍会被它抢走。
  useEffect(() => {
    if (msgMenu || !msgMenuRestoreFocusRef.current) return
    msgMenuRestoreFocusRef.current = false
    const trigger = msgMenuTriggerRef.current
    msgMenuTriggerRef.current = null
    if (!trigger?.isConnected) return
    const frame = requestAnimationFrame(() => {
      if (trigger.isConnected) trigger.focus({ preventScroll: true })
    })
    return () => { cancelAnimationFrame(frame) }
  }, [msgMenu])

  const renderSession = makeChatsSessionRowRenderer({ curSession, batchMode, selected, selfWxid, openSession, toggleSelect, aiReplyEnabledUsernames: aiReplyControls.enabledUsernames })

  // 群成员搜索：命中集合、展示上限、「查看更多」的文案都从同一份过滤结果算，
  // 否则会出现「搜出 24 个却写 256 人」这种数字自相矛盾（审计 P1-4）。
  // 换会话收起所有「装着上一个会话内容」的浮层（清单与理由见 chats-session-scope.ts）。
  // 两块右栏的开/关**不**在此列：默认关、头部按钮是唯一入口，选择跟着人走（2026-10-13 反转）。
  const closeMessageTool = messageTools.closeNow
  useEffect(() => {
    resetSessionOverlays({ setAnalysisTarget, setViewer, setChatlogStack, setMsgMenu, closeMessageTool, setEditedOpen, stopVoice: stopCurrentVoice })
  }, [curSession?.username, closeMessageTool])

  const viewState: React.ComponentProps<typeof ChatsView>['state'] = {
    calendar: { calActiveDays, calAvg, calCounts, calDays, calFirstDow, calHeat, calLoading, calMonth, calOpen, calTop, calTotal, calYear, jumpToDay, refreshCurrentMonth, setCalOpen, switchCalMonth },
    edited: { doReset, editedOpen, editing, edits, setEditedOpen },
    exportDialog: { EXPO_FORMATS, EXPO_TYPES, cancelExport, chooseExportDir, expCount, expDir, expFilename, expFormat, expFrom, expTo, expTypes, expZip, exportOpen, exportState, exportSession, finishing, pickingDir, setExpCount, setExpFilename, setExpFormat, setExpFrom, setExpTo, setExpTypes, setExpZip, setExportOpen },
    groupInfo: { annCanExpand, annExpanded, annRef, filteredMembers, groupInfo, groupInfoErr, groupInfoLoading, groupInfoTitleId, hideMemberProfile, memberExpanded, memberQuery, memberSearch, memberTotal, onExport: () => setExportOpen(true), setAnnExpanded, setGroupInfoOpen, setMemberExpanded, setMemberSearch, setProfileMember, showMemberProfile, shownMembers },
    aiEligible, aiFull, aiOpen, aiTarget, analysisPaneOpen, analysisTarget, batchMode, buildIndex, changeView, chatlogOpen, chatlogResolving, chatlogStack, clearAllDrafts, clearDraft, contactInfoOpen, curSession, dismissMsgMenu, error, exportBatch, exportMsg, filtered, groupInfoOpen, hasMore, indexBuilding, jumpToLatest, loadMore, loading, memberLimit, messages, messagesMatchSession, moreOpen, msgEndRef, msgError, msgHits, msgIndexed, msgItems, msgLoading, msgMenu, msgScrollRef, msgSearchError, msgSearchLoading, msgSearched, msgVirtualizer, newMsgCount, normalList, onSearchInput, openCalendar, openEdits, openGroupInfo, openNestedChatlog, openSession, openSessionAndLocate, pinnedCollapsed, pinnedList, pollStatus, profileMember, profilePos, reloadCurrent, renderMsgItem, renderSession, runMenuAction, search, searchMode, selected, sessBeforeHeight, sessCount, sessSentinel, sessStart, sessTopSentinel, sessionListRef, sessionSearching, sessionsLoadMoreRef, sessionsPager, setAiFull, setAiOpen, setAnalysisPaneOpen, setAnalysisTarget, setBatchMode, setChatlogStack, setContactInfoOpen, setMoreOpen, setMsgMenu, setSearch, setSearchMode, setSelected, setViewer, stats, togglePinned, typeStats, view, viewer,
  }

  // 编辑/草稿与复制/打开文件共用一条回执（同一时刻不会同时做两件事；都有值时编辑优先）。
  const headerNotice = editNotice ?? actionNotice

  return (
    <ChatsView
      state={viewState}
      batchExport={{
        state: batchExportState,
        running: batchExporting,
        finishing: batchFinishing,
        onCancel: cancelBatchExport,
      }}
      messageTools={messageTools}
      messagePoster={messagePoster}
      notice={headerNotice}
      indexProgress={indexProgress}
      onCancelIndexBuild={cancelIndexBuild}
      onCancelMsgSearch={cancelMsgSearch}
      onBackToList={closeCurrentSession}
      aiReply={aiReplyControls.aiReply}
      aiReplyFilter={aiReplyControls.aiReplyFilter}
      messageFileSave={messageFileSave}
      messageVirtualization={{ listRef: msgVirtualListRef, scrollMargin: msgScrollMargin }}
    />
  )
}
