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
import { useCallback, useEffect, useRef } from 'react'
import { SNAPSHOT_REFRESHED_EVENT, apiGetMessages, apiGetNewMessages, writeRenderCache } from '../api.ts'
import { POLL_HIDDEN_MS, POLL_VISIBLE_MS } from './chats-support.tsx'
import type { WechatMessage, WechatSession } from '@deepseek-ai/dsh-wechat-data/types'

/** 渲染缓存与后端快照共用的键前缀（拆开前后是同一个字符串，改这里要一起改缓存版本）。 */
const RENDER_CACHE_PREFIX = 'chat-msgs:v2:'

export interface ChatsPollingInputs {
  curSession: WechatSession | null
  /** 轮询闸门：一次只允许一个在途增量请求（四个入口都可能踩到它）。 */
  inFlightRef: React.MutableRefObject<boolean>
  msgEndRef: React.RefObject<HTMLDivElement>
  sessionAlive: (epoch: number, talker: string) => boolean
  sessionEpochRef: React.MutableRefObject<number>
  setMessages: React.Dispatch<React.SetStateAction<readonly WechatMessage[]>>
  setPollStatus: React.Dispatch<React.SetStateAction<string>>
  setWatermarkFrom: (list: readonly WechatMessage[]) => void
  watermarkRef: React.MutableRefObject<number>
}

/**
 * 起定时器、接宿主推送，并把两个取数函数交回去。
 * @returns pollNew（增量轮询一次）与 reconcileRecent（最近 50 条就地改对账）。
 */
export function useChatsPolling(inputs: ChatsPollingInputs): { pollNew: () => Promise<void>; reconcileRecent: () => Promise<void> } {
  const { curSession, inFlightRef, msgEndRef, sessionAlive, sessionEpochRef, setMessages, setPollStatus, setWatermarkFrom, watermarkRef } = inputs

  /** 增量轮询：取水位之后的新消息并接到列表尾部。 */
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
        writeRenderCache(RENDER_CACHE_PREFIX + talker, merged)
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
        writeRenderCache(RENDER_CACHE_PREFIX + talker, next)
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
    // SWR 的另一半（P0-3）：`apiGetMessages` 命中缓存时先画旧快照、后台才刷新，
    // 新值落地后按接口族广播 —— 不订阅它，界面就会一直停在「上一次打开时的那份」。
    window.addEventListener(`${SNAPSHOT_REFRESHED_EVENT}:messages`, onUpdated)
    return () => {
      window.removeEventListener('dsh-wechat-data-updated', onUpdated)
      window.removeEventListener(`${SNAPSHOT_REFRESHED_EVENT}:messages`, onUpdated)
    }
  }, [pollNew, reconcileRecent])

  return { pollNew, reconcileRecent }
}
