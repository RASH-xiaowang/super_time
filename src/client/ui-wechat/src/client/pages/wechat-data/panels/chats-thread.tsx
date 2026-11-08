
/**
 * Chats 面板的「会话打开与消息流」（M21 第三十四刀起自 Chats.tsx 拆出）。
 *
 * 原先散在 `ChatsPanel` 的函数体里（几十个 state 与回调），但输入输出很清楚 —— 抽成钩子后：
 * 面板把输入传进来、把用得到的值解构出去，其余细节（轮询、竞态防护、菜单构造）留在模块里。
 * 钩子在面板的**第一条组内声明处**调用 ⇒ 与原来的声明顺序等价。
 */

import type { ChatlogFrame } from './chats-chatlog.ts'
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { apiGetGroupInfo, apiResolveChatHistory } from '../api.ts'
import { useDialogFocus, useEscapeToClose } from '../ui/kit.tsx'
import type { ChatTarget } from './Chats.tsx'
import { ChatView } from './chats-support.tsx'
import { useChatsPolling } from './chats-polling.ts'
import { makeMsgRow } from './chats-msg-row.tsx'
import type { MsgMenuAnchor } from './chats-msg-menu.tsx'
import { useChatTargetNavigation } from './chats-target.ts'
import {
  beginGroupInfoRequest,
  groupInfoRequestApplies,
  groupInfoRequestGateFor,
  invalidateGroupInfoRequests,
} from './chats-info-live.ts'
import { loadOlderChatMessages, openChatSession, openChatSessionAndLocate } from './chats-session-loader.ts'
import { findQuotedTarget, quotedServerId } from './chats-quote-target.ts'
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
  onInitialTargetHandled?: (nonce: number) => void
  /** 会话令牌变化后的通知；用于让依赖该令牌的 UI 状态立即刷新。 */
  onSessionBegin?: (epoch: number) => void
  initialView: ChatView | undefined
  locateMessage: (localId: number, scopeKey?: string) => void
  messages: readonly WechatMessage[]
  messagesTalkerRef: React.MutableRefObject<string | null>
  moreOpen: boolean
  /** 消息区滚动容器：新消息到达时判断用户是否在看最新消息（浮标/自动跟随共用）。 */
  msgScrollRef: React.MutableRefObject<HTMLDivElement | null>
  /** 虚拟消息列表节点：只观察它的高度，避免轮询层反复观察所有子节点。 */
  msgListRef: React.MutableRefObject<HTMLDivElement | null>
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
  /** 与 watermarkRef 成对的 local_id，用于 sort_seq 重复边界的增量游标。 */
  watermarkLocalIdRef: React.MutableRefObject<number>
}

export function useChatsThread(inputs: useChatsThreadInputs) {
  const { annExpanded, annRef, closeCurrentSession, curSession, cursor, cursorLocalId, editedIds, groupInfo, groupInfoOpen, hasMore, inFlightRef, initialTarget, onInitialTargetHandled, onSessionBegin, initialView, locateMessage, messages, messagesTalkerRef, moreOpen, msgListRef, msgLoading, msgScrollRef, openMsgMenu, openViewer, selfWxid, sessionAlive, sessionEpochRef, sessions, setAnnCanExpand, setAnnExpanded, setChatlogStack, setCurSession, setCursor, setCursorLocalId, setGroupInfo, setGroupInfoErr, setGroupInfoLoading, setGroupInfoOpen, setHasMore, setMemberExpanded, setMemberSearch, setMessages, setMoreOpen, setMsgError, setMsgLoading, setMsgMenu, setPollStatus, setProfileMember, setSelfWxid, setTypeStats, setView, setWatermarkFrom, view, watermarkRef, watermarkLocalIdRef } = inputs
  /**
   * `locateMessage` 跟着消息列表换身份；异步定位完成时要用最新的一版，
   * 否则外部跳转从空列表启动，拿到的仍是“找不到目标”的旧闭包。
   */
  const locateMessageRef = useRef(locateMessage)
  locateMessageRef.current = locateMessage
/**
 * 「加载更多」不跳位（N18）：插入后把 scrollTop 补上「新增内容的高度」，
 * 让视口里那条消息留在原地。
 *
 * 为什么要跑三帧：动态测高是一帧一帧回填的（先估、后量、再量修正），
 * 只补一次会差出几十像素；每次都按**最初的**基准重算，所以重复执行是安全的。
 */
/** 往上插入更早消息前的滚动位置（见 loadMore）；由下面的 effect 消费。 */
const prependAnchorRef = useRef<{ h: number; top: number } | null>(null)
/** 与 useGroupInfoLive 共用：打开请求和实时刷新竞争同一个版本闸。 */
const groupInfoRequestGate = groupInfoRequestGateFor(sessionEpochRef)
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


const polling = useChatsPolling({ curSession, inFlightRef, messagesLen: messages.length, msgListRef, msgScrollRef, sessionAlive, sessionEpochRef, setMessages, setPollStatus, setWatermarkFrom, watermarkRef, watermarkLocalIdRef })


// Close the group-info drawer and drop the in-chat search scope on session switch.
useEffect(() => {
  invalidateGroupInfoRequests(groupInfoRequestGate)
  setGroupInfoOpen(false)
  setGroupInfo(null)
  setGroupInfoErr(null)
  setGroupInfoLoading(false)
  setMemberSearch('')
  setMemberExpanded(false)
  setProfileMember(null)
  setMoreOpen(false)
  setAnnExpanded(false)
  setAnnCanExpand(false)
}, [curSession?.username])

// 关闭抽屉后，仍在途的打开请求不再需要提交（尤其是“关闭后马上重开同一个群”）。
useEffect(() => {
  if (groupInfoOpen) return
  invalidateGroupInfoRequests(groupInfoRequestGate)
  setGroupInfoLoading(false)
}, [groupInfoOpen, groupInfoRequestGate])

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

const openGroupInfo = (): void => {
  if (!curSession) return
  const talker = curSession.username
  const epoch = sessionEpochRef.current
  const requestSeq = beginGroupInfoRequest(groupInfoRequestGate)
  setGroupInfoOpen(true)
  setGroupInfoLoading(true)
  setGroupInfoErr(null)
  setMemberSearch('')
  setMemberExpanded(false)
  apiGetGroupInfo(talker)
    .then((r) => {
      if (!groupInfoRequestApplies(requestSeq, groupInfoRequestGate.current, sessionAlive(epoch, talker))) return
      const g = r.group
      setGroupInfo(g)
    })
    .catch((e: unknown) => {
      if (!groupInfoRequestApplies(requestSeq, groupInfoRequestGate.current, sessionAlive(epoch, talker))) return
      setGroupInfoErr((e as Error).message); setGroupInfo(null)
    })
    .finally(() => {
      if (!groupInfoRequestApplies(requestSeq, groupInfoRequestGate.current, sessionAlive(epoch, talker))) return
      setGroupInfoLoading(false)
    })
}

const openSession = useCallback((session: WechatSession): Promise<void> => (
  openChatSession(inputs, session)
), [])

const loadMore = useCallback(async (): Promise<void> => {
  if (!curSession || !hasMore || msgLoading) return
  await loadOlderChatMessages(inputs, curSession, cursor, cursorLocalId, (box) => {
    prependAnchorRef.current = { h: box.scrollHeight, top: box.scrollTop }
  })
}, [curSession, hasMore, msgLoading, cursor, cursorLocalId])

/** Open a session and scroll to a message (by localId or day start). */
const openSessionAndLocate = useCallback((username: string, localId?: number, dayStart?: number): Promise<void> => (
  openChatSessionAndLocate({ ...inputs, locateMessage: locateMessageRef.current }, username, localId, dayStart)
), [sessions])

/** Jump from a quote preview to its original message in this conversation. */
const openQuote = useCallback((rich: MessageRich): void => {
  if (!curSession) return
  const session = curSession
  const loaded = findQuotedTarget(messages, rich)
  if (loaded) {
    locateMessageRef.current(loaded.localId, session.username + '\u0000' + String(sessionEpochRef.current))
    return
  }

  const epoch = sessionEpochRef.current
  const referTime = typeof rich.referTime === 'number' && rich.referTime > 0 ? rich.referTime : undefined
  const serverId = quotedServerId(rich)
  if (!serverId) {
    if (referTime !== undefined) {
      void openSessionAndLocate(session.username, undefined, referTime)
    } else {
      setMsgError('无法定位引用的原消息：缺少消息标识')
    }
    return
  }

  setMsgError(null)
  void apiResolveChatHistory(serverId, session.username)
    .then(async (result) => {
      if (!sessionAlive(epoch, session.username)) return
      if (!result.found || !result.message) {
        if (referTime !== undefined) {
          await openSessionAndLocate(session.username, undefined, referTime)
        } else {
          setMsgError('引用的原消息已删除或尚未同步')
        }
        return
      }
      await openSessionAndLocate(session.username, result.message.localId)
    })
    .catch((error: unknown) => {
      if (sessionAlive(epoch, session.username)) {
        setMsgError('定位引用的原消息失败：' + (error as Error).message)
      }
    })
}, [curSession, messages, openSessionAndLocate, sessionAlive, sessionEpochRef, setMsgError])

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

// External navigation (records/privacy/ask/contacts): open the target
// session and locate the message (or just open when no localId).
// Keep this after `initialView` synchronization: switching back from
// bizchats/servicechats/kefu closes the old session, and must run before the
// external target starts, otherwise it invalidates the just-started request.
useChatTargetNavigation({
  target: initialTarget,
  open: openSessionAndLocate,
  ...(onInitialTargetHandled ? { onHandled: onInitialTargetHandled } : {}),
})

/** 打开「聊天记录」弹窗（合并转发卡片与右键菜单两条入口共用同一实现）。 */
const openChatlog = useCallback((rich: MessageRich): void => {
  setChatlogStack([{ title: rich.title || '群聊的聊天记录', records: Array.isArray(rich.records) ? rich.records : [] }])
}, [])

// 行渲染器**必须造在 `openChatlog` 之后**：拆前它是函数声明，声明提升让「晚定义的回调」
// 在调用时才解析；换成工厂就是把依赖当参数传进去，写在这里会直接踩 TDZ（typecheck 报的）。
const renderMsgItem = makeMsgRow({ curSession, editedIds, openChatlog, openQuote, openMsgMenu, openViewer, selfWxid })

  return { changeView, jumpToLatest: polling.jumpToLatest, loadMore, newMsgCount: polling.newMsgCount, openChatlog, openGroupInfo, openSession, openSessionAndLocate, renderMsgItem }
}
