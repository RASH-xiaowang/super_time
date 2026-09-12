/**
 * Message edit store, rewritten from st_control edit_store.rs. Edits write to
 * the decrypted message shard and record the original snapshot in
 * <wechat>/message_edits.db so the original can be restored.
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'

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

/** Open (create) the edit store with schema. */
function openEditStore(decryptedDir: string): DatabaseSync {
  const db = new DatabaseSync(editDbPath(decryptedDir))
  db.exec('CREATE TABLE IF NOT EXISTS message_edits (account TEXT NOT NULL, session_id TEXT NOT NULL, db TEXT NOT NULL, table_name TEXT NOT NULL, local_id INTEGER NOT NULL, first_edited_at INTEGER NOT NULL, last_edited_at INTEGER NOT NULL, edit_count INTEGER NOT NULL, original_msg_json TEXT NOT NULL, edited_cols_json TEXT, PRIMARY KEY (account, session_id, db, table_name, local_id))')
  return db
}

/** Coerce a DB cell to a string (null -> '', else String()). */
function cellStr(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === null || v === undefined) return ''
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol') return String(v)
  return ''
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
    const db = new DatabaseSync(p, { readOnly: true })
    let rows: Array<Record<string, unknown>>
    if (sessionId) {
      rows = db.prepare('SELECT session_id, db, table_name, local_id, last_edited_at, edit_count, original_msg_json FROM message_edits WHERE session_id = ? ORDER BY last_edited_at DESC').all(sessionId)
    } else {
      rows = db.prepare('SELECT session_id, db, table_name, local_id, last_edited_at, edit_count, original_msg_json FROM message_edits ORDER BY last_edited_at DESC LIMIT 500').all()
    }
    db.close()
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

/** Locate the shard containing a talker Msg table. */
function findShard(decryptedDir: string, table: string): DatabaseSync | null {
  for (const f of messageShardFiles(decryptedDir)) {
    try {
      const db = new DatabaseSync(f)
      const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined
      if (has) return db
      db.close()
    } catch { /* try next */ }
  }
  return null
}

/**
 * Edit one message content (writes to the decrypted shard + records the edit).
 * @param decryptedDir - decrypted data root.
 * @param username - conversation username.
 * @param localId - message local id.
 * @param newContent - new message content text.
 * @returns result with ok + edited localId.
 */
export function editChatMessage(
  decryptedDir: string,
  username: string,
  localId: number,
  newContent: string,
): { ok: boolean; error?: string; localId?: number } {
  const table = msgTableName(username)
  const db = findShard(decryptedDir, table)
  if (!db) return { ok: false, error: '未找到消息分库' }
  try {
    const cols = (db.prepare('PRAGMA table_info("' + table + '")').all() as Array<{ name: string }>).map(r => r.name)
    const contentCol = cols.includes('message_content') ? 'message_content' : cols.includes('Content') ? 'Content' : null
    const strCol = cols.includes('str_content') ? 'str_content' : null
    if (!contentCol) { db.close(); return { ok: false, error: '消息表缺少内容列' } }
    const row = db.prepare('SELECT "' + contentCol + '" AS c FROM "' + table + '" WHERE local_id = ? LIMIT 1').get(localId) as { c?: unknown } | undefined
    if (!row) { db.close(); return { ok: false, error: '消息不存在' } }
    // record original snapshot (first edit)
    const store = openEditStore(decryptedDir)
    const ts = Date.now()
    const existing = store.prepare('SELECT 1 FROM message_edits WHERE session_id = ? AND local_id = ?').get(username, localId)
    if (!existing) {
      const originalJson = JSON.stringify({ [contentCol]: cellStr(row.c ?? '') })
      store.prepare("INSERT INTO message_edits(account, session_id, db, table_name, local_id, first_edited_at, last_edited_at, edit_count, original_msg_json, edited_cols_json) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, '[\"" + contentCol + "\"]')").run(username, username, 'message', table, localId, ts, ts, originalJson)
    } else {
      store.prepare('UPDATE message_edits SET last_edited_at = ?, edit_count = edit_count + 1 WHERE session_id = ? AND local_id = ?').run(ts, username, localId)
    }
    store.close()
    // write the new content
    db.prepare('UPDATE "' + table + '" SET "' + contentCol + '" = ? WHERE local_id = ?').run(newContent, localId)
    if (strCol) db.prepare('UPDATE "' + table + '" SET "' + strCol + '" = ? WHERE local_id = ?').run(newContent, localId)
    return { ok: true, localId }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  } finally {
    db.close()
  }
}

/**
 * Restore a message to its original content from the edit store.
 * @param decryptedDir - decrypted data root.
 * @param username - conversation username.
 * @param localId - message local id to restore.
 * @returns result with ok.
 */
export function resetEditedMessage(decryptedDir: string, username: string, localId: number): { ok: boolean; error?: string } {
  const p = editDbPath(decryptedDir)
  if (!existsSync(p)) return { ok: false, error: '编辑记录库不存在' }
  try {
    const store = new DatabaseSync(p)
    const rec = store.prepare('SELECT db, table_name, original_msg_json FROM message_edits WHERE session_id = ? AND local_id = ?').get(username, localId) as { db?: string; table_name?: string; original_msg_json?: string } | undefined
    if (!rec) { store.close(); return { ok: false, error: '无编辑记录' } }
    let original: Record<string, unknown> = {}
    try { original = JSON.parse(rec.original_msg_json ?? '{}') as Record<string, unknown> } catch { /* keep empty */ }
    store.close()
    const table = rec.table_name ?? msgTableName(username)
    const db = findShard(decryptedDir, table)
    if (!db) return { ok: false, error: '未找到消息分库' }
    try {
      const cols = (db.prepare('PRAGMA table_info("' + table + '")').all() as Array<{ name: string }>).map(r => r.name)
      for (const [col, val] of Object.entries(original)) {
        if (!cols.includes(col)) continue
        db.prepare('UPDATE "' + table + '" SET "' + col + '" = ? WHERE local_id = ?').run(String(val), localId)
      }
      // remove the edit record
      const store2 = new DatabaseSync(p)
      store2.prepare('DELETE FROM message_edits WHERE session_id = ? AND local_id = ?').run(username, localId)
      store2.close()
      return { ok: true }
    } finally {
      db.close()
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}
