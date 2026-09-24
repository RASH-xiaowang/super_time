
/**
 * Chats 面板的「会话打开与消息流」（M21 第三十四刀起自 Chats.tsx 拆出）。
 *
 * 原先散在 `ChatsPanel` 的函数体里（几十个 state 与回调），但输入输出很清楚 —— 抽成钩子后：
 * 面板把输入传进来、把用得到的值解构出去，其余细节（轮询、竞态防护、菜单构造）留在模块里。
 * 钩子在面板的**第一条组内声明处**调用 ⇒ 与原来的声明顺序等价。
 */

import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { apiGetGroupInfo, apiGetMessages, apiGetNewMessages, readRenderCache, writeRenderCache } from '../api.ts'
import { useDialogFocus, useEscapeToClose } from '../ui/kit.tsx'
import { fmtMsgClockSec } from '../utils/format.ts'
import { MessageRenderItem, renderKindOf } from '../utils/message-items.ts'
import { MessageBody } from './chats-cards.tsx'
import css from './chats.module.css'
import cssrows from './chats-rows.module.css'
import type { ChatTarget } from './Chats.tsx'
import { MessageImageGroup } from './chats-media.tsx'
import { Avatar, ChatView, POLL_HIDDEN_MS, POLL_VISIBLE_MS } from './chats-support.tsx'
import { messagesMatchTalker } from './msg-scope.ts'
import type { ChatlogRecord, GroupInfo, GroupMember, MessageRich, MessageRenderKind as RenderKind, WechatMessage, WechatSession } from '@deepseek-ai/dsh-wechat-data/types'

export interface useChatsThreadInputs {
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
  /** 只读的消息尾部锚点：调用方给的是 `useRef<HTMLDivElement>(null)`，那是 `RefObject`（current 只读），
   *  本模块只 `msgEndRef.current` 读它、从不赋值 ⇒ 不许声明成 `MutableRefObject`。 */
  msgEndRef: React.RefObject<HTMLDivElement>
  msgLoading: boolean
  msgScrollRef: React.MutableRefObject<HTMLDivElement | null>
  openMsgMenu: (ev: React.MouseEvent, m: WechatMessage, kind: RenderKind) => void
  openViewer: (m: WechatMessage) => void
  selfWxid: string
  sessionEpochRef: React.MutableRefObject<number>
  sessions: readonly WechatSession[]
  setAnnCanExpand: React.Dispatch<React.SetStateAction<boolean>>
  setAnnExpanded: React.Dispatch<React.SetStateAction<boolean>>
  setChatlogStack: React.Dispatch<React.SetStateAction<Array<{ title: string; records: ChatlogRecord[] }>>>
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
  const { annExpanded, annRef, closeCurrentSession, curSession, cursor, cursorLocalId, editedIds, groupInfo, groupInfoOpen, hasMore, inFlightRef, initialTarget, initialView, locateMessage, messages, messagesTalkerRef, moreOpen, msgEndRef, msgLoading, msgScrollRef, openMsgMenu, openViewer, selfWxid, sessionAlive, sessionEpochRef, sessions, setAnnCanExpand, setAnnExpanded, setChatlogStack, setCurSession, setCursor, setCursorLocalId, setGroupInfo, setGroupInfoErr, setGroupInfoLoading, setGroupInfoOpen, setHasMore, setMemberExpanded, setMemberSearch, setMessages, setMoreOpen, setMsgError, setMsgLoading, setMsgMenu, setPollStatus, setProfileMember, setSelfWxid, setTypeStats, setView, setWatermarkFrom, view, watermarkRef } = inputs
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
// 注：`sessionAlive` 定义在**面板**里（会话/消息两半都要用它，放外面才不产生钩子环），这里当输入用。

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
function renderMsgItem(item: MessageRenderItem): React.JSX.Element | null {
  if (item.kind === 'day') {
    return <div className={cssrows.msgDayDivider}><span>{item.label}</span></div>
  }
  const head = item.kind === 'group' ? item.items[0] : item.m
  if (!head || !curSession) return null
  const kind = renderKindOf(head)
  // 系统提示（含撤回）/ 拍一拍 / 无内容：居中行，没有头像与气泡。
  if (kind === 'system' || kind === 'revoke' || kind === 'pat' || kind === 'empty') {
    return (
      <div id={`msg-${head.localId}`} className={cssrows.msgRowSystem}>
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
        {isGroup && !isSelf && head.sender && <div className={cssrows.msgSender}>{avName}</div>}
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
useEffect(() => { if (initialView) changeViewRef.current(initialView) }, [initialView])

/** 打开「聊天记录」弹窗（合并转发卡片与右键菜单两条入口共用同一实现）。 */
const openChatlog = useCallback((rich: MessageRich): void => {
  setChatlogStack([{ title: rich.title || '群聊的聊天记录', records: Array.isArray(rich.records) ? rich.records : [] }])
}, [])

  return { changeView, loadMore, openChatlog, openGroupInfo, openSession, openSessionAndLocate, renderMsgItem }
}
