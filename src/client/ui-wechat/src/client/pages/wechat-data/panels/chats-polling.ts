/**
 * Chats 面板的「新消息轮询 + 就地改对账」（#19 第一刀，自 `chats-thread.tsx#useChatsThread` 拆出）。
 *
 * 为什么先切这一族：它是本面板**唯一会自己动**的东西 —— 定时器、可见性切换、宿主推送、
 * SWR 后台刷新四条入口都往同一份 `messages` 上写。四入口共用两个在途标志
 * （`inFlightRef` 管轮询、`reconcileRef` 管对账）和一套归属令牌（`sessionAlive`），
 * 写错的后果全是「看不见」那一类：上一个会话的消息画进当前会话、缓存被污染后重开还是错的、
 * 撤回的行永远留旧值。切出来之后这一族可以脱离整个 50 字段输入袋单独测。
 *
 * 钩子调用顺序**保持与拆前一致**：`useCallback(pollNew)` → `useRef(reconcileRef)` →
 * `useCallback(reconcileRecent)` → `useEffect(定时器)` → `useEffect(订阅)`，
 * 而本钩子在 `useChatsThread` 里正坐在原来那五个钩子的位置上（会话切换复位那个 effect 之前）。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { SNAPSHOT_REFRESHED_EVENT, apiGetDataRevision, apiGetMessages, apiGetNewMessages } from '../api.ts'
import { POLL_HIDDEN_MS, POLL_VISIBLE_MS } from './chats-support.tsx'
import { useKeepAliveActive } from './keep-alive.tsx'
import type { DataRevision, WechatMessage, WechatSession } from '@deepseek-ai/dsh-wechat-data/types'
import { canCacheChatId, canonicalChatId } from '../utils/chat-identity.ts'
import { CHAT_RENDER_CACHE_MAX_MESSAGES, writeChatRenderCache } from './chat-render-cache.ts'
import { mergeLatestWindow } from './message-identity.ts'

export { CHAT_RENDER_CACHE_MAX_MESSAGES }

/** 对账限频：`getMessages(50)` 冷跑要扫统计（实测百毫秒级），新消息显示不靠它。 */
const RECONCILE_MIN_GAP_MS = 2_000

/** 距底多少像素以内算「正在看最新消息」；超过就只出提示、不抢滚动。 */
export const NEAR_BOTTOM_PX = 80

/**
 * 滚动容器是否已接近底部 —— 决定新消息到达时「跟随滚到底」还是「只提示」。
 * 容器还没挂载时按「在底部」处理（首次打开应当看到最新消息）。
 * @param box - 消息区滚动容器。
 * @returns true 表示用户当前就在最新消息附近。
 */
export function isNearBottom(box: HTMLDivElement | null | undefined): boolean {
  if (!box) return true
  return box.scrollHeight - box.scrollTop - box.clientHeight < NEAR_BOTTOM_PX
}

/**
 * 把消息区钉到底部。
 *
 * 为什么不是一次 `scrollTop = scrollHeight`：虚拟列表的行高是**逐帧回填**的，图片、长文本、
 * 群公告横幅都会在首帧之后继续把内容撑高（真机实测：打开群聊后最后一条消息被窗口裁掉一截）。
 * 多跑几帧、每帧重新取 scrollHeight，直到布局稳定。
 * @param box - 消息区滚动容器。
 * @param frames - 最多再跑几帧（默认 6，约 100ms）。
 */
export function pinScrollToBottom(box: HTMLDivElement | null | undefined, frames = 6): void {
  if (!box) return
  const previous = scrollPinGenerations.get(box)
  const generation = (previous ?? 0) + 1
  scrollPinGenerations.set(box, generation)
  let left = frames
  const step = (): void => {
    // 后一次 pin 会让前一条 rAF 链失效，避免「贴底」在图片/测高回调里叠出几十条链。
    if (scrollPinGenerations.get(box) !== generation) return
    box.scrollTop = box.scrollHeight
    if (left-- > 0) requestAnimationFrame(step)
    else scrollPinGenerations.delete(box)
  }
  requestAnimationFrame(step)
}

const scrollPinGenerations = new WeakMap<HTMLDivElement, number>()

export interface ChatsPollingInputs {
  curSession: WechatSession | null
  /** 轮询闸门：一次只允许一个在途增量请求（四个入口都可能踩到它）。 */
  inFlightRef: React.MutableRefObject<boolean>
  /** 消息区滚动容器：新消息到达时判断用户是否在看最新消息（浮标/自动跟随共用）。 */
  msgScrollRef: React.MutableRefObject<HTMLDivElement | null>
  /** 已加载消息条数：变化时若用户贴底就把视口钉回最新（虚拟列表逐帧测高）。 */
  messagesLen: number
  /** 虚拟消息列表节点：高度变化比滚动容器更直接，避免观察整棵子节点树。 */
  msgListRef?: React.MutableRefObject<HTMLDivElement | null>
  sessionAlive: (epoch: number, talker: string) => boolean
  sessionEpochRef: React.MutableRefObject<number>
  setMessages: React.Dispatch<React.SetStateAction<readonly WechatMessage[]>>
  setPollStatus: React.Dispatch<React.SetStateAction<string>>
  setWatermarkFrom: (list: readonly WechatMessage[]) => void
  watermarkRef: React.MutableRefObject<number>
  /** 与 `watermarkRef` 成对的 local_id；sort_seq 重复时靠它继续向后读。 */
  watermarkLocalIdRef: React.MutableRefObject<number>
}

/**
 * 从宿主事件里读结构化修订。
 *
 * 旧宿主/远程重连的合成事件可能没有 detail（或仍是数组），这时返回 null，
 * 调用方退回一次轻量 `getDataRevision` RPC，保持兼容。
 */
function revisionDetailOf(event: Event): DataRevision | null {
  const detail = (event as CustomEvent<unknown>).detail
  if (detail === null || typeof detail !== 'object' || Array.isArray(detail)) return null
  const record = detail as Record<string, unknown>
  const revision = record['revision']
  if (!Number.isSafeInteger(revision) || (revision as number) < 0) return null
  const shards = Array.isArray(record['shards'])
    ? record['shards'].filter((item): item is string => typeof item === 'string')
    : []
  return {
    revision: revision as number,
    updatedAt: typeof record['updatedAt'] === 'number' ? record['updatedAt'] : 0,
    shards,
    messageChanged: record['messageChanged'] === true,
  }
}

/**
 * 起定时器、接宿主推送，并把两个取数函数交回去。
 * @returns pollNew（增量轮询一次）、reconcileRecent（最近 50 条就地改对账），
 *   以及「翻历史时收到的新消息」浮标数据（newMsgCount / jumpToLatest）。
 */
export function useChatsPolling(inputs: ChatsPollingInputs): { pollNew: () => Promise<number>; reconcileRecent: () => Promise<void>; newMsgCount: number; jumpToLatest: () => void } {
  const { curSession, inFlightRef, messagesLen, msgListRef, msgScrollRef, sessionAlive, sessionEpochRef, setMessages, setPollStatus, setWatermarkFrom, watermarkRef, watermarkLocalIdRef } = inputs
  /** 用户正在翻历史时收到、还没看的新消息条数（0 = 不显示浮标）。 */
  const [newMsgCount, setNewMsgCount] = useState(0)
  /** 是否贴着底部（用户滚进历史即 false）：布局继续长高时只有贴底才继续钉。 */
  const stickRef = useRef(true)

  // 换会话 = 从最新消息重新开始；上一个会话的浮标不能带过来。
  useEffect(() => {
    stickRef.current = true
    setNewMsgCount(0)
  }, [curSession?.username])

  // 用户滚动：贴底恢复跟随并清掉浮标；滚进历史后不再抢滚动。
  useEffect(() => {
    const box = msgScrollRef.current
    if (!box) return
    const onScroll = (): void => {
      stickRef.current = isNearBottom(box)
      if (stickRef.current) setNewMsgCount(0)
    }
    box.addEventListener('scroll', onScroll, { passive: true })
    return () => { box.removeEventListener('scroll', onScroll) }
  }, [curSession?.username, msgScrollRef])

  // 消息条数变化时，只有用户确实贴底才把视口钉回最新。
  useLayoutEffect(() => {
    if (!stickRef.current) return
    pinScrollToBottom(msgScrollRef.current, 3)
  }, [messagesLen, msgScrollRef])

  // 布局继续长高（虚拟列表逐帧测高 / 图片异步载入）时继续贴底。
  // 这是「打开会话后最后一条被窗口裁掉」的真正根因：单次 scrollTop 只跑 ~100ms，
  // 而图片可能在 1s 后才把行撑高；ResizeObserver 监听虚拟容器高度变化，贴底才跟随。
  useEffect(() => {
    const box = msgScrollRef.current
    if (!box || typeof ResizeObserver === 'undefined') return
    let frame: number | null = null
    const schedulePin = (): void => {
      if (!stickRef.current || frame !== null) return
      frame = requestAnimationFrame(() => {
        frame = null
        if (stickRef.current) pinScrollToBottom(box, 1)
      })
    }
    const ro = new ResizeObserver(schedulePin)
    ro.observe(box)
    const list = msgListRef?.current
    if (list && list !== box) ro.observe(list)
    return () => {
      ro.disconnect()
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [curSession?.username, messagesLen, msgListRef, msgScrollRef])

  /** 点「N 条新消息」浮标：跳回最新并清空提示。 */
  const jumpToLatest = useCallback((): void => {
    stickRef.current = true
    setNewMsgCount(0)
    pinScrollToBottom(msgScrollRef.current, 8)
  }, [msgScrollRef])

  /**
   * 增量轮询一次；返回「本拍候选新消息条数」（0 = 没有新消息）。
   *
   * 后端按 `(sort_seq, local_id)` 复合游标返回；`hasMore` 为真时继续排空，
   * 直到这一拍没有下一页或触到页数上限。`sort_seq` 重复的边界因此不会漏行。
   */
  const pollNew = useCallback(async (): Promise<number> => {
    if (!curSession || inFlightRef.current) return 0
    const talker = curSession.username
    const epoch = sessionEpochRef.current
    const after = watermarkRef.current
    if (!after) return 0
    inFlightRef.current = true
    try {
      let cursorAfter = after
      let cursorLocalId = watermarkLocalIdRef.current > 0 ? watermarkLocalIdRef.current : undefined
      const fresh: WechatMessage[] = []
      let canonicalUsername: string | undefined
      // 上限只是防异常后端无限返回；正常一拍最多 200 条。
      for (let page = 0; page < 20; page += 1) {
        const env = await apiGetNewMessages({
          talker,
          after: cursorAfter,
          ...(cursorLocalId === undefined ? {} : { afterLocalId: cursorLocalId }),
          limit: 200,
        })
        // 切走之后到达的响应必须丢弃：否则会把上一个会话的新消息追加进当前会话，
        // 并且写进**上一个会话**的渲染缓存（缓存被污染后重开也还是错的）。
        if (!sessionAlive(epoch, talker)) return 0
        fresh.push(...env.messages)
        canonicalUsername = env.canonicalUsername ?? canonicalUsername
        if (env.hasMore !== true) break
        const nextAfter = env.cursor
        const nextLocalId = env.cursorLocalId
        if (nextAfter === undefined || nextLocalId === undefined) break
        // 同一游标再次返回 ⇒ 后端没有前进；宁可停一拍，也不能死循环。
        if (nextAfter === cursorAfter && nextLocalId === cursorLocalId) break
        cursorAfter = nextAfter
        cursorLocalId = nextLocalId
      }
      if (!sessionAlive(epoch, talker)) return 0
      const cacheTalker = canonicalChatId(talker, canonicalUsername)
      setPollStatus(`✓ ${new Date().toLocaleTimeString()} · ${fresh.length} 条新消息`)
      if (fresh.length === 0) return 0
      setMessages((prev) => {
        if (!sessionAlive(epoch, talker)) return prev
        const key = (m: WechatMessage): string => `${m.localId}:${m.sortSeq ?? 0}`
        const seen = new Set(prev.map(m => key(m)))
        const add = fresh.filter(m => !seen.has(key(m)))
        if (add.length === 0) return prev
        let nextWatermark = watermarkRef.current
        let nextLocalId = watermarkLocalIdRef.current
        for (const message of add) {
          const seq = message.sortSeq ?? 0
          if (seq > nextWatermark) {
            nextWatermark = seq
            nextLocalId = message.localId
          } else if (seq === nextWatermark) {
            nextLocalId = Math.max(nextLocalId, message.localId)
          }
        }
        watermarkRef.current = nextWatermark
        watermarkLocalIdRef.current = nextLocalId
        setWatermarkFrom(add)
        // Keep the render cache current so a session reopen paints the same
        // newest messages before the authoritative fetch returns.
        const merged = [...prev, ...add]
        if (canCacheChatId(cacheTalker)) writeChatRenderCache(cacheTalker, merged)
        return merged
      })
      // 用户就在底部附近 ⇒ 跟随到最新消息；正在翻历史 ⇒ 只在窗口里提示，不抢滚动。
      const box = msgScrollRef.current
      if (box && !isNearBottom(box)) {
        setNewMsgCount(prev => prev + fresh.length)
      } else {
        pinScrollToBottom(box)
      }
      return fresh.length
    } catch (e) {
      if (sessionAlive(epoch, talker)) setPollStatus('✗ ' + ((e as Error).message || '轮询失败').slice(0, 60))
      return 0
    } finally {
      inFlightRef.current = false
    }
  }, [curSession])

  /** 与快照最近窗口对账：撤回(10002)/删除等就地修改保留原 sort_seq，
   *  增量轮询按 sort_seq 水位看不到它们；宿主推送后拉一次最近 50 条，
   *  按复合身份（sort_seq + local_id）用新行替换发生变化的行，界面与库保持一致（有界查询）。 */
  const reconcileRef = useRef(false)
  const reconcileRecent = useCallback(async (): Promise<void> => {
    if (!curSession || reconcileRef.current) return
    const talker = curSession.username
    const epoch = sessionEpochRef.current
    reconcileRef.current = true
    try {
      // 事件驱动对账必须绕过 5s SWR：撤回/编辑不会推进 sort_seq，
      // 命中旧缓存会让界面继续挂着上一版内容。
      const env = await apiGetMessages({ talker, limit: 50, fresh: true })
      // 归属令牌：切走后到达的窗口整条丢掉 —— 拿另一个会话的行去替换当前会话的行，
      // 等于按编号把别人的消息安到这个会话上。
      if (!sessionAlive(epoch, talker)) return
      if (env.messages.length === 0) return
      setMessages((prev) => {
        if (!sessionAlive(epoch, talker)) return prev
        const merge = mergeLatestWindow(prev, env.messages)
        // 最新窗口里出现 prev 没有的行 ⇒ 追加。
        // 空会话（水位 0）永远进不了 pollNew 的增量分支；只替换不追加的话，
        // 对方发来的第一条消息只能靠切走再点回来才看得见。
        if (merge.added.length === 0 && !merge.changed) return prev
        if (merge.added.length > 0) setWatermarkFrom(merge.added)
        const cacheTalker = canonicalChatId(talker, env.canonicalUsername)
        if (canCacheChatId(cacheTalker)) writeChatRenderCache(cacheTalker, merge.next)
        return merge.next
      })
    } catch { /* 保持当前视图，等待下一次推送对账 */ } finally {
      reconcileRef.current = false
    }
  }, [curSession])

  useChatsLiveRefresh(curSession, pollNew, reconcileRecent)

  return { jumpToLatest, newMsgCount, pollNew, reconcileRecent }
}

/** 把定时器、宿主推送与 SWR 广播三条入口接到增量与对账上。 */
function useChatsLiveRefresh(
  curSession: WechatSession | null,
  pollNew: () => Promise<number>,
  reconcileRecent: () => Promise<void>,
): void {
  const active = useKeepAliveActive()
  const activeRef = useRef(active)
  activeRef.current = active
  const wasActiveRef = useRef(active)

  /** 最近一次已处理的后端修订（纯内存读，见后端 `getDataRevision`）。 */
  const revisionRef = useRef(0)
  /** 修订对应的时间戳：后端重启后 revision 会归零，靠它识别“同一编号的新进程”。 */
  const revisionAtRef = useRef(0)
  /** 最近一次对账时刻（对账限频用）。 */
  const lastReconcileAtRef = useRef(0)
  /** 续订闸门：宿主推送与定时器可能同时到达，只允许一个 refresh 在途。 */
  const refreshingRef = useRef(false)
  /** 在途期间又来了一拍：结束后必须补跑，不能直接丢。 */
  const pendingRefreshRef = useRef(false)
  /**
   * 修订闸门：先读一次后端「实时同步修订」，只有 `revision` 真的变了、且这一拍
   * 动了消息分片（`messageChanged`）才拉增量与对账。
   *
   * 为什么值得多一次 RPC：修订是后端进程内存里的一个整数（零 SQL），而 `pollNew`
   * 每秒查一次消息分片、`reconcileRecent` 每次推送再查 50 条 —— 原来这两件事
   * 不管数据有没有变都在跑；现在「没变」的绝大多数节拍只花一次内存读。
   */
  const refresh = useCallback(async (detail?: DataRevision | null): Promise<void> => {
    if (!curSession) return
    if (refreshingRef.current) {
      pendingRefreshRef.current = true
      return
    }
    refreshingRef.current = true
    try {
      let revision = 0
      let messageChanged = false
      let updatedAt = 0
      if (detail !== null && detail !== undefined) {
        // 宿主事件已经把同一拍的 revision 带过来了，省掉一次 RPC。
        revision = detail.revision
        messageChanged = detail.messageChanged
        updatedAt = detail.updatedAt
      } else {
        try {
          const r = await apiGetDataRevision()
          revision = r.revision
          messageChanged = r.messageChanged
          updatedAt = r.updatedAt
        } catch {
          // 修订读不到只说明这次判断做不了，保持当前视图，等下一次推送/轮询。
          return
        }
      }
      const previousRevision = revisionRef.current
      const previousUpdatedAt = revisionAtRef.current
      const rewound = revision < previousRevision
        || (revision === previousRevision && updatedAt > previousUpdatedAt)
      if (revision === previousRevision && !rewound) return
      // 事件丢失（revision 跳号）时不能相信这一拍的 messageChanged：
      // 漏掉的那拍可能正好动了消息库，保守补一次增量。
      const gap = rewound || (previousRevision > 0 && revision > previousRevision + 1)
      revisionRef.current = revision
      revisionAtRef.current = Math.max(previousUpdatedAt, updatedAt)
      // 只动了会话/通讯录/朋友圈等库时不必拉消息增量（各自的推送会刷新各自的界面）。
      if (!messageChanged && !gap) return
      const added = await pollNew()
      const at = Date.now()
      // 对账要拉最近 50 条（冷跑要扫统计）；新消息不靠它显示。
      // 口径：没有新消息时立刻对一次（撤回/编辑类变更），有新消息时最多每 2s 一次。
      if (added === 0 || at - lastReconcileAtRef.current >= RECONCILE_MIN_GAP_MS) {
        lastReconcileAtRef.current = at
        await reconcileRecent()
      }
    } finally {
      refreshingRef.current = false
      if (pendingRefreshRef.current) {
        pendingRefreshRef.current = false
        if (activeRef.current) queueMicrotask(() => { void refresh() })
      }
    }
  }, [curSession, pollNew, reconcileRecent])

  useEffect(() => {
    if (!curSession || !active) return
    let timer: ReturnType<typeof setInterval> | null = null
    const start = (): void => {
      if (timer !== null) clearInterval(timer)
      const ms = document.visibilityState === 'visible' ? POLL_VISIBLE_MS : POLL_HIDDEN_MS
      timer = setInterval(() => { void refresh() }, ms)
    }
    start()
    const onVis = (): void => { void refresh(); start() }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      if (timer !== null) clearInterval(timer)
    }
  }, [curSession, refresh, active])

  // keep-alive 隐藏期间不轮询；重新显示时先补一拍，再恢复定时器。
  useEffect(() => {
    const resumed = active && !wasActiveRef.current
    wasActiveRef.current = active
    if (resumed) void refresh()
  }, [active, refresh])

  // Host push: a WAL increment was decrypted into the snapshot — refresh the
  // open chat immediately, reconcile in-place edits (revoke/delete), and
  // coalesce the session-list refresh.
  useEffect(() => {
    const onUpdated = (event: Event): void => {
      if (!activeRef.current) return
      void refresh(revisionDetailOf(event))
      // 会话列表**不在这里刷**：`usePagedList` 内部已订阅同一事件并做非破坏性 refresh，
      // 这里再刷一次只会重复取数；而原先这里走的是 `reset()`，每约 10 秒把列表清空重画，
      // 表现就是「有新消息时会话列表跳动一次」。
    }
    window.addEventListener('dsh-wechat-data-updated', onUpdated)
    // SWR 的另一半（P0-3）：`apiGetMessages` 命中缓存时先画旧快照、后台才刷新，
    // 新值落地后按接口族广播 —— 不订阅它，界面就会一直停在「上一次打开时的那份」。
    // 这一路是「同一份快照重放」而不是「又有新数据」，所以直接增量+对账，不经过修订闸门。
    const onSnapshot = (): void => {
      if (!activeRef.current) return
      void pollNew()
      void reconcileRecent()
    }
    window.addEventListener(`${SNAPSHOT_REFRESHED_EVENT}:messages`, onSnapshot)
    return () => {
      window.removeEventListener('dsh-wechat-data-updated', onUpdated)
      window.removeEventListener(`${SNAPSHOT_REFRESHED_EVENT}:messages`, onSnapshot)
    }
  }, [refresh, pollNew, reconcileRecent])

}
