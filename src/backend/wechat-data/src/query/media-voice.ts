/**
 * WeChat voice message lookup, rewritten from st_control voice.rs.
 * Locates silk voice data in media_0.db VoiceInfo (Name2Id direct, then
 * svr_id fallback). Node cannot decode silk without ffmpeg/a WASM decoder,
 * so decodable=false and the frontend shows a duration + degrade hint.
 */
import { DatabaseSync } from './db-open.ts'
import { withDb } from './db-open.ts'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { messageTableName, resolveTalkerUsername } from './message-identity.ts'

/** Msg_<md5(username)> table name for a talker. */
function msgTableName(username: string): string {
  return messageTableName(username)
}

/** Message shard DB files under <decrypted>/message. */
function messageShardFiles(decryptedDir: string): string[] {
  const dir = join(decryptedDir, 'message')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(f => f.endsWith('.db') && !f.includes('_shm') && !f.includes('_wal') && !f.includes('media') && !f.includes('fts') && !f.includes('resource'))
    .sort()
    .map(f => join(dir, f))
}

/**
 * server_id for (username, local_id) from the message shards.
 *
 * `local_id` is reused when WeChat shards/rebuilds old history, so a first-row
 * match is not safe. Only return a value when the voice rows agree on exactly
 * one server id; callers that already have the message's server id should pass
 * it explicitly.
 * @returns the server id as text (bigints exceed the safe-integer range).
 */
export function messageServerIdByLocal(decryptedDir: string, username: string, localId: number): string | null {
  const canonical = resolveTalkerUsername(decryptedDir, username)
  if (!canonical) return null
  const table = msgTableName(canonical)
  const matches = new Set<string>()
  for (const shard of messageShardFiles(decryptedDir)) {
    let db: DatabaseSync | null = null
    try { db = new DatabaseSync(shard, { readOnly: true }) } catch { continue }
    const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined
    if (has) {
      try {
        const columns = new Set((db.prepare('PRAGMA table_info("' + table + '")').all() as Array<{ name?: unknown }>)
          .map(column => typeof column.name === 'string' ? column.name : ''))
        if (!columns.has('local_id') || !columns.has('server_id')) {
          db.close()
          continue
        }
        // Message shards share local ids across media kinds too. Restrict the
        // fallback to voice rows when the schema exposes local_type.
        const voiceOnly = columns.has('local_type') ? ' AND (local_type & 4294967295) = 34' : ''
        const rows = db.prepare('SELECT CAST(server_id AS TEXT) AS s FROM "' + table + '" WHERE local_id = ?' + voiceOnly).all(localId) as Array<{ s?: string | null }>
        db.close()
        for (const row of rows) {
          if (row.s && row.s !== '0') matches.add(row.s)
        }
        if (matches.size > 1) return null
      } catch { db.close(); continue }
    } else {
      db.close()
    }
  }
  return matches.size === 1 ? [...matches][0]! : null
}

/**
 * Look up one voice message.
 * @param decryptedDir - decrypted data root.
 * @param username - conversation username.
 * @param localId - message local id.
 * @param explicitSvrId - the selected message's server id, when available.
 * @returns voice info; svrId as text (bigints exceed the safe-integer range);
 * decodable=false when no Node silk decoder is available.
 */
export function resolveVoiceInfo(
  decryptedDir: string,
  username: string,
  localId: number,
  explicitSvrId = '',
): { available: boolean; svrId?: string; length?: number; decodable: boolean; error?: string } {
  const canonical = resolveTalkerUsername(decryptedDir, username)
  if (!canonical) return { available: false, decodable: false, error: '无法解析会话身份' }
  const mediaDb = join(decryptedDir, 'message', 'media_0.db')
  if (!existsSync(mediaDb)) {
    return { available: false, decodable: false, error: '语音库不存在 (media_0.db)' }
  }
  try {
    return withDb(mediaDb, (db) => {
      const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='VoiceInfo'").get() !== undefined
      if (!has) return { available: false, decodable: false, error: 'VoiceInfo 表不存在' }
      let row: { svr_id?: string; len?: number } | undefined
      // The UI normally passes the selected message's server_id. That is the
      // only stable identity because local_id is reused over time.
      const resolvedSvrId = explicitSvrId.trim() || messageServerIdByLocal(decryptedDir, canonical, localId) || ''
      const requestedSvrId = explicitSvrId.trim()
      if (resolvedSvrId && resolvedSvrId !== '0') {
        row = db.prepare('SELECT CAST(svr_id AS TEXT) AS svr_id, length(voice_data) AS len FROM VoiceInfo WHERE CAST(svr_id AS TEXT) = ? LIMIT 1').get(resolvedSvrId)
      }
      // Legacy callers only have local_id. Use media_0.db only when exactly one
      // server id exists; guessing would return a different year's recording.
      if (!row && !requestedSvrId) {
        const chat = db.prepare('SELECT rowid FROM Name2Id WHERE user_name = ?').get(canonical) as { rowid: number } | undefined
        if (chat) {
          const candidates = db.prepare('SELECT CAST(svr_id AS TEXT) AS svr_id, length(voice_data) AS len FROM VoiceInfo WHERE chat_name_id = ? AND local_id = ?').all(chat.rowid, localId) as Array<{ svr_id?: string; len?: number }>
          const ids = new Set(candidates.map(candidate => candidate.svr_id).filter((id): id is string => Boolean(id)))
          if (ids.size === 1) row = candidates[0]
          else if (ids.size > 1) return { available: false, decodable: false, error: '语音标识不唯一，请从消息重新打开' }
        }
      }
      if (!row) return { available: false, decodable: false, error: '未找到语音数据' }
      return { available: true, svrId: row.svr_id ?? resolvedSvrId ?? '0', length: row.len ?? 0, decodable: false, error: 'silk 解码需要 ffmpeg/WASM（当前不可用）' }
    })
  } catch (e) {
    return { available: false, decodable: false, error: (e as Error).message }
  }
}
