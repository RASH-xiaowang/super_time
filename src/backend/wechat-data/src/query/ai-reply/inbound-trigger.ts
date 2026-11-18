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
  /** 转账金额（`￥100.00`）或红包金额（已去掉货币符号）。 */
  amount?: string
  /** 视频 / 通话时长（秒）。 */
  durationSec?: number
  /** 语音时长（毫秒）。 */
  durationMs?: number
  /** 通话结局原文，例如「已拒绝」「通话时长 00:21」。 */
  status?: string
  /** 通话类型：语音 / 视频。 */
  voipType?: string
  /** 引用消息的原发言人显示名。 */
  referName?: string
  /** 通话是否接通（其它设备接听也算接通）。 */
  connected?: boolean
}

export interface InboundMessageLike {
  type?: number
  renderType?: string
  displayText?: string
  strContent?: string
  msgContent?: string
  isSender?: number
  /**
   * **群聊专用**：这条消息是否 @ 了登录账号。
   *
   * 由消息读取边界（`remotes/chat-ai-reply.ts`）按 `source` 列的解构化
   * `atuserlist` 计算后注入，不在这里猜正文里的 `@昵称`（昵称可改、重名、
   * 正文普通 @ 都会误判）。单聊消息不带这个字段 ⇒ 不施加任何限制。
   */
  mentionSelf?: boolean
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
  const base = messageDisplayText(message)
  return kind === undefined ? base : enrichForContext(kind, message.rich, base)
}

/** 时长展示：60 秒以上折成分秒，未知返回空串。 */
function durationText(rich: InboundMessageRich | undefined): string {
  const raw = Number(rich?.durationSec ?? 0)
  const sec = Number.isFinite(raw) && raw > 0
    ? raw
    : Number(rich?.durationMs ?? 0) > 0 ? Number(rich?.durationMs) / 1000 : 0
  if (!Number.isFinite(sec) || sec <= 0) return ''
  const total = Math.max(1, Math.round(sec))
  return total >= 60 ? `${String(Math.floor(total / 60))}分${String(total % 60)}秒` : `${String(total)}秒`
}

/**
 * 给「只有占位符」的消息补上模型真正需要的细节。
 *
 * 微信的卡片类消息在库里只存 XML，`displayText` 往往是裸的 `[转账]`、`[引用]`，
 * 模型看不出转了多少钱、引用了谁说的什么。这里只**增强进上下文的文本**，
 * 界面上的气泡文案（`displayText`）保持原样 —— 那是渲染层与导出共用的口径。
 */
function enrichForContext(
  kind: RenderKind,
  rich: InboundMessageRich | undefined,
  base: string,
): string {
  const desc = String(rich?.desc ?? '').trim()
  switch (kind) {
    case 'transfer': {
      // 转账：金额在 title（`￥100.00`），备注在 desc。
      const amount = String(rich?.title ?? '').trim()
      if (amount === '' && desc === '') return base
      return `[转账${amount === '' ? '' : ' ' + amount}]${desc === '' ? '' : ' ' + desc}`
    }
    case 'redpacket': {
      // 红包：金额在 amount（已去货币符号），祝福语在 desc。
      const amount = String(rich?.amount ?? '').trim()
      const head = amount === '' ? '[红包]' : `[红包 ${amount}]`
      return desc === '' ? head : `${head} ${desc}`
    }
    case 'quote': {
      // 引用：title 是「我」的回复，desc 是被引用的那句；缺了后半截模型会答非所问。
      const reply = String(rich?.title ?? '').trim()
      if (desc === '') return base
      const who = String(rich?.referName ?? '').trim()
      const quoted = who === '' ? desc : `${who}：${desc}`
      return reply === '' ? `[引用 ${quoted}]` : `[引用 ${quoted}] ${reply}`
    }
    case 'video': {
      const dur = durationText(rich)
      return dur === '' ? base : `[视频 ${dur}]`
    }
    case 'voip': {
      const status = String(rich?.status ?? '').trim()
      const voipType = String(rich?.voipType ?? '').trim()
      if (status === '' && voipType === '') return base
      const label = voipType === 'video' ? '视频通话' : voipType === 'voice' ? '语音通话' : '通话'
      return status === '' ? `[${label}]` : `[${label}] ${status}`
    }
    case 'location': {
      const name = String(rich?.title ?? '').trim()
      const head = name === '' ? '[位置]' : `[位置] ${name}`
      return desc === '' || name.includes(desc) ? head : `${head}（${desc}）`
    }
    case 'voice': {
      const dur = durationText(rich)
      return dur === '' ? base : `[语音 ${dur}]`
    }
    default:
      return base
  }
}

/**
 * 对方发来的、可自动回复的消息。
 *
 * 自己的消息永远不是锚点。群聊额外要求 **@我**：`mentionSelf` 由读取边界注入，
 * 未注入（单聊）时不做限制 —— 这样纯函数不需要知道登录账号是谁。
 * @param message - 待判定的消息。
 * @returns 是否可作为自动回复的锚点。
 */
export function isInboundReplyTrigger(message: InboundMessageLike): boolean {
  if (message.isSender === 1) return false
  if (contextualMessageText(message) === '') return false
  return message.mentionSelf !== false
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

/**
 * 是否语音消息。语音要先用本地 whisper 转成文字再进上下文，
 * 否则模型只看到 `[语音]` 这个占位符，等于少了一整条对话。
 */
export function isVoiceMessage(message: InboundMessageLike): boolean {
  if (renderKindOf(message) === 'voice') return true
  return message.type === 34
}
