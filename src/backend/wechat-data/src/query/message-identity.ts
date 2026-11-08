/**
 * Canonical message-table identity resolution.
 *
 * WeChat 4.x stores a talker's messages in `Msg_<md5(username)>`. A table name
 * is therefore not a username. Some conversations (notably older groups) no
 * longer exist in `SessionTable` or `contact`, but their real username is still
 * present in each message shard's `Name2Id` and in `ChatName2Id`.
 *
 * All scanners should resolve through this module instead of rebuilding the
 * reverse map from only the contact/session tables.
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { isMd5 } from '../md5.ts'
import { DatabaseSync } from './db-open.ts'
import { cachedBySig, contactMeta, fileSigOf, shardCatalogDirs, shardCatalogSig } from './meta.ts'

const MSG_TABLE_PREFIX_RE = /^Msg_/i
const DEFAULT_DIRS = ['message', 'bizchat'] as const

/** Whether a value is a raw table hash or a complete `Msg_<hash>` table name. */
export function isMessageTableHash(value: string): boolean {
  return isMd5(value.trim().replace(MSG_TABLE_PREFIX_RE, '').toLowerCase())
}

/** `username` -> `Msg_<md5(username)>` suffix. */
export function messageTableHash(username: string): string {
  return createHash('md5').update(username, 'utf8').digest('hex')
}

/** `username` -> complete message table name. */
export function messageTableName(username: string): string {
  return 'Msg_' + messageTableHash(username)
}

/** Cached identity maps for every message shard in the selected directories. */
export interface MessageIdentityIndex {
  /** 32-char table hash -> real WeChat username. */
  hashToUsername: ReadonlyMap<string, string>
  /** `Msg_<hash>` -> real WeChat username. */
  tableToUsername: ReadonlyMap<string, string>
  /** Every real username discovered from shards/contact/session/resource DBs. */
  usernames: ReadonlySet<string>
}

/** Canonical chat identity resolved from a username or a legacy message-table reference. */
export interface ChatIdentity {
  /** Original caller input. */
  input: string
  /** Real WeChat username, or empty when a legacy hash cannot be resolved. */
  username: string
  /** Human-readable name that never exposes a message-table hash. */
  displayName: string
  type: 'private' | 'group'
  /** Whether the input was a legacy 32-char hash / Msg_<hash> table name. */
  legacyHash: boolean
  /** False only for unresolved legacy hashes and empty input. */
  resolved: boolean
}

/** Canonical username + physical message table resolved from one caller input. */
export interface ResolvedMessageTable {
  identity: ChatIdentity
  username: string
  table: string
}

/** Result of normalizing a caller-supplied chat reference at a mutation boundary. */
export interface CanonicalChatReference {
  username: string
  displayName: string
  type: 'private' | 'group'
  legacyHash: boolean
  error?: string
}

function cellText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Uint8Array) return new TextDecoder('utf-8', { fatal: false }).decode(value)
  if (value === null || value === undefined) return ''
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint' || typeof value === 'symbol') {
    return String(value)
  }
  return ''
}

function addUsername(out: Set<string>, value: string): void {
  const username = value.trim()
  if (!username || isMessageTableHash(username)) return
  out.add(username)
}

function tableExists(db: DatabaseSync, table: string): boolean {
  try {
    return db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined
  } catch {
    return false
  }
}

function addColumnValues(db: DatabaseSync, table: string, column: string, out: Set<string>): void {
  if (!tableExists(db, table)) return
  try {
    const rows = db.prepare(`SELECT "${column}" AS value FROM "${table}"`).all() as Array<{ value: unknown }>
    for (const row of rows) {
      const value = cellText(row.value).trim()
      addUsername(out, value)
    }
  } catch {
    // Schema drift must not disable the other identity sources.
  }
}

function addDatabaseUsernames(path: string, tables: ReadonlyArray<[string, string]>, out: Set<string>): void {
  if (!existsSync(path)) return
  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(path, { readOnly: true })
    for (const [table, column] of tables) addColumnValues(db, table, column, out)
  } catch {
    // Missing/locked optional DB: the shard Name2Id source still works.
  } finally {
    try { db?.close() } catch { /* already closed */ }
  }
}

function buildIdentityIndex(decryptedDir: string, dirs: ReadonlyArray<string>): MessageIdentityIndex {
  const usernames = new Set<string>()
  for (const username of contactMeta(decryptedDir).names.keys()) {
    addUsername(usernames, username)
  }

  // Name2Id is the authoritative source for conversations that disappeared
  // from session/contact metadata. Every Msg_ table in a shard shares it.
  const shards = shardCatalogDirs(decryptedDir, dirs)
  for (const shard of shards) {
    for (const meta of shard.tables.values()) {
      for (const username of meta.name2id.values()) {
        addUsername(usernames, username)
      }
    }
  }

  addDatabaseUsernames(
    join(decryptedDir, 'message', 'message_resource.db'),
    [['ChatName2Id', 'user_name']],
    usernames,
  )
  addDatabaseUsernames(
    join(decryptedDir, 'session', 'session.db'),
    [['SessionTable', 'username'], ['Session', 'username'], ['SessionNoContactInfoTable', 'username']],
    usernames,
  )

  const hashToUsername = new Map<string, string>()
  for (const username of usernames) {
    const hash = messageTableHash(username)
    if (!hashToUsername.has(hash)) hashToUsername.set(hash, username)
  }

  const tableToUsername = new Map<string, string>()
  for (const shard of shards) {
    for (const table of shard.tables.keys()) {
      if (!table.startsWith('Msg_')) continue
      const username = hashToUsername.get(table.slice(4).toLowerCase())
      if (username) tableToUsername.set(table, username)
    }
  }

  return { hashToUsername, tableToUsername, usernames }
}

/**
 * Human-readable chat name with contact > session-title > readable fallback
 * precedence. The fallback is deliberately lossy for unresolved hashes: it
 * returns `未命名会话` rather than leaking the table name into navigation.
 */
function displayNameFor(decryptedDir: string, username: string): string {
  const contactName = contactMeta(decryptedDir).names.get(username)?.trim() ?? ''
  if (contactName && contactName !== username) return contactName
  const sessionTitle = sessionDisplayNames(decryptedDir).get(username)?.trim() ?? ''
  if (sessionTitle && sessionTitle !== username) return sessionTitle
  return fallbackChatDisplayName(username)
}

/**
 * Resolve a caller-supplied chat reference before any message-table lookup.
 *
 * This is the boundary that prevents `Msg_<md5(username)>` suffixes from
 * flowing through the app as if they were usernames. Known legacy hashes are
 * converted back to their real username; unknown hashes are explicitly marked
 * unresolved and never echoed as a display name.
 * @param decryptedDir - decrypted data root.
 * @param value - username, raw table hash, or complete Msg_<hash> table name.
 * @param dirs - message shard directories.
 * @returns canonical identity plus display metadata.
 */
export function resolveChatIdentity(
  decryptedDir: string,
  value: string,
  dirs: ReadonlyArray<string> = DEFAULT_DIRS,
): ChatIdentity {
  const input = value.trim()
  const legacyHash = isMessageTableHash(input)
  if (!legacyHash) {
    const username = input
    return {
      input,
      username,
      displayName: username ? displayNameFor(decryptedDir, username) : '未命名会话',
      type: username.endsWith('@chatroom') ? 'group' : 'private',
      legacyHash: false,
      resolved: username !== '',
    }
  }
  const hash = input.replace(MSG_TABLE_PREFIX_RE, '').toLowerCase()
  const username = messageIdentityIndex(decryptedDir, dirs).hashToUsername.get(hash) ?? ''
  return {
    input,
    username,
    displayName: username ? displayNameFor(decryptedDir, username) : '未命名会话',
    type: username.endsWith('@chatroom') ? 'group' : 'private',
    legacyHash: true,
    resolved: username !== '',
  }
}

/**
 * Normalize a public mutation boundary.
 *
 * A resolved legacy hash is converted to the real username. An unknown legacy
 * hash is rejected instead of being persisted as an empty or fake chat. Normal
 * usernames (including ids not present in the metadata tables) pass through.
 * @param decryptedDir - decrypted data root.
 * @param value - username or legacy message-table hash.
 * @param label - user-facing field label used in the error.
 * @returns canonical identity or an error to return before writing.
 */
export function canonicalChatReference(
  decryptedDir: string,
  value: string | null | undefined,
  label = '会话',
): CanonicalChatReference {
  const input = (value ?? '').trim()
  if (input === '') {
    return { username: '', displayName: '未命名会话', type: 'private', legacyHash: false }
  }
  const identity = resolveChatIdentity(decryptedDir, input)
  if (identity.legacyHash && !identity.resolved) {
    return {
      username: '',
      displayName: '未命名会话',
      type: identity.type,
      legacyHash: true,
      error: label + '身份无法解析，请重新同步微信数据后再试',
    }
  }
  return {
    username: identity.username,
    displayName: identity.displayName,
    type: identity.type,
    legacyHash: identity.legacyHash,
  }
}

/**
 * Load the cached identity index.
 * @param decryptedDir - decrypted data root.
 * @param dirs - message shard directories (default: message + bizchat).
 * @returns hash/table/username maps invalidated by any source DB change.
 */
export function messageIdentityIndex(
  decryptedDir: string,
  dirs: ReadonlyArray<string> = DEFAULT_DIRS,
): MessageIdentityIndex {
  const key = 'message-identity:' + decryptedDir + ':' + dirs.join('|')
  const sig = [
    shardCatalogSig(decryptedDir, dirs),
    fileSigOf(join(decryptedDir, 'contact', 'contact.db')),
    fileSigOf(join(decryptedDir, 'message', 'message_resource.db')),
    fileSigOf(join(decryptedDir, 'session', 'session.db')),
  ].join('|')
  return cachedBySig(key, sig, () => buildIdentityIndex(decryptedDir, dirs))
}

/** Resolve a raw 32-char table hash to its username; normal usernames pass through. */
export function resolveTalkerUsername(
  decryptedDir: string,
  value: string,
  dirs: ReadonlyArray<string> = DEFAULT_DIRS,
): string {
  const input = value.trim()
  if (!isMessageTableHash(input)) return input
  const hash = input.replace(MSG_TABLE_PREFIX_RE, '').toLowerCase()
  return messageIdentityIndex(decryptedDir, dirs).hashToUsername.get(hash) ?? ''
}

/** Resolve a complete `Msg_<hash>` table name to its username. */
export function resolveMessageTableUsername(
  decryptedDir: string,
  table: string,
  dirs: ReadonlyArray<string> = DEFAULT_DIRS,
): string {
  const direct = messageIdentityIndex(decryptedDir, dirs).tableToUsername.get(table)
  if (direct) return direct
  if (!table.startsWith('Msg_')) return ''
  return resolveTalkerUsername(decryptedDir, table.slice(4), dirs)
}

/**
 * Resolve a chat reference and derive its physical message table in one step.
 *
 * Use this at public query boundaries instead of hashing the raw argument:
 * old navigation targets may be `Msg_<hash>` suffixes, which would otherwise
 * become `Msg_<md5(hash)>` and silently address a non-existent table.
 * @param decryptedDir - decrypted data root.
 * @param value - canonical username, raw hash, or `Msg_<hash>`.
 * @param dirs - message shard directories.
 * @returns canonical identity/table, or null when a legacy hash is unresolved.
 */
export function resolveMessageTable(
  decryptedDir: string,
  value: string,
  dirs: ReadonlyArray<string> = DEFAULT_DIRS,
): ResolvedMessageTable | null {
  const identity = resolveChatIdentity(decryptedDir, value, dirs)
  if (!identity.username) return null
  return {
    identity,
    username: identity.username,
    table: messageTableName(identity.username),
  }
}

/** Human-readable fallback that never leaks a table hash. */
export function fallbackChatDisplayName(username: string): string {
  const value = username.trim()
  if (value === '') return '未命名会话'
  if (value === 'filehelper') return '文件传输助手'
  if (value === 'weixin') return '微信团队'
  if (value.endsWith('@chatroom')) {
    const roomId = value.slice(0, -'@chatroom'.length)
    return roomId ? `群聊 ${roomId}` : '群聊'
  }
  if (isMessageTableHash(value)) return '未命名会话'
  // Unknown member/contact IDs are implementation detail. Showing a naked
  // wxid in rankings is no more useful than showing the old table hash.
  if (/^wxid_/i.test(value) || /@(?:openim|weclaw)$/i.test(value)) return '未知联系人'
  return value
}

/**
 * Contact display name with a safe non-ID fallback.
 * @param username - canonical WeChat username.
 * @param names - contact/session display-name map.
 * @param preferred - optional metadata name used when the map has no entry.
 * @returns the mapped name, or a readable fallback that never exposes raw IDs.
 */
export function displayNameForUsername(
  username: string,
  names?: ReadonlyMap<string, string>,
  preferred?: string,
): string {
  const mapped = names?.get(username)?.trim() ?? ''
  if (mapped && mapped !== username) return mapped
  const candidate = preferred?.trim() ?? ''
  if (candidate) return candidate
  return fallbackChatDisplayName(username)
}

const INTERNAL_WECHAT_ID_RE = /(?:[a-z0-9][a-z0-9_.-]*@(?:chatroom|openim|weclaw)|(?:wxid|gh)_[a-z0-9_.-]+)/i
const INTERNAL_WECHAT_ID_GLOBAL_RE = /(?:[a-z0-9][a-z0-9_.-]*@(?:chatroom|openim|weclaw)|(?:wxid|gh)_[a-z0-9_.-]+)/gi
const GENERATED_GROUP_LABEL_RE = /^群聊\s+\d+$/i

/** Whether a value is an internal WeChat identifier rather than a display label. */
export function isInternalWechatId(value: string): boolean {
  return INTERNAL_WECHAT_ID_RE.test(value.trim())
}

/**
 * Return a user-facing name only when it is safe to show to the model/user.
 *
 * Contact maps can contain generated fallbacks such as `群聊 123`; those are
 * useful inside the app, but must not be mistaken for a real customer name in
 * an AI answer.
 */
export function readableIdentityLabel(value: string, raw = ''): string {
  const clean = value.trim()
  if (
    clean === ''
    || clean === raw.trim()
    || isInternalWechatId(clean)
    || GENERATED_GROUP_LABEL_RE.test(clean)
  ) return ''
  return clean
}

/**
 * Replace internal IDs embedded in message text with human-readable labels.
 *
 * Group message bodies and quoted XML occasionally retain `wxid_*` or
 * `...@chatroom` tokens. Resolving them at the tool boundary prevents the
 * synthesis model from copying implementation details into the final answer.
 */
export function replaceWechatIds(
  text: string,
  labelOf: (id: string) => string | undefined,
  fallbackOf: (id: string) => string,
): string {
  if (text === '') return ''
  return text.replace(INTERNAL_WECHAT_ID_GLOBAL_RE, (raw) => {
    return readableIdentityLabel(labelOf(raw) ?? '', raw) || fallbackOf(raw)
  })
}

/** Session titles are the best readable fallback for groups absent from contact DBs. */
export function sessionDisplayNames(decryptedDir: string): ReadonlyMap<string, string> {
  const path = join(decryptedDir, 'session', 'session.db')
  const sig = fileSigOf(path)
  return cachedBySig('session-display-names:' + decryptedDir, sig, () => {
    const names = new Map<string, string>()
    if (!sig) return names
    let db: DatabaseSync | null = null
    try {
      db = new DatabaseSync(path, { readOnly: true })
      if (tableExists(db, 'SessionNoContactInfoTable')) {
        const rows = db.prepare('SELECT username, session_title FROM SessionNoContactInfoTable')
          .all() as Array<{ username: unknown; session_title: unknown }>
        for (const row of rows) {
          const stored = cellText(row.username).trim()
          // Session titles can also be keyed by the physical Msg_<hash> suffix.
          // Resolve that key so title lookup works after SessionTable rows are
          // canonicalized to the real chat username.
          const username = stored ? resolveTalkerUsername(decryptedDir, stored) : ''
          const title = cellText(row.session_title).trim()
          if (username && title && title !== stored && !isMessageTableHash(title)) {
            names.set(username, title)
          }
        }
      }
    } catch {
      // Optional metadata: fall back to contact names and readable IDs.
    } finally {
      try { db?.close() } catch { /* already closed */ }
    }
    return names
  })
}

/**
 * Merge contact, session-title and readable fallback names.
 *
 * Priority: contact remark/nick > session title > readable fallback. Passing
 * the identity index from a scanner avoids rebuilding it once per row.
 */
export function mergeDisplayNames(
  decryptedDir: string,
  knownUsernames?: Iterable<string>,
): Map<string, string> {
  const names = new Map<string, string>(sessionDisplayNames(decryptedDir))
  for (const [username, name] of contactMeta(decryptedDir).names) {
    const clean = name.trim()
    if (username && clean) names.set(username, clean)
  }
  const known = knownUsernames ?? messageIdentityIndex(decryptedDir).usernames
  for (const username of known) {
    const current = names.get(username)?.trim() ?? ''
    if (!current || current === username) names.set(username, displayNameForUsername(username, names))
  }
  return names
}
