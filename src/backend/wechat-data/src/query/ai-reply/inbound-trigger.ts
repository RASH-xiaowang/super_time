/**
 * AI 回复的入站消息判定与稳定占位文本。
 *
 * 触发扫描、启用时的水位计算和上下文收集必须共用这一份规则，否则很容易出现
 * 「扫描能看到消息、上下文却把它丢掉」或相反的分叉。实际会话消息都可触发，
 * 只有系统、撤回、空消息、未知/不支持类型和拍一拍等非对话事件被排除。
 */
import {
  RENDER_LABEL,
  RICH_TO_RENDER,
  TYPE_TO_RENDER,
  richPlaceholder,
  type RenderKind,
} from '../parse.ts'

export interface InboundMessageRich {
  type?: string
  title?: string
  nickname?: string
  desc?: string
  md5?: string
  emojiUrl?: string
}

export interface InboundMessageLike {
  type?: number
  renderType?: string
  displayText?: string
  strContent?: string
  msgContent?: string
  isSender?: number
  rich?: InboundMessageRich
}

/** 这些不是可供自然回复的对话内容。 */
const NON_REPLY_RENDER_TYPES = new Set<string>([
  'system',
  'revoke',
  'empty',
  'unknown',
  'unsupported',
  'pat',
])

const RENDER_ALIASES: Record<string, RenderKind> = {
  chatHistory: 'chatlog',
  redPacket: 'redpacket',
  call: 'voip',
  contact: 'contactCard',
  newsfeed: 'link',
  appmsg: 'link',
}

function normalizedRenderKind(value: string | undefined): RenderKind | undefined {
  const text = String(value ?? '').trim()
  if (text === '') return undefined
  if (text in RENDER_LABEL) return text as RenderKind
  return RENDER_ALIASES[text]
}

/** 将新快照的 renderType、rich.type 和旧快照的 local_type 归一成同一分类。 */
export function renderKindOf(message: InboundMessageLike): RenderKind | undefined {
  const direct = normalizedRenderKind(message.renderType)
  if (direct !== undefined) return direct
  const richType = String(message.rich?.type ?? '').trim()
  const fromRich = RICH_TO_RENDER[richType]
  if (fromRich !== undefined) return fromRich
  return TYPE_TO_RENDER[Number(message.type)]
}

function rawTextOf(message: InboundMessageLike): string {
  return String(message.displayText ?? message.strContent ?? message.msgContent ?? '').trim()
}

/**
 * 返回适合交给模型的稳定文本。
 *
 * 文本类直接使用正文；媒体与卡片消息在旧快照缺少 displayText 时按 rich/type
 * 合成 `[图片]`、`[语音]`、`[文件 合同.pdf]` 等占位，不能因为展示字段为空就
 * 让整条消息失去触发资格。
 */
export function messageDisplayText(message: InboundMessageLike): string {
  const raw = rawTextOf(message)
  if (raw !== '') return raw
  if (message.rich !== undefined && typeof message.rich.type === 'string') {
    const placeholder = richPlaceholder({
      type: message.rich.type,
      ...(message.rich.title === undefined ? {} : { title: message.rich.title }),
      ...(message.rich.nickname === undefined ? {} : { nickname: message.rich.nickname }),
      ...(message.rich.desc === undefined ? {} : { desc: message.rich.desc }),
    }).trim()
    if (placeholder !== '') return placeholder
  }
  const kind = renderKindOf(message)
  if (kind === undefined) return ''
  if (kind === 'text') return ''
  return `[${RENDER_LABEL[kind]}]`
}

/** 可放进会话上下文的文本；系统/撤回等事件返回空串。 */
export function contextualMessageText(message: InboundMessageLike): string {
  const renderType = String(message.renderType ?? '').trim()
  const key = String(
    renderType in RENDER_ALIASES ? RENDER_ALIASES[renderType] ?? renderType : renderType,
  )
  if (NON_REPLY_RENDER_TYPES.has(key)) return ''
  const kind = renderKindOf(message)
  if (kind !== undefined && NON_REPLY_RENDER_TYPES.has(kind)) return ''
  return messageDisplayText(message)
}

/** 对方发来的、可自动回复的消息。自己的消息永远不作为触发锚点。 */
export function isInboundReplyTrigger(message: InboundMessageLike): boolean {
  return message.isSender !== 1 && contextualMessageText(message) !== ''
}

/** 图片与自定义表情都会作为视觉内容进入模型。 */
export function visualKindOf(message: InboundMessageLike): 'image' | 'sticker' | null {
  const kind = renderKindOf(message)
  if (kind === 'image' || (kind === undefined && message.type === 3)) return 'image'
  if (kind === 'emoji' || kind === 'sticker' || (kind === undefined && message.type === 47)) {
    return 'sticker'
  }
  return null
}
