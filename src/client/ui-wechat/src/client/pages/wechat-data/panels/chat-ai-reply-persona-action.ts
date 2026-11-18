import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { ChatAiReplyState } from '@deepseek-ai/dsh-wechat-data/types'
import { apiSetChatAiReplyPersona } from '../api-chat-ai-reply.ts'
import {
  sameChatAiReplyIdentity,
  type ChatAiReplyIdentity,
} from './chat-ai-reply-identity.ts'

export interface ChatAiReplyPersonaLatest extends ChatAiReplyIdentity {
  isGroup: boolean
  alive: (epoch: number, talker: string) => boolean
  onNotice: (text: string) => void
  onEnabledChanged?: (chatUsername: string, enabled: boolean) => void
}

export interface ChatAiReplyPersonaSaveContext {
  state: ChatAiReplyState | null
  latestRef: MutableRefObject<ChatAiReplyPersonaLatest>
  stateIdentityRef: MutableRefObject<ChatAiReplyIdentity | null>
  requestIdRef: MutableRefObject<number>
  savingLockRef: MutableRefObject<symbol | null>
  scanningLockRef: MutableRefObject<symbol | null>
  setSaving: Dispatch<SetStateAction<boolean>>
  setError: Dispatch<SetStateAction<string | null>>
  setState: Dispatch<SetStateAction<ChatAiReplyState | null>>
}

/**
 * 保存人格请求与会话切换共用同一套 requestId / 身份校验。
 * 抽成独立动作后，hook 只负责编排，不在会话切换后回写旧会话结果。
 */
export async function saveChatAiReplyPersona(
  context: ChatAiReplyPersonaSaveContext,
  draft: {
    name: string
    prompt: string
    splitReply: boolean
    kbEnabled: boolean
    kbId: number
    contextWindowHours: number
  },
): Promise<boolean> {
  const latest = context.latestRef.current
  const stateIdentity = context.stateIdentityRef.current
  if (
    context.state === null
    || stateIdentity === null
    || context.savingLockRef.current !== null
    || context.scanningLockRef.current !== null
    || latest.selfWxid === ''
    || !sameChatAiReplyIdentity(stateIdentity, latest)
  ) return false

  const lock = Symbol('chat-ai-reply-persona-save')
  context.savingLockRef.current = lock
  const requestId = context.requestIdRef.current + 1
  context.requestIdRef.current = requestId
  context.setSaving(true)
  context.setError(null)
  try {
    const result = await apiSetChatAiReplyPersona({
      chatUsername: latest.chatUsername,
      chatName: latest.chatName,
      personaName: draft.name,
      personaPrompt: draft.prompt,
      splitReply: draft.splitReply,
      kbEnabled: draft.kbEnabled,
      kbId: draft.kbId,
      contextWindowHours: draft.contextWindowHours,
      expectedRevision: context.state.revision,
    })
    if (context.requestIdRef.current !== requestId) return false
    if (!result.ok || result.state === undefined) {
      const message = result.error ?? 'AI 回复人格保存失败'
      context.setError(message)
      context.latestRef.current.onNotice(message)
      return false
    }
    const now = context.latestRef.current
    if (
      !now.alive(now.sessionEpoch, now.chatUsername)
      || now.selfWxid === ''
      || result.state.accountKey !== now.selfWxid
    ) return false
    context.stateIdentityRef.current = {
      selfWxid: now.selfWxid,
      chatUsername: now.chatUsername,
      chatName: now.chatName,
      sessionEpoch: now.sessionEpoch,
    }
    context.setState({ ...result.state, chatName: now.chatName })
    now.onNotice('AI 回复人格已保存')
    return true
  } catch (e) {
    if (context.requestIdRef.current !== requestId) return false
    const message = e instanceof Error ? e.message : String(e)
    context.setError(message)
    context.latestRef.current.onNotice(message)
    return false
  } finally {
    if (context.savingLockRef.current === lock) {
      context.savingLockRef.current = null
      // 同 `toggle`：收尾只看锁归属，不看 requestId —— 否则并发回源会让 `saving`
      // 永久为真，设置弹窗的保存按钮从此一直是「保存中」。
      context.setSaving(false)
    }
  }
}
