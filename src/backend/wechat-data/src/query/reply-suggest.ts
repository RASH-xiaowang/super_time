/**
 * 「推荐回复」的上下文收集（**纯数据层，不碰模型**）。
 *
 * 与 `daily-summary.ts` 的 `collectDayMessages` / `collectPeriodMessages` 同一分工：
 * 这里只负责把「该给模型看的东西」取出来，提示词与出站闸门留在 gateway ——
 * 那里是唯一的出网咽喉（见 `privacyGate` 的注释）。
 *
 * 两个来源：
 *   · 会话上下文：当前对话最近若干条（`queryMessages` 已经按时间正序返回，可直接拼）；
 *   · 知识库片段：用户**当前选中的那个库**里与「对方最近那句话」相关的块。
 */
import { queryMessages, queryMessagesAtOrBefore } from './messages.ts'
import {
  contextualMessageText,
  isVoiceMessage,
  visualKindOf,
} from './ai-reply/inbound-trigger.ts'

/** 单条消息进提示词前截断到这个长度：推荐回复只需要语义，不需要全文。 */
const MAX_LINE_CHARS = 300

/** 推荐回复固定携带的最近消息窗口；超过这个量只会稀释最后一句的回复意图。 */
export const REPLY_SUGGEST_CONTEXT_LIMIT = 60

/** `collectReplyContext` 的结果。 */
export interface ReplyContext {
  /** 按时间正序的对话行（`我：…` / `对方：…`）；空行已剔除。 */
  lines: string[]
  /** 当前窗口内可交给多模态模型的图片/表情消息定位信息。 */
  imageCandidates?: ReplyImageCandidate[]
  /** 对方最近的一条非空消息 —— 就是「要回的那句」；没有则为空串。 */
  latestPeer: string
  /** 参与拼装的条数（供隐私审计的 `messages` 计数用）。 */
  count: number
  /** 指定了目标消息时，该消息是否仍存在于当前解密快照（缺省 = 未按目标截取）。 */
  targetFound?: boolean
  /** 目标消息的发送者标签（单聊为「对方」，群聊为成员名）。 */
  targetSpeaker?: string
  /**
   * 本轮唯一需要回复的那一行。
   *
   * 会话级推荐取上下文最后一行；分析面板指定历史消息时取该消息，
   * 这样提示词不必再让模型自己猜“最后一条”是哪条。
   */
  targetLine: string
}

/** 视觉消息只暴露会话内定位键；真实图片/表情字节由上层按需解码。 */
export interface ReplyImageCandidate {
  localId: number
  /** 缺省按普通图片处理；自定义表情/表情包显式标记为 sticker。 */
  kind?: 'image' | 'sticker'
  md5?: string
  emojiUrl?: string
}

/** 一条进入模型上下文的聊天消息；正文已压平空白但**未截断**。 */
export interface ReplyContextEntry {
  localId: number
  /** 消息时间（秒）；未知为 0。 */
  createTime: number
  isSender: boolean
  /** 单聊为「我 / 对方」；群聊为成员显示名。 */
  speaker: string
  /** 已压平空白的完整展示文本（媒体消息为 [图片]/[表情] 等占位）。 */
  text: string
  /** 仅视觉消息出现：会话内定位键。 */
  image?: ReplyImageCandidate
  /** 语音消息：正文只是 `[语音]` 占位，需上层转写后再替换。 */
  voice?: true
}

/** `collectReplyContextEntries` 的结果：结构化条目 + 与 `collectReplyContext` 同源的汇总字段。 */
export interface ReplyContextEntries {
  entries: ReplyContextEntry[]
  imageCandidates?: ReplyImageCandidate[]
  /** 落到上下文里的语音消息 localId（时间正序）；上层按需转写成文本。 */
  voiceCandidates?: number[]
  latestPeer: string
  count: number
  targetFound?: boolean
  targetSpeaker?: string
  targetLine: string
}

/**
 * 取当前会话最近的对话上下文。
 * @param decryptedDir - 解密数据根。
 * @param talker - 会话 username（**范围就是它**，绝不跨会话取）。
 * @param selfUsername - 登录账号 wxid（用于标注「我」，未知时传空）。
 * @param limit - 取最近多少条（默认 60）。
 * @param targetLocalId - 只分析/回复截至这条消息的上下文；缺省时仍取会话最新一页。
 * @returns 上下文；该会话没有可用文本时 `count` 为 0。
 */
export function collectReplyContext(
  decryptedDir: string,
  /** 会话微信 ID —— 同一个概念的正名见 `WechatSession.username`（P3-6：问答链沿用库里更早的列名）。 */
  talker: string,
  selfUsername?: string,
  limit = REPLY_SUGGEST_CONTEXT_LIMIT,
  targetLocalId?: number,
): ReplyContext {
  // 取数、过滤与发言者标注都收在共享实现里；它内部仍只按 talker 走
  // queryMessages(talker, …) / queryMessagesAtOrBefore，跨会话隔离的边界不变。
  const context = collectReplyContextEntries(decryptedDir, talker, selfUsername, limit, targetLocalId)
  return {
    // 每条文本只保留头部 300 字（`messageText` 的既有口径）；entries 里的正文保持完整。
    lines: context.entries.map((entry) => `${entry.speaker}：${truncateLine(entry.text)}`),
    ...(context.imageCandidates === undefined ? {} : { imageCandidates: context.imageCandidates }),
    latestPeer: context.latestPeer,
    count: context.entries.length,
    targetLine: context.targetLine,
    ...(context.targetFound === undefined ? {} : { targetFound: context.targetFound }),
    ...(context.targetSpeaker === undefined ? {} : { targetSpeaker: context.targetSpeaker }),
  }
}

/**
 * 取当前会话最近的对话上下文（**结构化条目**版）。
 *
 * 与 `collectReplyContext` 共用同一份取数/过滤/发言者标注/图片候选规则；区别只在
 * 每条消息保留**未截断**的正文与身份字段，供上下文预算引擎自行取舍。
 * 汇总字段（`latestPeer` / `targetLine`）沿用推荐回复的既有 300 字口径。
 * @param decryptedDir - 解密数据根。
 * @param talker - 会话 username（**范围就是它**，绝不跨会话取）。
 * @param selfUsername - 登录账号 wxid（用于标注「我」，未知时传空）。
 * @param limit - 取最近多少条（默认 60）。
 * @param targetLocalId - 只分析/回复截至这条消息的上下文；缺省时仍取会话最新一页。
 * @param sinceCreateTime - 只保留这个时间点（秒）之后的消息；0/缺省表示不限。
 *   「上下文时间窗」用它实现：窗口之外的消息不进提示词，模型也就不会把几天前的
 *   旧事项当成待办反复追问。
 * @returns 结构化条目；该会话没有可用文本时 `count` 为 0。
 */
export function collectReplyContextEntries(
  decryptedDir: string,
  // talker 是 `WechatSession.username` 的别名。
  talker: string,
  selfUsername?: string,
  limit = REPLY_SUGGEST_CONTEXT_LIMIT,
  targetLocalId?: number,
  sinceCreateTime?: number,
): ReplyContextEntries {
  const cap = Math.max(1, Math.min(limit, 60))
  const since = Number.isFinite(sinceCreateTime) && Number(sinceCreateTime) > 0
    ? Math.trunc(Number(sinceCreateTime))
    : 0
  const targetId = Number.isFinite(targetLocalId) && Number(targetLocalId) > 0
    ? Math.trunc(Number(targetLocalId))
    : undefined
  // 无目标时保持原行为（最新一页）；有目标时只取截至该消息的窗口，避免历史消息
  // 被错误地拿最新一句来推荐回复。
  const snapshot = targetId === undefined
    ? queryMessages(decryptedDir, talker, cap, undefined, selfUsername)
    : queryMessagesAtOrBefore(decryptedDir, talker, targetId, cap, selfUsername)
  if (targetId !== undefined && 'found' in snapshot && !snapshot.found) {
    return { entries: [], latestPeer: '', count: 0, targetFound: false, targetLine: '' }
  }
  const entries: ReplyContextEntry[] = []
  const imageCandidates: ReplyImageCandidate[] = []
  /** 语音 localId（时间正序、去重）：上层用它决定要转写哪几条。 */
  const voiceCandidates: number[] = []
  const seenVoice = new Set<number>()
  // localId -> 候选，用于同一视觉消息重复出现时仍让 entry 拿到定位键；
  // imageCandidates 本身保持「时间正序、按 localId 去重」的既有规则。
  const visualByLocalId = new Map<number, ReplyImageCandidate>()
  let latestPeer = ''
  let latestLine = ''
  let targetSpeaker: string | undefined
  let targetText = ''
  const isGroup = talker.endsWith('@chatroom')
  for (const m of snapshot.messages) {
    // 时间窗：窗口之外的消息整条跳过（正文、图片、语音一起排除），
    // 否则模型仍会看到几天前的旧事项。
    if (since > 0 && Number(m.createTime) > 0 && Number(m.createTime) < since) continue
    // 所有对话类型都进入上下文；媒体/卡片缺少展示字段时由同一条规则合成占位。
    // 这里刻意用完整正文：截断只发生在 `collectReplyContext` 映射行时。
    const text = flattenMessageText({ ...m, displayText: contextualMessageText(m) })
    if (text === '') continue
    const voice = isVoiceMessage(m)
    if (voice && m.localId > 0 && !seenVoice.has(m.localId)) {
      seenVoice.add(m.localId)
      voiceCandidates.push(m.localId)
    }
    const visualKind = visualKindOf(m)
    let image: ReplyImageCandidate | undefined
    if (visualKind !== null && m.localId > 0) {
      image = visualByLocalId.get(m.localId)
      if (image === undefined) {
        image = {
          localId: m.localId,
          ...(visualKind === 'sticker'
            ? {
                kind: 'sticker' as const,
                ...(m.rich?.md5 ? { md5: m.rich.md5 } : {}),
                ...(m.rich?.emojiUrl ? { emojiUrl: m.rich.emojiUrl } : {}),
              }
            : {}),
        }
        visualByLocalId.set(m.localId, image)
        imageCandidates.push(image)
      }
    }
    const self = m.isSender === 1
    // 群聊必须保留发言者身份，否则模型会把不同成员揉成同一个「对方」。
    const rawSenderName = String(m.senderName ?? '').trim()
    const senderName = /^(?:未知联系人|未知成员|群成员|成员)$/.test(rawSenderName)
      ? ''
      : rawSenderName
    const speaker = self
      ? '我'
      : isGroup
        ? (senderName || m.sender || '群成员')
        : '对方'
    entries.push({
      localId: m.localId,
      createTime: Number.isFinite(m.createTime) ? m.createTime : 0,
      isSender: self,
      speaker,
      text,
      ...(image === undefined ? {} : { image }),
      ...(voice ? { voice: true as const } : {}),
    })
    // 汇总字段沿用推荐回复的既有口径：单条只保留头部 300 字。
    const lineText = truncateLine(text)
    latestLine = `${speaker}：${lineText}`
    if (m.localId === targetId) {
      targetText = lineText
      targetSpeaker = speaker
    }
    if (!self) latestPeer = lineText
  }
  if (targetText !== '') latestPeer = targetText
  const targetLine = targetText !== '' && targetSpeaker !== undefined
    ? `${targetSpeaker}：${targetText}`
    : latestLine
  return {
    entries,
    ...(imageCandidates.length === 0 ? {} : { imageCandidates }),
    ...(voiceCandidates.length === 0 ? {} : { voiceCandidates }),
    latestPeer,
    count: entries.length,
    targetLine,
    ...(targetId === undefined ? {} : { targetFound: true }),
    ...(targetSpeaker === undefined ? {} : { targetSpeaker }),
  }
}

/**
 * 拼「推荐回复」的提示词。
 *
 * 几个刻意的取舍：
 *   · **明确告诉模型几条**（`want`），并要求 JSON 数组 —— 但 `parseReplyCandidates` 仍然宽容，
 *     因为小模型未必听话；
 *   · 上下文标注「我 / 对方」，否则模型分不清是谁在问，会生成「替对方回我」的话；
 *   · 知识库片段**标注文件名**：让模型知道依据来自哪份文件，也让用户能核对（配合界面上的
 *     「知识库 N 段」说明）；
 *   · 没选库/没命中时不编造「参考资料」，直接说只有对话上下文。
 * @param lines - `collectReplyContext` 产出的对话行（时间正序）。
 * @param snippets - 知识库混合检索产出的片段。
 * @param want - 要几条候选。
 * @param targetLine - 唯一要回复的目标行；缺省时取上下文最后一行。
 * @returns 提示词全文。
 */
export function buildReplyPrompt(
  lines: readonly string[],
  snippets: readonly string[],
  want: number,
  targetLine = '',
): string {
  const target = String(targetLine).trim() || (lines[lines.length - 1] ?? '').trim()
  const parts = [
    `以下是微信聊天的最近 ${String(lines.length)} 条对话（时间正序，标注了每句是谁说的）：`,
    '',
    ...lines,
  ]
  if (snippets.length > 0) {
    parts.push('', '本轮必须结合的知识库片段（来自用户当前选中的知识库）：', ...snippets.map((s, i) => `${String(i + 1)}. ${s}`))
  } else {
    parts.push('', '（本次没有可用的知识库片段，只依据上面这段对话。）')
  }
  if (target !== '') {
    parts.push(
      '',
      `本次唯一要回复的目标消息：${target}`,
      '更早的消息只用于理解上下文和检索依据；不要逐条回复、总结或延续其中的其他话题。',
    )
  }
  parts.push(
    '',
    `请只针对上述目标消息，给出 ${String(Math.max(1, want))} 条我可以直接发送的回复候选。`,
    '要求：',
    '1) 每条独立成句，口吻自然、像我本人在微信里说话；',
    '2) 三条之间要有差异（例如：直接回答 / 反问确认 / 简短暂缓），不要互相改写；',
    '3) 结合与目标消息相关的知识库事实作答；片段无关时不要强行引用，更不要编造；',
    '4) 只输出 JSON 字符串数组，形如 ["第一条","第二条","第三条"]，不要任何解释。',
  )
  return parts.join('\n')
}

/** 把展示文本压平空白但**不截断**；空串表示该消息不该进上下文。 */
function flattenMessageText(m: { displayText?: string; strContent?: string; msgContent?: string }): string {
  const raw = String(m.displayText ?? m.strContent ?? m.msgContent ?? '').trim()
  if (raw === '') return ''
  return raw.replace(/\s+/g, ' ')
}

/** 单条文本只保留头部 `MAX_LINE_CHARS` 字符（推荐回复的既有口径）。 */
function truncateLine(flat: string): string {
  return flat.length > MAX_LINE_CHARS ? flat.slice(0, MAX_LINE_CHARS) + '…' : flat
}

/** 一条消息用于拼提示词的文本：优先展示文本，其次落回原始字段；过长截断。 */
export function messageText(m: { displayText?: string; strContent?: string; msgContent?: string }): string {
  return truncateLine(flattenMessageText(m))
}

/**
 * 把模型输出解析成候选回复列表。
 *
 * 模型（尤其小模型）不会永远规规矩矩给 JSON：常见形态有 ```json 围栏、编号列表、
 * 每行一句、或在前言后附一段 JSON。解析必须**宽容**，但也不能把解释性文字当回复 ——
 * 所以策略是「先试 JSON 数组，再退化为逐行」，并且逐条清洗：剥编号/项目符号/引号，
 * 丢掉过短或明显是说明文字的行（以「好的」「以下是」这类开场）。
 * @param raw - 模型返回的原始文本。
 * @param want - 最多要几条。
 * @returns 清洗后的候选（可能少于 `want`，也可能为空 —— 空即「这次没产出」）。
 */
export function parseReplyCandidates(raw: string, want = 3): string[] {
  const text = String(raw ?? '').trim()
  if (text === '') return []
  const out: string[] = []

  // ① JSON 数组（含 ```json 围栏、或正文里夹着一段数组）
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const jsonText = (fenced?.[1] ?? text).trim()
  const bracket = /\[[\s\S]*\]/.exec(jsonText)
  if (bracket) {
    try {
      const arr = JSON.parse(bracket[0]) as unknown
      if (Array.isArray(arr)) {
        for (const item of arr) {
          const s = typeof item === 'string'
            ? item
            : (item && typeof item === 'object' ? String((item as { text?: unknown; reply?: unknown }).text ?? (item as { reply?: unknown }).reply ?? '') : '')
          const clean = cleanLine(s)
          if (clean !== '') out.push(clean)
        }
      }
    } catch { /* 不是合法 JSON：落到逐行解析 */ }
  }

  // ② 逐行兜底（编号列表 / 每行一句）
  if (out.length === 0) {
    for (const line of text.split(/\r?\n/)) {
      const clean = cleanLine(line)
      if (clean !== '') out.push(clean)
    }
  }

  return dedupe(out).slice(0, Math.max(1, want))
}

/** 逐条清洗：剥围栏/编号/项目符号/成对引号，丢掉开场白与过短的碎片。 */
function cleanLine(input: string): string {
  let s = String(input ?? '').trim()
  s = s.replace(/^```[a-z]*\s*/i, '').replace(/```$/, '').trim()
  s = s.replace(/^(?:[-*•]|\d+[.、)]|[(（]\d+[)）])\s*/, '').trim()
  s = s.replace(/^["'“”‘’「『]+/, '').replace(/["'“”‘’」』]+$/, '').trim()
  if (s === '') return ''
  // 开场白/解释性文字不是回复：它们通常是「好的，以下是…」「以下是 3 条…」这种句子。
  if (/^(好的|好[，,]|以下是|下面是|当然|没问题[，,])/.test(s) && /[:：]/.test(s)) return ''
  if (/^[\[{]/.test(s) && /[\]}]$/.test(s)) return ''   // JSON 残片
  // 注意别按「长度 ≥ 2」过滤：中文里「好」「嗯」「行」都是完整回复。
  if (s === '') return ''
  return s
}

/** 去重（模型偶尔把同一句写两遍），保持原顺序。 */
function dedupe(list: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const x of list) {
    if (seen.has(x)) continue
    seen.add(x)
    out.push(x)
  }
  return out
}
