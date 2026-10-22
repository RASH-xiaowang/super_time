/**
 * Message edit store, rewritten from st_control edit_store.rs. Edits write to
 * the decrypted message shard and record the original snapshot in
 * <wechat>/message_edits.db so the original can be restored exactly.
 */
import * as zlib from 'node:zlib'
import { existsSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { withDb, withWritableDb } from './db-open.ts'

/** Which field the editor is changing. `text` is guarded to plain text rows only. */
export type MessageEditMode = 'text' | 'source'

const EDIT_SCHEMA = 'CREATE TABLE IF NOT EXISTS message_edits (account TEXT NOT NULL, session_id TEXT NOT NULL, db TEXT NOT NULL, table_name TEXT NOT NULL, local_id INTEGER NOT NULL, first_edited_at INTEGER NOT NULL, last_edited_at INTEGER NOT NULL, edit_count INTEGER NOT NULL, original_msg_json TEXT NOT NULL, edited_cols_json TEXT, PRIMARY KEY (account, session_id, db, table_name, local_id))'
/** Runtime zstd probe: Electron's bundled Node version decides whether the API exists. */
const zstdApi = zlib as unknown as {
  zstdCompressSync?: (bytes: Buffer) => Buffer
}

/** Msg_<md5(username)> table name for a talker. */
function msgTableName(username: string): string {
  return 'Msg_' + createHash('md5').update(username, 'utf8').digest('hex')
}

/** Message shard DB files under <decrypted>/message. */
function messageShardFiles(decryptedDir: string): string[] {
  const dir = join(decryptedDir, 'message')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(f => f.endsWith('.db') && !f.includes('_shm') && !f.includes('_wal') && !f.includes('monitor_cache')).sort().map(f => join(dir, f))
}

/** Edit store DB path: sibling of the decrypted dir. */
function editDbPath(decryptedDir: string): string {
  return join(dirname(decryptedDir), 'message_edits.db')
}

/** Coerce a DB cell to a string (null -> '', else String()). */
function cellStr(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === null || v === undefined) return ''
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol') return String(v)
  return ''
}

/**
 * Encode a raw SQLite cell into the JSON snapshot.
 *
 * BLOB must be base64-tagged. Treating it as an empty string would make restore
 * overwrite the original compressed payload permanently.
 */
type EncodedCell = string | number | { b64: string } | { i64: string } | { null: true }

function encodeOriginalCell(v: unknown): EncodedCell {
  if (v === null || v === undefined) return { null: true }
  if (v instanceof Uint8Array) return { b64: Buffer.from(v).toString('base64') }
  if (typeof v === 'bigint') return { i64: String(v) }
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  return cellStr(v)
}

/** Decode a snapshot cell back to the SQLite storage type it came from. */
function decodeOriginalCell(v: unknown): string | number | bigint | Buffer | null {
  if (v && typeof v === 'object') {
    const tagged = v as { b64?: unknown; i64?: unknown; null?: unknown }
    if (typeof tagged.b64 === 'string') return Buffer.from(tagged.b64, 'base64')
    if (typeof tagged.i64 === 'string') return BigInt(tagged.i64)
    if (tagged.null === true) return null
  }
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'string') return v
  return String(v ?? '')
}

/** One edited-message record. */
export interface EditedMessageRecord {
  sessionId: string
  db: string
  tableName: string
  localId: number
  lastEditedAt: number
  editCount: number
  originalMsgJson: string
}

/**
 * List edited messages (optionally for one session).
 * @param decryptedDir - decrypted data root.
 * @param sessionId - optional session to filter by.
 * @returns edited message records plus total count.
 */
export function listEditedMessages(decryptedDir: string, sessionId?: string): { items: EditedMessageRecord[]; total: number } {
  const p = editDbPath(decryptedDir)
  if (!existsSync(p)) return { items: [], total: 0 }
  try {
    const rows = withDb(p, (db) => sessionId
      ? db.prepare('SELECT session_id, db, table_name, local_id, last_edited_at, edit_count, original_msg_json FROM message_edits WHERE session_id = ? ORDER BY last_edited_at DESC').all(sessionId)
      : db.prepare('SELECT session_id, db, table_name, local_id, last_edited_at, edit_count, original_msg_json FROM message_edits ORDER BY last_edited_at DESC LIMIT 500').all()) as Array<Record<string, unknown>>
    const items = rows.map(r => ({
      sessionId: cellStr(r['session_id'] ?? ''),
      db: cellStr(r['db'] ?? ''),
      tableName: cellStr(r['table_name'] ?? ''),
      localId: Number(r['local_id'] ?? 0),
      lastEditedAt: Number(r['last_edited_at'] ?? 0),
      editCount: Number(r['edit_count'] ?? 0),
      originalMsgJson: cellStr(r['original_msg_json'] ?? ''),
    }))
    return { items, total: items.length }
  } catch {
    return { items: [], total: 0 }
  }
}

/**
 * Locate the first shard/table that really contains the target row.
 *
 * A conversation's Msg_ table can exist in more than one shard. Checking each
 * candidate read-only before opening the writable connection also guarantees
 * every probe connection is closed, including SQLite error paths.
 */
function findShardFile(decryptedDir: string, table: string, localId: number): string | null {
  let fallback: string | null = null
  for (const file of messageShardFiles(decryptedDir)) {
    try {
      const state = withDb(file, (db): 'none' | 'table' | 'hit' => {
        const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined
        if (!has) return 'none'
        const hit = db.prepare('SELECT 1 FROM "' + table + '" WHERE local_id = ? LIMIT 1').get(localId) !== undefined
        return hit ? 'hit' : 'table'
      })
      if (state === 'hit') return file
      if (state === 'table' && fallback === null) fallback = file
    } catch {
      // A damaged shard must not stop the search in the remaining shards.
    }
  }
  return fallback
}

/** SQLite may return `local_type` as a wide integer-like value. Keep the low 32 bits. */
function normalizedLocalType(value: unknown): number {
  try {
    return Number(BigInt(Math.trunc(Number(value))) & 0xffffffffn)
  } catch {
    return 0
  }
}

/** The original cell shape decides how the edited value must be written back. */
function usesCompressedBlob(content: unknown, flag: unknown): boolean {
  return content instanceof Uint8Array || Number(flag) === 4
}

/** Encode text in the same storage family as the original message cell. */
function encodeEditedContent(content: unknown, flag: unknown, text: string): { value: string | Buffer; flag: number } {
  if (!usesCompressedBlob(content, flag)) return { value: text, flag: 0 }
  if (typeof zstdApi.zstdCompressSync !== 'function') {
    throw new Error('这条消息使用 zstd 压缩存储，但当前运行时不支持安全压缩，已阻止写入')
  }
  return { value: Buffer.from(zstdApi.zstdCompressSync(Buffer.from(text, 'utf8'))), flag: 4 }
}

/**
 * Edit one message while preserving its original SQLite storage family.
 * @param decryptedDir - decrypted data root.
 * @param username - conversation username.
 * @param localId - message local id.
 * @param newContent - new visible text (text mode) or raw source (source mode).
 * @param mode - `text` rejects non-text rows; `source` allows structured payloads.
 * @returns result with ok + edited localId.
 */
export function editChatMessage(
  decryptedDir: string,
  username: string,
  localId: number,
  newContent: string,
  mode: MessageEditMode = 'text',
): { ok: boolean; error?: string; localId?: number } {
  if (mode !== 'text' && mode !== 'source') return { ok: false, error: '不支持的消息修改模式' }
  const table = msgTableName(username)
  const shardFile = findShardFile(decryptedDir, table, localId)
  if (!shardFile) return { ok: false, error: '未找到消息分库或目标消息' }
  try {
    return withWritableDb(shardFile, (db) => {
      const cols = (db.prepare('PRAGMA table_info("' + table + '")').all() as Array<{ name: string }>).map(r => r.name)
      const contentCol = cols.includes('message_content') ? 'message_content' : cols.includes('Content') ? 'Content' : null
      const strCol = cols.includes('str_content') ? 'str_content' : null
      const flagCol = contentCol === 'message_content' && cols.includes('WCDB_CT_message_content')
        ? 'WCDB_CT_message_content'
        : null
      if (!contentCol) return { ok: false, error: '消息表缺少内容列' }

      const localTypeCol = cols.includes('local_type') ? 'local_type' : null
      const select = [
        '"' + contentCol + '" AS content',
        flagCol ? '"' + flagCol + '" AS flag' : 'NULL AS flag',
        strCol ? '"' + strCol + '" AS str_content' : 'NULL AS str_content',
        localTypeCol ? '"' + localTypeCol + '" AS local_type' : 'NULL AS local_type',
      ].join(', ')
      const row = db.prepare('SELECT ' + select + ' FROM "' + table + '" WHERE local_id = ? LIMIT 1').get(localId) as Record<string, unknown> | undefined
      if (!row) return { ok: false, error: '消息不存在' }
      if (mode === 'text' && normalizedLocalType(row['local_type']) !== 1) {
        return { ok: false, error: '这条消息不是纯文本，不能用「修改消息」改写；请使用「修改源码」' }
      }

      const original: Record<string, unknown> = {
        [contentCol]: encodeOriginalCell(row['content']),
      }
      if (flagCol) original[flagCol] = encodeOriginalCell(row['flag'])
      if (strCol) original[strCol] = encodeOriginalCell(row['str_content'])
      const editedCols = [contentCol, ...(flagCol ? [flagCol] : []), ...(strCol ? [strCol] : [])]
      const encoded = encodeEditedContent(row['content'], row['flag'], newContent)

      withWritableDb(editDbPath(decryptedDir), (store) => {
        store.exec(EDIT_SCHEMA)
        const existing = store.prepare('SELECT original_msg_json, edited_cols_json FROM message_edits WHERE session_id = ? AND local_id = ?').get(username, localId) as { original_msg_json?: string; edited_cols_json?: string } | undefined
        const ts = Date.now()
        if (!existing) {
          store.prepare('INSERT INTO message_edits(account, session_id, db, table_name, local_id, first_edited_at, last_edited_at, edit_count, original_msg_json, edited_cols_json) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)')
            .run(username, username, 'message', table, localId, ts, ts, JSON.stringify(original), JSON.stringify(editedCols))
          return
        }

        // Old records may only have the content cell. Fill missing metadata
        // without overwriting the original content snapshot.
        let previous: Record<string, unknown> = {}
        try { previous = JSON.parse(existing.original_msg_json ?? '{}') as Record<string, unknown> } catch { /* replace corrupt snapshot while merging */ }
        for (const [col, value] of Object.entries(original)) {
          if (!(col in previous)) previous[col] = value
        }
        let previousCols: string[] = []
        try {
          const parsed = JSON.parse(existing.edited_cols_json ?? '[]') as unknown
          if (Array.isArray(parsed)) previousCols = parsed.filter((x): x is string => typeof x === 'string')
        } catch { /* use current columns */ }
        const mergedCols = [...new Set([...previousCols, ...editedCols])]
        store.prepare('UPDATE message_edits SET last_edited_at = ?, edit_count = edit_count + 1, original_msg_json = ?, edited_cols_json = ? WHERE session_id = ? AND local_id = ?')
          .run(ts, JSON.stringify(previous), JSON.stringify(mergedCols), username, localId)
      })

      const assignments = ['"' + contentCol + '" = ?']
      const values: Array<string | number | Uint8Array> = [encoded.value]
      if (flagCol) {
        assignments.push('"' + flagCol + '" = ?')
        values.push(encoded.flag)
      }
      if (strCol) {
        assignments.push('"' + strCol + '" = ?')
        values.push(newContent)
      }
      values.push(localId)
      db.prepare('UPDATE "' + table + '" SET ' + assignments.join(', ') + ' WHERE local_id = ?').run(...values)
      return { ok: true, localId }
    })
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/**
 * Restore every snapshotted column to its original value and storage type.
 * @param decryptedDir - decrypted data root.
 * @param username - conversation username.
 * @param localId - message local id to restore.
 * @returns result with ok.
 */
export function resetEditedMessage(decryptedDir: string, username: string, localId: number): { ok: boolean; error?: string } {
  const p = editDbPath(decryptedDir)
  if (!existsSync(p)) return { ok: false, error: '编辑记录库不存在' }
  try {
    const rec = withDb(p, (store) => store.prepare('SELECT db, table_name, original_msg_json FROM message_edits WHERE session_id = ? AND local_id = ?').get(username, localId) as { db?: string; table_name?: string; original_msg_json?: string } | undefined)
    if (!rec) return { ok: false, error: '无编辑记录' }
    let original: Record<string, unknown> = {}
    try { original = JSON.parse(rec.original_msg_json ?? '{}') as Record<string, unknown> } catch { /* keep empty */ }
    const table = rec.table_name ?? msgTableName(username)
    const shardFile = findShardFile(decryptedDir, table, localId)
    if (!shardFile) return { ok: false, error: '未找到消息分库' }
    withWritableDb(shardFile, (db) => {
      const cols = (db.prepare('PRAGMA table_info("' + table + '")').all() as Array<{ name: string }>).map(r => r.name)
      for (const [col, val] of Object.entries(original)) {
        if (!cols.includes(col)) continue
        db.prepare('UPDATE "' + table + '" SET "' + col + '" = ? WHERE local_id = ?').run(decodeOriginalCell(val), localId)
      }
    })
    withWritableDb(p, (store) => {
      store.prepare('DELETE FROM message_edits WHERE session_id = ? AND local_id = ?').run(username, localId)
    })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}
