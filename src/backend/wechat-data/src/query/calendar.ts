/**
 * Chat calendar: per-day message counts for one month, rewritten from
 * st_control handlers/session/search.rs get_chat_daily_counts.
 */
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** Msg_<md5(username)> table name for a talker. */
function msgTableName(username: string): string {
  return 'Msg_' + createHash('md5').update(username, 'utf8').digest('hex')
}

/**
 * Daily message counts for one talker in a month (local time).
 * @param decryptedDir - decrypted data root.
 * @param username - conversation username.
 * @param year - calendar year.
 * @param month - calendar month (1-12).
 * @returns day -> count plus the requested year/month.
 */
export function getDailyCounts(
  decryptedDir: string,
  username: string,
  year: number,
  month: number,
): { counts: Record<string, number>; year: number; month: number } {
  if (month < 1 || month > 12) throw new Error('无效月份')
  const start = new Date(year, month - 1, 1, 0, 0, 0, 0)
  const end = new Date(year, month, 1, 0, 0, 0, 0)
  const startTs = Math.floor(start.getTime() / 1000)
  const endTs = Math.floor(end.getTime() / 1000)
  const counts: Record<string, number> = {}
  const msgDir = join(decryptedDir, 'message')
  if (!existsSync(msgDir)) return { counts, year, month }
  const files = readdirSync(msgDir).filter(f =>
    f.endsWith('.db') && f.startsWith('message_')
      && !f.includes('fts') && !f.includes('resource') && !f.includes('media'),
  ).sort()
  const table = msgTableName(username)
  for (const f of files) {
    let db: DatabaseSync | null = null
    try { db = new DatabaseSync(join(msgDir, f), { readOnly: true }) } catch { continue }
    const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined
    if (!has) { db.close(); continue }
    try {
      const sql = "SELECT strftime('%d', create_time, 'unixepoch', 'localtime') AS d, COUNT(*) AS c FROM \"" + table + '" WHERE create_time >= ? AND create_time < ? GROUP BY d'
      const rows = db.prepare(sql).all(startTs, endTs) as Array<{ d: string; c: number }>
      for (const r of rows) {
        const day = Number(r.d)
        if (Number.isFinite(day)) counts[String(day)] = (counts[String(day)] ?? 0) + r.c
      }
    } catch {
      // skip unreadable shard
    } finally {
      db.close()
    }
  }
  return { counts, year, month }
}
