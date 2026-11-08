/**
 * AI 回复的分段规划与 sourceRef 编码。
 *
 * 模型只调用一次，返回完整回复；本模块负责把完整回复按语义切成多条可独立
 * 发送的微信消息。每段的 sourceRef 都从同一条入站消息派生，第一段沿用基础
 * sourceRef，后续段追加 `:segment:<index>`，因此仍受消息列表唯一索引保护。
 */
import { FEATHER_MESSAGE_MAX_UTF16 } from '../message-list-store-shared.ts'

export const CHAT_AI_REPLY_SEGMENT_MAX_UTF16 = 25
export const CHAT_AI_REPLY_TEXT_MAX = 4000
export const CHAT_AI_REPLY_MAX_SEGMENTS = 50

export interface ChatAiReplySourceRefParts {
  accountKey: string
  chatUsername: string
  createTime: number
  localId: number
  /** 第一条为 1；后续分段从 2 开始。 */
  segmentIndex: number
  /** 去掉可选 `:segment:<n>` 后的基础幂等键。 */
  baseSourceRef: string
}

const AI_REPLY_SOURCE_REF_RE =
  /^ai-reply:([^:]+):([^:]+):(\d+):(\d+)(?::segment:(\d+))?$/

const DISALLOWED_SEGMENT_END_RE = /[。，、；：,.…;:]$/

export function parseChatAiReplySourceRef(
  value: string | undefined,
): ChatAiReplySourceRefParts | null {
  if (value === undefined || value === '') return null
  const match = AI_REPLY_SOURCE_REF_RE.exec(value)
  if (match === null) return null
  const accountKey = match[1] ?? ''
  const chatUsername = match[2] ?? ''
  const createTime = Number(match[3] ?? '')
  const localId = Number(match[4] ?? '')
  const segmentIndex = match[5] === undefined ? 1 : Number(match[5])
  if (
    accountKey === ''
    || chatUsername === ''
    || !Number.isSafeInteger(createTime)
    || createTime < 0
    || !Number.isSafeInteger(localId)
    || localId <= 0
    || !Number.isSafeInteger(segmentIndex)
    || segmentIndex <= 0
  ) {
    return null
  }
  return {
    accountKey,
    chatUsername,
    createTime,
    localId,
    segmentIndex,
    baseSourceRef: 'ai-reply:' + accountKey + ':' + chatUsername
      + ':' + String(createTime) + ':' + String(localId),
  }
}

export function chatAiReplySegmentSourceRef(baseSourceRef: string, segmentIndex: number): string {
  const index = Math.trunc(segmentIndex)
  if (index <= 1) return baseSourceRef
  return baseSourceRef + ':segment:' + String(index)
}

/**
 * 优先按空行分段，再按句末标点、次级标点和 UTF-16 安全硬切逐级降级。
 * 每段长度不超过 cap，且不会把 emoji 的代理对拆开。
 */
export function splitChatAiReplyText(
  text: string,
  limit = CHAT_AI_REPLY_SEGMENT_MAX_UTF16,
): string[] {
  const trimmed = text.trim()
  if (trimmed === '') return []
  const cap = Math.min(
    FEATHER_MESSAGE_MAX_UTF16,
    Math.max(1, Math.trunc(limit) || CHAT_AI_REPLY_SEGMENT_MAX_UTF16),
  )
  if (trimmed.length <= cap) return nonEmptySegments([trimmed])

  const out: string[] = []
  for (const paragraph of trimmed.split(/\n\s*\n/)) {
    const value = paragraph.trim()
    if (value === '') continue
    if (value.length <= cap) {
      out.push(value)
      continue
    }

    let buffer = ''
    for (const sentence of value.split(/(?<=[。！？；!?;])/)) {
      const next = sentence.trim()
      if (next === '') continue
      if (buffer !== '' && buffer.length + next.length > cap) {
        out.push(buffer)
        buffer = ''
      }
      if (next.length > cap) {
        if (buffer !== '') {
          out.push(buffer)
          buffer = ''
        }
        out.push(...hardSplit(next, cap))
        continue
      }
      buffer += next
    }
    if (buffer !== '') out.push(buffer)
  }
  const normalized = nonEmptySegments(out)
  return normalized.length > 0 ? normalized : nonEmptySegments([trimmed])
}

/**
 * 消息气泡结尾只保留问号/感叹号；逗号、句号、分号等仅作为句中分隔。
 * 仅清洗分段末尾，不影响正文内部标点。
 */
function cleanSegmentEnd(value: string): string {
  let text = value.trimEnd()
  while (DISALLOWED_SEGMENT_END_RE.test(text)) {
    text = text.slice(0, -1).trimEnd()
  }
  return text
}

function nonEmptySegments(values: string[]): string[] {
  return values
    .map(cleanSegmentEnd)
    .filter((value) => value !== '')
}

function hardSplit(value: string, cap: number): string[] {
  const out: string[] = []
  let rest = value
  while (rest.length > cap) {
    const safeLimit = utf16SafeCutIndex(rest, cap)
    const window = rest.slice(0, Math.max(1, safeLimit))
    const secondary = /[，、：；,;:][^，、：；,;:]*$/.exec(window)
    const secondaryCut = secondary !== null
      && secondary.index + 1 >= Math.floor(cap / 2)
      ? secondary.index + 1
      : -1
    const cut = secondaryCut > 0 ? Math.min(secondaryCut, safeLimit) : safeLimit
    out.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest !== '') out.push(rest)
  return out.filter((part) => part !== '')
}

function utf16SafeCutIndex(value: string, maxUnits: number): number {
  let units = 0
  let index = 0
  for (const character of value) {
    if (units + character.length > maxUnits) break
    units += character.length
    index += character.length
  }
  if (index > 0) return index
  // 单码点本身已超过上限时宁可让该段略长，也不能留下孤立代理项。
  return Array.from(value)[0]?.length ?? 1
}
