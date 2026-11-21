/**
 * AI 回复调用的发送闸。
 *
 * 生成前只拦截「现在不该开口」：紧急停止、静默、冷却、额度。
 * 生成后才把「必须先给人看」的结果留成草稿，例如群聊夹带知识库。
 *
 * @module query/agent/reply-gate
 */
import { parseChatAiReplySourceRef } from '../ai-reply/segments.ts'
import { readChatAiReplyState } from '../ai-reply/config-store.ts'
import { evaluateOutbound, type OutboundAction } from './decision.ts'
import { noteReplySent, readAgentControl, readReplyBudget } from './store.ts'

export interface ReplyGateInput {
  accountKey: string
  chatUsername: string
  group: boolean
  kbEnabled: boolean
  phase: 'preflight' | 'postflight'
  hasAttachment?: boolean
  channel?: 'feather-webhook' | 'feather-text' | 'generic'
}

export interface ReplyGateDecision {
  action: 'proceed' | 'defer' | 'send' | 'hold'
  reason: string
  reasonCode: string
}

export function assessReplyOutbound(
  decryptedDir: string,
  input: ReplyGateInput,
  now = new Date(),
): ReplyGateDecision {
  const control = readAgentControl(decryptedDir)
  const budget = readReplyBudget(decryptedDir, input.accountKey, input.chatUsername, now.getTime())
  const decision = evaluateOutbound({
    killed: control.killed,
    quietStart: control.quietStart,
    quietEnd: control.quietEnd,
    hour: now.getHours(),
    minute: now.getMinutes(),
    cooldownMs: control.cooldownMs,
    lastSentAt: budget.lastSentAt,
    nowMs: now.getTime(),
    hourCount: budget.hourCount,
    hourCap: control.hourCap,
    dayCount: budget.dayCount,
    dayCap: control.dayCap,
    group: input.group,
    kbEnabled: input.kbEnabled,
    proactive: false,
    shadow: control.shadow,
    recipientIsSelf: false,
    triggerTrusted: false,
    channel: input.channel ?? 'generic',
    hasAttachment: input.hasAttachment === true,
    handoff: control.handoff,
  })
  if (input.phase === 'preflight') {
    return decision.action === 'defer'
      ? { action: 'defer', reason: decision.reason, reasonCode: decision.reasonCode }
      : { action: 'proceed', reason: decision.reason, reasonCode: decision.reasonCode }
  }
  if (decision.action === 'send' || decision.action === 'hold' || decision.action === 'defer') {
    return { action: decision.action, reason: decision.reason, reasonCode: decision.reasonCode }
  }
  return { action: 'hold', reason: decision.reason, reasonCode: decision.reasonCode }
}

export function rememberReplySent(decryptedDir: string, accountKey: string, chatUsername: string): void {
  noteReplySent(decryptedDir, accountKey, chatUsername)
}

/**
 * 自动投递路径上的最后一道闸。只拦「必须先草稿」；静默和额度返回 defer，
 * 记录保持 pending，时间到了还能发。人工单条重发不走这里。
 */
export function automaticReplyBlock(
  decryptedDir: string,
  sourceRef: string | undefined,
  chatUsername: string,
): ReplyGateDecision | undefined {
  const parsed = parseChatAiReplySourceRef(sourceRef)
  const accountKey = parsed?.accountKey ?? ''
  const chat = parsed?.chatUsername || chatUsername
  if (accountKey === '' || chat === '') return undefined
  const state = readChatAiReplyState(decryptedDir, accountKey, chat)
  const decision = assessReplyOutbound(decryptedDir, {
    accountKey,
    chatUsername: chat,
    group: chat.endsWith('@chatroom'),
    kbEnabled: state.kbEnabled,
    phase: 'postflight',
  })
  return decision.action === 'send' ? undefined : decision
}

export type { OutboundAction }
