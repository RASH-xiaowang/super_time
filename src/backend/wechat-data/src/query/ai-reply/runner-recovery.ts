/**
 * AI 回复的锚点、游标与恢复窗口。
 *
 * 这里只处理消息身份和扫描窗口，不读设置、不拿租约、不出网。把 sourceRef
 * 解析、pending 锚点校验和最新未处理消息选择放在同一层，便于恢复路径共享
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
import {
  contextualMessageText,
  isInboundReplyTrigger,
} from './inbound-trigger.ts'

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

function messagePosition(
  message: ChatAiReplyScanMessage,
): { sortSeq: number; localId: number } | null {
  const localId = Number(message.localId)
  const sortSeq = Number(message.sortSeq ?? message.localId)
  if (!Number.isSafeInteger(localId) || localId <= 0
    || !Number.isSafeInteger(sortSeq) || sortSeq < 0) {
    return null
  }
  return { sortSeq, localId }
}

export function messageAfterAnchor(
  message: ChatAiReplyScanMessage,
  anchor: ChatAiReplyAnchor,
): boolean {
  const position = messagePosition(message)
  if (position === null) return false
  return position.sortSeq > anchor.sortSeq
    || (position.sortSeq === anchor.sortSeq && position.localId > anchor.localId)
}

/** 自己发出的可读消息表示这一轮已经有人回答，系统事件不算。 */
export function isVisibleConversationMessage(message: ChatAiReplyScanMessage): boolean {
  return message.isSender === 1
    ? contextualMessageText(message) !== ''
    : isInboundReplyTrigger(message)
}

function compareMessagePosition(
  a: ChatAiReplyScanMessage,
  b: ChatAiReplyScanMessage,
): number {
  const left = messagePosition(a)
  const right = messagePosition(b)
  if (left === null || right === null) return 0
  return left.sortSeq - right.sortSeq || left.localId - right.localId
}

/** 会话中最后一条可视消息；用于判断当前是否轮到对方、需要自动回复。 */
export function latestVisibleMessage(
  messages: readonly ChatAiReplyScanMessage[],
): ChatAiReplyScanMessage | undefined {
  return messages
    .filter(isVisibleConversationMessage)
    .sort(compareMessagePosition)
    .at(-1)
}

/** 只选择游标之后最新的一条对方消息，把同一轮连续消息合并成一次回复。 */
export function latestInboundAfterCursor(
  messages: readonly ChatAiReplyScanMessage[],
  cursor: string,
): ChatAiReplyAnchor | undefined {
  return messages
    .filter(isInboundReplyTrigger)
    .map(anchorOf)
    .filter((anchor): anchor is ChatAiReplyAnchor => anchor !== null)
    .filter((anchor) => afterCursor(anchor, cursor))
    .sort((a, b) => a.sortSeq - b.sortSeq || a.localId - b.localId)
    .at(-1)
}

/** 供初始化水位使用；自己或对方的消息都可以作为“已看到这里”的位置。 */
export function cursorOfMessage(message: ChatAiReplyScanMessage): string | undefined {
  const position = messagePosition(message)
  if (position === null) return undefined
  return 'v2:' + String(position.sortSeq) + ':' + String(position.localId)
}

/**
 * 会话最新一条具有稳定排序键的消息位置。
 *
 * 初始化水位不能只找“最新入站消息”：如果最新 80 条里恰好没有对方消息，
 * cursor 会退成 0:0，之后窗口滚动到历史入站消息时就可能把旧问题再答一遍。
 * 系统事件也是会话已推进的事实，同样可以作为水位，只是不触发回复。
 */
export function latestMessageCursor(
  messages: readonly ChatAiReplyScanMessage[],
): string | undefined {
  let latest: ChatAiReplyScanMessage | undefined
  for (const message of messages) {
    if (messagePosition(message) === null) continue
    if (latest === undefined || compareMessagePosition(message, latest) > 0) latest = message
  }
  return latest === undefined ? undefined : cursorOfMessage(latest)
}

/**
 * 会话是否已经越过指定锚点。
 *
 * 恢复不能只看 pending 自身：如果对方又发了新消息，或用户/其它链路已经手工
 * 回复，再补发旧问题的答案就会造成“总是回复上一次的问题”。任一方出现新的
 * 可视消息都视为本轮已经过时；系统事件不计入。
 */
export async function conversationProgressedAfter(
  deps: ChatAiReplyScanDeps,
  state: ChatAiReplyState,
  anchor: ChatAiReplyAnchor,
  messages: readonly ChatAiReplyScanMessage[] = [],
): Promise<boolean> {
  const progressed = (message: ChatAiReplyScanMessage): boolean =>
    isVisibleConversationMessage(message) && messageAfterAnchor(message, anchor)
  if (messages.some(progressed)) return true
  if (deps.listMessagesAfter === undefined) return false
  // 发送前复核必须 fail-closed：读不到新消息时不能假定“会话没前进”，否则
  // 一次数据库抖动就可能把旧问题重新发出去。调用方负责暂缓本轮并保留 pending。
  const newer = await deps.listMessagesAfter(
    state.chatUsername,
    cursorOf(anchor),
    SCAN_MESSAGE_LIMIT,
  )
  if (newer.some(progressed)) return true
  // “游标后最早 80 条”可能全是系统事件；再核一次最新页，避免新问题被
  // 大量系统事件挤在 80 条之外而漏判。
  const latestWindow = await deps.listMessages(state.chatUsername, SCAN_MESSAGE_LIMIT)
  return latestWindow.some(progressed)
}

/** 合并“游标之后”和“最新一页”两个窗口，确保真正最新的消息不会被分页遮住。 */
export function mergeMessageWindows(
  ...windows: ReadonlyArray<readonly ChatAiReplyScanMessage[]>
): ChatAiReplyScanMessage[] {
  const byLocalId = new Map<number, ChatAiReplyScanMessage>()
  for (const window of windows) {
    for (const message of window) {
      const position = messagePosition(message)
      if (position !== null) byLocalId.set(position.localId, message)
    }
  }
  return [...byLocalId.values()].sort(compareMessagePosition)
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
 * - 正常增量：游标之后的消息与最新一页合并，合并后只选最新一条对方消息；
 *   积压不会被分页遮住，也不会逐条补答旧消息；
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
    const afterCursorMessages = await deps.listMessagesAfter(
      state.chatUsername,
      state.cursor,
      SCAN_MESSAGE_LIMIT,
    )
    const latestWindow = await deps.listMessages(state.chatUsername, SCAN_MESSAGE_LIMIT)
    return mergeMessageWindows(afterCursorMessages, latestWindow)
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
