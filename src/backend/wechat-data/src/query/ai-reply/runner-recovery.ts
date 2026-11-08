/**
 * AI 回复的锚点、游标与恢复窗口。
 *
 * 这里只处理消息身份和扫描窗口，不读设置、不拿租约、不出网。把 sourceRef
 * 解析、pending 锚点校验和最早未处理消息选择放在同一层，便于恢复路径共享
 * 同一套 fail-closed 规则。
 */
import type {
  ChatAiReplyAnchor,
  ChatAiReplyRecordSnapshot,
  ChatAiReplyScanDeps,
  ChatAiReplyScanMessage,
  ChatAiReplyStage,
  ChatAiReplyState,
} from './types.ts'
import {
  parseChatAiReplySourceRef,
  type ChatAiReplySourceRefParts,
} from './segments.ts'
import { contextualMessageText } from './inbound-trigger.ts'

const SCAN_MESSAGE_LIMIT = 80

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function isBusyError(e: unknown): boolean {
  const record = e as { code?: unknown; message?: unknown } | null | undefined
  const code = typeof record?.code === 'string' ? record.code : ''
  const message = typeof record?.message === 'string' ? record.message : String(e)
  return /SQLITE_(?:BUSY|LOCKED)/i.test(code)
    || /database (?:table )?is locked|database is busy/i.test(message)
}

export function anchorOf(message: ChatAiReplyScanMessage): ChatAiReplyAnchor | null {
  const text = contextualMessageText(message)
  if (message.localId <= 0 || message.isSender === 1 || text === '') return null
  const sortSeq = Number(message.sortSeq ?? message.localId)
  const createTime = Number(message.createTime)
  if (!Number.isSafeInteger(sortSeq) || sortSeq < 0
    || !Number.isSafeInteger(createTime) || createTime < 0) return null
  return {
    localId: message.localId,
    sortSeq,
    createTime,
    content: text,
  }
}

/**
 * 新 cursor 采用 v2:sortSeq:localId，与消息查询的排序键一致。
 *
 * 旧版 createTime:localId 仍可读取，用于平滑迁移；下一次成功处理后会写成 v2。
 */
export function cursorOf(anchor: ChatAiReplyAnchor): string {
  return 'v2:' + String(anchor.sortSeq) + ':' + String(anchor.localId)
}

export function sourceRefOf(state: ChatAiReplyState, anchor: ChatAiReplyAnchor): string {
  return [
    'ai-reply',
    state.accountKey,
    state.chatUsername,
    String(anchor.createTime),
    String(anchor.localId),
  ].join(':')
}

export function parseSourceRef(value: string | undefined): ChatAiReplySourceRefParts | null {
  return parseChatAiReplySourceRef(value)
}

export function pendingAnchorOf(
  state: ChatAiReplyState,
  messages: ChatAiReplyScanMessage[],
): ChatAiReplyAnchor | null {
  const hasCursor = state.pendingCursor !== undefined
  const hasSourceRef = state.pendingSourceRef !== undefined
  if (!hasCursor && !hasSourceRef) return null
  if (!hasCursor || !hasSourceRef) {
    throw new Error('AI 回复 pending 锚点不完整；已停止本会话自动扫描')
  }
  const cursor = /^v2:(\d+):(\d+)$/.exec(state.pendingCursor ?? '')
  const ref = parseSourceRef(state.pendingSourceRef)
  if (cursor === null || ref === null) {
    throw new Error('AI 回复 pending 锚点格式损坏；已停止本会话自动扫描')
  }
  const sortSeq = Number(cursor[1])
  const localId = Number(cursor[2])
  if (!Number.isSafeInteger(sortSeq) || sortSeq < 0
    || !Number.isSafeInteger(localId) || localId <= 0
    || localId !== ref.localId
    || ref.accountKey !== state.accountKey
    || ref.chatUsername !== state.chatUsername) {
    throw new Error('AI 回复 pending 锚点与账号/会话不一致；已停止本会话自动扫描')
  }
  const message = messages.find((candidate) => candidate.localId === localId)
  if (message === undefined) {
    throw new Error('AI 回复 pending 锚点在当前会话中不存在；已停止本会话自动扫描')
  }
  const actual = anchorOf(message)
  if (actual === null
    || actual.sortSeq !== sortSeq
    || actual.createTime !== ref.createTime
    || sourceRefOf(state, actual) !== ref.baseSourceRef) {
    throw new Error('AI 回复 pending 锚点与真实消息不一致；已停止本会话自动扫描')
  }
  return actual
}

export function anchorOfRecord(
  state: ChatAiReplyState,
  record: ChatAiReplyRecordSnapshot,
  messages: ChatAiReplyScanMessage[],
): ChatAiReplyAnchor | null {
  const pending = pendingAnchorOf(state, messages)
  if (pending !== null) return pending
  const ref = parseSourceRef(record.sourceRef)
  if (ref === null || ref.accountKey !== state.accountKey || ref.chatUsername !== state.chatUsername) {
    throw new Error('AI 回复记录的 sourceRef 与账号/会话不一致；已停止本会话自动扫描')
  }
  const match = messages.find((message) => message.localId === ref.localId)
  if (match === undefined) {
    // 旧状态没有 pendingCursor 时，sourceRef 只有 createTime/localId，无法可靠
    // 还原消息查询使用的 sortSeq。宁可停住并提示，也不能拿 localId 冒充 sortSeq
    // 推进水位，否则一次错误恢复就可能永久越过其它消息。
    throw new Error('AI 回复记录缺少原始消息排序键；已停止本会话自动扫描，避免错误推进水位')
  }
  const actual = anchorOf(match)
  if (actual === null
    || actual.createTime !== ref.createTime
    || sourceRefOf(state, actual) !== ref.baseSourceRef) {
    throw new Error('AI 回复记录的 sourceRef 与真实消息不一致；已停止本会话自动扫描')
  }
  return actual
}

export function afterCursor(anchor: ChatAiReplyAnchor, cursor: string): boolean {
  const v2 = /^v2:(\d+):(\d+)$/.exec(cursor)
  if (v2 !== null) {
    const sortSeq = Number(v2[1])
    const localId = Number(v2[2])
    return anchor.sortSeq > sortSeq || (anchor.sortSeq === sortSeq && anchor.localId > localId)
  }
  const legacy = /^(\d+):(\d+)$/.exec(cursor)
  if (legacy === null) return true
  const createTime = Number(legacy[1])
  const localId = Number(legacy[2])
  return anchor.createTime > createTime
    || (anchor.createTime === createTime && anchor.localId > localId)
}

function pendingLocalIdOf(state: ChatAiReplyState): number | undefined {
  const cursor = /^v2:(\d+):(\d+)$/.exec(state.pendingCursor ?? '')
  if (cursor !== null) {
    const localId = Number(cursor[2])
    if (Number.isSafeInteger(localId) && localId > 0) return localId
  }
  const ref = parseSourceRef(state.pendingSourceRef)
  return ref?.localId
}

async function recoveryAnchorLocalId(
  deps: ChatAiReplyScanDeps,
  state: ChatAiReplyState,
): Promise<number | undefined> {
  const pending = pendingLocalIdOf(state)
  if (pending !== undefined) return pending
  if (state.recordId === undefined || !isUnfinishedStage(state.stage)) return undefined
  const record = await inspectReply(deps, state.recordId)
  if (!record.found) return undefined
  return parseSourceRef(record.sourceRef)?.localId
}

/**
 * 选择本轮扫描窗口。
 *
 * - 有 pending/未完成记录：按 localId 精确取回锚点，不受“最新 80 条”限制；
 * - 正常增量：从持久化 cursor 之后取最早一批，积压超过一页也不会跳过；
 * - 旧 cursor 或依赖未注入：保留原最新窗口降级路径。
 */
export async function loadMessagesForState(
  deps: ChatAiReplyScanDeps,
  state: ChatAiReplyState,
  recoverOnly: boolean,
): Promise<ChatAiReplyScanMessage[]> {
  const anchorLocalId = await recoveryAnchorLocalId(deps, state)
  if (anchorLocalId !== undefined && deps.listMessagesAtOrBefore !== undefined) {
    return deps.listMessagesAtOrBefore(state.chatUsername, anchorLocalId, 20)
  }
  if (!recoverOnly
    && state.cursor !== ''
    && deps.listMessagesAfter !== undefined) {
    return deps.listMessagesAfter(state.chatUsername, state.cursor, SCAN_MESSAGE_LIMIT)
  }
  return deps.listMessages(state.chatUsername, SCAN_MESSAGE_LIMIT)
}

export function isUnfinishedStage(stage: ChatAiReplyStage): boolean {
  return stage === 'generating' || stage === 'saving' || stage === 'dispatching'
    || stage === 'waiting_config'
}

export async function inspectReply(
  deps: ChatAiReplyScanDeps,
  recordId: number,
): Promise<ChatAiReplyRecordSnapshot> {
  try {
    return await deps.getReply(recordId)
  } catch (e) {
    return { found: false, error: errorText(e) }
  }
}
