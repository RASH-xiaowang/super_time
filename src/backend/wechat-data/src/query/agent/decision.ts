/**
 * 调研报告里可以在本机算完的决策。
 *
 * 这里没有数据库、也没有出网。AI 回复发送前、记忆写入、主动提案和工具审批
 * 都先问这些纯函数，避免每一层各写一套门槛。
 *
 * @module query/agent/decision
 */

export type OutboundAction = 'send' | 'hold' | 'defer' | 'drop'

export interface OutboundFacts {
  killed: boolean
  /** `HH:MM`，空串表示没有静默时段。 */
  quietStart: string
  quietEnd: string
  hour: number
  minute: number
  cooldownMs: number
  lastSentAt: number
  nowMs: number
  hourCount: number
  hourCap: number
  dayCount: number
  dayCap: number
  group: boolean
  kbEnabled: boolean
  /** 主动外发，而不是对方刚发来的消息。 */
  proactive: boolean
  /** 影子模式：只记录决策，不把主动消息送出本机。 */
  shadow: boolean
  /** 收件人就是使用者本人（例如文件传输助手）。 */
  recipientIsSelf: boolean
  /** 触发来自本机可信日程，而不是聊天正文。 */
  triggerTrusted: boolean
  channel: 'feather-webhook' | 'feather-text' | 'generic'
  hasAttachment: boolean
  /** 用户点了转人工，自动回复先停。 */
  handoff: boolean
}

export interface OutboundDecision {
  action: OutboundAction
  reasonCode: string
  reason: string
}

const MINUTE = 60_000

function clockMinutes(hour: number, minute: number): number {
  return Math.max(0, Math.min(23, Math.trunc(hour))) * 60
    + Math.max(0, Math.min(59, Math.trunc(minute)))
}

/** `HH:MM` → 当天分钟；非法返回 null。 */
export function parseClock(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (match === null) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return null
  return hour * 60 + minute
}

/** 静默时段可跨午夜。起止相同或有一端非法时视为未设置。 */
export function inQuietHours(start: string, end: string, hour: number, minute: number): boolean {
  const from = parseClock(start)
  const to = parseClock(end)
  if (from === null || to === null || from === to) return false
  const now = clockMinutes(hour, minute)
  return from < to ? now >= from && now < to : now >= from || now < to
}

/**
 * 发送前的资格闸。
 *
 * 顺序固定：紧急停止、静默、冷却、配额，然后才是「能不能自动发出去」。
 * 群聊同时使用知识库，或主动消息不是「可信触发 + 只发给本人」，都改成草稿。
 */
export function evaluateOutbound(facts: OutboundFacts): OutboundDecision {
  if (facts.killed) {
    return { action: 'defer', reasonCode: 'kill_switch', reason: 'AI 队友已紧急停止，本轮先不发送' }
  }
  if (facts.handoff) {
    return { action: 'defer', reasonCode: 'handoff', reason: '已转人工，自动回复暂停' }
  }
  if (inQuietHours(facts.quietStart, facts.quietEnd, facts.hour, facts.minute)) {
    return { action: 'defer', reasonCode: 'quiet_hours', reason: '当前在静默时段，等时段结束后再处理' }
  }
  if (facts.cooldownMs > 0 && facts.lastSentAt > 0 && facts.nowMs - facts.lastSentAt < facts.cooldownMs) {
    return { action: 'defer', reasonCode: 'cooldown', reason: '距上一条自动回复太近，先等冷却结束' }
  }
  if (facts.hourCap > 0 && facts.hourCount >= facts.hourCap) {
    return { action: 'defer', reasonCode: 'hour_budget', reason: '这一小时的自动回复额度已用完' }
  }
  if (facts.dayCap > 0 && facts.dayCount >= facts.dayCap) {
    return { action: 'defer', reasonCode: 'day_budget', reason: '今天的自动回复额度已用完' }
  }
  if (facts.channel === 'feather-text' && facts.hasAttachment) {
    return {
      action: 'hold',
      reasonCode: 'capability',
      reason: '这条地址是 /send/text。附件请改用 /webhook/<token> 的 attachments 字段再发',
    }
  }
  if (facts.proactive) {
    if (facts.shadow || !facts.triggerTrusted || !facts.recipientIsSelf) {
      return {
        action: 'hold',
        reasonCode: 'draft_first',
        reason: '主动消息默认先草稿。只有可信日程并且收件人是本人时，才允许直接发',
      }
    }
  }
  if (facts.group && facts.kbEnabled) {
    return {
      action: 'hold',
      reasonCode: 'rule_of_two',
      reason: '群聊回复用了知识库，不能在无人确认时发到群里',
    }
  }
  return { action: 'send', reasonCode: 'allowed', reason: '允许发送' }
}

export interface ChannelCapability {
  id: string
  text: boolean
  image: boolean
  buttons: boolean
  editSent: boolean
  readReceipt: boolean
  groupMention: boolean
  stream: boolean
  /** 发送不走公众号客服窗口，走 Webhook 的 target/message。 */
  serviceWindow: 'none'
  maxUtf16: number
}

export const CHANNELS: Readonly<Record<OutboundFacts['channel'], ChannelCapability>> = {
  'feather-webhook': {
    id: 'feather-webhook',
    text: true,
    image: true,
    buttons: false,
    editSent: false,
    readReceipt: false,
    groupMention: true,
    stream: false,
    serviceWindow: 'none',
    maxUtf16: 511,
  },
  'feather-text': {
    id: 'feather-text',
    text: true,
    image: false,
    buttons: false,
    editSent: false,
    readReceipt: false,
    groupMention: false,
    stream: false,
    serviceWindow: 'none',
    maxUtf16: 511,
  },
  generic: {
    id: 'generic',
    text: true,
    image: true,
    buttons: false,
    editSent: false,
    readReceipt: false,
    groupMention: false,
    stream: false,
    serviceWindow: 'none',
    maxUtf16: 4000,
  },
}

/** Webhook 发送不看客服会话窗口。文本、附件和群 @ 都按这套地址发。 */
export function serviceWindowOpen(channel: OutboundFacts['channel']): { open: boolean; reason: string } {
  const caps = CHANNELS[channel]
  return {
    open: caps.serviceWindow === 'none',
    reason: '发送使用 Webhook：文本、附件、群成员 @ 和任务查询',
  }
}

/** 渠道做不到卡片时，降成纯文本。 */
export function degradeToText(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
    .trim()
}

export type MemoryOp = 'ADD' | 'UPDATE' | 'DELETE' | 'NOOP'

export interface MemoryFact {
  id: number
  scope: 'user' | 'conversation'
  scopeKey: string
  kind: 'semantic' | 'episode' | 'profile' | 'relation' | 'promise'
  text: string
  status: 'active' | 'disputed' | 'deleted'
}

export interface MemoryPlan {
  op: MemoryOp
  status: MemoryFact['status']
  text: string
  /** 冲突时不覆盖旧事实，调用方要把它标成 disputed。 */
  disputeId?: number
}

export function normalizeMemoryText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 500)
}

/**
 * 记忆写入准入。相同正文不重复记；新旧事实打架时两份都留，并标 disputed。
 */
export function planMemoryWrite(
  existing: readonly MemoryFact[],
  incoming: { scope: MemoryFact['scope']; scopeKey: string; kind: MemoryFact['kind']; text: string; replaceId?: number },
): MemoryPlan {
  const text = normalizeMemoryText(incoming.text)
  if (text === '') return { op: 'NOOP', status: 'active', text: '' }
  if (incoming.replaceId !== undefined) {
    const target = existing.find((fact) => fact.id === incoming.replaceId && fact.status !== 'deleted')
    if (target === undefined) return { op: 'NOOP', status: 'active', text }
    if (normalizeMemoryText(target.text) === text) return { op: 'NOOP', status: target.status, text }
    return { op: 'UPDATE', status: 'active', text }
  }
  const sameScope = existing.filter((fact) =>
    fact.status !== 'deleted'
    && fact.scope === incoming.scope
    && fact.scopeKey === incoming.scopeKey
    && fact.kind === incoming.kind)
  if (sameScope.some((fact) => normalizeMemoryText(fact.text) === text)) {
    return { op: 'NOOP', status: 'active', text }
  }
  const conflict = sameScope.find((fact) => fact.status === 'active')
  if (conflict !== undefined) {
    return { op: 'ADD', status: 'disputed', text, disputeId: conflict.id }
  }
  return { op: 'ADD', status: 'active', text }
}

export type ProposalDecision = 'send' | 'digest' | 'hold' | 'drop'

export interface ProposalInput {
  duplicate: boolean
  killed: boolean
  quiet: boolean
  nothingHappened: boolean
  needProb: number
  value: number
  acceptProb: number
  interruptCost: number
  ignoreCost: number
  computeCost: number
  ageHours: number
  decay: number
  threshold: number
  confidence: number
  hourCount: number
  hourCap: number
  shadow: boolean
  triggerTrusted: boolean
  recipientIsSelf: boolean
}

export interface ProposalResult {
  decision: ProposalDecision
  reasonCode: string
  score: number
}

/** 报告里的期望效用。低于门槛就不要推进聊天主线程。 */
export function expectedUtility(input: Pick<
  ProposalInput,
  'needProb' | 'value' | 'acceptProb' | 'interruptCost' | 'ignoreCost' | 'computeCost' | 'ageHours' | 'decay'
>): number {
  const raw = input.needProb * input.value
    - (input.acceptProb * input.interruptCost + (1 - input.acceptProb) * input.ignoreCost)
    - input.computeCost
  const decay = Math.exp(-Math.max(0, input.decay) * Math.max(0, input.ageHours))
  return raw * decay
}

/**
 * 主动消息的三道闸：资格、价值、预算。
 * 影子模式和「不是发给本人的可信日程」把 send 降成 hold，调用方不得据此出网。
 */
export function decideProposal(input: ProposalInput): ProposalResult {
  const score = expectedUtility(input)
  if (input.nothingHappened) {
    return { decision: 'drop', reasonCode: 'nothing_happened', score }
  }
  if (input.duplicate) return { decision: 'drop', reasonCode: 'duplicate_event', score }
  if (input.killed || input.quiet) return { decision: 'drop', reasonCode: 'ineligible', score }
  if (input.hourCap > 0 && input.hourCount >= input.hourCap) {
    return { decision: 'digest', reasonCode: 'budget', score }
  }
  if (input.confidence < 0.5 || score <= input.threshold) {
    return { decision: 'hold', reasonCode: 'low_value', score }
  }
  const maySend = input.triggerTrusted && input.recipientIsSelf && !input.shadow
  if (!maySend) return { decision: 'hold', reasonCode: 'draft_first', score }
  return { decision: 'send', reasonCode: 'allowed', score }
}

export type MisfirePolicy = 'skip' | 'run_once'

/** 日报错过就跳过；提醒错过只补跑一次。 */
export function applyMisfire(policy: MisfirePolicy, lateMs: number, kind: 'digest' | 'reminder'): 'skip' | 'run' {
  if (lateMs <= 0) return 'run'
  if (kind === 'digest' || policy === 'skip') return 'skip'
  return lateMs <= 6 * 60 * MINUTE ? 'run' : 'skip'
}

export function reconcileCounts(expected: number, executed: number, skipped: number): { ok: boolean; delta: number } {
  const delta = expected - executed - skipped
  return { ok: delta === 0, delta }
}

export type ToolErrorClass =
  | 'E_TRANSIENT'
  | 'E_RATE_LIMIT'
  | 'E_VALIDATION'
  | 'E_AUTH'
  | 'E_NOT_FOUND'
  | 'E_CONFLICT'
  | 'E_TIMEOUT'
  | 'E_PERMANENT'

export function classifyToolError(status: number): ToolErrorClass {
  if (status === 408 || status === 504) return 'E_TIMEOUT'
  if (status === 429) return 'E_RATE_LIMIT'
  if (status === 401 || status === 403) return 'E_AUTH'
  if (status === 404) return 'E_NOT_FOUND'
  if (status === 409) return 'E_CONFLICT'
  if (status === 400 || status === 422) return 'E_VALIDATION'
  if (status >= 500 || status === 0) return 'E_TRANSIENT'
  return 'E_PERMANENT'
}

/** 只有暂时失败和限流可以退避重试。校验错误重试没有意义。 */
export function shouldRetryTool(kind: ToolErrorClass): boolean {
  return kind === 'E_TRANSIENT' || kind === 'E_RATE_LIMIT'
}

export interface ToolResultView {
  preview: string
  truncated: boolean
  artifactId: string
}

/** 超预算的工具结果只留预览和指针，不把全文塞进上下文。 */
export function governToolResult(text: string, maxChars: number, artifactId: string): ToolResultView {
  const cap = Math.max(80, Math.trunc(maxChars))
  if (text.length <= cap) return { preview: text, truncated: false, artifactId: '' }
  return { preview: text.slice(0, cap), truncated: true, artifactId }
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'consumed'

export function consumeApproval(status: ApprovalStatus, argsHash: string, snapshotHash: string): ApprovalStatus | 'reject' {
  if (status !== 'approved') return 'reject'
  if (argsHash !== snapshotHash) return 'reject'
  return 'consumed'
}

export interface DeliveryParts {
  channel: string
  account: string
  outboundId: string
}

/** 四层幂等键。eventId 只标识传输，不能拿来当「这条回复只发一次」。 */
export function deliveryKey(parts: DeliveryParts): string {
  return ['delivery', parts.channel, parts.account, parts.outboundId].join(':')
}

export function messageKey(channel: string, account: string, platformMessageId: string): string {
  return ['message', channel, account, platformMessageId].join(':')
}

export function toolIdempotencyKey(runId: string, callId: string): string {
  return runId.trim() !== '' && callId.trim() !== '' ? `${runId}:${callId}` : ''
}

export function eventKey(source: string, entity: string, version: string): string {
  return ['event', source.trim(), entity.trim(), version.trim()].join(':')
}
