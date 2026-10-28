/** Shared display formatting for identities that may belong to WeCom. */

export interface EnterpriseIdentity {
  name: string
  enterpriseName?: string
  sender?: string
  senderEnterpriseName?: string
}

export interface SessionEnterpriseIdentity {
  username: string
  displayName?: string
  enterpriseName?: string
}

/** Enterprise-WeChat contact/user account, excluding kefu/service accounts. */
export function isEnterpriseWechatUser(username: string): boolean {
  const value = (username || '').trim().toLowerCase()
  return value.endsWith('@openim') && !value.endsWith('@kefu.openim')
}

/** Resolve a direct-chat enterprise name from already-loaded messages. */
export function directChatEnterpriseName(
  username: string,
  messages: ReadonlyArray<{ senderEnterpriseName?: string }>,
): string | undefined {
  if (!isEnterpriseWechatUser(username)) return undefined
  for (const message of messages) {
    const enterpriseName = message.senderEnterpriseName?.trim() ?? ''
    if (enterpriseName !== '') return enterpriseName
  }
  return undefined
}

/** Append an enterprise name without replacing the person's display name. */
export function withEnterprise(name: string, enterpriseName?: string): string {
  const display = name.trim()
  const enterprise = enterpriseName?.trim() ?? ''
  if (enterprise === '' || enterprise === display) return display
  const existing = /（企业：([^）]*)）$/.exec(display)
  if (existing?.[1]?.trim() === enterprise) return display
  if (existing) return display.slice(0, existing.index).trimEnd() + `（企业：${enterprise}）`
  return `${display}（企业：${enterprise}）`
}

/** Session scope label used by ask history without changing its persisted username. */
export function sessionDisplayNameWithEnterprise(
  sessions: ReadonlyArray<SessionEnterpriseIdentity>,
  username?: string,
): string {
  const value = username?.trim() ?? ''
  if (value === '') return ''
  const session = sessions.find(item => item.username === value)
  return withEnterprise(session?.displayName || value, session?.enterpriseName)
}

/**
 * Format a session or message citation as `会话（企业：X） · 发送者（企业：Y）`.
 * Group messages use the sender's enterprise; direct chats use the session's.
 */
export function identityLabel(identity: EnterpriseIdentity): string {
  const session = withEnterprise(identity.name, identity.enterpriseName)
  const sender = identity.sender?.trim() ?? ''
  if (sender === '') return session
  return `${session} · ${withEnterprise(sender, identity.senderEnterpriseName)}`
}
