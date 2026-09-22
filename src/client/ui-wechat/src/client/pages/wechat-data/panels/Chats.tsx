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
export { ChatView, isEnterpriseChat } from './chats-support.tsx'
export { ViewerImage } from './chats-media.tsx'
import { AVATAR_CACHE_MAX, Avatar, ChatView, FILE_STYLE, IconCalendar, IconCallMissedOutline, IconCallOutline, IconImage, IconMinus, IconPin, MsgMenuAction, MsgMenuItem, POLL_HIDDEN_MS, POLL_VISIBLE_MS, TransferArrowGlyph, TransferCheckGlyph, avatarCache, buildMsgMenu, decodeEntities, downloadMessageFile, estimateMsgItemHeight, fileStyle, isEnterpriseChat, isKefuSession, itemLocalId, liveStatusText, msgItemKey, openLink, quoteTypeLabel, sessionInView, transferStateKey, transferStatusLabel, unreadTitle } from './chats-support.tsx'
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
  const [batchMode, setBatchMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [batchExporting, setBatchExporting] = useState(false)
  const [batchMsg, setBatchMsg] = useState<string | null>(null)
  const [, setAvatarVersion] = useState(0)

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

  const toggleSelect = (username: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(username)) next.delete(username)
      else next.add(username)
      return next
    })
  }

  const exportBatch = useCallback(async (): Promise<void> => {
    const list = [...selected]
    if (list.length === 0) return
    setBatchExporting(true)
    setBatchMsg(null)
    let done = 0
    const errors: string[] = []
    try {
      for (const username of list) {
        try {
          await apiExportSessionMessages({ username, format: 'txt', count: 0 })
          done += 1
        } catch (e) {
          errors.push(username + ': ' + (e as Error).message)
        }
      }
      setBatchMsg(`已导出 ${done}/${list.length} 个会话${errors.length ? `，失败 ${errors.length} 个` : ''}`)
    } finally {
      setBatchExporting(false)
    }
  }, [selected])

  const togglePinned = (): void => {
    setPinnedCollapsed((v) => {
      const nv = !v
      try { localStorage.setItem('wc_pinned_collapsed', nv ? '1' : '0') } catch { /* ignore */ }
      return nv
    })
  }

  /** Open the lightbox at a message image (strip = all type-3 messages loaded). */
  const openViewer = useCallback((m: WechatMessage): void => {
    const imgs: ViewerImage[] = messages
      .filter(x => x.type === 3)
      .map(x => ({ username: curSession?.username ?? '', localId: x.localId }))
    if (imgs.length === 0) return
    const idx = imgs.findIndex(x => x.localId === m.localId)
    setViewer({ images: imgs, index: idx >= 0 ? idx : 0 })
  }, [messages, curSession])

  const [exporting, setExporting] = useState(false)
  const [exportMsg, setExportMsg] = useState<string | null>(null)
  // export dialog state
  const [exportOpen, setExportOpen] = useState(false)
  const [expFormat, setExpFormat] = useState<'txt' | 'html' | 'md' | 'excel' | 'csv' | 'sql' | 'json'>('txt')
  const [expCount, setExpCount] = useState(0)
  const [expDir, setExpDir] = useState('')
  const [expTypes, setExpTypes] = useState<readonly string[]>([])
  const [expFrom, setExpFrom] = useState('')
  const [expTo, setExpTo] = useState('')
  const [expFilename, setExpFilename] = useState('')
  const [expZip, setExpZip] = useState(false)
  const [pickingDir, setPickingDir] = useState(false)

  const EXPO_FORMATS: ReadonlyArray<{ value: string; label: string }> = [
    { value: 'txt', label: 'TXT' }, { value: 'html', label: 'HTML' }, { value: 'md', label: 'Markdown' },
    { value: 'excel', label: 'Excel' }, { value: 'sql', label: 'SQL' }, { value: 'json', label: 'JSON' },
  ]
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

  const exportSession = useCallback(async (): Promise<void> => {
    if (!curSession || exporting) return
    setExporting(true)
    setExportMsg(null)
    try {
      const chosen = EXPO_TYPES.filter(c => expTypes.includes(c.key))
      const types = chosen.flatMap(c => [...(c.types ?? [])])
      const richTypes = chosen.flatMap(c => [...(c.rich ?? [])])
      const fromSec = expFrom ? Math.floor(new Date(expFrom + 'T00:00:00').getTime() / 1000) : 0
      const toSec = expTo ? Math.floor(new Date(expTo + 'T23:59:59').getTime() / 1000) : 0
      const opts: {
        username: string
        format: string
        count: number
        dir?: string
        types?: number[]
        richTypes?: string[]
        from?: number
        to?: number
        filename?: string
        zip?: boolean
      } = {
        username: curSession.username,
        format: expFormat,
        count: expCount,
      }
      if (expDir.trim()) opts.dir = expDir.trim()
      if (types.length > 0) opts.types = types
      if (richTypes.length > 0) opts.richTypes = richTypes
      if (fromSec > 0) opts.from = fromSec
      if (toSec > 0) opts.to = toSec
      if (expFilename.trim()) opts.filename = expFilename.trim()
      if (expZip) opts.zip = true
      const r = await apiExportSessionMessages(opts)
      setExportMsg(`已导出 ${r.count} 条 → ${r.path}`)
      setExportOpen(false)
    } catch (e) {
      setExportMsg('导出失败: ' + (e as Error).message)
    } finally {
      setExporting(false)
    }
  }, [curSession, exporting, expFormat, expCount, expDir, expTypes, expFrom, expTo, expFilename, expZip])

  const chooseExportDir = async (): Promise<void> => {
    if (pickingDir) return
    setPickingDir(true)
    try {
      const dir = await pickDirectory()
      if (dir) setExpDir(dir)
    } finally {
      setPickingDir(false)
    }
  }

  const openNestedChatlog = async (rec: ChatlogRecord): Promise<void> => {
    if (rec.nested && rec.nested.length > 0) {
      setChatlogStack(prev => [...prev, { title: rec.datatitle || rec.text || '聊天记录', records: rec.nested ?? [] }])
      return
    }
    if (rec.fromnewmsgid && !chatlogResolving) {
      setChatlogResolving(true)
      try {
        const r = await apiResolveChatHistory(rec.fromnewmsgid)
        const rich = r.found ? r.message?.rich : null
        if (r.found && rich && Array.isArray(rich.records) && rich.records.length > 0) {
          setChatlogStack(prev => [...prev, { title: rich.title || '聊天记录', records: rich.records ?? [] }])
        } else {
          window.alert('未找到该聊天记录（可能需要微信端完整同步）')
        }
      } catch (e) {
        window.alert('解析聊天记录失败: ' + (e as Error).message)
      } finally {
        setChatlogResolving(false)
      }
    }
  }

  // ── message edit (C5) ──
  const [editedOpen, setEditedOpen] = useState(false)
  const [edits, setEdits] = useState<readonly EditedMessageRecord[]>([])
  const [editedIds, setEditedIds] = useState<Set<number>>(new Set())
  const [editing, setEditing] = useState(false)
  /** 「编辑消息副本」对话框：目标消息 / 编辑中的文本 / 失败原因 / 保存中 */
  const [editTarget, setEditTarget] = useState<WechatMessage | null>(null)
  const [editText, setEditText] = useState('')
  const [editErr, setEditErr] = useState<string | null>(null)
  const [editBusy, setEditBusy] = useState(false)
  const editAreaRef = useRef<HTMLTextAreaElement | null>(null)

  // 打开即把光标放进编辑框并全选原文（Radix 默认聚焦标题栏的关闭按钮）。
  useEffect(() => {
    if (!editTarget) return undefined
    const t = window.setTimeout(() => { editAreaRef.current?.focus(); editAreaRef.current?.select() }, 60)
    return () => { window.clearTimeout(t) }
  }, [editTarget])

  const loadEdits = useCallback(async (): Promise<void> => {
    try {
      const r = await apiListEditedMessages(curSession ? { sessionId: curSession.username } : undefined)
      setEdits(r.items)
      setEditedIds(new Set(r.items.map(it => it.localId)))
    } catch { setEdits([]); setEditedIds(new Set()) }
  }, [curSession])

  const openEdits = useCallback(async (): Promise<void> => {
    setEditedOpen(v => !v)
    if (!editedOpen) await loadEdits()
  }, [editedOpen, loadEdits])

  const reloadCurrent = useCallback(async (): Promise<void> => {
    if (!curSession) return
    // 记下发起时的归属：编辑后刷新期间用户可能已经切走，回来必须校验。
    const talker = curSession.username
    const epoch = sessionEpochRef.current
    try {
      // 键带 v2：早期版本在「切会话」竞态下把上一个会话写进过 v1 缓存（别人的消息留在本会话里），
      // 升版让那些脏数据彻底读不到；读到之后还要再校验一次归属（见 msg-scope.ts）。
      const raw = readRenderCache<WechatMessage[]>('chat-msgs:v2:' + talker)
      const cached = raw && messagesMatchTalker(raw, talker, selfWxid) ? raw : null
      if (!sessionAlive(epoch, talker)) return
      if (cached && cached.length > 0) {
        setMessages(cached)
        setHasMore(true)
      }
      const env = await apiGetMessages({ talker, limit: 100 })
      if (!sessionAlive(epoch, talker)) return
      setMessages(env.messages)
      setWatermarkFrom(env.messages)
      setSelfWxid(env.selfWxid ?? '')
      setHasMore(env.hasMore ?? false)
      setCursor(env.cursor ?? 0)
      setCursorLocalId(env.cursorLocalId)
      setTypeStats(env.typeStats ?? [])
      writeRenderCache('chat-msgs:v2:' + talker, env.messages)
    } catch { /* keep current view */ }
  }, [curSession])

  /**
   * 打开「编辑消息副本」对话框。
   *
   * 原实现用 `window.prompt(...)` 取新内容 —— **Electron 渲染进程不支持 prompt**
   * （调用即抛 `prompt() is not supported.`），于是右键菜单点「编辑消息副本」除了在
   * 控制台留一条报错外什么都不发生（用户反馈「为什么还不能编辑信息」）。
   * 改成应用内对话框：可多行、能显示保存失败的原文、Esc/取消可退。
   */
  const doEdit = useCallback((m: WechatMessage): void => {
    setEditTarget(m)
    setEditText(m.displayText || m.strContent || '')
    setEditErr(null)
  }, [])

  const closeEdit = useCallback((): void => {
    setEditTarget(null)
    setEditErr(null)
  }, [])

  const saveEdit = useCallback(async (): Promise<void> => {
    const m = editTarget
    if (!m || !curSession) return
    setEditBusy(true)
    setEditErr(null)
    try {
      const r = await apiEditChatMessage({ username: curSession.username, localId: m.localId, content: editText })
      if (!r.ok) { setEditErr(r.error ?? '未知错误'); return }
      setEditTarget(null)
      await reloadCurrent()
      await loadEdits()
    } catch (e) {
      setEditErr((e as Error).message)
    } finally {
      setEditBusy(false)
    }
  }, [editTarget, editText, curSession, reloadCurrent, loadEdits])

  const sessionListRef = useRef<HTMLDivElement | null>(null)
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
  const clearDraft = useCallback(async (): Promise<void> => {
    if (!curSession || !curSession.draft) return
    const ok = await confirm({
      title: `清空「${curSession.displayName || curSession.username}」的草稿？`,
      message: '清空的是本地解密副本里的草稿，不影响微信本身。',
      tone: 'danger',
    })
    if (!ok) return
    try {
      const r = await apiClearSessionDraft({ username: curSession.username })
      if (r.ok) reloadSessionsList()
    } catch { /* keep view */ }
  }, [curSession, reloadSessionsList])

  const clearAllDrafts = useCallback(async (): Promise<void> => {
    const ok = await confirm({
      title: '清空所有会话草稿？',
      message: '清空的是本地解密副本里的草稿，不影响微信本身。',
      tone: 'danger',
    })
    if (!ok) return
    try {
      const r = await apiClearAllSessionDrafts()
      window.alert(`已清空 ${r.count} 条草稿`)
      reloadSessionsList()
    } catch (e) {
      window.alert('清空失败: ' + (e as Error).message)
    }
  }, [reloadSessionsList])

  const copyMsgJson = useCallback((m: WechatMessage): void => {
    try {
      const json = JSON.stringify({
        localId: m.localId,
        type: m.type,
        isSender: m.isSender,
        createTime: m.createTime,
        displayText: m.displayText,
        typeLabel: m.typeLabel,
        sender: m.sender ?? undefined,
        rich: m.rich ?? undefined,
      }, null, 2)
      void navigator.clipboard.writeText(json).then(() => { window.alert('消息 JSON 已复制') }).catch(() => { window.alert('复制失败') })
    } catch { window.alert('复制失败') }
  }, [])

  const doReset = useCallback(async (rec: EditedMessageRecord): Promise<void> => {
    if (!curSession) return
    const ok = await confirm({
      title: '恢复该消息为原始内容？',
      message: '本次编辑会被撤销。',
      tone: 'danger',
      confirmText: '恢复原文',
    })
    if (!ok) return
    setEditing(true)
    try {
      const r = await apiResetEditedMessage({ username: rec.sessionId, localId: rec.localId })
      if (!r.ok) window.alert('恢复失败: ' + (r.error ?? ''))
      else { await reloadCurrent(); await loadEdits() }
    } catch (e) {
      window.alert('恢复失败: ' + (e as Error).message)
    } finally {
      setEditing(false)
    }
  }, [curSession, reloadCurrent, loadEdits])

  // ── message search (A7) ──
  const [searchMode, setSearchMode] = useState<'session' | 'message'>('session')
  const [msgHits, setMsgHits] = useState<readonly SearchHit[]>([])
  const [msgSearchLoading, setMsgSearchLoading] = useState(false)
  const [msgSearchError, setMsgSearchError] = useState<string | null>(null)
  const [msgSearched, setMsgSearched] = useState(false)
  const [msgIndexed, setMsgIndexed] = useState(true)
  const [indexBuilding, setIndexBuilding] = useState(false)
  const msgSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const msgSearchSeqRef = useRef(0)
  /**
   * 在跑的消息搜索的 jobId（N9）。换关键词/清空/离开面板时用它打断上一轮扫描 ——
   * 后端兜底扫描最长可达秒级，不打断就白占着 worker（用户已经不看结果了）。
   */
  const activeSearchJobRef = useRef<string | null>(null)
  /** 打断在跑的那次搜索（没有就别调 RPC）。 */
  const cancelActiveSearch = useCallback((): void => {
    const jobId = activeSearchJobRef.current
    activeSearchJobRef.current = null
    if (jobId === null) return
    void apiCancelSearch({ jobId }).catch(() => { /* 搜索已跑完 —— cancelSearch 会回 ok:false，不是错误 */ })
  }, [])

  // ── group chat info panel (群聊信息) ──
  const [groupInfoOpen, setGroupInfoOpen] = useState(false)
  const [groupInfo, setGroupInfo] = useState<GroupInfo | null>(null)
  const [groupInfoLoading, setGroupInfoLoading] = useState(false)
  const [groupInfoErr, setGroupInfoErr] = useState<string | null>(null)
  const [memberSearch, setMemberSearch] = useState('')
  const [memberExpanded, setMemberExpanded] = useState(false)
  /**
   * 群公告展开态。公告是自由文本（实测样本 5 行）。
   * 原先 `.groupInfoValue` 用 -webkit-line-clamp:3 **静默**截断且没有展开入口 ——
   * 用户不知道内容被吃掉了（审计 P1-5）。这里给可展开的行内开关。
   */
  const [annExpanded, setAnnExpanded] = useState(false)
  const [annCanExpand, setAnnCanExpand] = useState(false)
  const annRef = useRef<HTMLDivElement | null>(null)
  const groupInfoTitleId = useId()
  const [profileMember, setProfileMember] = useState<GroupMember | null>(null)
  const [profilePos, setProfilePos] = useState<{ left: number; top: number } | null>(null)
  const [chatlogStack, setChatlogStack] = useState<Array<{ title: string; records: ChatlogRecord[] }>>([])
  const [chatlogResolving, setChatlogResolving] = useState(false)
  const chatlogOpen = chatlogStack.length > 0 ? chatlogStack[chatlogStack.length - 1] : null
  const profileHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const showMemberProfile = (m: GroupMember, el: HTMLElement): void => {
    if (profileHideTimer.current) clearTimeout(profileHideTimer.current)
    setProfileMember(m)
    const rect = el.getBoundingClientRect()
    const width = 232
    const left = rect.left - width - 10 >= 8 ? rect.left - width - 10 : rect.right + 10
    const top = Math.max(8, Math.min(rect.top, window.innerHeight - 170))
    setProfilePos({ left, top })
  }

  const hideMemberProfile = (): void => {
    if (profileHideTimer.current) clearTimeout(profileHideTimer.current)
    profileHideTimer.current = setTimeout(() => {
      setProfileMember(null)
      setProfilePos(null)
    }, 150)
  }
  const buildIndex = useCallback(async (silent = false): Promise<void> => {
    setIndexBuilding(true)
    try {
      const r = await apiBuildSearchIndex({ force: false })
      setMsgIndexed(true)
      // r.message 只在「跳过不可读分片」时出现：索引残缺必须让用户看见
      if (!silent) {
        setMsgSearchError(r.message
          ? `搜索索引已就绪（${r.rows ?? 0} 条，但${r.message}）`
          : `搜索索引已就绪（${r.rows ?? 0} 条）`)
      }
    } catch (e) {
      if (!silent) setMsgSearchError('索引构建失败: ' + (e as Error).message)
    } finally {
      setIndexBuilding(false)
    }
  }, [])

  const checkIndexStatus = useCallback(async (): Promise<void> => {
    try {
      const st = await apiGetSearchIndexStatus()
      setMsgIndexed(st.exists && st.rows > 0)
    } catch { /* keep default */ }
  }, [])

  const onSearchInput = useCallback((q: string): void => {
    if (msgSearchTimer.current) clearTimeout(msgSearchTimer.current)
    const term = q.trim()
    if (term.length < 1) {
      msgSearchSeqRef.current += 1
      cancelActiveSearch()
      setMsgHits([])
      setMsgSearched(false)
      setMsgSearchError(null)
      return
    }
    const seq = ++msgSearchSeqRef.current
    // 新一轮搜索开始即打断上一轮（N9）：上一次的兜底扫描可能还在 worker 里跑
    cancelActiveSearch()
    if (!msgIndexed && !indexBuilding) void buildIndex(true)
    msgSearchTimer.current = setTimeout(async () => {
      setMsgSearchLoading(true)
      setMsgSearchError(null)
      const jobId = 'chats-search-' + (globalThis.crypto?.randomUUID?.() ?? String(Date.now()))
      activeSearchJobRef.current = jobId
      try {
        const r = await apiSearchMessages({ query: term, limit: 200, jobId })
        if (seq !== msgSearchSeqRef.current) return
        setMsgHits(r.hits)
        setMsgIndexed(r.indexed)
        setMsgSearched(true)
      } catch (e) {
        if (seq !== msgSearchSeqRef.current) return
        setMsgSearchError((e as Error).message)
        setMsgHits([])
      } finally {
        if (activeSearchJobRef.current === jobId) activeSearchJobRef.current = null
        if (seq === msgSearchSeqRef.current) setMsgSearchLoading(false)
      }
    }, 350)
  }, [msgIndexed, indexBuilding, buildIndex, cancelActiveSearch])

  // 离开面板时打断在跑的搜索（N9；与上面那条「新搜索打断旧搜索」同一套 token）
  useEffect(() => () => { cancelActiveSearch() }, [cancelActiveSearch])

  // ── message calendar (A8) ──
  const [calOpen, setCalOpen] = useState(false)
  // 手写覆盖层的 Esc 关闭（kit 的 Drawer/Dialog 由 Radix 提供；这几个是手写的）
  useEscapeToClose(exportOpen, () => { setExportOpen(false) })
  useEscapeToClose(chatlogStack.length > 0, () => { setChatlogStack([]) })
  useEscapeToClose(calOpen, () => { setCalOpen(false) })
  useEscapeToClose(editedOpen, () => { setEditedOpen(false) })
  // 焦点管理：进入移入、Tab 循环、关闭还原（手写弹窗没有 Radix 的那套）
  useDialogFocus(exportOpen, '[data-st-dialog="chats-export"]')
  useDialogFocus(chatlogStack.length > 0, '[data-st-dialog="chats-chatlog"]')
  useDialogFocus(calOpen, '[data-st-dialog="chats-cal"]')
  useDialogFocus(editedOpen, '[data-st-dialog="chats-edited"]')
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

  const onEditFn = doEdit

  /** 消息右键菜单的光标定位状态（null = 未打开）。 */
  const [msgMenu, setMsgMenu] = useState<{ x: number; y: number; m: WechatMessage; kind: RenderKind } | null>(null)

  /**
   * 切换分类视图（全部 / 公众号 / 服务号 / 客服）。
   *
   * 类目互斥：列表换类目后，右侧那个「打开中的会话」已经不属于当前界面，
   * 必须一并关掉 —— 否则在「客服」视图里会看到之前打开的某个公众号聊天，
   * 就是这个界面上出现了别的类目的信息。会话无关的浮层（聊天记录弹窗、
   * 右键菜单）也一起收起，避免残留指向上一个会话的内容。
   * @param next - the category to switch to.
   */
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
  const memberQuery = memberSearch.trim().toLowerCase()
  const memberTotal = groupInfo ? groupInfo.members.length : 0
  const filteredMembers = ((): GroupMember[] => {
    if (!groupInfo) return []
    if (!memberQuery) return groupInfo.members
    return groupInfo.members.filter((m) =>
      m.name.toLowerCase().includes(memberQuery) || m.username.toLowerCase().includes(memberQuery))
  })()
  const memberLimit = memberExpanded ? 200 : 24
  const shownMembers = filteredMembers.slice(0, memberLimit)

  return (
    <div className={css.panel} data-ai-full={(aiOpen && aiFull) || undefined}>
      {/* left: session list */}
      <div className={css.sidebar}>
        <div className={css.search}>
          <SearchInput
            className={css.searchField}
            value={search}
            onChange={(v) => {
              setSearch(v)
              if (searchMode === 'message') onSearchInput(v)
            }}
            placeholder={searchMode === 'message' ? '搜索全部消息' : '搜索会话'}
            ariaLabel={searchMode === 'message' ? '搜索全部消息' : '搜索会话'}
          />
          <button
            type="button"
            className={css.searchActionBtn}
            data-active={searchMode === 'message' || undefined}
            title="全局消息搜索"
            onClick={() => {
              const next = searchMode === 'message' ? 'session' : 'message'
              setSearchMode(next)
              if (next === 'message' && search.trim()) onSearchInput(search)
            }}
          >搜消息</button>
          <button
            type="button"
            className={css.searchActionBtn}
            data-active={batchMode || undefined}
            title="批量导出会话"
            onClick={() => { setBatchMode(v => !v); setSelected(new Set()) }}
          >{batchMode ? '退出批量' : '批量'}</button>
        </div>
        {searchMode === 'session' ? (
          <>
            <div className={css.typeFilter}>
              <Segmented
                options={[
                  { value: 'chats', label: '全部' },
                  { value: 'bizchats', label: '公众号' },
                  { value: 'servicechats', label: '服务号' },
                  { value: 'kefu', label: '客服' },
                ]}
                value={view}
                onChange={(v) => { changeView(v as ChatView) }}
                ariaLabel="会话分类"
              />
            </div>
            <div className={css.stats}>
              {batchMode ? (
                <>
                  <button type="button" className={css.batchBtn} onClick={() => { setSelected(new Set(filtered.map(x => x.username))) }}>全选</button>
                  <button type="button" className={css.batchBtn} onClick={() =>{  setSelected(new Set()) }}>清空</button>
                  <span className={css.statUnread}>已选 {selected.size}</span>
                  <button type="button" className={css.batchBtn} onClick={() => { void exportBatch() }} disabled={batchExporting || selected.size === 0}>
                    {batchExporting ? '导出中…' : '导出所选'}
                  </button>
                  {batchMsg && <span className={css.batchMsg}>{batchMsg}</span>}
                </>
              ) : (
                <>
                  <span>好友 {stats.friends}</span>
                  <span>群聊 {stats.groups}</span>
                  {stats.unread > 0 && <span className={css.statUnread}>未读 {stats.unread}</span>}
                </>
              )}
            </div>
            <div ref={sessionListRef} className={css.list}>
              {loading && <ListSkeleton rows={10} />}
              {error && <div className={kitCss.error} role="alert">{error}</div>}
              {!loading && !error && filtered.length === 0 && <div className={kitCss.emptyInline}>{view === 'chats' ? '暂无会话' : '暂无' + (view === 'kefu' ? '客服会话' : '订阅会话')}</div>}
              {!loading && !error && pinnedList.length > 0 && (
                <div className={css.pinSection}>
                  {!pinnedCollapsed && pinnedList.map(s => renderSession(s))}
                  <button type="button" className={css.pinToggle} onClick={togglePinned}>
                    <span className={css.pinMark}><IconPin /> 置顶（{pinnedList.length}）</span>
                    <span className={css.pinArrow}>{pinnedCollapsed ? '▸' : '▾'}</span>
                  </button>
                </div>
              )}
              {!loading && !error && normalList.slice(0, sessCount).map(s => renderSession(s))}
              {!loading && !error && normalList.length > sessCount && <ListSentinel refFn={sessSentinel} />}
              {!loading && !error && !sessionSearching && sessionsPager.hasMore && <ListSentinel refFn={sessionsLoadMoreRef} />}
            </div>
          </>
        ) : (
          <div className={css.list}>
            {!msgIndexed && (
              <div className={css.searchIndexHint}>
                <span>消息搜索索引尚未构建（当前为全表扫描）</span>
                <button type="button" className={css.loadMore} onClick={() => { void buildIndex() }} disabled={indexBuilding}>
                  {indexBuilding ? '构建中…' : '构建索引'}
                </button>
              </div>
            )}
            {msgSearchLoading && <div className={kitCss.emptyInline}>搜索中…</div>}
            {msgSearchError && <div className={kitCss.emptyInline}>{msgSearchError}</div>}
            {!msgSearchLoading && msgSearched && msgHits.length === 0 && !msgSearchError && <div className={kitCss.emptyInline}>未找到相关消息</div>}
            {!msgSearchLoading && msgHits.length > 0 && (
              <>
                <div className={css.searchHitCount}>命中 {msgHits.length} 条 · 点击定位到原消息</div>
                {msgHits.map(hit => (
                  <button key={`${hit.username}:${hit.local_id}`} type="button" className={css.searchHit} onClick={() => { void openSessionAndLocate(hit.username, hit.local_id) }}>
                    <div className={css.searchHitTop}>
                      <span className={css.searchHitName}>{hit.name || hit.username}</span>
                      <span className={css.searchHitTime}>{hit.time}</span>
                    </div>
                    <div className={css.searchHitSnippet}>{hit.snippet}</div>
                  </button>
                ))}
              </>
            )}
            {!msgSearchLoading && !msgSearched && !msgSearchError && <div className={kitCss.emptyInline}>输入关键词搜索全部消息</div>}
          </div>
        )}
      </div>

      {/* right: message stream */}
      <div className={css.messages}>
        <div className={css.starWrap} data-hidden={curSession !== null || undefined}>
          <RainWindow className={css.starfield} label="" active={curSession === null} />
        </div>
        {curSession === null && (
          <div className={css.msgEmptyState}>
            <div className={css.msgEmptyIcon}>💬</div>
            <div className={css.msgEmptyTitle}>从左侧选择一个会话</div>
            <div className={css.msgEmptyText}>点击会话即可查看聊天记录与文件，数据仅在本机只读预览。</div>
            {filtered.length > 0 && (
              <button type="button" className={css.msgEmptyAction} onClick={() => { const first = filtered[0]; if (first !== undefined) void openSession(first) }}>
                查看最近会话
              </button>
            )}
          </div>
        )}
        {curSession !== null && (
          <>
            <div className={css.msgHeader}>
              <div className={css.msgHeaderInfo}>
                <div className={css.msgHeaderName}>
                  {curSession.displayName || curSession.username}
                  {isEnterpriseChat(curSession.username) && <span className={css.entBadge} title="企业微信">企业微信</span>}
                </div>
                <div className={css.msgHeaderUser}>{curSession.username}{messages.length > 0 ? ` · 共 ${messages.length} 条` : ''}</div>
                {exportMsg && <div className={css.msgHeaderExport} title={exportMsg}>{exportMsg}</div>}
              </div>
              <div className={css.msgHeaderActions}>
                {/* AI 问答入口：只对单聊/群聊出现（详见 aiEligible）。 */}
                {aiEligible && (
                  <button
                    type="button"
                    className={css.calBtn}
                    data-active={aiOpen || undefined}
                    aria-expanded={aiOpen}
                    title="AI 问答：基于本会话聊天记录提问，回答附原文出处"
                    onClick={() => { setAiOpen(v => !v); setSuggestOpen(false) }}
                  >
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z" />
                    </svg>
                    <span className={css.calBtnLabel}>AI 问答</span>
                  </button>
                )}
                {/* 推荐回复：只给单聊（群聊里「回一句」的语义不成立）。 */}
                {curSession.type === 'private' && (
                  <button
                    type="button"
                    className={css.calBtn}
                    data-active={suggestOpen || undefined}
                    aria-expanded={suggestOpen}
                    title="推荐回复：按这段对话（可结合当前知识库）生成 3 条候选回复"
                    onClick={() => { setSuggestOpen(v => !v); setAiOpen(false) }}
                  >
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M9 17H7a4 4 0 0 1 0-8h10a4 4 0 0 1 0 8h-2" /><path d="m12 12 3 3-3 3" />
                    </svg>
                    <span className={css.calBtnLabel}>推荐回复</span>
                  </button>
                )}
                <button type="button" className={css.calBtn} title="消息日历（每日消息数热力图）" onClick={() => { void openCalendar() }}><IconCalendar /> <span className={css.calBtnLabel}>日历</span></button>
                {curSession.type === 'group' && (
                  <button type="button" className={css.calBtn} data-active={groupInfoOpen || undefined} title="群聊信息" onClick={openGroupInfo}><IconUserOutline16 size={14} /><span className={css.calBtnLabel}>群信息</span></button>
                )}
                {/*
                  低频动作（导出/已编辑/清空草稿）收进溢出菜单：此前它们与上面三个按钮平铺，
                  动作区内容宽 468px 且 flex-shrink:0，窗口一窄就被消息区裁掉 ——
                  1152px 丢 1 个、1024px 丢 3 个、960px 连「群信息」都点不到（审计 P0-2）。
                */}
                <div className={css.msgHeaderMoreWrap} data-st-menu="msg-header-more">
                  <button
                    type="button"
                    className={css.calBtn}
                    title="更多操作"
                    aria-haspopup="menu"
                    aria-expanded={moreOpen || undefined}
                    data-active={moreOpen || undefined}
                    onClick={() => { setMoreOpen(v => !v) }}
                  >
                    <IconEllipsisOutline16 size={14} /><span className={css.calBtnLabel}>更多</span>
                  </button>
                  {moreOpen && (
                    <div className={css.msgHeaderMoreMenu} role="menu" aria-label="更多操作">
                      <button type="button" role="menuitem" className={css.msgHeaderMoreItem} disabled={exporting}
                        onClick={() => { setMoreOpen(false); setExportOpen(true) }}>
                        <IconDownloadOutline16 size={14} />导出消息
                      </button>
                      <button type="button" role="menuitem" className={css.msgHeaderMoreItem} disabled={editing}
                        onClick={() => { setMoreOpen(false); void openEdits() }}>
                        <IconListPenOutline16 size={14} />已编辑消息{edits.length > 0 ? ` (${String(edits.length)})` : ''}
                      </button>
                      <button type="button" role="menuitem" className={css.msgHeaderMoreItem}
                        onClick={() => { setMoreOpen(false); void clearAllDrafts() }}>
                        <IconTrashOutline16 size={14} />清空所有会话草稿
                      </button>
                      {curSession.draft && (
                        <button type="button" role="menuitem" className={css.msgHeaderMoreItem}
                          onClick={() => { setMoreOpen(false); void clearDraft() }}>
                          <IconTrashOutline16 size={14} />清空本会话草稿
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
              {pollStatus && <span className={css.msgHeaderExport} title={pollStatus}>{pollStatus}</span>}
            </div>
            {/*
              类型统计 chip 行此前在 .msgHeader 内，与标题行/动作行争宽 —— 实测头部因此在
              1664px 就有 94.6px 高、到 960px 涨到 195px 且 chip 被挤成三行竖排（审计 P1-9）。
              移出成独立条：头部回到单行，窄窗口下由容器查询整条收起。
            */}
            {typeStats.length > 0 && (
              <div className={css.msgTypeChips}>
                {typeStats.slice(0, 5).map(t => (
                  <span key={t.type} className={css.msgTypeChip} title={`${t.label}共 ${t.count} 条`}>{t.label} {t.count}</span>
                ))}
                {typeStats.length > 5 && (
                  <span className={css.msgTypeChip}>其他 +{typeStats.slice(5).reduce((a, s) => a + s.count, 0)}</span>
                )}
              </div>
            )}
            <div className={css.msgBody} ref={msgScrollRef}>
              {/* 归属不符（正在切会话）时只显示骨架，绝不把上一个会话的消息画出来 */}
              {!messagesMatchSession && <ListSkeleton rows={8} />}
              {messagesMatchSession && hasMore && (
                <button type="button" className={css.loadMore} onClick={() => { void loadMore() }}>
                  {msgLoading ? '加载中…' : '加载更多'}
                </button>
              )}
              {messagesMatchSession && msgError && <div className={css.msgErr}>{msgError}</div>}
              {messagesMatchSession && (
                /*
                 * 虚拟化（N18）：外层按总高度撑开滚动条，行按各自偏移绝对定位。
                 * 只挂载视口附近（`overscan`）+ 动态测高（`measureElement`），
                 * 所以 DOM 节点数与已加载的历史长度**解耦**（实测 1 万条消息从 9,700 个节点降到几十个）。
                 * `id="msg-<localId>"` 仍在行上，深链与 `locateMessage` 照旧可用。
                 */
                <div style={{ height: msgVirtualizer.getTotalSize(), position: 'relative', flex: '0 0 auto' }}>
                  {msgVirtualizer.getVirtualItems().map((vi) => {
                    const item = msgItems[vi.index]
                    if (!item) return null
                    return (
                      <div
                        key={vi.key}
                        data-index={vi.index}
                        ref={msgVirtualizer.measureElement}
                        style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vi.start}px)` }}
                      >
                        {renderMsgItem(item)}
                      </div>
                    )
                  })}
                </div>
              )}
              {msgLoading && messages.length === 0 && <ListSkeleton rows={8} />}
              <div ref={msgEndRef} />
            </div>
          </>
        )}
      </div>

      {groupInfoOpen && curSession?.type === 'group' && (
        <div
          className={css.groupInfo}
          role="dialog"
          aria-modal="true"
          aria-labelledby={groupInfoTitleId}
          data-st-dialog="chats-groupinfo"
        >
          <div className={css.groupInfoHeader}>
            <span className={css.groupInfoTitle} id={groupInfoTitleId}>群聊信息</span>
            <button type="button" className={css.groupInfoClose} title="关闭" aria-label="关闭" onClick={() => { setGroupInfoOpen(false); setProfileMember(null) }}><IconCloseOutline16 size={15} /></button>
          </div>
          <div className={css.groupInfoBody}>
            {groupInfoLoading && <div className={kitCss.emptyInline}>加载中…</div>}
            {groupInfoErr && <div className={kitCss.emptyInline}>{groupInfoErr}</div>}
            {!groupInfoLoading && groupInfo && (
              <>
                <div className={css.memberSearchBox}>
                  <div className={css.searchIcon}><IconSearchOutline16 size={13} /></div>
                  <input
                    type="text"
                    placeholder="搜索群成员"
                    value={memberSearch}
                    onChange={(e) => { setMemberSearch(e.target.value) }}
                  />
                </div>
                {memberQuery && filteredMembers.length === 0 ? (
                  /* 搜索无结果必须给空态：此前网格直接渲染成 0 高度，界面只剩一片空白（审计 P0-3） */
                  <div className={css.memberEmpty}>
                    <div className={css.memberEmptyIcon}><IconSearchOutline16 size={22} /></div>
                    <div className={css.memberEmptyTitle}>未找到相关成员</div>
                    <div className={css.memberEmptyDesc}>
                      群里共 {memberTotal} 位成员，试试昵称或微信号的其它片段
                    </div>
                    <button type="button" className={css.memberEmptyClear} onClick={() => { setMemberSearch('') }}>
                      清空搜索
                    </button>
                  </div>
                ) : (
                  <div className={css.memberGrid}>
                    {shownMembers.map(m => (
                      <button
                        type="button"
                        key={m.username}
                        className={css.memberTile}
                        title={m.name}
                        onMouseEnter={(e) => { showMemberProfile(m, e.currentTarget) }}
                        onMouseLeave={hideMemberProfile}
                      >
                        {/* 与会话列表同一套懒挂载：展开到 200 人时不再一次性发起 200 个头像请求（审计 P2-4） */}
                        <LazyMount placeholder={<span className={css.avatarStub} style={{ width: 40, height: 40 }} />} rootMargin="300px 0px">
                          <Avatar name={m.name} username={m.username} size={40} />
                        </LazyMount>
                        <span className={css.memberName}>{m.name}</span>
                      </button>
                    ))}
                    {/*
                      故意的死控件（L13）：微信「聊天信息」页的成员网格末尾就是这个「＋ 添加」方块，
                      而本应用只**读**本机聊天库，没有可用的邀请/入群通道（往群里加人要么走微信协议、
                      要么直接改对方数据库，两者都不该做）。保留它的理由是布局保真 —— 去掉会让
                      成员网格与官方形态不一致（视觉审计 P1-8 行结构）。
                      因此它刻意不可交互：不是 <button>（键盘/焦点不进来）、不挂 onClick、
                      aria-disabled + title 说明原因，并且不给任何 hover 反馈让外观也不像可点
                      （见 chats.module.css 的 `.memberTile[data-disabled='true']` 规则）。
                      若将来真要做邀请，这里应换成打开确认对话框的按钮，而不是给它挂 onClick。
                    */}
                    {!memberQuery && (
                      <div className={css.memberTile} data-disabled="true" title="暂不支持邀请" aria-disabled="true">
                        <div className={css.memberAdd}><span>＋</span></div>
                        <span className={css.memberName}>添加</span>
                      </div>
                    )}
                  </div>
                )}
                {/* 有查询词时不再用「256 人」这个与过滤结果无关的数字（审计 P1-4） */}
                {memberQuery ? (
                  filteredMembers.length > memberLimit && (
                    <button type="button" className={css.memberMore} onClick={() => { setMemberExpanded(v => !v) }}>
                      {memberExpanded ? '收起' : `展开更多匹配（共 ${filteredMembers.length} 位）`}
                    </button>
                  )
                ) : memberTotal > 24 && (
                  <button type="button" className={css.memberMore} onClick={() => { setMemberExpanded(v => !v) }}>
                    {memberExpanded ? '收起' : `查看更多（${memberTotal} 人）`}
                  </button>
                )}
                {/* 微信的聊天信息是「标签左 / 值右」的列表行，不是「标签上 / 值下」的块（审计 P1-8 行结构） */}
                <div className={css.groupInfoRows}>
                  <div className={css.groupInfoRow}>
                    <span className={css.groupInfoRowLabel}>群聊名称</span>
                    <span className={css.groupInfoRowValue}>{groupInfo.name}</span>
                  </div>
                  {groupInfo.announcement && (
                    <div className={css.groupInfoRowStack}>
                      <span className={css.groupInfoRowLabel}>群公告</span>
                      <div ref={annRef} className={css.groupInfoAnn} data-clamp={!annExpanded || undefined}>
                        {groupInfo.announcement}
                      </div>
                      {annCanExpand && (
                        <button type="button" className={css.groupInfoAnnToggle} onClick={() => { setAnnExpanded(v => !v) }}>
                          {annExpanded ? '收起' : '展开'}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* message export dialog (格式/类型/时间范围/文件名/目录) */}
      {exportOpen && (
        <div className={css.calOverlay} data-st-dialog="chats-export" onClick={(e) => { if (e.target === e.currentTarget) setExportOpen(false) }} role="dialog" aria-modal="true">
          <div className={css.exportDialog}>
            <div className={css.calHeader}>
              <span className={css.calTitle}>导出消息</span>
              <button type="button" className={css.calClose} onClick={() => { setExportOpen(false) }}><IconCloseOutline16 size={15} /></button>
            </div>
            <div className={css.exportBody}>
              <div className={css.exportSection}>
                <div className={css.exportSectionHead}>
                  <span className={css.exportSectionTitle}>格式与内容</span>
                  <span className={css.exportCountBadge}>{expTypes.length === 0 ? '全部消息' : `${expTypes.length} 类消息`}</span>
                </div>
                <div className={css.exportField}>
                  <span className={kitCss.textMeta}>文件格式</span>
                  <div className={css.exportFormatGrid}>
                    {EXPO_FORMATS.map(f => (
                      <button key={f.value} type="button" className={css.exportFormatCard}
                        data-active={expFormat === f.value || undefined}
                        onClick={() => { setExpFormat(f.value as typeof expFormat) }}>
                        <span>{f.label}</span>
                        <i className={css.exportRadio} data-active={expFormat === f.value || undefined} />
                      </button>
                    ))}
                  </div>
                </div>
                <div className={css.exportField}>
                  <span className={kitCss.textMeta}>导出条数</span>
                  <div className={css.exportChips}>
                    {[10, 50, 100, 0].map(n => (
                      <button key={String(n)} type="button" className={css.exportChip} data-active={(expCount === n) || undefined}
                        onClick={() => { setExpCount(n) }}>{n === 0 ? '全部' : String(n) + ' 条'}</button>
                    ))}
                  </div>
                </div>
                <div className={css.exportField}>
                  <div className={css.exportLabelRow}>
                    <span className={kitCss.textMeta}>消息类型</span>
                    <button type="button" className={css.exportLinkBtn}
                      onClick={() => { setExpTypes(prev => prev.length > 0 ? [] : EXPO_TYPES.map(c => c.key)) }}>
                      {expTypes.length > 0 ? '取消全选' : '全选'}
                    </button>
                  </div>
                  <div className={css.exportChips}>
                    {EXPO_TYPES.map(c => (
                      <button key={c.key} type="button" className={css.exportChipCheck}
                        data-active={expTypes.includes(c.key) || undefined}
                        onClick={() => { setExpTypes(prev => prev.includes(c.key) ? prev.filter(k => k !== c.key) : [...prev, c.key]) }}>
                        <i className={css.exportCheck} data-active={expTypes.includes(c.key) || undefined}>{expTypes.includes(c.key) ? '✓' : ''}</i>
                        {c.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <div className={css.exportSection}>
                <div className={css.exportSectionHead}>
                  <span className={css.exportSectionTitle}>时间范围</span>
                  <button type="button" className={css.exportLinkBtn} onClick={() => { setExpFrom(''); setExpTo('') }}>全部时间</button>
                </div>
                <div className={css.exportRangeRow}>
                  <DateRangeField
                    from={expFrom}
                    to={expTo}
                    onFrom={setExpFrom}
                    onTo={setExpTo}
                    presets={['today', 'week', 'month', 'last-7', 'last-30']}
                    ariaLabel="导出时间范围"
                  />
                </div>
              </div>
              <div className={css.exportSection}>
                <div className={css.exportSectionHead}>
                  <span className={css.exportSectionTitle}>导出文件名</span>
                  <span className={css.exportHint}>可选，留空时自动生成</span>
                </div>
                <input type="text" className={css.exportInput} placeholder="例如：微信聊天记录_2026-07-11"
                  value={expFilename} onChange={(e) => { setExpFilename(e.target.value) }} />
                <label className={css.exportCheckbox}>
                  <input type="checkbox" checked={expZip} onChange={(e) => { setExpZip(e.target.checked) }} />
                  打包为 ZIP（含导出文件与 record_media.json）
                </label>
              </div>
              <div className={css.exportSection}>
                <div className={css.exportSectionHead}>
                  <span className={css.exportSectionTitle}>保存目录</span>
                </div>
                <div className={css.exportDirBox} data-chosen={(!!expDir.trim()) || undefined}>
                  <span className={css.exportDirIcon}>📁</span>
                  <div className={css.exportDirInfo}>
                    <span className={css.exportDirTitle}>{expDir.trim() ? '已选择保存目录' : '尚未选择保存目录'}</span>
                    <span className={kitCss.textCaptionTrunc}>{expDir.trim() ? expDir.trim() : '留空时导出到默认目录 ~/.dsh/wechat-data/exports'}</span>
                  </div>
                  <button type="button" className={css.exportBtn} onClick={() => { void chooseExportDir() }} disabled={pickingDir}>
                    {'＋ ' + (pickingDir ? '选择中…' : '选择目录')}
                  </button>
                </div>
              </div>
              <div className={css.exportActions}>
                <button type="button" className={css.exportBtnGhost} onClick={() => { setExportOpen(false) }}>取消</button>
                <button type="button" className={css.exportBtnPrimary} onClick={() => { void exportSession() }} disabled={exporting}>
                  {exporting ? '导出中…' : '导出'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* merged chat log viewer (聊天记录, 支持嵌套) */}
      {chatlogOpen && (
        <div className={css.calOverlay} data-st-dialog="chats-chatlog" onClick={(e) => { if (e.target === e.currentTarget) setChatlogStack([]) }} role="dialog" aria-modal="true">
          <div className={css.chatlogDialog}>
            <div className={css.calHeader}>
              <span className={css.calTitle}>{chatlogOpen.title}</span>
              <span className={css.calHeaderActions}>
                {chatlogStack.length > 1 && (
                  <button type="button" className={css.calClose} title="返回上一级" onClick={() => { setChatlogStack(prev => prev.slice(0, -1)) }} aria-label="返回上一级">‹</button>
                )}
                <button type="button" className={css.calClose} title="关闭" aria-label="关闭" onClick={() => { setChatlogStack([]) }}><IconCloseOutline16 size={15} /></button>
              </span>
            </div>
            <div className={css.chatlogBody}>
              {chatlogResolving && <div className={kitCss.emptyInline}>解析聊天记录…</div>}
              {chatlogOpen.records.length === 0 && !chatlogResolving && <div className={kitCss.emptyInline}>暂无内层消息</div>}
              {chatlogOpen.records.map((r, idx) => {
                const rt = r.renderType || (r.isImage ? 'image' : 'text')
                const nested = rt === 'chatHistory'
                const link = r.link || r.url || ''
                const nestedCount = (r.nested ?? []).length
                // head 来自聊天记录卡片 XML 的 <sourceheadurl>，是**未校验的原始地址**。
                // 实测 360 条内层记录里 193 条是 http，直接当 src 会被 CSP 拦（并写下违规日志）。
                // 过滤后为空则回退到首字母头像（下面的分支本来就是这么设计的）。
                const head = cspSafeSrc(r.head)
                return (
                  <div key={idx} className={css.chatlogRow}>
                    <div className={css.chatlogAvatar}>
                      {head ? (
                        <img src={head} alt="" referrerPolicy="no-referrer" loading="lazy"
                          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
                      ) : (
                        <span>{(r.name || '?').slice(0, 1)}</span>
                      )}
                    </div>
                    <div className={css.chatlogMain}>
                      <div className={css.chatlogTop}>
                        <span className={css.chatlogName}>{r.name}</span>
                        <span className={css.chatlogTime}>{r.time}</span>
                      </div>
                      {nested && (
                        <button type="button" className={css.chatlogNested} onClick={() => { void openNestedChatlog(r) }}>
                          <span>📋 {r.text || '聊天记录'}（{nestedCount > 0 ? String(nestedCount) + ' 条' : '点击查看'}）</span>
                        </button>
                      )}
                      {rt === 'link' && link ? (
                        <div className={css.chatlogText}><a href={link} target="_blank" rel="noopener noreferrer"
                          onClick={(e) => { e.preventDefault(); openLink(link) }} className={css.msgTextLink}>{r.text || link}</a></div>
                      ) : rt === 'voice' ? (
                        <div className={css.chatlogText}>🎤 {r.text || '[语音]'}{r.duration ? String(Math.round(Number(r.duration) / 20)) + '"' : ''}</div>
                      ) : rt === 'video' ? (
                        <div className={css.chatlogText}>🎬 {r.text || '[视频]'}{r.duration ? String(Math.round(Number(r.duration) / 1000)) + 's' : ''}</div>
                      ) : rt === 'emoji' ? (
                        <div className={css.chatlogText}>😀 {r.text || '[表情]'}</div>
                      ) : rt === 'image' ? (
                        <div className={css.chatlogText}>🖼️ [图片]{r.datasize ? ' (' + r.datasize + ' 字节)' : ''}</div>
                      ) : (
                        <div className={css.chatlogText}>{r.text || ''}</div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {/* 编辑消息副本：写入本地解密副本，原文在 message_edits.db 里留底，可用「恢复原文」回退 */}
      <Dialog
        open={editTarget !== null}
        onClose={() => { if (!editBusy) closeEdit() }}
        title="编辑消息副本"
        footer={(
          <div className={css.editFoot}>
            <button type="button" className={css.exportBtn} disabled={editBusy} onClick={closeEdit}>取消</button>
            <button
              type="button"
              className={css.exportBtnPrimary}
              disabled={editBusy || editText.trim() === (editTarget?.displayText || editTarget?.strContent || '').trim()}
              onClick={() => { void saveEdit() }}
            >
              {editBusy ? '保存中…' : '保存'}
            </button>
          </div>
        )}
      >
        <p className={css.editHint}>
          只改动本地解密副本（微信原始数据库不动）。保存后这条消息会标上「已编辑」，
          随时可在「更多 → 已编辑消息」里恢复原文。
        </p>
        <textarea
          ref={editAreaRef}
          className={css.editArea}
          value={editText}
          onChange={(e) => { setEditText(e.target.value) }}
          aria-label="消息内容"
          spellCheck={false}
        />
        {editErr && <p className={css.editErr} role="alert">保存失败：{editErr}</p>}
      </Dialog>

      {/* 消息右键菜单（微信同款）：点空白处 / Esc / 滚动都会关掉 */}
      {msgMenu && (
        <div className={css.msgCtxOverlay} onMouseDown={() => { setMsgMenu(null) }}>
          <div
            className={css.msgCtxMenu}
            style={{ left: msgMenu.x, top: msgMenu.y }}
            role="menu"
            onMouseDown={(e) => { e.stopPropagation() }}
          >
            {buildMsgMenu(msgMenu.m, msgMenu.kind).map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                className={css.msgCtxItem}
                onClick={() => { const m = msgMenu.m; setMsgMenu(null); runMenuAction(item, m) }}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* member profile popover (群成员资料，悬浮于头像旁) */}
      {profileMember && profilePos && (
        <div className={css.memberProfilePop} style={{ left: profilePos.left, top: profilePos.top }}>
          <div className={css.memberProfileBody}>
            <Avatar name={profileMember.name} username={profileMember.username} size={56} />
            <div className={css.memberProfileName}>{profileMember.name}</div>
            <div className={css.memberProfileItem}>
              <span>微信号</span><span className={css.memberProfileMono}>{profileMember.username}</span>
            </div>
            {profileMember.region && (
              <div className={css.memberProfileItem}>
                <span>地区</span><span className={css.memberProfileMono}>{profileMember.region}</span>
              </div>
            )}
            {profileMember.signature && (
              <div className={css.memberProfileItem}>
                <span>签名</span><span className={css.memberProfileMono}>{profileMember.signature}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* message calendar dialog (A8) */}
      {calOpen && (
        <div className={css.calOverlay} data-st-dialog="chats-cal" onClick={(e) => { if (e.target === e.currentTarget) setCalOpen(false) }} role="dialog" aria-modal="true">
          <div className={css.calDialog}>
            <div className={css.calHeader}>
              <span className={css.calTitle}>消息日历</span>
              <button type="button" className={css.calClose} onClick={() =>{  setCalOpen(false) }}><IconCloseOutline16 size={15} /></button>
            </div>
            <div className={css.calBody}>
              <div className={css.calNav}>
                <button type="button" className={css.loadMore} onClick={() => { void switchCalMonth(-1) }} aria-label="上一月">‹</button>
                <span className={css.calMonthTitle}>{calYear} 年 {calMonth} 月</span>
                <button type="button" className={css.loadMore} onClick={() => { void switchCalMonth(1) }} aria-label="下一月">›</button>
              </div>
              {calLoading ? (
                <div className={kitCss.emptyInline}>加载中…</div>
              ) : (
                <>
                  <div className={css.calStats}>
                    <span className={css.calStat}>本月共 <b>{calTotal}</b> 条消息</span>
                    <span className={css.calStat}>活跃 <b>{calActiveDays}</b> 天</span>
                    <span className={css.calStat}>日均 <b>{calAvg}</b> 条</span>
                    {calTop && <span className={css.calStat}>最活跃：{calMonth}月{calTop.day}日（{calTop.count} 条）</span>}
                  </div>
                  <div className={css.calGrid}>
                    {['一', '二', '三', '四', '五', '六', '日'].map(wd => (
                      <div key={wd} className={css.calWd}>{wd}</div>
                    ))}
                    {Array.from({ length: calFirstDow }).map((_, i) => <div key={`e${i}`} className={css.calEmpty} />)}
                    {Array.from({ length: calDays }).map((_, i) => {
                      const day = i + 1
                      const cnt = calCounts[String(day)] ?? 0
                      return (
                        <button key={day} type="button" className={css.calDay} style={{ background: calHeat(cnt) }}
                          title={cnt ? `${calMonth}月${day}日：${cnt} 条消息` : `${calMonth}月${day}日：无消息`}
                          onClick={() =>{  jumpToDay(day) }}>
                          <span className={css.calDayNum}>{day}</span>
                          {cnt > 0 && <span className={css.calDayCnt}>{cnt}</span>}
                        </button>
                      )
                    })}
                  </div>
                  <p className={css.calHint}>点击日期跳转到当天消息（色块深浅表示消息量）</p>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* edited-messages popup */}
      {editedOpen && (
        <div className={css.calOverlay} data-st-dialog="chats-edited" onClick={() =>{  setEditedOpen(false) }} role="dialog" aria-modal="true">
          <div className={css.calDialog}>
            <div className={css.calHeader}>
              <span className={css.calTitle}>本会话已编辑消息</span>
              <button type="button" className={css.calClose} onClick={() =>{  setEditedOpen(false) }} aria-label="关闭">×</button>
            </div>
            <div className={css.calBody}>
              {edits.length === 0 ? (
                <div className={kitCss.emptyInline}>暂无编辑记录（修改仅写入本地解密副本）</div>
              ) : (
                edits.map(rec => (
                  <div key={`${rec.sessionId}:${rec.localId}`} className={css.editRow}>
                    <span className={css.editRowInfo}>
                      #{rec.localId} · 编辑 {rec.editCount} 次 · {new Date(rec.lastEditedAt).toLocaleString()}
                    </span>
                    <button type="button" className={css.loadMore} onClick={() => { void doReset(rec) }} disabled={editing}>恢复原文</button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* 会话级 AI 面板（「新对话」）：.panel 的第三栏，与消息流并排。
          仅单聊/群聊给入口；读取范围固定为当前会话，检索仍走同一条 RAG 流水线。 */}
      {/* 推荐回复：同样是 .panel 的第三栏；读取范围=当前会话 + 当前选中的知识库。 */}
      {suggestOpen && curSession !== null && curSession.type === 'private' && (
        <ReplySuggest target={curSession} onClose={() => { setSuggestOpen(false) }} />
      )}

      {aiOpen && aiEligible && aiTarget && (
        <SessionAsk
          target={aiTarget}
          onClose={() => { setAiOpen(false); setAiFull(false) }}
          onOpenMessage={(u, id) => { void openSessionAndLocate(u, id > 0 ? id : undefined) }}
          full={aiFull}
          onToggleFull={() => { setAiFull(v => !v) }}
        />
      )}

      {/* image lightbox */}
      {viewer && (
        <ImageViewer
          images={viewer.images}
          index={viewer.index}
          onClose={() =>{  setViewer(null) }}
          onIndexChange={(i) =>{  setViewer(v => (v ? { ...v, index: i } : v)) }}
        />
      )}
    </div>
  )
}

