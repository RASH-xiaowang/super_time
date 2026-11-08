/**
 * Session draft clearing, rewritten from st_control handlers/session.rs
 * clear_session_draft / clear_all_session_drafts. Writes to the decrypted
 * session.db copy only (the WeChat source is untouched).
 */
import { DatabaseSync } from './db-open.ts'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { messageTableHash, resolveTalkerUsername } from './message-identity.ts'

/** Open the decrypted session.db read-write. */
function openSessionDb(decryptedDir: string): DatabaseSync | null {
  const p = join(decryptedDir, 'session', 'session.db')
  if (!existsSync(p)) return null
  try { return new DatabaseSync(p) } catch { return null }
}

/** Coerce a DB cell to a string (null -> '', else String()). */
function cellStr(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === null || v === undefined) return ''
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol') return String(v)
  return ''
}

/** Decode a draft cell (TEXT or BLOB). */
function draftText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (v instanceof Uint8Array) return new TextDecoder('utf-8', { fatal: false }).decode(v)
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol') return String(v)
  return ''
}

/**
 * Clear one session draft (decrypted copy only).
 * @param decryptedDir - decrypted data root.
 * @param username - session username whose draft is cleared.
 * @returns ok + rows updated.
 */
export function clearSessionDraft(decryptedDir: string, username: string): { ok: boolean; updated: number; error?: string } {
  const db = openSessionDb(decryptedDir)
  if (!db) return { ok: false, updated: 0, error: '解密 session.db 不存在' }
  try {
    const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='SessionTable'").get() !== undefined
    // 早退分支**不许**自己 close：`finally` 已经负责关，而 `node:sqlite` 对已关闭的连接
    // 再 close() 会抛 `ERR_INVALID_STATE` —— 在 finally 里抛会把上面这条人话错误吞掉，
    // 用户在界面上看到的是「database is not open」，真实原因（没有 SessionTable）反而丢了。
    if (!has) return { ok: false, updated: 0, error: 'SessionTable 不存在' }
    const requested = username.trim()
    const canonical = requested ? resolveTalkerUsername(decryptedDir, requested) : ''
    // Older SessionTable rows may be keyed by either the real username or the
    // physical Msg_<md5> suffix. The UI now only has the canonical value, so
    // clear both aliases in one statement.
    const aliases = [...new Set([
      requested,
      canonical,
      ...(canonical ? [messageTableHash(canonical)] : []),
    ].filter(Boolean))]
    if (aliases.length === 0) return { ok: true, updated: 0 }
    const r = db.prepare(
      `UPDATE SessionTable SET draft = ? WHERE username IN (${aliases.map(() => '?').join(', ')})`,
    ).run('', ...aliases)
    return { ok: true, updated: Number(r.changes) }
  } catch (e) {
    return { ok: false, updated: 0, error: (e as Error).message }
  } finally {
    db.close()
  }
}

/**
 * Clear all session drafts, returning the cleared drafts list.
 * @param decryptedDir - decrypted data root.
 * @returns cleared drafts + count.
 */
export function clearAllSessionDrafts(
  decryptedDir: string,
): { ok: boolean; cleared: Array<{ username: string; draft: string }>; count: number; error?: string } {
  const db = openSessionDb(decryptedDir)
  if (!db) return { ok: false, cleared: [], count: 0, error: '解密 session.db 不存在' }
  try {
    const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='SessionTable'").get() !== undefined
    // 同上：早退分支交给 `finally` 关连接，自己再 close() 会抛 ERR_INVALID_STATE 并掩盖真实原因
    if (!has) return { ok: false, cleared: [], count: 0, error: 'SessionTable 不存在' }
    const rows = db.prepare('SELECT username, draft FROM SessionTable WHERE draft IS NOT NULL AND length(draft) > 0').all() as Array<Record<string, unknown>>
    const cleared = rows.map((r) => {
      const stored = cellStr(r['username'] ?? '').trim()
      // Never return a physical message-table hash as an undo/navigation id.
      // An unresolved legacy hash is cleared but intentionally has no username.
      const username = stored ? resolveTalkerUsername(decryptedDir, stored) : ''
      return { username, draft: draftText(r['draft']) }
    })
    db.prepare('UPDATE SessionTable SET draft = ? WHERE draft IS NOT NULL AND length(draft) > 0').run('')
    return { ok: true, cleared, count: cleared.length }
  } catch (e) {
    return { ok: false, cleared: [], count: 0, error: (e as Error).message }
  } finally {
    db.close()
  }
}
