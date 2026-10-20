
/**
 * Chats 面板的「会话打开与消息流」（M21 第三十四刀起自 Chats.tsx 拆出）。
 *
 * 原先散在 `ChatsPanel` 的函数体里（几十个 state 与回调），但输入输出很清楚 —— 抽成钩子后：
 * 面板把输入传进来、把用得到的值解构出去，其余细节（轮询、竞态防护、菜单构造）留在模块里。
 * 钩子在面板的**第一条组内声明处**调用 ⇒ 与原来的声明顺序等价。
 */

import type { ChatlogFrame } from './chats-chatlog.ts'
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { apiGetGroupInfo, apiGetMessages, readRenderCache, writeRenderCache } from '../api.ts'
import { useDialogFocus, useEscapeToClose } from '../ui/kit.tsx'
import type { ChatTarget } from './Chats.tsx'
import { ChatView } from './chats-support.tsx'
import { messagesMatchTalker } from './msg-scope.ts'
import { pinScrollToBottom, useChatsPolling } from './chats-polling.ts'
import { makeMsgRow } from './chats-msg-row.tsx'
import type { MsgMenuAnchor } from './chats-msg-menu.tsx'
import type { GroupInfo, GroupMember, MessageRich, MessageRenderKind as RenderKind, WechatMessage, WechatSession } from '@deepseek-ai/dsh-wechat-data/types'

export interface useChatsThreadInputs {
  /**
   * 在途结果是否仍属于本次会话 —— 定义在**面板**里（会话/消息两半都要用它，放外面才不产生钩子环），
   * 这里当输入用；其语义见 `Chats.tsx#sessionAlive`。
   */
  sessionAlive: (epoch: number, talker: string) => boolean
  annExpanded: boolean
  annRef: React.MutableRefObject<HTMLDivElement | null>
  closeCurrentSession: () => void
  curSession: WechatSession | null
  cursor: number
  cursorLocalId: number | undefined
  editedIds: Set<number>
  groupInfo: GroupInfo | null
  groupInfoOpen: boolean
  hasMore: boolean
  inFlightRef: React.MutableRefObject<boolean>
  /** 深链进来的「定位到某条消息」，没有就是没有（`ChatsPanel` 的道具本就是可选的）。 */
  initialTarget?: ChatTarget | null
  initialView: ChatView | undefined
  locateMessage: (localId: number) => void
  messages: readonly WechatMessage[]
  messagesTalkerRef: React.MutableRefObject<string | null>
  moreOpen: boolean
  /** 消息区滚动容器：新消息到达时判断用户是否在看最新消息（浮标/自动跟随共用）。 */
  msgScrollRef: React.MutableRefObject<HTMLDivElement | null>
  msgLoading: boolean
  openMsgMenu: (ev: MsgMenuAnchor, m: WechatMessage, kind: RenderKind) => void
  openViewer: (m: WechatMessage) => void
  selfWxid: string
  sessionEpochRef: React.MutableRefObject<number>
  sessions: readonly WechatSession[]
  setAnnCanExpand: React.Dispatch<React.SetStateAction<boolean>>
  setAnnExpanded: React.Dispatch<React.SetStateAction<boolean>>
  setChatlogStack: React.Dispatch<React.SetStateAction<ChatlogFrame[]>>
  setCurSession: React.Dispatch<React.SetStateAction<WechatSession | null>>
  setCursor: React.Dispatch<React.SetStateAction<number>>
  setCursorLocalId: React.Dispatch<React.SetStateAction<number | undefined>>
  setGroupInfo: React.Dispatch<React.SetStateAction<GroupInfo | null>>
  setGroupInfoErr: React.Dispatch<React.SetStateAction<string | null>>
  setGroupInfoLoading: React.Dispatch<React.SetStateAction<boolean>>
  setGroupInfoOpen: React.Dispatch<React.SetStateAction<boolean>>
  setHasMore: React.Dispatch<React.SetStateAction<boolean>>
  setMemberExpanded: React.Dispatch<React.SetStateAction<boolean>>
  setMemberSearch: React.Dispatch<React.SetStateAction<string>>
  setMessages: React.Dispatch<React.SetStateAction<readonly WechatMessage[]>>
  setMoreOpen: React.Dispatch<React.SetStateAction<boolean>>
  setMsgError: React.Dispatch<React.SetStateAction<string | null>>
  setMsgLoading: React.Dispatch<React.SetStateAction<boolean>>
  setMsgMenu: React.Dispatch<React.SetStateAction<{ x: number; y: number; m: WechatMessage; kind: RenderKind } | null>>
  setPollStatus: React.Dispatch<React.SetStateAction<string>>
  setProfileMember: React.Dispatch<React.SetStateAction<GroupMember | null>>
  setSelfWxid: React.Dispatch<React.SetStateAction<string>>
  setTypeStats: React.Dispatch<React.SetStateAction<readonly { type: number; label: string; count: number }[]>>
  setView: React.Dispatch<React.SetStateAction<ChatView>>
  setWatermarkFrom: (list: readonly WechatMessage[]) => void
  view: ChatView
  watermarkRef: React.MutableRefObject<number>
}

export function useChatsThread(inputs: useChatsThreadInputs) {
  const { annExpanded, annRef, closeCurrentSession, curSession, cursor, cursorLocalId, editedIds, groupInfo, groupInfoOpen, hasMore, inFlightRef, initialTarget, initialView, locateMessage, messages, messagesTalkerRef, moreOpen, msgLoading, msgScrollRef, openMsgMenu, openViewer, selfWxid, sessionAlive, sessionEpochRef, sessions, setAnnCanExpand, setAnnExpanded, setChatlogStack, setCurSession, setCursor, setCursorLocalId, setGroupInfo, setGroupInfoErr, setGroupInfoLoading, setGroupInfoOpen, setHasMore, setMemberExpanded, setMemberSearch, setMessages, setMoreOpen, setMsgError, setMsgLoading, setMsgMenu, setPollStatus, setProfileMember, setSelfWxid, setTypeStats, setView, setWatermarkFrom, view, watermarkRef } = inputs
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


const polling = useChatsPolling({ curSession, inFlightRef, messagesLen: messages.length, msgScrollRef, sessionAlive, sessionEpochRef, setMessages, setPollStatus, setWatermarkFrom, watermarkRef })


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
    .catch((e: unknown) => { setGroupInfoErr((e as Error).message); setGroupInfo(null) }) // 失败也要清快照：留着就是「B 群的抽屉里挂着 A 群的人」
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
    // 虚拟列表行高逐帧测：50ms 后多帧钉底，避免最后一条停在窗口下沿。
    setTimeout(() => { if (sessionAlive(epoch, s.username)) pinScrollToBottom(msgScrollRef.current, 8) }, 50)
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
        pinScrollToBottom(msgScrollRef.current, 8)
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
useEffect(() => { if (initialView) changeViewRef.current(initialView) }, [initialView])

/** 打开「聊天记录」弹窗（合并转发卡片与右键菜单两条入口共用同一实现）。 */
const openChatlog = useCallback((rich: MessageRich): void => {
  setChatlogStack([{ title: rich.title || '群聊的聊天记录', records: Array.isArray(rich.records) ? rich.records : [] }])
}, [])

// 行渲染器**必须造在 `openChatlog` 之后**：拆前它是函数声明，声明提升让「晚定义的回调」
// 在调用时才解析；换成工厂就是把依赖当参数传进去，写在这里会直接踩 TDZ（typecheck 报的）。
const renderMsgItem = makeMsgRow({ curSession, editedIds, openChatlog, openMsgMenu, openViewer, selfWxid })

  return { changeView, jumpToLatest: polling.jumpToLatest, loadMore, newMsgCount: polling.newMsgCount, openChatlog, openGroupInfo, openSession, openSessionAndLocate, renderMsgItem }
}
