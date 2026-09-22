/**
 * 聊天面板 —— React 版，忠实迁移 WeChatPanel 的 chats 页签核心：左侧会话
 * 列表（搜索/统计/置顶/批量导出），右侧消息流（分页加载 + 多类型消息渲染）。
 * 数据通过 DSH 后端 Remote（sessions + messages）。
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { LazyMount, ListSentinel, ListSkeleton, useLazySentinel, usePagedList, useProgressiveList } from './hooks.tsx'
import { messagesMatchTalker } from './msg-scope.ts'
import { SessionAsk } from './SessionAsk.tsx'
import { ReplySuggest } from './ReplySuggest.tsx'
import { clickableKey, DateRangeField, Dialog, SearchInput, Segmented, useDialogFocus, useEscapeToClose } from '../ui/kit.tsx'
import { useConfirm } from '../ui/confirm.tsx'
import { apiBuildSearchIndex, apiCancelSearch, apiClearAllSessionDrafts, apiClearSessionDraft, apiEditChatMessage, apiExportSessionMessages, apiGetAvatar, apiGetAvatarsLocal, apiGetDailyCounts, apiGetEmoticonDataUrl, apiGetGroupInfo, apiGetImageDataUrl, apiGetImageOriginal, apiGetMessageFile, apiGetMessages, apiGetNewMessages, apiGetPaymentStatus, apiGetSearchIndexStatus, apiGetSessions, apiGetVideoInfo, apiGetVoiceDataUrl, apiGetVoiceInfo, apiGetVoiceTranscript, apiListEditedMessages, apiOpenPath, apiResetEditedMessage, apiResolveChatHistory, apiSearchMessages, apiTranscribeVoiceMessage, pickDirectory, readRenderCache, writeRenderCache } from '../api.ts'
import type { ChatlogRecord, EditedMessageRecord, GroupInfo, GroupMember, MessageRenderKind as RenderKind, MessageRich, PaymentStatus, SearchHit, WechatMessage, WechatSession } from '@deepseek-ai/dsh-wechat-data/types'
import {
  IconChevronLeftOutline14, IconChevronRightOutline14, IconCloseOutline16,
  IconDataOutline16, IconDownloadOutline16, IconEllipsisOutline16,
  IconFullscreenOutline16, IconLinkOutline14, IconListPenOutline16,
  IconPlayOutline16, IconPlusOutline16, IconSearchOutline16, IconTrashOutline16, IconUserOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { RainWindow } from './rain-window.tsx'
import { ChatsView } from './chats-view.tsx'
import { useChatsMsgSearch } from './chats-msg-search.tsx'
import { useChatsGroupInfo } from './chats-group-info.tsx'
import { useChatsEdit } from './chats-edit.tsx'
import { useChatsExport } from './chats-export.tsx'
// 类型与值要分开转发：`ChatView`/`ViewerImage` 是 type，Rollup 找不到运行期导出会直接构建失败
export type { ChatView } from './chats-support.tsx'
export { isEnterpriseChat } from './chats-support.tsx'
export type { ViewerImage } from './chats-media.tsx'
import type { ChatView } from './chats-support.tsx'
import { AVATAR_CACHE_MAX, Avatar, FILE_STYLE, IconCalendar, IconCallMissedOutline, IconCallOutline, IconImage, IconMinus, IconPin, MsgMenuAction, MsgMenuItem, POLL_HIDDEN_MS, POLL_VISIBLE_MS, TransferArrowGlyph, TransferCheckGlyph, avatarCache, buildMsgMenu, decodeEntities, downloadMessageFile, estimateMsgItemHeight, fileStyle, isEnterpriseChat, isKefuSession, itemLocalId, liveStatusText, msgItemKey, openLink, quoteTypeLabel, sessionInView, transferStateKey, transferStatusLabel, unreadTitle } from './chats-support.tsx'
import { IconQuoteCard, IconVideoCallOutline, IconVoiceWaves, ImageViewer, MessageCall, MessageContact, MessageEmoticon, MessageImage, MessageImageGroup, MessageLocation, MessageSystem, MessageThumb, MessageVideo, MessageVoice, ViewerImage, currentVoiceAudio, fmtCallDuration, quoteKindIcon, voiceWidth } from './chats-media.tsx'
import { CARD_KINDS, CardFoot, LabeledCard, LinkCard, MediaCoverCard, MessageBody, MpArticle, MpNewsCard, OpenFileCard, PayStatusLine, RichCard, mpArticlesOf } from './chats-cards.tsx'
import { cacheBounded } from '../utils/misc.ts'
import { MessageText } from '../utils/message-text.tsx'
import { buildMessageItems, renderKindOf, type MessageRenderItem } from '../utils/message-items.ts'
import { useVirtualizer } from '@tanstack/react-virtual'
import { cspSafeSrc } from '../utils/url.ts'
import kitCss from '../ui/kit.module.css'
import css from './chats.module.css'
import { avatarColors, fmtBytes, fmtDateTimeSec, fmtMsgClockSec, fmtSessionTimeSec } from '../utils/format.ts'






















































/** External navigation target: open a session and (optionally) locate a message. */
export interface ChatTarget {
  username: string
  localId?: number
  /** Monotonic nonce so the same session can be re-targeted. */
  nonce: number
}








/**
 * Render the chats panel.
 * @param props - optional view filter for subscription tabs and an external
 *   navigation target (records/privacy/ask jump into a session + message).
 * @returns the chats element tree.
 */
export function ChatsPanel({ initialView = 'chats', initialTarget }: { initialView?: ChatView; initialTarget?: ChatTarget | null }): React.JSX.Element {
  /** 应用内确认框（替代原生 window.confirm）。 */
  const confirm = useConfirm()
  const [view, setView] = useState<ChatView>(() => initialView)

  const [sessions, setSessions] = useState<readonly WechatSession[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [curSession, setCurSession] = useState<WechatSession | null>(null)
  const [messages, setMessages] = useState<readonly WechatMessage[]>([])
  const [msgLoading, setMsgLoading] = useState(false)
  const [msgError, setMsgError] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [cursor, setCursor] = useState(0)
  /**
   * 复合游标的第二段（上一页最后一行的 local_id）。
   * 只回传 cursor（sort_seq）会在 sort_seq 重复的分页边界上丢消息，
   * 两个值必须成对传回后端。
   */
  const [cursorLocalId, setCursorLocalId] = useState<number | undefined>(undefined)
  /**
   * 实时推送**默认开启，且不再提供开关**（2026-09-20 移除头部的「实时」按钮）。
   *
   * 原先那个按钮把开关写进 `localStorage.wc_realtime`，但它的默认值就是开的，
   * 而「关掉实时推送」这个动作的收益极小（新消息不再自动出现，用户多半会以为是坏了）
   * 却要常驻一个按钮占头部动作区 —— 那个区域本来就是宽度紧张的（见下方「更多」菜单的注释）。
   */
  /** 头部「更多」溢出菜单（导出/已编辑/清空草稿）。 */
  const [moreOpen, setMoreOpen] = useState(false)
  /** Highest sort_seq already loaded; the incremental-poll watermark. */
  const watermarkRef = useRef(0)
  const inFlightRef = useRef(false)
  /**
   * 会话归属令牌 —— 用于挡住「上一个会话的在途取数」写进当前会话。
   *
   * `curSession` 与 `messages` 是两份独立 state，切会话时必然有一段
   * 「curSession 已换、messages 还是上一个人」的窗口。首次/翻页/轮询/对账
   * 都是异步的：如果回来时不校验归属就 setMessages，上一个人的消息就会
   * 出现在当前会话里，并且会被写进**上一个会话的渲染缓存**（`chat-msgs:<talker>`），
   * 于是重开那个会话也还是错的 —— 这是「别人的消息出现在这个聊天界面」的根因。
   *
   * 约定：任何异步取数在**提交 state 之前**必须调用 `sessionAlive(epoch, talker)`；
   * 追加/替换型更新还要在 updater 内部再判一次（updater 可能在切会话之后才被 React 执行）。
   */
  const sessionEpochRef = useRef(0)
  /** 当前 `messages` 所属的 talker；与 sessionEpochRef 同步更新。 */
  const messagesTalkerRef = useRef<string | null>(null)
  /** ── 会话级 AI 面板（「新对话」）──
   *  入口在聊天头部；面板作为第三栏并排。读取范围**恒为当前会话**，线程按会话隔离。 */
  /** 推荐回复面板（单聊）。与 AI 问答面板互斥：两者都是消息流右侧的第三栏。 */
  const [suggestOpen, setSuggestOpen] = useState(false)
  const [aiOpen, setAiOpen] = useState(false)
  const [aiFull, setAiFull] = useState(false)
  const [pollStatus, setPollStatus] = useState<string>('')
  /** Logged-in account wxid (from the messages snapshot) for own avatars. */
  const [selfWxid, setSelfWxid] = useState('')
  const [typeStats, setTypeStats] = useState<readonly { type: number; label: string; count: number }[]>([])
  const msgEndRef = useRef<HTMLDivElement>(null)
  const [viewer, setViewer] = useState<{ images: ViewerImage[]; index: number } | null>(null)
  const [pinnedCollapsed, setPinnedCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem('wc_pinned_collapsed') === '1' } catch { return false }
  })
  const setWatermarkFrom = (list: readonly WechatMessage[]): void => {
    let w = watermarkRef.current
    for (const m of list) if (m.sortSeq && m.sortSeq > w) w = m.sortSeq
    watermarkRef.current = w
  }

  /**
   * 开始一个会话：令牌自增（作废所有在途请求）并声明 `messages` 将归属该 talker。
   * @param talker - 会话 username。
   * @returns 本次令牌，供后续 `sessionAlive` 校验。
   */
  const beginSession = (talker: string): number => {
    sessionEpochRef.current += 1
    messagesTalkerRef.current = talker
    // 上一个会话的在途轮询已被令牌作废，这里放开闸门让新会话立刻可以轮询。
    inFlightRef.current = false
    return sessionEpochRef.current
  }

  /**
   * 在途结果是否仍属于本次会话。
   * @param epoch - 发起请求时拿到的令牌。
   * @param talker - 发起请求时的会话 username。
   * @returns 令牌未变且 talker 未被切走时为 true。
   */
  const sessionAlive = (epoch: number, talker: string): boolean => (
    sessionEpochRef.current === epoch && messagesTalkerRef.current === talker
  )

  /**
   * 关闭当前会话并把归属令牌作废。
   *
   * 用于切换分类视图（公众号/服务号/客服）时：那三个类目互斥，
   * 列表换类目后右侧绝不能留着上一类目的会话 —— 否则会在「客服」视图里
   * 看到某个公众号的聊天，就是「别人的信息出现在这个界面」。
   *
   * 只清理本函数之前声明的 state；依赖于会话的浮层（聊天记录弹窗、右键菜单）
   * 由调用方 changeView 一并收起。
   */
  const closeCurrentSession = useCallback((): void => {
    sessionEpochRef.current += 1
    messagesTalkerRef.current = null
    inFlightRef.current = false
    watermarkRef.current = 0
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
  }, [])

  const openViewer = useCallback((m: WechatMessage): void => {
    const imgs: ViewerImage[] = messages
      .filter(x => x.type === 3)
      .map(x => ({ username: curSession?.username ?? '', localId: x.localId }))
    if (imgs.length === 0) return
    const idx = imgs.findIndex(x => x.localId === m.localId)
    setViewer({ images: imgs, index: idx >= 0 ? idx : 0 })
  }, [messages, curSession])

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

  const sessionsPager = usePagedList<WechatSession>({
    pageSize: 120,
    fetchPage: async (offset, limit) => {
      const env = await apiGetSessions({ limit, offset })
      return { items: env.sessions, total: env.total }
    },
  })

  /**
   * 刷新会话列表（动作后 / 由调用方显式触发）。
   *
   * 用 `refresh()` 而不是 `reset()`：`reset()` 会同步清空列表 → 闪骨架屏 → 内容高度
   * 塌陷把 `scrollTop` 钳到 0（见 `load-page-range.ts` 头部的实测记录）。
   * 筛选/分类真的变了才该回顶部，那条路径单独用 `reset()`。
   */
  const reloadSessionsList = useCallback((): void => {
    sessionsPager.refresh()
  }, [sessionsPager.refresh])

  /** Clear the current session's draft (only the local decrypted copy). */
  const { clearAllDrafts, clearDraft, closeEdit, copyMsgJson, doReset, editAreaRef, editBusy, editErr, editTarget, editText, editedIds, editedOpen, editing, edits, loadEdits, msgMenu, onEditFn, openEdits, saveEdit, searchMode, sessionListRef, setEditText, setEditedOpen, setMsgMenu, setSearchMode } = useChatsEdit({ confirm, curSession, reloadSessionsList, selfWxid, sessionAlive, sessionEpochRef, setCursor, setCursorLocalId, setHasMore, setMessages, setSelfWxid, setTypeStats, setWatermarkFrom })
  const cancelActiveSearch = useCallback((): void => {
    const jobId = activeSearchJobRef.current
    activeSearchJobRef.current = null
    if (jobId === null) return
    void apiCancelSearch({ jobId }).catch(() => { /* 搜索已跑完 —— cancelSearch 会回 ok:false，不是错误 */ })
  }, [])

  // ── group chat info panel (群聊信息) ──
  const { annExpanded, chatlogStack, filteredMembers, groupInfo, groupInfoErr, groupInfoLoading, groupInfoOpen, groupInfoTitleId, hideMemberProfile, memberExpanded, memberLimit, memberQuery, memberSearch, memberTotal, profileMember, profilePos, setAnnExpanded, setChatlogStack, setGroupInfo, setGroupInfoErr, setGroupInfoLoading, setGroupInfoOpen, setMemberExpanded, setMemberSearch, setProfileMember, showMemberProfile, shownMembers } = useChatsGroupInfo({  })
  const [annCanExpand, setAnnCanExpand] = useState(false)
  const annRef = useRef<HTMLDivElement | null>(null)
  const [chatlogResolving, setChatlogResolving] = useState(false)
  const { EXPO_FORMATS, batchExporting, batchMode, batchMsg, chooseExportDir, expCount, expDir, expFilename, expFormat, expFrom, expTo, expTypes, expZip, exportBatch, exportMsg, exportOpen, exportSession, exporting, openNestedChatlog, pickingDir, selected, setAvatarVersion, setBatchMode, setExpCount, setExpFilename, setExpFormat, setExpFrom, setExpTo, setExpTypes, setExpZip, setExportOpen, setSelected, togglePinned, toggleSelect } = useChatsExport({ EXPO_TYPES, chatlogResolving, curSession, setChatlogResolving, setChatlogStack, setPinnedCollapsed })
  const { activeSearchJobRef, buildIndex, calOpen, checkIndexStatus, indexBuilding, msgHits, msgIndexed, msgSearchError, msgSearchLoading, msgSearched, onSearchInput, setCalOpen } = useChatsMsgSearch({ cancelActiveSearch, chatlogStack, editedOpen, exportOpen, setChatlogStack, setEditedOpen, setExportOpen })
  const chatlogOpen = chatlogStack.length > 0 ? chatlogStack[chatlogStack.length - 1] : null
  const [calYear, setCalYear] = useState(new Date().getFullYear())
  const [calMonth, setCalMonth] = useState(new Date().getMonth() + 1)
  const [calCounts, setCalCounts] = useState<Record<string, number>>({})
  const [calLoading, setCalLoading] = useState(false)

  const calTotal = useMemo(() => Object.values(calCounts).reduce((a, b) => a + b, 0), [calCounts])
  const calActiveDays = useMemo(() => Object.values(calCounts).filter(n => n > 0).length, [calCounts])
  const calAvg = useMemo(() => (calActiveDays > 0 ? Math.round(calTotal / calActiveDays) : 0), [calTotal, calActiveDays])
  const calTop = useMemo(() => {
    let best = 0
    let bestDay = 0
    for (const [k, v] of Object.entries(calCounts)) {
      const d = Number(k)
      if (Number.isFinite(d) && v > best) { best = v; bestDay = d }
    }
    return best > 0 ? { day: bestDay, count: best } : null
  }, [calCounts])
  const calFirstDow = useMemo(() => {
    const dow = new Date(calYear, calMonth - 1, 1).getDay()
    return dow === 0 ? 6 : dow - 1
  }, [calYear, calMonth])
  const calDays = useMemo(() => new Date(calYear, calMonth, 0).getDate(), [calYear, calMonth])
  const calHeat = (cnt: number): string => {
    if (cnt <= 0) return 'transparent'
    const alpha = Math.min(0.15 + cnt / 200, 0.85)
    return 'rgba(34, 211, 238, ' + alpha.toFixed(3) + ')'
  }

  const openCalendar = useCallback(async (): Promise<void> => {
    if (!curSession) return
    setCalOpen(true)
    setCalLoading(true)
    setCalCounts({})
    try {
      const r = await apiGetDailyCounts({ username: curSession.username, year: calYear, month: calMonth })
      setCalCounts(r.counts)
    } catch (e) {
      setMsgError((e as Error).message)
    } finally {
      setCalLoading(false)
    }
  }, [curSession, calYear, calMonth])

  const switchCalMonth = useCallback(async (delta: number): Promise<void> => {
    let m = calMonth + delta
    let y = calYear
    if (m < 1) { m = 12; y -= 1 }
    if (m > 12) { m = 1; y += 1 }
    setCalMonth(m)
    setCalYear(y)
    if (!curSession) return
    setCalLoading(true)
    setCalCounts({})
    try {
      const r = await apiGetDailyCounts({ username: curSession.username, year: y, month: m })
      setCalCounts(r.counts)
    } catch (e) {
      setMsgError((e as Error).message)
    } finally {
      setCalLoading(false)
    }
  }, [curSession, calMonth, calYear])

  const jumpToDay = useCallback((day: number): void => {
    const startTs = Math.floor(new Date(calYear, calMonth - 1, day, 0, 0, 0, 0).getTime() / 1000)
    setCalOpen(false)
    if (curSession) void openSessionAndLocate(curSession.username, undefined, startTs)
  }, [calYear, calMonth, curSession, calOpen])

  const sessionSearch = searchMode === 'session' ? search : ''
  const sessionSearching = sessionSearch.trim() !== ''
  // 普通会话列表：分页逐页加载；会话搜索时一次性拉满 500 条（用户主动操作），保证搜索结果完整。
  useEffect(() => {
    setError(null)
    if (sessionSearching) {
      let cancelled = false
      setLoading(true)
      void apiGetSessions({ keyword: sessionSearch.trim(), limit: 500 })
        .then((env) => {
          if (cancelled) return
          setSessions(env.sessions)
        })
        .catch((e: unknown) => { if (!cancelled) setError((e as Error).message) })
        .finally(() => { if (!cancelled) setLoading(false) })
      return () => { cancelled = true }
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

  const sessionsLoadMoreRef = useLazySentinel(() => { if (sessionsPager.hasMore && !sessionsPager.loadingMore) sessionsPager.loadMore() }, '600px 0px', () => sessionListRef.current)

  // 搜索索引状态只在用户切到「消息搜索」时检查，进入页签不再触发。
  useEffect(() => { if (searchMode === 'message') void checkIndexStatus() }, [searchMode, checkIndexStatus])
  // 已编辑消息列表仅在打开某个会话时按需加载，避免进入页签就拉全量已编辑记录。
  // 会话内「已编辑」徽标仍会在进入会话后正常出现。
  useEffect(() => { if (curSession) void loadEdits() }, [curSession, loadEdits])

  // Batch-prefetch avatars for the visible session list + message senders so
  // Avatar components hit the module cache instead of one Remote per row.
  useEffect(() => {
    const keys = [
      ...sessions.map(s => s.username),
      ...messages.map(m => m.sender ?? ''),
      ...(curSession ? [curSession.username] : []),
    ]
    const uniq = [...new Set(keys.filter(Boolean))].filter(u => avatarCache.get(u) === undefined)
    if (uniq.length === 0) return
    const batch = uniq.slice(0, 60)
    void apiGetAvatarsLocal({ usernames: batch })
      .then((map) => {
        let changed = false
        for (const u of batch) {
          if (!avatarCache.has(u)) { cacheBounded(avatarCache, u, map[u] ?? null, AVATAR_CACHE_MAX); changed = true }
        }
        if (changed) setAvatarVersion(v => v + 1)
      })
      .catch(() => { /* individual Avatar fallback covers misses */ })
  }, [sessions, messages, curSession])

  const filtered = useMemo(() => {
    // subscription views filter by session kind first（判据与 sessionInView 同源）
    const base = view === 'chats' ? sessions : sessions.filter(s => sessionInView(s, view))
    const q = search.trim().toLowerCase()
    if (!q) return base
    return base.filter(s =>
      (s.displayName || s.username).toLowerCase().includes(q)
      || (s.summary || '').toLowerCase().includes(q))
  }, [sessions, search, view])

  const { pinnedList, normalList } = useMemo(() => {
    const pinned: WechatSession[] = []
    const normal: WechatSession[] = []
    for (const s2 of filtered) {
      if (s2.pinned) pinned.push(s2)
      else normal.push(s2)
    }
    return { pinnedList: pinned, normalList: normal }
  }, [filtered])

  const stats = useMemo(() => ({
    friends: sessions.filter(s => s.type === 'private').length,
    groups: sessions.filter(s => s.type === 'group').length,
    unread: sessions.reduce((a, s) => a + (s.unreadCount || 0), 0),
  }), [sessions])

  /**
   * AI 入口的可见性：单聊与群聊才有「这段聊天」的语义；
   * 公众号/服务号/客服是单向广播，问答没有意义，不给入口。
   */
  const aiEligible = curSession !== null && (curSession.type === 'private' || curSession.type === 'group')

  /**
   * AI 面板的读取范围：**就是当前打开的会话**。
   * 不给下拉选择——面板与右侧消息流是同一个会话，两者范围必须一致，
   * 否则会出现「看着 A 的聊天、问的却是 B」这种无法自证的错位。
   */
  const aiTarget = curSession

  const { count: sessCount, sentinelRef: sessSentinel } = useProgressiveList(normalList.length, 120)

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
  const msgItems = useMemo(() => buildMessageItems(messages, 0), [messages])
  const msgVirtualizer = useVirtualizer({
    count: msgItems.length,
    getScrollElement: () => msgScrollRef.current,
    estimateSize: (i) => estimateMsgItemHeight(msgItems[i]),
    overscan: 6,
    getItemKey: (i) => msgItemKey(msgItems[i]),
  })
  /**
   * 跳到某条消息：先把虚拟窗口滚到它的位置，等元素真正挂载后再精确对齐。
   * @param localId - 目标消息的 local_id。
   */
  const locateMessage = useCallback((localId: number): void => {
    const idx = msgItems.findIndex((it) => itemLocalId(it) === localId)
    if (idx >= 0) msgVirtualizer.scrollToIndex(idx, { align: 'center' })
    setTimeout(() => { document.getElementById('msg-' + String(localId))?.scrollIntoView({ block: 'center' }) }, 80)
  }, [msgItems, msgVirtualizer])
  /**
   * 渲染一个「消息渲染项」（日期分隔 / 系统行 / 普通气泡 / 图片组）。
   *
   * 从原来的内联循环里抽出来：虚拟化后每项要单独套一层定位容器，
   * 而**行内结构必须保持原样**（`id="msg-<localId>"`、头像身份键、悬停时间戳这些
   * 都被守卫与深链依赖）。
   * @param item - `buildMessageItems` 的产物。
   * @returns 行元素（日期分隔没有 id）。
   */
  function renderMsgItem(item: MessageRenderItem): React.JSX.Element | null {
    if (item.kind === 'day') {
      return <div className={css.msgDayDivider}><span>{item.label}</span></div>
    }
    const head = item.kind === 'group' ? item.items[0] : item.m
    if (!head || !curSession) return null
    const kind = renderKindOf(head)
    // 系统提示（含撤回）/ 拍一拍 / 无内容：居中行，没有头像与气泡。
    if (kind === 'system' || kind === 'revoke' || kind === 'pat' || kind === 'empty') {
      return (
        <div id={`msg-${head.localId}`} className={css.msgRowSystem}>
          <MessageBody m={head} selfName={curSession.username} onOpenImage={openViewer} />
        </div>
      )
    }
    const isSelf = head.isSender === 1
    const isGroup = curSession.type === 'group'
    /*
     * 头像的身份键必须是真实 wxid，拿不到就留空（只渲染首字母占位）。
     *
     *  - 自己：用登录账号的 wxid。以前 fallback 到 `curSession.username`，
     *    那会把「我」键成**对方**的 username，于是自己和对方显示同一个头像；
     *    账号 wxid 未知时宁可不取头像，也不要取错。
     *  - 群成员：用消息里的 sender wxid；解析不出来时留空，
     *    绝不用昵称当键（群里同名成员会互相顶掉头像）。
     *  - 私聊对方：就是会话 username 本身。
     */
    const avUsername = isSelf
      ? selfWxid
      : (isGroup ? (head.sender ?? '') : curSession.username)
    const avName = isSelf ? '我' : (isGroup ? (head.senderName || head.sender || '') : curSession.displayName)
    const isEdited = editedIds.has(head.localId)
    return (
      <div
        id={`msg-${head.localId}`}
        className={`${css.msgRow} ${isSelf ? css.msgRowSelf : ''}`}
        onContextMenu={(ev) => { openMsgMenu(ev, head, kind) }}
      >
        <Avatar name={avName} username={avUsername} size={34} />
        <div className={css.msgCol}>
          {/* 悬停才出现的完整时间戳（微信行为）；已编辑折进同一枚气泡提示里 */}
          <span className={css.msgTimeChip}>
            {fmtMsgClockSec(head.createTime)}{isEdited ? ' · 已编辑' : ''}
          </span>
          {isGroup && !isSelf && head.sender && <div className={css.msgSender}>{avName}</div>}
          {item.kind === 'group' ? (
            <div className={`${css.msgBubble} ${css.msgBubbleTight}`}>
              <MessageImageGroup items={item.items} username={curSession.username} onOpenAt={openViewer} />
            </div>
          ) : (
            <MessageBody
              m={item.m}
              selfName={curSession.username}
              onOpenImage={openViewer}
              onOpenChatlog={openChatlog}
            />
          )}
        </div>
      </div>
    )
  }
  /**
   * 「加载更多」不跳位（N18）：插入后把 scrollTop 补上「新增内容的高度」，
   * 让视口里那条消息留在原地。
   *
   * 为什么要跑三帧：动态测高是一帧一帧回填的（先估、后量、再量修正），
   * 只补一次会差出几十像素；每次都按**最初的**基准重算，所以重复执行是安全的。
   */
  /** 往上插入更早消息前的滚动位置（见 loadMore）；由下面的 effect 消费。 */
  const prependAnchorRef = useRef<{ h: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const anchor = prependAnchorRef.current
    const box = msgScrollRef.current
    if (!anchor || !box) return
    prependAnchorRef.current = null
    const apply = (): void => {
      const delta = box.scrollHeight - anchor.h
      if (delta > 0) box.scrollTop = anchor.top + delta
    }
    apply()
    requestAnimationFrame(() => { apply(); requestAnimationFrame(apply) })
  }, [messages.length])

  /**
   * 当前 `messages` 是否确实属于正在显示的会话。
   *
   * `curSession` 与 `messages` 是两份 state，中间必然有一段不一致的窗口。
   * 与其只在各个异步回调里保证顺序，这里再加一道**结构性**断言：归属不符时
   * 一律不渲染消息列表（显示骨架），从根上杜绝「把上一个人的消息画在这个
   * 会话的标题下面」。`messagesTalkerRef` 与两份 state 在同一批次里更新，
   * 因此渲染时读到的值一定是自洽的。
   */
  const messagesMatchSession = curSession !== null && messagesTalkerRef.current === curSession.username

  /** Incremental poll: fetch messages newer than the watermark and append. */
  const pollNew = useCallback(async (): Promise<void> => {
    if (!curSession || inFlightRef.current) return
    const talker = curSession.username
    const epoch = sessionEpochRef.current
    const after = watermarkRef.current
    if (!after) return
    inFlightRef.current = true
    try {
      const env = await apiGetNewMessages({ talker, after, limit: 200 })
      // 切走之后到达的响应必须丢弃：否则会把上一个会话的新消息追加进当前会话，
      // 并且写进**上一个会话**的渲染缓存（缓存被污染后重开也还是错的）。
      if (!sessionAlive(epoch, talker)) return
      const fresh = env.messages
      setPollStatus(`✓ ${new Date().toLocaleTimeString()} · ${fresh.length} 条新消息`)
      if (fresh.length === 0) return
      setMessages((prev) => {
        if (!sessionAlive(epoch, talker)) return prev
        const key = (m: WechatMessage): string => `${m.localId}:${m.sortSeq ?? 0}`
        const seen = new Set(prev.map(m => key(m)))
        const add = fresh.filter(m => !seen.has(key(m)))
        if (add.length === 0) return prev
        setWatermarkFrom(add)
        // Keep the render cache current so a session reopen paints the same
        // newest messages before the authoritative fetch returns.
        const merged = [...prev, ...add]
        writeRenderCache('chat-msgs:v2:' + talker, merged)
        return merged
      })
      // follow to the bottom only when the user is already near it
      requestAnimationFrame(() => {
        if (!sessionAlive(epoch, talker)) return
        const el = msgEndRef.current
        if (!el) return
        const rect = el.getBoundingClientRect()
        const vh = window.innerHeight || document.documentElement.clientHeight
        if (rect.top < vh && rect.bottom >= 0) el.scrollIntoView({ block: 'end' })
      })
    } catch (e) {
      if (sessionAlive(epoch, talker)) setPollStatus('✗ ' + ((e as Error).message || '轮询失败').slice(0, 60))
    } finally {
      inFlightRef.current = false
    }
  }, [curSession])

  /** 与快照最近窗口对账：撤回(10002)/删除等就地修改保留原 sort_seq，
   *  增量轮询按 sort_seq 水位看不到它们；宿主推送后拉一次最近 50 条，
   *  按 localId 用新行替换发生变化的行，界面与库保持一致（有界查询）。 */
  const reconcileRef = useRef(false)
  const reconcileRecent = useCallback(async (): Promise<void> => {
    if (!curSession || reconcileRef.current) return
    const talker = curSession.username
    const epoch = sessionEpochRef.current
    reconcileRef.current = true
    try {
      const env = await apiGetMessages({ talker, limit: 50 })
      // 对账按 localId 匹配，而 local_id 只在会话内唯一 —— 切走后拿另一个会话的
      // 行去替换当前会话的行，等于按编号把别人的消息安到这个会话上，必须丢弃。
      if (!sessionAlive(epoch, talker)) return
      const byId = new Map<number, WechatMessage>()
      for (const m of env.messages) byId.set(m.localId, m)
      if (byId.size === 0) return
      setMessages((prev) => {
        if (!sessionAlive(epoch, talker)) return prev
        const next = prev.map((m) => {
          const cur = byId.get(m.localId)
          if (cur && (cur.type !== m.type || (cur.sortSeq ?? 0) !== (m.sortSeq ?? 0))) return cur
          return m
        })
        const changed = next.some((m, i) => m !== prev[i])
        if (!changed) return prev
        writeRenderCache('chat-msgs:v2:' + talker, next)
        return next
      })
    } catch { /* 保持当前视图，等待下一次推送对账 */ } finally {
      reconcileRef.current = false
    }
  }, [curSession])

  useEffect(() => {
    if (!curSession) return
    let timer: ReturnType<typeof setInterval> | null = null
    const start = (): void => {
      if (timer !== null) clearInterval(timer)
      const ms = document.visibilityState === 'visible' ? POLL_VISIBLE_MS : POLL_HIDDEN_MS
      timer = setInterval(() => { void pollNew() }, ms)
    }
    start()
    const onVis = (): void => { void pollNew(); start() }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      if (timer !== null) clearInterval(timer)
    }
  }, [curSession, pollNew])

  // Close the group-info drawer and drop the in-chat search scope on session switch.
  useEffect(() => {
    setGroupInfoOpen(false)
    setGroupInfo(null)
    setGroupInfoErr(null)
    setMemberSearch('')
    setMemberExpanded(false)
    setProfileMember(null)
    setMoreOpen(false)
    setAnnExpanded(false)
    setAnnCanExpand(false)
  }, [curSession?.username])

  // 群公告是否被截断：只在折叠态量（展开后 clientHeight 变大，量了会把「展开」按钮吃掉）。
  useEffect(() => {
    if (!groupInfoOpen || !groupInfo || annExpanded) return
    const el = annRef.current
    if (!el) return
    setAnnCanExpand(el.scrollHeight > el.clientHeight + 1)
  }, [groupInfoOpen, groupInfo, annExpanded])

  // 抽屉是**手写覆盖层**，要自己接 Esc 与焦点管理：
  // 项目已有一套（kit 的 useEscapeToClose / useDialogFocus），其余四个手写弹窗都注册了，
  // 只有这个抽屉漏了 —— 实测 Esc 关不掉、Tab 会跑到抽屉背后的会话列表里（审计 P1-7）。
  useEscapeToClose(groupInfoOpen, () => { setGroupInfoOpen(false); setProfileMember(null) })
  useDialogFocus(groupInfoOpen, '[data-st-dialog="chats-groupinfo"]')

  // 「更多」菜单：Esc 关闭（与其他手写覆盖层共用同一套栈，只让最上层响应）
  useEscapeToClose(moreOpen, () => { setMoreOpen(false) })
  // 点菜单外部关闭。菜单没有遮罩，所以必须自己判 contains。
  useEffect(() => {
    if (!moreOpen) return
    const onDown = (e: MouseEvent): void => {
      const el = document.querySelector('[data-st-menu="msg-header-more"]')
      if (el && e.target instanceof Node && el.contains(e.target)) return
      setMoreOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => { document.removeEventListener('mousedown', onDown) }
  }, [moreOpen])

  // Host push: a WAL increment was decrypted into the snapshot — refresh the
  // open chat immediately, reconcile in-place edits (revoke/delete), and
  // coalesce the session-list refresh.
  useEffect(() => {
    const onUpdated = (): void => {
      void pollNew()
      void reconcileRecent()
      // 会话列表**不在这里刷**：`usePagedList` 内部已订阅同一事件并做非破坏性 refresh，
      // 这里再刷一次只会重复取数；而原先这里走的是 `reset()`，每约 10 秒把列表清空重画，
      // 表现就是「有新消息时会话列表跳动一次」。
    }
    window.addEventListener('dsh-wechat-data-updated', onUpdated)
    return () => { window.removeEventListener('dsh-wechat-data-updated', onUpdated) }
  }, [pollNew, reconcileRecent])

  const openGroupInfo = (): void => {
    if (!curSession) return
    setGroupInfoOpen(true)
    setGroupInfoLoading(true)
    setGroupInfoErr(null)
    setMemberSearch('')
    setMemberExpanded(false)
    apiGetGroupInfo(curSession.username)
      .then((r) => {
        const g = r.group
        setGroupInfo(g)
      })
      .catch((e: unknown) => { setGroupInfoErr((e as Error).message) })
      .finally(() => { setGroupInfoLoading(false) })
  }

  const openSession = useCallback(async (s: WechatSession): Promise<void> => {
    const epoch = beginSession(s.username)
    setCurSession(s)
    watermarkRef.current = 0
    setCursor(0)
    setCursorLocalId(undefined)
    setTypeStats([])
    setMsgLoading(true)
    setMsgError(null)
    try {
      // 先用上次渲染的消息缓存秒开,后台再同步最近 100 条
      const raw = readRenderCache<WechatMessage[]>('chat-msgs:v2:' + s.username)
      const cached = raw && messagesMatchTalker(raw, s.username, selfWxid) ? raw : null
      if (!sessionAlive(epoch, s.username)) return
      setMessages(cached ?? [])
      if (cached && cached.length > 0) { setHasMore(true); setMsgLoading(false) }
      const env = await apiGetMessages({ talker: s.username, limit: 100 })
      // 用户在加载期间又点了另一个会话：这份响应已经过期，丢弃，
      // 否则上一个会话的消息会盖到当前会话上。
      if (!sessionAlive(epoch, s.username)) return
      const list = env.messages
      setMessages(list)
      setWatermarkFrom(list)
      setSelfWxid(env.selfWxid ?? '')
      setHasMore(env.hasMore ?? false)
      setCursor(env.cursor ?? 0)
      setCursorLocalId(env.cursorLocalId)
      setTypeStats(env.typeStats ?? [])
      writeRenderCache('chat-msgs:v2:' + s.username, list)
      setTimeout(() => {
        if (!sessionAlive(epoch, s.username)) return
        msgEndRef.current?.scrollIntoView({ block: 'end' })
      }, 50)
    } catch (e) {
      if (sessionAlive(epoch, s.username)) setMsgError((e as Error).message)
    } finally {
      if (sessionAlive(epoch, s.username)) setMsgLoading(false)
    }
  }, [])

  const loadMore = useCallback(async (): Promise<void> => {
    if (!curSession || !hasMore || msgLoading) return
    const talker = curSession.username
    const epoch = sessionEpochRef.current
    setMsgLoading(true)
    try {
      const env = await apiGetMessages({ talker, limit: 100, cursor, cursorLocalId })
      // 翻页结果按会话拼接：切走之后到达的上一页属于上一个会话，必须丢弃。
      if (!sessionAlive(epoch, talker)) return
      const list = env.messages
      // N18：往上插入**更早**的消息会让整段内容下移，视口看着像「跳了一下」。
      // 先记下当前的滚动高度与位置，插完由下面那个 effect 按差值补回 scrollTop。
      const box = msgScrollRef.current
      if (box) prependAnchorRef.current = { h: box.scrollHeight, top: box.scrollTop }
      setMessages(prev => (sessionAlive(epoch, talker) ? [...list, ...prev] : prev))
      setWatermarkFrom(list)
      setHasMore(env.hasMore ?? false)
      setCursor(env.cursor ?? cursor)
      setCursorLocalId(env.cursorLocalId)
    } catch (e) {
      if (sessionAlive(epoch, talker)) setMsgError((e as Error).message)
    } finally {
      if (sessionAlive(epoch, talker)) setMsgLoading(false)
    }
  }, [curSession, hasMore, msgLoading, cursor, cursorLocalId])

  /** Open a session and scroll to a message (by localId or day start). */
  const openSessionAndLocate = useCallback(async (username: string, localId?: number, dayStart?: number): Promise<void> => {
    const found = sessions.find(x => x.username === username)
    const s: WechatSession = found ?? {
      username,
      displayName: username,
      type: username.endsWith('@chatroom') ? 'group' : 'private',
      lastTimestamp: 0, summary: '', unreadCount: 0, draft: '', pinned: false, hidden: false,
    }
    setCurSession(s)
    const epoch = beginSession(username)
    setMessages([])
    watermarkRef.current = 0
    setCursor(0)
    setCursorLocalId(undefined)
    setTypeStats([])
    setMsgLoading(true)
    setMsgError(null)
    try {
      let env = await apiGetMessages({ talker: username, limit: 100 })
      let list = env.messages
      let pages = 0
      let hit = -1
      const findHit = (): number => {
        if (localId !== undefined) return list.findIndex(m => m.localId === localId)
        if (dayStart !== undefined) return list.findIndex(m => m.createTime >= dayStart)
        return -1
      }
      hit = findHit()
      while (hit < 0 && (env.hasMore ?? false) && pages < 10) {
        const moreOpts: { talker: string; limit: number; cursor?: number; cursorLocalId?: number } = { talker: username, limit: 100 }
        if (env.cursor !== undefined) moreOpts.cursor = env.cursor
        if (env.cursorLocalId !== undefined) moreOpts.cursorLocalId = env.cursorLocalId
        env = await apiGetMessages(moreOpts)
        // 定位可能翻 10 页，期间用户在左侧点了别的会话是很正常的事：
        // 每次翻页后都要确认归属，否则会把目标会话的消息灌进当前会话。
        if (!sessionAlive(epoch, username)) return
        list = [...env.messages, ...list]
        pages += 1
        hit = findHit()
      }
      if (!sessionAlive(epoch, username)) return
      setMessages(list)
      setWatermarkFrom(list)
      setSelfWxid(env.selfWxid ?? '')
      setHasMore(env.hasMore ?? false)
      setCursor(env.cursor ?? 0)
      setCursorLocalId(env.cursorLocalId)
      setTypeStats(env.typeStats ?? [])
      // N18：虚拟化后不必再「预先展开窗口」—— 目标消息没挂载时由 locateMessage 先滚到它的位置
      setTimeout(() => {
        if (!sessionAlive(epoch, username)) return
        if (hit >= 0) {
          const m = list[hit]
          if (m) locateMessage(m.localId)
        } else {
          msgEndRef.current?.scrollIntoView({ block: 'end' })
        }
      }, 80)
    } catch (e) {
      if (sessionAlive(epoch, username)) setMsgError((e as Error).message)
    } finally {
      if (sessionAlive(epoch, username)) setMsgLoading(false)
    }
  }, [sessions, locateMessage])

  // External navigation (records/privacy/ask/contacts): open the target
  // session and locate the message (or just open when no localId).
  useEffect(() => {
    if (!initialTarget) return
    void openSessionAndLocate(initialTarget.username, initialTarget.localId)
  }, [initialTarget, openSessionAndLocate])

  const changeView = useCallback((next: ChatView): void => {
    if (next === view) return
    setView(next)
    closeCurrentSession()
    setChatlogStack([])
    setMsgMenu(null)
  }, [view, closeCurrentSession])

  /*
   * 外层 tab 与 `initialView` 的同步（公众号/服务号/客服在侧栏是独立导航项）。
   *
   * 用 ref 转一手，让 effect **不**依赖 `initialView`：如果把 `changeView` 放进依赖，
   * 它在面板内切换分段时会随 `view` 换新身份，effect 便会把视图弹回 `initialView`，
   * 用户就没法在面板内切到「服务号」。
   */
  const changeViewRef = useRef(changeView)
  changeViewRef.current = changeView
  useEffect(() => { changeViewRef.current(initialView) }, [initialView])

  /** 打开「聊天记录」弹窗（合并转发卡片与右键菜单两条入口共用同一实现）。 */
  const openChatlog = useCallback((rich: MessageRich): void => {
    setChatlogStack([{ title: rich.title || '群聊的聊天记录', records: Array.isArray(rich.records) ? rich.records : [] }])
  }, [])

  const copyMsgText = useCallback((t: string): void => {
    void navigator.clipboard.writeText(t).then(() => { window.alert('文本已复制') }).catch(() => { window.alert('复制失败') })
  }, [])

  /**
   * 右键菜单「打开文件」：同样要把消息自带的体积/时间透传给后端，
   * 否则同名文件会在别的会话里随便挑一份。
   * @param fileName - 文件名。
   * @param m - 该消息（取 fileSize 与 createTime 作为归属线索）。
   */
  const openFileFromMenu = useCallback((fileName: string, m: WechatMessage): void => {
    const bytes = Number(m.rich?.fileSize)
    const opts: { size?: number; createTime?: number } = {}
    if (Number.isFinite(bytes) && bytes > 0) opts.size = bytes
    if (m.createTime) opts.createTime = m.createTime
    void downloadMessageFile(fileName, opts).then((err) => { if (err) window.alert('打开失败：' + err) })
  }, [])

  /**
   * 在光标处打开消息菜单。
   *
   * 坐标夹进视口（留 8px 余量）。高度按条目数估算：估大了只是留白，估小了最后一条
   * 会被挤出视口，所以按 34px/条 + 16px 走，菜单本体另有 max-height + overflow 兜底。
   * @param ev - the contextmenu event.
   * @param m - the target message.
   * @param kind - its render kind.
   */
  const openMsgMenu = useCallback((ev: React.MouseEvent, m: WechatMessage, kind: RenderKind): void => {
    ev.preventDefault()
    const estH = buildMsgMenu(m, kind).length * 34 + 16
    const x = Math.max(8, Math.min(ev.clientX, window.innerWidth - 184))
    const y = Math.max(8, Math.min(ev.clientY, window.innerHeight - estH - 8))
    setMsgMenu({ x, y, m, kind })
  }, [])

  /** 菜单项分发：把「声明式条目」落到具体的面板动作上。 */
  const runMenuAction = useCallback((item: MsgMenuItem, m: WechatMessage): void => {
    switch (item.action) {
      case 'copyText': copyMsgText(item.arg ?? ''); break
      case 'copyJson': copyMsgJson(m); break
      case 'openLink': openLink(item.arg ?? ''); break
      case 'openViewer': openViewer(m); break
      case 'openFile': openFileFromMenu(item.arg ?? '', m); break
      case 'openChatlog': if (m.rich) openChatlog(m.rich); break
      case 'edit': void onEditFn(m); break
      default: break
    }
  }, [copyMsgText, copyMsgJson, openViewer, openFileFromMenu, openChatlog, onEditFn])

  /** 菜单打开期间：Esc、滚动、改窗口大小都关闭它（微信点空白处即关）。 */
  useEffect(() => {
    if (!msgMenu) return
    const close = (): void => { setMsgMenu(null) }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') close() }
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [msgMenu])

  const lastTypeIcon = (t: number | undefined): string => {
    switch (t) {
      case 3: return '🖼️'
      case 34: return '🎤'
      case 43: return '🎬'
      case 47: return '😀'
      case 49: return '🔗'
      case 50: return '📞'
      case 10000: return '📢'
      case 10002: return '↩️'
      default: return ''
    }
  }

  const renderSession = (s: WechatSession): React.JSX.Element => (
    // 会话名与摘要都会被省略号截断（实测名 135<230、摘要 187<829），title 给全文
    <button
      key={s.username}
      type="button"
      className={css.sessionItem}
      data-active={!batchMode && curSession?.username === s.username || undefined}
      title={`${s.displayName || s.username}\n${s.username}`}
      onClick={() => { if (batchMode) toggleSelect(s.username); else void openSession(s) }}
    >
      {batchMode && (
        <span className={kitCss.batchCheck} data-checked={selected.has(s.username) || undefined}>
          {selected.has(s.username) ? '✓' : ''}
        </span>
      )}
      <LazyMount placeholder={<span className={css.avatarStub} />} rootMargin="400px 0px">
        <Avatar name={s.displayName} username={s.username} />
      </LazyMount>
      <div className={css.sessionInfo}>
        <div className={css.sessionTop}>
          <span className={css.sessionNameWrap}>
            <span className={css.sessionName}>{s.displayName || s.username}</span>
            {s.hidden && <span className={css.hiddenBadge} title="该会话在微信中被隐藏">已隐藏</span>}
            {isEnterpriseChat(s.username) && <span className={css.entBadge} title="企业微信">企微</span>}
          </span>
          <span className={css.sessionTimeGroup}>
            <span className={css.sessionTime}>{fmtSessionTimeSec(s.lastTimestamp)}</span>
            {s.pinned && <span className={css.pinMark} title="置顶会话"><IconPin /></span>}
          </span>
        </div>
        <div className={css.sessionBottom}>
          {lastTypeIcon(s.lastMsgType) && (
            <span className={css.sessionTypeBadge} title="最后消息类型图标">{lastTypeIcon(s.lastMsgType)}</span>
          )}
          {/* 会话摘要实测最长 829px 而格位 187px（4.4 倍），必须给出全文入口 */}
          <span className={css.sessionSummary} title={s.summary || (s.draft ? `[草稿] ${s.draft}` : '')}>{s.summary || (s.draft ? `[草稿] ${s.draft}` : '')}</span>
          {/*
            未读角标带上「最早一条未读」的时间（第 67 轮）：后端由
            `SessionTable.unread_first_msg_srv_id` 反查该会话的 Msg_ 表得到 `unreadSince`。
            光一个数字看不出「该先看哪个」；「未读 48 · 最早 2 小时前」能直接判断积压有多旧。
            角标本身很小放不下，放在 title 里（悬停可见），不增加视觉噪音。
          */}
          {s.unreadCount > 0 && (
            <span className={css.unread} title={unreadTitle(s.unreadCount, s.unreadSince)}>{s.unreadCount}</span>
          )}
        </div>
      </div>
    </button>
  )

  // 群成员搜索：命中集合、展示上限、「查看更多」的文案都从同一份过滤结果算，
  // 否则会出现「搜出 24 个却写 256 人」这种数字自相矛盾（审计 P1-4）。
  return (
    <ChatsView
      EXPO_FORMATS={EXPO_FORMATS}
      EXPO_TYPES={EXPO_TYPES}
      aiEligible={aiEligible}
      aiFull={aiFull}
      aiOpen={aiOpen}
      aiTarget={aiTarget}
      annCanExpand={annCanExpand}
      annExpanded={annExpanded}
      annRef={annRef}
      batchExporting={batchExporting}
      batchMode={batchMode}
      batchMsg={batchMsg}
      buildIndex={buildIndex}
      calActiveDays={calActiveDays}
      calAvg={calAvg}
      calCounts={calCounts}
      calDays={calDays}
      calFirstDow={calFirstDow}
      calHeat={calHeat}
      calLoading={calLoading}
      calMonth={calMonth}
      calOpen={calOpen}
      calTop={calTop}
      calTotal={calTotal}
      calYear={calYear}
      changeView={changeView}
      chatlogOpen={chatlogOpen}
      chatlogResolving={chatlogResolving}
      chatlogStack={chatlogStack}
      chooseExportDir={chooseExportDir}
      clearAllDrafts={clearAllDrafts}
      clearDraft={clearDraft}
      closeEdit={closeEdit}
      curSession={curSession}
      doReset={doReset}
      editAreaRef={editAreaRef}
      editBusy={editBusy}
      editErr={editErr}
      editTarget={editTarget}
      editText={editText}
      editedOpen={editedOpen}
      editing={editing}
      edits={edits}
      error={error}
      expCount={expCount}
      expDir={expDir}
      expFilename={expFilename}
      expFormat={expFormat}
      expFrom={expFrom}
      expTo={expTo}
      expTypes={expTypes}
      expZip={expZip}
      exportBatch={exportBatch}
      exportMsg={exportMsg}
      exportOpen={exportOpen}
      exportSession={exportSession}
      exporting={exporting}
      filtered={filtered}
      filteredMembers={filteredMembers}
      groupInfo={groupInfo}
      groupInfoErr={groupInfoErr}
      groupInfoLoading={groupInfoLoading}
      groupInfoOpen={groupInfoOpen}
      groupInfoTitleId={groupInfoTitleId}
      hasMore={hasMore}
      hideMemberProfile={hideMemberProfile}
      indexBuilding={indexBuilding}
      jumpToDay={jumpToDay}
      loadMore={loadMore}
      loading={loading}
      memberExpanded={memberExpanded}
      memberLimit={memberLimit}
      memberQuery={memberQuery}
      memberSearch={memberSearch}
      memberTotal={memberTotal}
      messages={messages}
      messagesMatchSession={messagesMatchSession}
      moreOpen={moreOpen}
      msgEndRef={msgEndRef}
      msgError={msgError}
      msgHits={msgHits}
      msgIndexed={msgIndexed}
      msgItems={msgItems}
      msgLoading={msgLoading}
      msgMenu={msgMenu}
      msgScrollRef={msgScrollRef}
      msgSearchError={msgSearchError}
      msgSearchLoading={msgSearchLoading}
      msgSearched={msgSearched}
      msgVirtualizer={msgVirtualizer}
      normalList={normalList}
      onSearchInput={onSearchInput}
      openCalendar={openCalendar}
      openEdits={openEdits}
      openGroupInfo={openGroupInfo}
      openNestedChatlog={openNestedChatlog}
      openSession={openSession}
      openSessionAndLocate={openSessionAndLocate}
      pickingDir={pickingDir}
      pinnedCollapsed={pinnedCollapsed}
      pinnedList={pinnedList}
      pollStatus={pollStatus}
      profileMember={profileMember}
      profilePos={profilePos}
      renderMsgItem={renderMsgItem}
      renderSession={renderSession}
      runMenuAction={runMenuAction}
      saveEdit={saveEdit}
      search={search}
      searchMode={searchMode}
      selected={selected}
      sessCount={sessCount}
      sessSentinel={sessSentinel}
      sessionListRef={sessionListRef}
      sessionSearching={sessionSearching}
      sessionsLoadMoreRef={sessionsLoadMoreRef}
      sessionsPager={sessionsPager}
      setAiFull={setAiFull}
      setAiOpen={setAiOpen}
      setAnnExpanded={setAnnExpanded}
      setBatchMode={setBatchMode}
      setCalOpen={setCalOpen}
      setChatlogStack={setChatlogStack}
      setEditText={setEditText}
      setEditedOpen={setEditedOpen}
      setExpCount={setExpCount}
      setExpFilename={setExpFilename}
      setExpFormat={setExpFormat}
      setExpFrom={setExpFrom}
      setExpTo={setExpTo}
      setExpTypes={setExpTypes}
      setExpZip={setExpZip}
      setExportOpen={setExportOpen}
      setGroupInfoOpen={setGroupInfoOpen}
      setMemberExpanded={setMemberExpanded}
      setMemberSearch={setMemberSearch}
      setMoreOpen={setMoreOpen}
      setMsgMenu={setMsgMenu}
      setProfileMember={setProfileMember}
      setSearch={setSearch}
      setSearchMode={setSearchMode}
      setSelected={setSelected}
      setSuggestOpen={setSuggestOpen}
      setViewer={setViewer}
      showMemberProfile={showMemberProfile}
      shownMembers={shownMembers}
      stats={stats}
      suggestOpen={suggestOpen}
      switchCalMonth={switchCalMonth}
      togglePinned={togglePinned}
      typeStats={typeStats}
      view={view}
      viewer={viewer}
    />
  )
}

