/**
 * 会话列表的 AI 回复索引。
 *
 * 一次批量读取当前账号已开启 AI 回复的会话，避免每行发一条 Remote；任务状态变化后回源，
 * 本地开关切换则先做乐观更新，保证行内徽标和筛选计数立即变化。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { WechatSession } from '@deepseek-ai/dsh-wechat-data/types'
import { apiListEnabledChatAiReplyStates } from '../api-chat-ai-reply.ts'
import { MESSAGE_LIST_UPDATED_EVENT } from '../message-list-events.ts'

/**
 * 这个会话是「可对话会话」吗（单聊或群聊）。
 *
 * **AI 回复与 AI 问答的入口可见性、AI 回复的计数/筛选/徽标都必须共用本函数**：
 * 各写一遍正是「开了 2 个 AI 回复却显示 1 个」的根因 —— 计数处漏了群聊，
 * 另外两处没漏。`WechatSession.type` 目前只有 `private`/`group`，两种都算；
 * 将来新增类型（公众号/服务号/客服）时必须在这里显式判断，
 * 而不是让它自动落进「支持」。
 * @param session - 会话（只需 `type`）。
 * @returns 是否属于可对话会话。
 */
export function sessionIsConversational(session: Pick<WechatSession, 'type'>): boolean {
  return session.type === 'private' || session.type === 'group'
}

/** 指定会话是否已开启 AI 回复：类型要可对话，且在当前账号的已开启集合里。 */
export function sessionHasAiReply(
  session: Pick<WechatSession, 'type' | 'username'>,
  enabledUsernames: ReadonlySet<string>,
): boolean {
  return sessionIsConversational(session) && enabledUsernames.has(session.username)
}

export interface ChatAiReplyEnabledIndex {
  enabledUsernames: ReadonlySet<string>
  loading: boolean
  error: string | null
  markEnabled: (chatUsername: string, enabled: boolean) => void
  refresh: (silent?: boolean) => Promise<void>
}

export function useChatAiReplyEnabledIndex(): ChatAiReplyEnabledIndex {
  const [enabledUsernames, setEnabledUsernames] = useState<ReadonlySet<string>>(() => new Set())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const requestIdRef = useRef(0)
  const aliveRef = useRef(false)

  const refresh = useCallback(async (silent = false): Promise<void> => {
    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    if (!silent) setLoading(true)
    try {
      const result = await apiListEnabledChatAiReplyStates()
      if (!aliveRef.current || requestIdRef.current !== requestId) return
      if (!result.ok) {
        setError(result.error)
        return
      }
      setEnabledUsernames(new Set(
        result.chats
          .map((chat) => chat.chatUsername.trim())
          .filter((username) => username !== ''),
      ))
      setError(null)
    } catch (e) {
      if (!aliveRef.current || requestIdRef.current !== requestId) return
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (aliveRef.current && requestIdRef.current === requestId) {
        setLoading(false)
      }
    }
  }, [])

  const markEnabled = useCallback((chatUsername: string, enabled: boolean): void => {
    const username = chatUsername.trim()
    if (username === '') return
    // 乐观切换是比任何已发出的批量回源都新的本地事实；让旧回源失效，
    // 否则慢响应会在开关刚变绿/变灰后把它覆盖回去。
    requestIdRef.current += 1
    setError(null)
    setLoading(false)
    setEnabledUsernames((previous) => {
      const had = previous.has(username)
      if (had === enabled) return previous
      const next = new Set(previous)
      if (enabled) next.add(username)
      else next.delete(username)
      return next
    })
  }, [])

  useEffect(() => {
    aliveRef.current = true
    void refresh()
    const onUpdated = (): void => { void refresh(true) }
    window.addEventListener(MESSAGE_LIST_UPDATED_EVENT, onUpdated)
    return () => {
      aliveRef.current = false
      requestIdRef.current += 1
      window.removeEventListener(MESSAGE_LIST_UPDATED_EVENT, onUpdated)
    }
  }, [refresh])

  return {
    enabledUsernames,
    loading,
    error,
    markEnabled,
    refresh,
  }
}
