import type { MessageRich, WechatMessage } from '@deepseek-ai/dsh-wechat-data/types'

/** Return a usable quoted-message server id (`0` means absent). */
export function quotedServerId(rich: MessageRich): string {
  const serverId = (rich.referSvrId ?? '').trim()
  return serverId === '0' ? '' : serverId
}

function normalizedQuoteText(value: string | undefined): string {
  return (value ?? '')
    .replace(/^\[[^\]]+\]\s*/, '')
    .replace(/\s+/g, '')
    .toLowerCase()
}

/**
 * Find a quoted message that is already in the loaded window.
 *
 * Server id is authoritative. Time is only used as a fallback, and ambiguous
 * same-second matches are rejected unless the quoted text uniquely selects one.
 */
export function findQuotedTarget(
  messages: readonly WechatMessage[],
  rich: MessageRich,
): WechatMessage | undefined {
  const serverId = quotedServerId(rich)
  if (serverId) {
    const exact = messages.find((message) => message.serverId === serverId)
    if (exact) return exact
  }

  const createTime = typeof rich.referTime === 'number' ? rich.referTime : 0
  if (!createTime) return undefined
  const candidates = messages.filter((message) => message.createTime === createTime)
  if (candidates.length === 1) return candidates[0]
  if (candidates.length === 0) return undefined

  const quotedText = normalizedQuoteText(rich.desc)
  if (!quotedText) return undefined
  const textOf = (message: WechatMessage): string => normalizedQuoteText(
    message.displayText || message.strContent || message.msgContent,
  )
  const exact = candidates.filter((message) => textOf(message) === quotedText)
  if (exact.length === 1) return exact[0]
  const partial = candidates.filter((message) => {
    const text = textOf(message)
    return text.length > 0 && (text.includes(quotedText) || quotedText.includes(text))
  })
  return partial.length === 1 ? partial[0] : undefined
}
