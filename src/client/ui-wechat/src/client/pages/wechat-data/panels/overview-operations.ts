/** Overview-only projections: retain counts, never message bodies, prompts or endpoints. */
import type { MessageListSnapshot, ChatAiReplyEnabledChatsResult } from '@deepseek-ai/dsh-wechat-data/types'
/** Project a store-wide listMessageListRecords sample; the query has no account filter. */
export function summarizeAiReplies(snapshot: MessageListSnapshot, now: number) {
  if (snapshot.readError || !Array.isArray(snapshot.items)) throw new Error('Reply snapshot unavailable')
  const rows = snapshot.items.filter(item => item.source === 'ai_reply')
  return {
    sampled: rows.length,
    success: rows.filter(item => item.status === 'success').length,
    sendFailed: rows.filter(item => item.status === 'failed' && item.failureKind === 'send_failed').length,
    generationFailed: rows.filter(item => item.status === 'failed' && item.failureKind === 'generation_failed').length,
    held: rows.filter(item => item.status === 'failed' && item.failureKind === 'held_draft').length,
    inFlight: rows.filter(item => ['pending', 'dispatching', 'queued', 'running'].includes(item.status)).length,
    unconfirmed: rows.filter(item => item.status === 'sent_unconfirmed').length,
    sampledAt: now,
  }
}
export type RuntimeOverview = ReturnType<typeof summarizeAiReplyRuntime>
export type ReplyOverview = ReturnType<typeof summarizeAiReplies>
/** Refresh preserves the last successful snapshot only within the same data identity. */
export type OverviewSourceSnapshot<T> = {
  status: 'loading' | 'unavailable' | 'ready' | 'refreshing' | 'stale'
  data: T | null
  refreshing?: boolean
}
export function beginOverviewRefresh<T>(previous: OverviewSourceSnapshot<T>): OverviewSourceSnapshot<T> {
  return previous.data === null ? { status: 'loading', data: null } : {
    status: previous.status === 'stale' ? 'stale' : 'refreshing', data: previous.data, refreshing: true,
  }
}
export function failOverviewRefresh<T>(previous: OverviewSourceSnapshot<T>): OverviewSourceSnapshot<T> {
  return previous.data === null ? { status: 'unavailable', data: null } : { status: 'stale', data: previous.data }
}
/** Only project counts; never retain conversation names/identifiers. */
export function summarizeAiReplyRuntime(result: ChatAiReplyEnabledChatsResult, now: number) {
  if (!result.ok || !Array.isArray(result.chats) || result.chats.some(chat => typeof chat.chatUsername !== 'string' || !chat.chatUsername)) throw new Error('Reply settings unavailable')
  const chats = [...new Set(result.chats.map(chat => chat.chatUsername))]
  const groups = chats.filter(chat => chat.endsWith('@chatroom')).length
  return { enabled: chats.length, groups, direct: chats.length - groups, sampledAt: now }
}
