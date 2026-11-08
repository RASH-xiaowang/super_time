/**
 * Front-end identity gate for WeChat 4.x physical message-table hashes.
 *
 * A 32-char hash (or `Msg_<hash>`) is only a temporary request token. It must
 * never become active chat state, a render-cache key, or a visible title.
 */
const MESSAGE_HASH_RE = /^[0-9a-f]{32}$/i

export function isLegacyChatId(value: string | null | undefined): boolean {
  return MESSAGE_HASH_RE.test((value ?? '').trim().replace(/^Msg_/i, ''))
}

/** Prefer a canonical backend identity; unresolved legacy hashes fail closed. */
export function canonicalChatId(
  requested: string | null | undefined,
  backendCanonical?: string | null,
): string {
  const value = (requested ?? '').trim()
  const canonical = (backendCanonical ?? '').trim()
  if (canonical !== '' && !isLegacyChatId(canonical)) return canonical
  if (value === '' || isLegacyChatId(value)) return ''
  return value
}

export function canCacheChatId(value: string | null | undefined): boolean {
  const id = (value ?? '').trim()
  return id !== '' && !isLegacyChatId(id)
}

export function readableChatName(
  name: string | null | undefined,
  username: string | null | undefined,
): string {
  const id = (username ?? '').trim()
  const label = (name ?? '').trim()
  if (label !== '' && !isLegacyChatId(label) && label !== id) return label
  if (isLegacyChatId(id)) return '未命名会话'
  if (id.endsWith('@chatroom')) return `群聊 ${id.slice(0, -'@chatroom'.length)}`
  if (/^wxid_/i.test(id) || /@(?:openim|weclaw)$/i.test(id)) return '未知联系人'
  return label || id || '未命名会话'
}

