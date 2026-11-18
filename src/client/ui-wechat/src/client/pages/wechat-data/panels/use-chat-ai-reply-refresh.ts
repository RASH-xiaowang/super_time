/**
 * 当前会话 AI 状态的后台刷新。
 *
 * 消息列表事件只做尾随去抖后的静默回源；页面隐藏时停表，可见且已有状态时
 * 15s 兜底。静默刷新不翻 loading，并共享在途请求，避免事件风暴把状态菜单
 * 打成“处理中”。`useChatAiReply` 只保留状态与动作编排。
 */
import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react'
import type { ChatAiReplyState } from '@deepseek-ai/dsh-wechat-data/types'
import { apiGetChatAiReplyState } from '../api-chat-ai-reply.ts'
import { MESSAGE_LIST_UPDATED_EVENT } from '../message-list-events.ts'
import type { ChatAiReplyIdentity } from './chat-ai-reply-identity.ts'
import type { ChatAiReplyPersonaLatest } from './chat-ai-reply-persona-action.ts'

/** 消息列表事件触发的尾随去抖：合并一次投递产生的多条状态变化。 */
export const CHAT_AI_REPLY_REFRESH_DEBOUNCE_MS = 2_000
/** 页面可见且已有状态时的轻量兜底轮询；仍走静默刷新，不翻 loading。 */
export const CHAT_AI_REPLY_POLL_MS = 15_000

export interface ChatAiReplyRefreshInput {
  chatUsername: string
  selfWxid: string
  sessionEpoch: number
  latestRef: MutableRefObject<ChatAiReplyPersonaLatest>
  stateIdentityRef: MutableRefObject<ChatAiReplyIdentity | null>
  requestIdRef: MutableRefObject<number>
  /**
   * 写操作（开关 / 人格）的在飞锁。
   *
   * 为什么回源要看它：写入期间若并发一次静默回源，它会推进 `requestIdRef` —— 写请求
   * 拿到结果时序号已过期，于是结果被丢弃、`saving` 收不回来。实测症状是「开关关掉之后
   * 按钮永久变灰、再点没反应」。写期间直接让回源让路，写完由事件触发下一轮。
   */
  savingLockRef: MutableRefObject<symbol | null>
  hasState: boolean
  setState: Dispatch<SetStateAction<ChatAiReplyState | null>>
  setLoading: Dispatch<SetStateAction<boolean>>
  setError: Dispatch<SetStateAction<string | null>>
}

export interface ChatAiReplyRefreshController {
  refresh: (options?: { silent?: boolean }) => Promise<void>
}

export function useChatAiReplyRefresh(input: ChatAiReplyRefreshInput): ChatAiReplyRefreshController {
  const {
    chatUsername,
    selfWxid,
    sessionEpoch,
    latestRef,
    stateIdentityRef,
    requestIdRef,
    savingLockRef,
    hasState,
    setState,
    setLoading,
    setError,
  } = input
  const refreshInFlightRef = useRef<Promise<void> | null>(null)

  // 旧会话的静默请求即使还在飞，也不能被新会话的事件刷新复用。
  useEffect(() => {
    refreshInFlightRef.current = null
  }, [chatUsername, selfWxid, sessionEpoch])

  const refresh = useCallback((options?: { silent?: boolean }): Promise<void> => {
    const silent = options?.silent === true
    // 静默刷新共享在途请求：事件去抖/兜底轮询撞在一起时只发一次 Remote。
    if (silent && refreshInFlightRef.current !== null) {
      return refreshInFlightRef.current
    }
    const latest = latestRef.current
    if (latest.chatUsername === '' || latest.selfWxid === '') {
      return Promise.resolve()
    }
    // 写操作在飞时回源让路：它会推进 requestId，让写结果被判成过期（见接口注释）。
    if (savingLockRef.current !== null) return Promise.resolve()
    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    if (!silent) setLoading(true)
    const run = async (): Promise<void> => {
      try {
        const next = await apiGetChatAiReplyState({
          chatUsername: latest.chatUsername,
          chatName: latest.chatName,
        })
        if (requestIdRef.current !== requestId) return
        const now = latestRef.current
        if (
          !now.alive(latest.sessionEpoch, latest.chatUsername)
          || now.selfWxid === ''
          || next.accountKey !== now.selfWxid
        ) return
        stateIdentityRef.current = {
          selfWxid: latest.selfWxid,
          chatUsername: latest.chatUsername,
          chatName: latest.chatName,
          sessionEpoch: latest.sessionEpoch,
        }
        setError(null)
        setState({ ...next, chatName: latest.chatName })
      } catch (e) {
        // 静默刷新失败不打断当前界面；下一次事件或轮询会再试。
        if (requestIdRef.current === requestId && !silent) {
          setError(e instanceof Error ? e.message : String(e))
        }
      } finally {
        if (!silent && requestIdRef.current === requestId) setLoading(false)
      }
    }
    const promise = run()
    refreshInFlightRef.current = promise
    void promise.finally(() => {
      if (refreshInFlightRef.current === promise) refreshInFlightRef.current = null
    })
    return promise
  }, [latestRef, requestIdRef, savingLockRef, setError, setLoading, setState, stateIdentityRef])

  // 消息列表事件先做 2s 尾随去抖：一次投递往往连续回写多条记录，没必要逐条回源。
  useEffect(() => {
    if (chatUsername === '' || selfWxid === '') return undefined
    const hidden = (): boolean => typeof document !== 'undefined' && document.hidden === true
    let timer: ReturnType<typeof setTimeout> | null = null
    const onUpdated = (): void => {
      if (hidden()) return
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        if (hidden()) return
        void refresh({ silent: true })
      }, CHAT_AI_REPLY_REFRESH_DEBOUNCE_MS)
    }
    window.addEventListener(MESSAGE_LIST_UPDATED_EVENT, onUpdated)
    return () => {
      window.removeEventListener(MESSAGE_LIST_UPDATED_EVENT, onUpdated)
      if (timer !== null) clearTimeout(timer)
    }
  }, [chatUsername, refresh, selfWxid])

  // 页面可见且已有状态时做 15s 轻量兜底；切到后台停表，回来先补一次。
  useEffect(() => {
    if (!hasState || chatUsername === '' || selfWxid === '') return undefined
    const hidden = (): boolean => typeof document !== 'undefined' && document.hidden === true
    let timer: ReturnType<typeof setInterval> | null = null
    const stop = (): void => {
      if (timer !== null) clearInterval(timer)
      timer = null
    }
    const start = (): void => {
      stop()
      if (!hidden()) {
        timer = setInterval(() => { void refresh({ silent: true }) }, CHAT_AI_REPLY_POLL_MS)
      }
    }
    const onVisibility = (): void => {
      if (hidden()) {
        stop()
        return
      }
      void refresh({ silent: true })
      start()
    }
    start()
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility)
    }
    return () => {
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility)
      }
      stop()
    }
  }, [chatUsername, hasState, refresh, selfWxid])

  return { refresh }
}
