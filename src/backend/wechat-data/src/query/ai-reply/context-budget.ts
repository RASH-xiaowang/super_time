/**
 * AI 回复会话上下文的 token 预算装配（纯函数，不读库、不联网）。
 *
 * 输入是按时间正序整理好的结构化消息；输出既包含可直接放进提示词的对话行，
 * 也包含 `stats` 供调用方记录「为什么裁掉了旧消息」。裁剪永远从最旧的一端
 * 连续丢弃，不能为了凑条数挖洞 —— 否则模型会看到一段不连续、因果错位的对话。
 */
import { fmtDateTimeSec } from '../../format.ts'
import type { ReplyContextEntry } from '../reply-suggest.ts'

/** 单次 AI 回复请求给上下文正文（不含图片）的默认 token 预算。 */
export const AI_REPLY_INPUT_TOKEN_BUDGET = 6000
/** 无论预算多紧，都至少保留最近这么多条（最新一条永远保留）。 */
export const AI_REPLY_MIN_RECENT_ENTRIES = 8
/** 至少保留多少条对方消息，避免模型只看到自己说过的话。 */
export const AI_REPLY_MIN_PEER_ENTRIES = 4
/** 至少保留多少条「我」的消息，作为回复口吻的锚点。 */
export const AI_REPLY_MIN_SELF_ENTRIES = 2
/** 单条正文进提示词前的默认最大字符数（按 code point 计）。 */
export const AI_REPLY_MAX_LINE_CHARS = 600
/** 相邻消息间隔达到这个秒数时补一条时间标记。 */
export const AI_REPLY_MARKER_GAP_SECONDS = 30 * 60
/** 一张图片/表情在上下文预算里的保守 token 估算。 */
export const AI_REPLY_IMAGE_TOKEN_ESTIMATE = 800
/** 为满足最低条数时，正文最多允许超出预算的倍数。 */
export const AI_REPLY_BUDGET_HARD_OVERRUN = 1.35

/** 单条消息在提示词里的粗略 token 成本：前缀 + 正文 + 行开销。 */
const AI_REPLY_LINE_OVERHEAD_TOKENS = 4

/** 调用方可以按模型/场景覆盖的预算参数。 */
export interface ChatAiReplyContextBudgetOptions {
  tokenBudget?: number
  minRecent?: number
  minPeer?: number
  minSelf?: number
  maxLineChars?: number
  gapSeconds?: number
  imageCount?: number
  imageTokenEstimate?: number
  hardOverrun?: number
}

/** 预算装配的可观测结果。 */
export interface ChatAiReplyContextStats {
  /** 输入条数。 */
  collected: number
  /** 实际进入提示词的条数（不含时间标记与省略行）。 */
  included: number
  /** 被丢弃的条数；只会是窗口最旧的一段。 */
  dropped: number
  /** 最终输出所有行（含时间标记/省略行）的 token 估算 + 图片预留。 */
  estimatedTokens: number
  /** 本次生效的 token 预算。 */
  tokenBudget: number
  /** 是否在顶部加了「更早的对话已省略」。 */
  truncated: boolean
  /** 被头尾截断的条数。 */
  shortened: number
  /** 纳入的对方消息条数。 */
  peerIncluded: number
  /** 纳入的「我」的消息条数。 */
  selfIncluded: number
  /** 本次按候选数预留的图片数；实际解码成功数以调用方日志为准。 */
  imageCount: number
}

/** 装配后的上下文。 */
export interface ChatAiReplyAssembledContext {
  /** 时间正序的提示词行；可能包含时间标记与省略行。 */
  lines: string[]
  /** 只含正文行（`speaker：text`），不含时间标记与省略行；供检索等下游使用。 */
  dialogueLines: string[]
  /** 实际纳入窗口的消息 localId（升序）；图片候选必须落在这个窗口里才有意义。 */
  includedLocalIds: number[]
  stats: ChatAiReplyContextStats
}

/** 已截断、已算好成本的一条消息。 */
interface PreparedChatAiReplyEntry {
  localId: number
  createTime: number
  isSender: boolean
  speaker: string
  text: string
  shortened: boolean
  cost: number
}

/**
 * 估算一段文本的 token 数。
 *
 * 这是一个刻意保守的跨模型估算，不对齐任何一家的 tokenizer：
 *   · 非 ASCII 视觉字符（汉字、全角标点、emoji 等）按 1 token/字；
 *   · ASCII 连续字符（含空白）每 3 个约 1 token，最后向上取整。
 * 对中文为主的微信对话，这个数通常比真实 tokenizer 略高，宁可在预算上留余量；
 * 长 base64/hex/URL 仍可能被低估，因此预算只是目标值，不声称是模型窗口硬保护。
 * @param text - 待估算文本。
 * @returns 非负整数 token 估算；空串为 0。
 */
export function estimateChatAiReplyTokens(text: string): number {
  let nonAscii = 0
  let ascii = 0
  for (const char of String(text ?? '')) {
    const codePoint = char.codePointAt(0) ?? 0
    if (codePoint > 0x7f) nonAscii += 1
    else ascii += 1
  }
  return nonAscii + (ascii === 0 ? 0 : Math.ceil(ascii / 3))
}

/**
 * 把单条正文压缩到字符上限内，保留开头和结尾。
 *
 * 微信里重要的信息常在首尾（称呼、结论、问句），中段往往只是铺垫；
 * 所以超限时保留约 65% 的头部与其余尾部，用一个 `…` 连接。
 * 全部按 code point 切，避免把 emoji 的代理对劈成乱码。
 * @param text - 原始正文。
 * @param maxChars - 最大字符数，默认 {@link AI_REPLY_MAX_LINE_CHARS}。
 * @returns 压缩后的文本与是否发生截断。
 */
export function shortenChatAiReplyLine(
  text: string,
  maxChars?: number,
): { text: string; shortened: boolean } {
  const limit = positiveIntegerOption(maxChars, AI_REPLY_MAX_LINE_CHARS)
  const flattened = String(text ?? '').replace(/\s+/g, ' ').trim()
  // UTF-16 长度不超过上限 ⇒ code point 数也一定不超过；先走这条快路径，
  // 避免为每条（包括随后会被预算丢弃的）消息分配码点数组。
  if (flattened.length <= limit) return { text: flattened, shortened: false }
  const chars = Array.from(flattened)
  if (chars.length <= limit) return { text: flattened, shortened: false }

  const keep = Math.max(0, limit - 1)
  const head = Math.floor(keep * 0.65)
  const tail = keep - head
  const prefix = head > 0 ? chars.slice(0, head).join('') : ''
  const suffix = tail > 0 ? chars.slice(chars.length - tail).join('') : ''
  return { text: `${prefix}…${suffix}`, shortened: true }
}

/**
 * 按 token 预算装配会话上下文。
 *
 * 关键顺序：
 *   1. 图片先占预算；
 *   2. 最新至少 `minRecent` 条无条件保留（最新一条永远保留）；
 *   3. 预算还有余量时继续向旧扩展；
 *   4. 对方/我条数不足时，允许突破预算、在硬上限内继续向旧扩展；
 *   5. 若窗口里有「我」但一条都没纳入，硬上限内至少要捞回一条作口吻锚点；
 *   6. 输出时补时间标记和省略行，最后按实际行重新估算 token。
 * @param entries - 已按时间正序排列的消息；不会被修改。
 * @param options - 预算覆盖项；非法值回退默认值。
 * @returns 提示词行与统计。
 */
export function assembleChatAiReplyContext(
  entries: readonly ReplyContextEntry[],
  options: ChatAiReplyContextBudgetOptions = {},
): ChatAiReplyAssembledContext {
  const tokenBudget = nonNegativeIntegerOption(options.tokenBudget, AI_REPLY_INPUT_TOKEN_BUDGET)
  const minRecent = nonNegativeIntegerOption(options.minRecent, AI_REPLY_MIN_RECENT_ENTRIES)
  const minPeer = nonNegativeIntegerOption(options.minPeer, AI_REPLY_MIN_PEER_ENTRIES)
  const minSelf = nonNegativeIntegerOption(options.minSelf, AI_REPLY_MIN_SELF_ENTRIES)
  const maxLineChars = positiveIntegerOption(options.maxLineChars, AI_REPLY_MAX_LINE_CHARS)
  const gapSeconds = nonNegativeNumberOption(options.gapSeconds, AI_REPLY_MARKER_GAP_SECONDS)
  const imageCount = nonNegativeIntegerOption(options.imageCount, 0)
  const imageTokenEstimate = nonNegativeIntegerOption(
    options.imageTokenEstimate,
    AI_REPLY_IMAGE_TOKEN_ESTIMATE,
  )
  const hardOverrun = nonNegativeNumberOption(options.hardOverrun, AI_REPLY_BUDGET_HARD_OVERRUN)
  const imageTokens = imageCount * imageTokenEstimate
  const hardTokenLimit = tokenBudget * hardOverrun

  const prepared: PreparedChatAiReplyEntry[] = entries.map((entry) => {
    const speaker = String(entry.speaker ?? '')
    const shortened = shortenChatAiReplyLine(String(entry.text ?? ''), maxLineChars)
    const createTime = Number.isFinite(Number(entry.createTime))
      ? Number(entry.createTime)
      : 0
    return {
      localId: Number.isFinite(Number(entry.localId)) ? Number(entry.localId) : 0,
      createTime,
      isSender: entry.isSender === true,
      speaker,
      text: shortened.text,
      shortened: shortened.shortened,
      cost: estimateChatAiReplyTokens(`${speaker}：`) +
        estimateChatAiReplyTokens(shortened.text) +
        AI_REPLY_LINE_OVERHEAD_TOKENS,
    }
  })

  const total = prepared.length
  // 最低条数只能凑到「窗口里真的存在」的类别：纯对方会话里 self 目标为 0，
  // 否则循环会为永远凑不齐的 self 一路扩到硬上限。纯自己会话的 peer 同理。
  const totalPeer = prepared.reduce((n, item) => n + (item.isSender ? 0 : 1), 0)
  const targetPeer = Math.min(minPeer, totalPeer)
  const targetSelf = Math.min(minSelf, total - totalPeer)
  let start = total
  let textTokens = 0
  let peerIncluded = 0
  let selfIncluded = 0

  if (total > 0) {
    // 最新一条必须保留；minRecent 再在此基础上向前兜底。即使单条已超预算也照留。
    const guaranteed = Math.max(1, Math.min(total, minRecent))
    start = total - guaranteed
    for (let i = start; i < total; i += 1) {
      const item = prepared[i]
      if (item === undefined) continue
      textTokens += item.cost
      if (item.isSender) selfIncluded += 1
      else peerIncluded += 1
    }

    // 预留图片后仍有预算，才继续吸收更旧的条目。
    while (start > 0) {
      const candidate = prepared[start - 1]
      if (candidate === undefined) break
      if (imageTokens + textTokens + candidate.cost > tokenBudget) break
      start -= 1
      textTokens += candidate.cost
      if (candidate.isSender) selfIncluded += 1
      else peerIncluded += 1
    }

    // 对方/我条数不足时突破软预算，但绝不越过硬上限；图片预留同样算进硬上限，
    // 否则「正文 1.35 倍 + 图片 2400」会让总输入远超预算。
    while (start > 0 && (peerIncluded < targetPeer || selfIncluded < targetSelf)) {
      const candidate = prepared[start - 1]
      if (candidate === undefined) break
      if (imageTokens + textTokens + candidate.cost > hardTokenLimit) break
      start -= 1
      textTokens += candidate.cost
      if (candidate.isSender) selfIncluded += 1
      else peerIncluded += 1
    }

    // 风格锚点：即使调用方把 minSelf 设成 0，只要窗口里真的有「我」说过的话，
    // 也尽量在硬上限内纳入一条作口吻参考；一条「我」都没有的会话不额外扩。
    if (selfIncluded === 0 && total - totalPeer > 0) {
      while (start > 0) {
        const candidate = prepared[start - 1]
        if (candidate === undefined) break
        if (imageTokens + textTokens + candidate.cost > hardTokenLimit) break
        start -= 1
        textTokens += candidate.cost
        if (candidate.isSender) {
          selfIncluded += 1
          break
        }
        peerIncluded += 1
      }
    }
  }

  const lines: string[] = []
  const dialogueLines: string[] = []
  const includedLocalIds: number[] = []
  if (start > 0) lines.push('（更早的对话已省略）')

  let shortened = 0
  // 只记录最近一条**有效**时间：中间夹着 createTime=0 的占位消息时，
  // 后一条仍应拿到自己的时间标记，而不是静默丢掉。
  let previousTime = 0
  for (let i = start; i < total; i += 1) {
    const item = prepared[i]
    if (item === undefined) continue
    if (item.createTime > 0) {
      const needsMarker = previousTime === 0 ||
        localDayKey(item.createTime) !== localDayKey(previousTime) ||
        item.createTime - previousTime >= gapSeconds
      // 复用后端唯一的本地时间格式化，避免再写第二份月份/补零口径。
      if (needsMarker) lines.push(`[${fmtDateTimeSec(item.createTime)}]`)
      previousTime = item.createTime
    }
    const dialogue = `${item.speaker}：${item.text}`
    lines.push(dialogue)
    dialogueLines.push(dialogue)
    if (item.localId > 0) includedLocalIds.push(item.localId)
    if (item.shortened) shortened += 1
  }

  const included = total - start
  const estimatedTokens = imageTokens +
    lines.reduce((sum, line) => sum + estimateChatAiReplyTokens(line), 0)
  return {
    lines,
    dialogueLines,
    includedLocalIds,
    stats: {
      collected: total,
      included,
      dropped: total - included,
      estimatedTokens,
      tokenBudget,
      truncated: start > 0,
      shortened,
      peerIncluded,
      selfIncluded,
      imageCount,
    },
  }
}

/** 本地时区里两个时间戳是否属于同一自然日。 */
function localDayKey(seconds: number): number {
  const date = new Date(seconds * 1000)
  return date.getFullYear() * 10_000 + (date.getMonth() + 1) * 100 + date.getDate()
}

/** NaN/负数回退默认值的非负整数参数。 */
function nonNegativeIntegerOption(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback
  return Math.trunc(value)
}

/** NaN/负数回退默认值的非负浮点参数。 */
function nonNegativeNumberOption(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback
  return value
}

/** NaN/负数/0 回退默认值的正整数参数。 */
function positiveIntegerOption(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return fallback
  return Math.trunc(value)
}
