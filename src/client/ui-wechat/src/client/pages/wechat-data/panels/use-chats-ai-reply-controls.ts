/**
 * Chats 面板的 AI 回复编排。
 *
 * 把「当前会话开关 + 列表批量索引 + AI-only 筛选」收在一个 hook 里，避免面板同时持有
 * 三套状态并逐层手工接线。权威开关状态仍来自 message-list；本地切换只负责即时更新索引。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { WechatSession } from '@deepseek-ai/dsh-wechat-data/types'
import type { ChatView } from './chats-support.tsx'
import type { ChatsViewProps } from './chats-view.tsx'
import { useChatAiReply } from './use-chat-ai-reply.ts'
import { sessionHasAiReply, sessionIsConversational, useChatAiReplyEnabledIndex } from './use-chat-ai-reply-enabled.ts'

interface ChatsAiReplyControlsInput {
  view: ChatView
  sessions: readonly WechatSession[]
  curSession: WechatSession | null
  selfWxid: string
  sessionEpoch: number
  alive: (epoch: number, talker: string) => boolean
  onNotice: (text: string) => void
}

export interface ChatsAiReplyControls {
  aiOnly: boolean
  enabledUsernames: ReadonlySet<string>
  aiReply: ChatsViewProps['aiReply']
  aiReplyFilter: ChatsViewProps['aiReplyFilter']
}

export function useChatsAiReplyControls({
  view,
  sessions,
  curSession,
  selfWxid,
  sessionEpoch,
  alive,
  onNotice,
}: ChatsAiReplyControlsInput): ChatsAiReplyControls {
  const [aiOnly, setAiOnly] = useState(false)
  const enabledIndex = useChatAiReplyEnabledIndex()

  // AI 回复筛选只属于「全部」，切到公众号/服务号/客服时自动退出。
  useEffect(() => {
    if (view !== 'chats') setAiOnly(false)
  }, [view])

  // 计数与筛选、行内徽标共用 `sessionHasAiReply`：三处各写一遍判据，
  // 曾导致「群聊开了 AI 回复却不算进 chip 计数」（显示 1，实际 2）。
  const matchCount = useMemo(
    () => view === 'chats'
      ? sessions.filter((session) => sessionHasAiReply(session, enabledIndex.enabledUsernames)).length
      : 0,
    [enabledIndex.enabledUsernames, sessions, view],
  )

  /** 会话级 AI 回复：单聊与群聊都可用（群聊只回 @我 的消息），切换会话立即作废旧请求。 */
  const chatAiReply = useChatAiReply({
    chatUsername: curSession?.username ?? '',
    chatName: curSession?.displayName ?? '',
    isGroup: curSession?.type === 'group',
    selfWxid,
    sessionEpoch,
    alive,
    onNotice,
    onEnabledChanged: enabledIndex.markEnabled,
  })

  // 2026-11-18 起群聊也能开启（此前只有单聊）：群聊的触发条件收在后端
  // （只有 @我 的消息才成为锚点）。公众号/文件传输等其它会话类型仍不显示。
  const aiReply = curSession !== null
    && sessionIsConversational(curSession)
    && chatAiReply.available
    ? {
        visible: true,
        enabled: chatAiReply.state?.enabled === true,
        stage: chatAiReply.state?.stage ?? 'idle',
        busy: chatAiReply.available && (chatAiReply.loading || chatAiReply.saving || chatAiReply.scanning),
        ready: chatAiReply.available && chatAiReply.state !== null,
        ...(chatAiReply.error === null ? {} : { error: chatAiReply.error }),
        ...(chatAiReply.state?.lastRunAt === undefined
          ? {}
          : { lastRunAt: chatAiReply.state.lastRunAt }),
        ...(chatAiReply.state?.recordId === undefined
          ? {}
          : { recordId: chatAiReply.state.recordId }),
        personaName: chatAiReply.state?.personaName ?? '',
        personaPrompt: chatAiReply.state?.personaPrompt ?? '',
        splitReply: chatAiReply.state?.splitReply !== false,
        kbEnabled: chatAiReply.state?.kbEnabled === true,
        kbId: chatAiReply.state?.kbId ?? 0,
        contextWindowHours: chatAiReply.state?.contextWindowHours ?? 0,
        safetyHandoff: chatAiReply.state?.safetyHandoff ?? '',
        safetyBlocked: chatAiReply.state?.safetyBlocked ?? '',
        onToggle: () => { void chatAiReply.toggle() },
        onScanNow: () => { void chatAiReply.scanNow() },
        onSavePersona: (persona: {
          name: string
          prompt: string
          splitReply: boolean
          kbEnabled: boolean
          kbId: number
          contextWindowHours: number
          safetyHandoff: string
          safetyBlocked: string
        }) => chatAiReply.savePersona(persona),
      }
    : undefined

  const toggleAiOnly = useCallback((): void => {
    setAiOnly((value) => !value)
  }, [])

  const aiReplyFilter = useMemo<ChatsViewProps['aiReplyFilter']>(() => ({
    aiOnly,
    count: matchCount,
    enabledUsernames: enabledIndex.enabledUsernames,
    loading: enabledIndex.loading,
    ...(enabledIndex.error === null ? {} : { error: enabledIndex.error }),
    onToggle: toggleAiOnly,
  }), [
    aiOnly,
    enabledIndex.enabledUsernames,
    enabledIndex.error,
    enabledIndex.loading,
    matchCount,
    toggleAiOnly,
  ])

  return {
    aiOnly,
    enabledUsernames: enabledIndex.enabledUsernames,
    aiReply,
    aiReplyFilter,
  }
}
