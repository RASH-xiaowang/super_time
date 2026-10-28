/**
 * Enterprise-WeChat contact metadata from `contact.db`.
 *
 * An enterprise-WeChat user is stored as `<id>@openim`. Its `extra_buffer`
 * protobuf field 2 holds an enterprise wording id, while `openim_wording`
 * maps that id to the human-readable enterprise name:
 *
 *   extra_buffer[2] = 46A0...@im.wxwork
 *   openim_wording(wording_id=46A0...@im.wxwork, wording=企业名称)
 *
 * Keep this parsing in one place so contacts, sessions, group members,
 * customer profiles, and search all resolve the same name.
 */
import type { DatabaseSync } from './db-open.ts'
import { cellText, parseContactExtra } from './region.ts'

/** Maps loaded from one contact.db snapshot. */
export interface OpenimDirectory {
  /** `openim_wording.wording_id` -> enterprise name. */
  wordingNames: Map<string, string>
  /** Enterprise-WeChat username -> enterprise name. */
  enterpriseNames: Map<string, string>
}

/** Whether a username is an enterprise-WeChat user (not a kefu/service account). */
export function isEnterpriseWechatUser(username: string): boolean {
  const value = username.trim()
  return value.endsWith('@openim') && !value.endsWith('@kefu.openim')
}

/** Normalize SQLite BLOB/TEXT into a protobuf buffer. */
function extraBufferOf(value: unknown): Buffer {
  if (value instanceof Uint8Array) return Buffer.from(value)
  if (typeof value === 'string' && value.length > 0) return Buffer.from(value, 'utf8')
  return Buffer.alloc(0)
}

/** Resolve an enterprise name from one `contact.extra_buffer` value. */
export function enterpriseNameFromExtra(
  extraBuffer: unknown,
  wordingNames: ReadonlyMap<string, string>,
): string | undefined {
  const raw = extraBufferOf(extraBuffer)
  if (raw.length === 0) return undefined
  const wordingId = parseContactExtra(raw).wordingId?.trim()
  if (!wordingId) return undefined
  const name = wordingNames.get(wordingId)?.trim()
  return name !== undefined && name !== '' ? name : undefined
}

/** Load `openim_wording`; a missing table is a normal legacy snapshot. */
export function loadOpenimWordingNames(db: DatabaseSync): Map<string, string> {
  const names = new Map<string, string>()
  try {
    const rows = db.prepare('SELECT wording_id AS id, wording AS name FROM openim_wording').all() as Array<{
      id: unknown
      name: unknown
    }>
    for (const row of rows) {
      const id = cellText(row.id).trim()
      const name = cellText(row.name).trim()
      if (id !== '' && name !== '') names.set(id, name)
    }
  } catch { /* openim_wording may be absent */ }
  return names
}

function tableColumns(db: DatabaseSync, table: string): Set<string> {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    return new Set(rows.map((row) => row.name))
  } catch {
    return new Set()
  }
}

function enterpriseNamesFromWording(
  db: DatabaseSync,
  wordingNames: ReadonlyMap<string, string>,
): Map<string, string> {
  const names = new Map<string, string>()
  const cols = tableColumns(db, 'contact')
  if (!cols.has('username') || !cols.has('extra_buffer')) return names
  try {
    const rows = db.prepare(
      "SELECT username AS username, extra_buffer AS extra_buffer FROM contact WHERE username LIKE '%@openim'",
    ).all() as Array<{ username: unknown; extra_buffer: unknown }>
    for (const row of rows) {
      const username = cellText(row.username).trim()
      if (!isEnterpriseWechatUser(username)) continue
      const name = enterpriseNameFromExtra(row.extra_buffer, wordingNames)
      if (name !== undefined) names.set(username, name)
    }
  } catch { /* contact schema drift: keep the names resolved so far */ }
  return names
}

/** Load both enterprise names and their wording-id map from one connection. */
export function loadOpenimDirectoryFromDb(db: DatabaseSync): OpenimDirectory {
  const wordingNames = loadOpenimWordingNames(db)
  return {
    wordingNames,
    enterpriseNames: enterpriseNamesFromWording(db, wordingNames),
  }
}

/** Load only username -> enterprise name from one connection. */
export function loadOpenimEnterpriseNamesFromDb(db: DatabaseSync): Map<string, string> {
  return loadOpenimDirectoryFromDb(db).enterpriseNames
}
