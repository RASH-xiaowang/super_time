/**
 * 会话列表的 AI 回复索引。
 *
 * 一次批量读取当前账号已开启的单聊，避免每行发一条 Remote；任务状态变化后回源，
 * 本地开关切换则先做乐观更新，保证行内徽标和筛选计数立即变化。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { apiListEnabledChatAiReplyStates } from '../api-chat-ai-reply.ts'
import { MESSAGE_LIST_UPDATED_EVENT } from '../message-list-events.ts'

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
          .filter((username) => username !== '' && !username.endsWith('@chatroom')),
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
