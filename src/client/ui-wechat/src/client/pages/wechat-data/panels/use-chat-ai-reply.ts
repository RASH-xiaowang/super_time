/**
 * 「更多 → AI 回复」的会话级状态。
 * 每次异步返回都校验 epoch/talker/selfWxid，避免切换会话后旧响应写到新会话。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatAiReplyScanResult, ChatAiReplyState } from '@deepseek-ai/dsh-wechat-data/types'
import {
  apiGetChatAiReplyState,
  apiScanChatAiReplyNow,
  apiSetChatAiReplyEnabled,
} from '../api-chat-ai-reply.ts'
import {
  saveChatAiReplyPersona,
  type ChatAiReplyPersonaLatest,
} from './chat-ai-reply-persona-action.ts'
import {
  sameChatAiReplyIdentity,
  type ChatAiReplyIdentity,
} from './chat-ai-reply-identity.ts'
import { useChatAiReplyRefresh } from './use-chat-ai-reply-refresh.ts'

export {
  CHAT_AI_REPLY_POLL_MS,
  CHAT_AI_REPLY_REFRESH_DEBOUNCE_MS,
} from './use-chat-ai-reply-refresh.ts'

export interface ChatAiReplyController {
  state: ChatAiReplyState | null
  loading: boolean
  saving: boolean
  scanning: boolean
  error: string | null
  /** 菜单是否应出现（单聊与群聊即可；正在等待账号 wxid 时为可显示但禁用）。 */
  available: boolean
  toggle: () => Promise<void>
  refresh: (options?: { silent?: boolean }) => Promise<void>
  scanNow: () => Promise<void>
  savePersona: (input: {
    name: string
    prompt: string
    splitReply: boolean
    kbEnabled: boolean
    kbId: number
    contextWindowHours: number
    safetyHandoff: string
    safetyBlocked: string
  }) => Promise<boolean>
}

function currentChatAiReplyState(
  state: ChatAiReplyState | null,
  identity: ChatAiReplyIdentity | null,
  input: Pick<ChatAiReplyPersonaLatest, 'selfWxid' | 'chatUsername' | 'chatName' | 'sessionEpoch'>,
): ChatAiReplyState | null {
  if (
    state === null
    || identity === null
    || !sameChatAiReplyIdentity(identity, input)
    || state.accountKey !== input.selfWxid
  ) return null
  return state
}

export function useChatAiReply(input: {
  chatUsername: string
  chatName: string
  isGroup: boolean
  selfWxid: string
  sessionEpoch: number
  alive: (epoch: number, talker: string) => boolean
  onNotice: (text: string) => void
  /** 列表索引的乐观同步；权威状态仍由 message-list 事件回源。 */
  onEnabledChanged?: (chatUsername: string, enabled: boolean) => void
}): ChatAiReplyController {
  const { chatUsername, chatName, selfWxid, sessionEpoch } = input
  const [state, setState] = useState<ChatAiReplyState | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestIdRef = useRef(0)
  const savingLockRef = useRef<symbol | null>(null)
  const scanningLockRef = useRef<symbol | null>(null)
  const latestRef = useRef<ChatAiReplyPersonaLatest>(input)
  latestRef.current = input
  /** The exact account/session snapshot that produced current `state`. */
  const stateIdentityRef = useRef<ChatAiReplyIdentity | null>(null)
  const current = currentChatAiReplyState(state, stateIdentityRef.current, input)

  const valid = (epoch: number, talker: string, account: string): boolean => (
    latestRef.current.alive(epoch, talker)
    && latestRef.current.selfWxid !== ''
    && account === latestRef.current.selfWxid
  )

  useEffect(() => {
    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    setState(null)
    setError(null)
    setLoading(false)
    setSaving(false)
    setScanning(false)
    // 切换会话后释放旧的“仅作用于当前会话”的 UI 锁；旧请求仍由 requestId
    // 阻止回写，但不应让新会话的保存/扫描一直等着它。
    savingLockRef.current = null
    scanningLockRef.current = null
    stateIdentityRef.current = null
    // 2026-11-18 起群聊也支持：只按「有没有会话」判断，不再按 isGroup 提前返回。
    if (chatUsername === '') return
    if (selfWxid === '') return
    setLoading(true)
    void apiGetChatAiReplyState({ chatUsername, chatName })
      .then((next) => {
        if (requestIdRef.current !== requestId) return
        if (!valid(sessionEpoch, chatUsername, next.accountKey)) return
        if (next.accountKey === '') {
          setError('无法解析当前账号 wxid')
          return
        }
        stateIdentityRef.current = { selfWxid, chatUsername, chatName, sessionEpoch }
        setState({ ...next, chatName })
      })
      .catch((e: unknown) => {
        if (requestIdRef.current === requestId) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (requestIdRef.current === requestId) setLoading(false)
      })
  }, [chatUsername, chatName, selfWxid, sessionEpoch])

  const { refresh } = useChatAiReplyRefresh({
    chatUsername,
    selfWxid,
    sessionEpoch,
    latestRef,
    stateIdentityRef,
    requestIdRef,
    savingLockRef,
    hasState: current !== null,
    setState,
    setLoading,
    setError,
  })

  const scanNow = useCallback(async (): Promise<void> => {
    const latest = latestRef.current
    if (latest.chatUsername === '' || latest.selfWxid === '') return
    if (latestRef.current.alive(latest.sessionEpoch, latest.chatUsername) === false) return
    if (scanningLockRef.current !== null) return
    const lock = Symbol('chat-ai-reply-scan')
    const scanIdentity: ChatAiReplyIdentity = {
      selfWxid: latest.selfWxid,
      chatUsername: latest.chatUsername,
      chatName: latest.chatName,
      sessionEpoch: latest.sessionEpoch,
    }
    const ownsScan = (): boolean => {
      const now = latestRef.current
      return scanningLockRef.current === lock
        && sameChatAiReplyIdentity(scanIdentity, now)
        && now.alive(now.sessionEpoch, now.chatUsername)
    }
    scanningLockRef.current = lock
    setScanning(true)
    setError(null)
    try {
      const result: ChatAiReplyScanResult = await apiScanChatAiReplyNow()
      if (!ownsScan()) return
      await refresh()
      if (!ownsScan()) return
      const scanError = result.errors?.[0]
      if (scanError !== undefined && scanError !== '') {
        setError(scanError)
        latestRef.current.onNotice(scanError)
        return
      }
      latestRef.current.onNotice(
        result.queued > 0
          ? 'AI 回复检查完成：已开始处理 ' + String(result.queued) + ' 个会话'
          : 'AI 回复检查完成：暂无待处理的新消息',
      )
    } catch (e) {
      if (!ownsScan()) return
      const message = e instanceof Error ? e.message : String(e)
      setError(message)
      latestRef.current.onNotice(message)
    } finally {
      if (scanningLockRef.current === lock) {
        scanningLockRef.current = null
        setScanning(false)
      }
    }
  }, [refresh])

  const savePersona = useCallback(async (input: {
    name: string
    prompt: string
    splitReply: boolean
    kbEnabled: boolean
    kbId: number
    contextWindowHours: number
    safetyHandoff: string
    safetyBlocked: string
  }): Promise<boolean> => saveChatAiReplyPersona({
    state,
    latestRef,
    stateIdentityRef,
    requestIdRef,
    savingLockRef,
    scanningLockRef,
    setSaving,
    setError,
    setState,
  }, input), [state])

  const toggle = useCallback(async (): Promise<void> => {
    const latest = latestRef.current
    const stateIdentity = stateIdentityRef.current
    if (
      state === null
      || stateIdentity === null
      || savingLockRef.current !== null
      || scanningLockRef.current !== null
      || latest.selfWxid === ''
      || !sameChatAiReplyIdentity(stateIdentity, {
        selfWxid: latest.selfWxid,
        chatUsername: latest.chatUsername,
        chatName: latest.chatName,
        sessionEpoch: latest.sessionEpoch,
      })
    ) return
    const lock = Symbol('chat-ai-reply-save')
    savingLockRef.current = lock
    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    setSaving(true)
    setError(null)
    try {
      const result = await apiSetChatAiReplyEnabled({
        chatUsername: latest.chatUsername,
        chatName: latest.chatName,
        enabled: !state.enabled,
        provider: state.provider,
        expectedRevision: state.revision,
      })
      if (requestIdRef.current !== requestId) return
      if (!result.ok || result.state === undefined) {
        const message = result.error ?? 'AI 回复设置失败'
        setError(message)
        latestRef.current.onNotice(message)
        return
      }
      const now = latestRef.current
      if (!valid(now.sessionEpoch, now.chatUsername, result.state.accountKey)) return
      stateIdentityRef.current = {
        selfWxid: now.selfWxid,
        chatUsername: now.chatUsername,
        chatName: now.chatName,
        sessionEpoch: now.sessionEpoch,
      }
      setState({ ...result.state, chatName: now.chatName })
      now.onEnabledChanged?.(now.chatUsername, result.state.enabled)
      const warning = result.state.error?.trim() ?? ''
      if (result.state.enabled && warning !== '') {
        setError(warning)
        now.onNotice('AI 回复已开启；' + warning)
      } else {
        now.onNotice(result.state.enabled ? 'AI 回复已开启' : 'AI 回复已关闭')
      }
    } catch (e) {
      if (requestIdRef.current !== requestId) return
      const message = e instanceof Error ? e.message : String(e)
      setError(message)
      latestRef.current.onNotice(message)
    } finally {
      if (savingLockRef.current === lock) {
        savingLockRef.current = null
        // 不要用 requestId 兜这个收尾：一旦被并发回源推进，`saving` 就永远收不回来，
        // 按钮永久变灰（实测「关掉后再也打不开」的根因）。锁仍属于本次写入时直接收尾。
        setSaving(false)
      }
    }
  }, [state])

  const errorText = selfWxid === ''
    ? '正在读取当前账号，请稍候'
    : (error ?? current?.error ?? null)
  return {
    state: current,
    loading,
    saving,
    scanning,
    error: errorText,
    available: chatUsername !== '',
    toggle,
    refresh,
    scanNow,
    savePersona,
  }
}
