import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { apiGetMessages, readRenderCache, writeRenderCache } from '../api.ts'
import type { MessagesSnapshot, WechatMessage, WechatSession } from '@deepseek-ai/dsh-wechat-data/types'
import { messagesMatchTalker } from './msg-scope.ts'
import { pinScrollToBottom } from './chats-polling.ts'
import { directChatEnterpriseName } from './enterprise-identity.ts'
import {
  canCacheChatId,
  canonicalChatId,
  readableChatName,
} from '../utils/chat-identity.ts'

export interface SessionRuntime {
  sessionAlive: (epoch: number, talker: string) => boolean
  sessionEpochRef: MutableRefObject<number>
  messagesTalkerRef: MutableRefObject<string | null>
  inFlightRef: MutableRefObject<boolean>
  msgScrollRef: MutableRefObject<HTMLDivElement | null>
  watermarkRef: MutableRefObject<number>
  onSessionBegin?: (epoch: number) => void
  setCurSession: Dispatch<SetStateAction<WechatSession | null>>
  setMessages: Dispatch<SetStateAction<readonly WechatMessage[]>>
  setCursor: Dispatch<SetStateAction<number>>
  setCursorLocalId: Dispatch<SetStateAction<number | undefined>>
  setTypeStats: Dispatch<SetStateAction<readonly { type: number; label: string; count: number }[]>>
  setMsgLoading: Dispatch<SetStateAction<boolean>>
  setMsgError: Dispatch<SetStateAction<string | null>>
  setHasMore: Dispatch<SetStateAction<boolean>>
  setSelfWxid: Dispatch<SetStateAction<string>>
  setWatermarkFrom: (list: readonly WechatMessage[]) => void
}

export interface OpenSessionRuntime extends SessionRuntime {
  selfWxid: string
}

export interface LocateRuntime extends SessionRuntime {
  sessions: readonly WechatSession[]
  /** Queue a locate request until the virtualizer has rendered the target list. */
  locateMessage: (localId: number, scopeKey?: string) => void
}

function readableSessionName(name: string | undefined, username: string): string {
  return readableChatName(name, username)
}

/**
 * Rebuild a provisional navigation session from the first message response.
 * The backend resolves legacy `Msg_<md5>` targets and returns the canonical
 * username/type/name, so the UI never keeps a hash as its active chat id.
 */
function sessionFromSnapshot(
  requestedUsername: string,
  sessions: readonly WechatSession[],
  snapshot?: MessagesSnapshot,
): WechatSession {
  const canonical = canonicalChatId(requestedUsername, snapshot?.canonicalUsername)
  if (canonical === '') {
    return {
      username: '',
      displayName: '正在解析会话身份…',
      type: 'private',
      lastTimestamp: 0,
      summary: '',
      unreadCount: 0,
      draft: '',
      pinned: false,
      hidden: false,
    }
  }
  const found = sessions.find((session) => session.username === canonical)
  const displayName = readableSessionName(
    snapshot?.chatDisplayName ?? found?.displayName,
    canonical,
  )
  if (found) {
    return {
      ...found,
      username: canonical,
      displayName,
      type: snapshot?.chatType ?? found.type,
    }
  }
  return {
    username: canonical,
    displayName,
    type: snapshot?.chatType ?? (canonical.endsWith('@chatroom') ? 'group' : 'private'),
    lastTimestamp: 0,
    summary: '',
    unreadCount: 0,
    draft: '',
    pinned: false,
    hidden: false,
  }
}

/** Start a session epoch and declare the talker that owns the message state. */
function beginSession(runtime: SessionRuntime, talker: string): number {
  runtime.sessionEpochRef.current += 1
  runtime.messagesTalkerRef.current = talker
  runtime.inFlightRef.current = false
  runtime.onSessionBegin?.(runtime.sessionEpochRef.current)
  return runtime.sessionEpochRef.current
}

function resetSessionState(runtime: SessionRuntime, messages: readonly WechatMessage[]): void {
  runtime.setMessages(messages)
  runtime.watermarkRef.current = 0
  runtime.setCursor(0)
  runtime.setCursorLocalId(undefined)
  runtime.setTypeStats([])
  runtime.setMsgLoading(true)
  runtime.setMsgError(null)
}

/** Open a session, paint its render cache immediately, then refresh the latest page. */
export async function openChatSession(runtime: OpenSessionRuntime, session: WechatSession): Promise<void> {
  const requestedUsername = session.username.trim()
  let activeUsername = requestedUsername
  const epoch = beginSession(runtime, requestedUsername)
  runtime.setCurSession(sessionFromSnapshot(requestedUsername, [session]))
  resetSessionState(runtime, [])

  try {
    const raw = canCacheChatId(requestedUsername)
      ? readRenderCache<WechatMessage[]>('chat-msgs:v2:' + requestedUsername)
      : null
    const cached = raw && messagesMatchTalker(raw, requestedUsername, runtime.selfWxid) ? raw : null
    if (!runtime.sessionAlive(epoch, activeUsername)) return
    runtime.setMessages(cached ?? [])
    if (cached && cached.length > 0) {
      runtime.setHasMore(true)
      runtime.setMsgLoading(false)
    }

    const env = await apiGetMessages({ talker: requestedUsername, limit: 100 })
    if (!runtime.sessionAlive(epoch, activeUsername)) return
    const canonical = canonicalChatId(activeUsername, env.canonicalUsername)
    if (canonical === '') throw new Error('无法解析该会话身份，请重新同步微信数据后再试')
    if (canonical !== activeUsername) {
      activeUsername = canonical
      runtime.messagesTalkerRef.current = canonical
    }
    runtime.setCurSession(sessionFromSnapshot(activeUsername, [session], env))
    runtime.setMessages(env.messages)
    runtime.setWatermarkFrom(env.messages)
    runtime.setSelfWxid(env.selfWxid ?? '')
    runtime.setHasMore(env.hasMore ?? false)
    runtime.setCursor(env.cursor ?? 0)
    runtime.setCursorLocalId(env.cursorLocalId)
    runtime.setTypeStats(env.typeStats ?? [])
    if (canCacheChatId(activeUsername)) {
      writeRenderCache('chat-msgs:v2:' + activeUsername, env.messages)
    }
    setTimeout(() => {
      if (runtime.sessionAlive(epoch, activeUsername)) pinScrollToBottom(runtime.msgScrollRef.current, 8)
    }, 50)
  } catch (error) {
    if (runtime.sessionAlive(epoch, activeUsername)) runtime.setMsgError((error as Error).message)
  } finally {
    if (runtime.sessionAlive(epoch, activeUsername)) runtime.setMsgLoading(false)
  }
}

/** Load one older page and anchor the scroll position before prepending it. */
export async function loadOlderChatMessages(
  runtime: SessionRuntime,
  session: WechatSession,
  cursor: number,
  cursorLocalId: number | undefined,
  onBeforePrepend: (box: HTMLDivElement) => void,
): Promise<void> {
  const talker = session.username
  if (!canCacheChatId(talker)) {
    runtime.setMsgError('该会话身份尚未解析，暂时不能加载更多消息')
    runtime.setMsgLoading(false)
    return
  }
  const epoch = runtime.sessionEpochRef.current
  runtime.setMsgLoading(true)
  try {
    const env = await apiGetMessages({ talker, limit: 100, cursor, cursorLocalId })
    if (!runtime.sessionAlive(epoch, talker)) return
    if (canonicalChatId(talker, env.canonicalUsername) !== talker) {
      throw new Error('会话身份发生变化，已停止合并历史消息')
    }
    const box = runtime.msgScrollRef.current
    if (box) onBeforePrepend(box)
    runtime.setMessages((previous) => (
      runtime.sessionAlive(epoch, talker) ? [...env.messages, ...previous] : previous
    ))
    runtime.setWatermarkFrom(env.messages)
    runtime.setHasMore(env.hasMore ?? false)
    runtime.setCursor(env.cursor ?? cursor)
    runtime.setCursorLocalId(env.cursorLocalId)
  } catch (error) {
    if (runtime.sessionAlive(epoch, talker)) runtime.setMsgError((error as Error).message)
  } finally {
    if (runtime.sessionAlive(epoch, talker)) runtime.setMsgLoading(false)
  }
}

function addDirectChatEnterprise(
  current: WechatSession | null,
  username: string,
  messages: ReadonlyArray<WechatMessage>,
): WechatSession | null {
  if (current?.username !== username || current.enterpriseName) return current
  const enterpriseName = directChatEnterpriseName(username, messages)
  return enterpriseName ? { ...current, enterpriseName } : current
}

/** Open a target session and page backwards until a message/day is found. */
export async function openChatSessionAndLocate(
  runtime: LocateRuntime,
  username: string,
  localId?: number,
  dayStart?: number,
): Promise<void> {
  const requestedUsername = username.trim()
  let activeUsername = requestedUsername
  runtime.setCurSession(sessionFromSnapshot(requestedUsername, runtime.sessions))
  const epoch = beginSession(runtime, requestedUsername)
  resetSessionState(runtime, [])

  try {
    const initialOptions: {
      talker: string
      limit: number
      beforeLocalId?: number
    } = { talker: requestedUsername, limit: 100 }
    // A known local id can be read directly from a bounded window ending at
    // that message. This avoids walking hundreds of pages for old quotes/cites.
    if (localId !== undefined) initialOptions.beforeLocalId = localId
    let env = await apiGetMessages(initialOptions)
    if (!runtime.sessionAlive(epoch, activeUsername)) return
    const adoptSnapshot = (snapshot: MessagesSnapshot): void => {
      const canonical = canonicalChatId(activeUsername, snapshot.canonicalUsername)
      if (canonical === '') {
        throw new Error('无法解析该会话身份，请重新同步微信数据后再试')
      }
      if (canonical !== activeUsername) {
        activeUsername = canonical
        runtime.messagesTalkerRef.current = canonical
      }
      runtime.setCurSession(sessionFromSnapshot(activeUsername, runtime.sessions, snapshot))
    }
    adoptSnapshot(env)
    let list = env.messages
    const findHit = (): number => {
      if (localId !== undefined) return list.findIndex((message) => message.localId === localId)
      if (dayStart !== undefined) return list.findIndex((message) => message.createTime >= dayStart)
      return -1
    }
    let hit = findHit()
    // Older backends may ignore beforeLocalId. Fall back to the latest page +
    // bounded backwards paging so navigation still works during upgrades.
    if (localId !== undefined && hit < 0) {
      env = await apiGetMessages({ talker: activeUsername, limit: 100 })
      if (!runtime.sessionAlive(epoch, activeUsername)) return
      adoptSnapshot(env)
      list = env.messages
      hit = findHit()
    }
    let pages = 0
    while (hit < 0 && (env.hasMore ?? false) && pages < 10) {
      const options: { talker: string; limit: number; cursor?: number; cursorLocalId?: number } = {
        talker: activeUsername,
        limit: 100,
      }
      if (env.cursor !== undefined) options.cursor = env.cursor
      if (env.cursorLocalId !== undefined) options.cursorLocalId = env.cursorLocalId
      env = await apiGetMessages(options)
      if (!runtime.sessionAlive(epoch, activeUsername)) return
      adoptSnapshot(env)
      list = [...env.messages, ...list]
      pages += 1
      hit = findHit()
    }
    if (!runtime.sessionAlive(epoch, activeUsername)) return
    runtime.setCurSession((current) => addDirectChatEnterprise(current, activeUsername, list))
    runtime.setMessages(list)
    runtime.setWatermarkFrom(list)
    runtime.setSelfWxid(env.selfWxid ?? '')
    runtime.setHasMore(env.hasMore ?? false)
    runtime.setCursor(env.cursor ?? 0)
    runtime.setCursorLocalId(env.cursorLocalId)
    runtime.setTypeStats(env.typeStats ?? [])
    if (hit >= 0) {
      const target = list[hit]
      if (target) runtime.locateMessage(target.localId, activeUsername + '\u0000' + String(epoch))
    } else {
      if (localId !== undefined || dayStart !== undefined) {
        runtime.setMsgError('未找到目标消息，可能已删除或尚未同步')
      }
      pinScrollToBottom(runtime.msgScrollRef.current, 8)
    }
  } catch (error) {
    if (runtime.sessionAlive(epoch, activeUsername)) runtime.setMsgError((error as Error).message)
  } finally {
    if (runtime.sessionAlive(epoch, activeUsername)) runtime.setMsgLoading(false)
  }
}
