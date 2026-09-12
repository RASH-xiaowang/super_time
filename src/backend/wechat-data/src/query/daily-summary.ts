/**
 * Daily chat summary: collect one day of messages across all sessions,
 * then the host gateway sends them to the DSH LLM for a Chinese summary.
 * Collection is pure; the LLM call lives in the gateway (needs ctx.llm).
 */
import { DatabaseSync } from 'node:sqlite'
import { decompress } from 'fzstd'
import { existsSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

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

/** Session usernames from session.db (SessionTable or Session). */
function loadSessionUsernames(decryptedDir: string): string[] {
  const dbPath = join(decryptedDir, 'session', 'session.db')
  if (!existsSync(dbPath)) return []
  const out: string[] = []
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(r => r.name)
    const table = tables.includes('SessionTable') ? 'SessionTable' : tables.includes('Session') ? 'Session' : ''
    if (table) {
      const rows = db.prepare('SELECT username FROM "' + table + '"').all() as Array<Record<string, unknown>>
      for (const r of rows) { const u = cellStr(r['username'] ?? '').trim(); if (u) out.push(u) }
    }
    db.close()
  } catch { /* session db unavailable */ }
  return out
}

/** Coerce a DB cell to a string (null -> '', else String()). */
function cellStr(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === null || v === undefined) return ''
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol') return String(v)
  return ''
}

/** zstd magic bytes (WCDB compressed blobs). */
const ZSTD_MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD])

/** Decode raw column bytes: zstd-decompress when the magic matches. */
function tryDecompress(data: Buffer): Buffer | null {
  if (data.length >= 4 && data.subarray(0, 4).equals(ZSTD_MAGIC)) {
    try { return Buffer.from(decompress(data)) } catch { return null }
  }
  return null
}

/** Decode bytes as UTF-8, falling back to GBK when UTF-8 leaves replacement chars. */
function decodeUtfOrGbk(bytes: Buffer): string {
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  if (!utf8.includes('\uFFFD')) return utf8
  try {
    const gbk = new TextDecoder('gbk', { fatal: false }).decode(bytes)
    const utf8Bad = (utf8.match(/\uFFFD/g) ?? []).length
    const gbkBad = (gbk.match(/\uFFFD/g) ?? []).length
    return gbkBad < utf8Bad ? gbk : utf8
  } catch { return utf8 }
}

/** Decode a BLOB or TEXT cell to text (zstd-decompress, then UTF-8/GBK). */
function decodeCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol') return String(v)
  const raw = Buffer.from(v instanceof Uint8Array ? v : [])
  const decompressed = tryDecompress(raw)
  return decodeUtfOrGbk(decompressed ?? raw)
}

/** Strip XML tags for a plain snippet. */
function stripXml(xml: string): string {
  return xml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)
}

/** Heuristic: true when a decoded line looks like human chat text (rejects numeric/base64/JSON/binary/system noise). */
function isHumanText(text: string): boolean {
  const t = (text || '').trim()
  if (!t || t.length < 2) return false
  if (t.includes('\uFFFD')) return false
  let printable = 0, space = 0, cjk = 0, base64 = 0
  for (let i = 0; i < t.length; i += 1) {
    const cc = t.charCodeAt(i)
    const ch = t[i] ?? ''
    if ((cc >= 0x20 && cc <= 0x7e) || cc >= 0x80) printable += 1
    if (ch === ' ' || ch === '\u3000') space += 1
    if (cc >= 0x4e00 && cc <= 0x9fff) cjk += 1
    if (/[A-Za-z0-9+/=]/.test(ch)) base64 += 1
  }
  if (printable / t.length < 0.6) return false                       // binary remnant
  if (/^[\d\s.,，。;；:：!！?？+*#\-—/]+$/.test(t)) return false         // numeric-only (0 0 0 0 0)
  const nonSpace = t.length - space
  if (nonSpace >= 40 && base64 / nonSpace > 0.75 && cjk === 0) return false  // base64/hex blob
  if ((t.startsWith('{') || t.startsWith('[')) && t.includes(':')) return false  // JSON-ish
  if (cjk === 0 && nonSpace - base64 < 8) return false               // no real human chars
  return true
}

/** Human label for a normalized message type. */
function typeLabel(t: number): string {
  if (t === 1) return '文本'
  if (t === 3) return '图片'
  if (t === 34) return '语音'
  if (t === 42) return '名片'
  if (t === 43) return '视频'
  if (t === 47) return '表情'
  if (t === 48) return '位置'
  if (t === 49) return '链接'
  if (t === 10000) return '系统消息'
  return '其他'
}

/** Collected message stats shared by day/period summaries. */
type CollectedSummary = {
  lines: string[]
  count: number
  sessions: number
  total: number
  types: Record<string, number>
  hourly: number[]
  topSessions: Array<{ username: string; count: number }>
}

/** One picked message with its source (for task extraction provenance). */
export interface SourceLine {
  index: number
  username: string
  localId: number
  time: number
  text: string
}

/** collectRange result: summary plus optional source lines. */
type CollectedRangeResult = CollectedSummary & { sources: SourceLine[] }

const EMPTY_COLLECTED: CollectedSummary = { lines: [], count: 0, sessions: 0, total: 0, types: {}, hourly: [], topSessions: [] }

function tableColumns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>
  return new Set(rows.map(r => r.name))
}

/** Shared range collection across sessions (chronological, capped per session). */
function collectRange(
  decryptedDir: string,
  start: number,
  end: number,
  cap: number,
  groupUsername?: string,
  collectSources = false,
): CollectedRangeResult {
  const lines: string[] = []
  const sources: SourceLine[] = []
  let sessions = 0
  let total = 0
  const hourly = new Array<number>(24).fill(0)
  const types = new Map<string, number>()
  const perSession = new Map<string, number>()
  const sessionUsernames = loadSessionUsernames(decryptedDir)
  const tableToUser = new Map<string, string>()
  for (const username of sessionUsernames) tableToUser.set(msgTableName(username), username)
  // File-first pass: open each shard once, map its Msg_* tables to sessions.
  const fileInfos: Array<{ path: string; tables: Array<[string, string]> }> = []
  for (const shard of messageShardFiles(decryptedDir)) {
    let probe: DatabaseSync | null = null
    try { probe = new DatabaseSync(shard, { readOnly: true }) } catch { continue }
    try {
      const names = (probe.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'").all() as Array<{ name: string }>).map(r => r.name)
      const tables: Array<[string, string]> = []
      for (const n of names) {
        const u = tableToUser.get(n)
        if (u) tables.push([n, u])
      }
      if (tables.length > 0) fileInfos.push({ path: shard, tables })
    } catch { /* skip */ } finally { probe.close() }
  }
  for (const fi of fileInfos) {
    let db: DatabaseSync | null = null
    try { db = new DatabaseSync(fi.path, { readOnly: true }) } catch { continue }
    try {
      for (const [table, username] of fi.tables) {
        if (groupUsername && username !== groupUsername) continue
        const picked: Array<{ t: number; text: string }> = []
        try {
          const statRows = db.prepare('SELECT COUNT(*) c, CAST(strftime(\'%H\', datetime(create_time, \'unixepoch\')) AS INTEGER) h, local_type lt FROM "' + table + '" WHERE create_time >= ? AND create_time < ? GROUP BY h, lt').all(start, end) as Array<{ c: number; h: number; lt: number }>
          for (const sr of statRows) {
            const c = sr.c
            total += c
            const h = sr.h
            if (h >= 0 && h < 24) hourly[h] = (hourly[h] ?? 0) + c
            const lt = sr.lt
            const normLt = lt > 4294967296 ? lt % 4294967296 : lt
            const label = typeLabel(normLt)
            types.set(label, (types.get(label) ?? 0) + c)
          }
          perSession.set(username, (perSession.get(username) ?? 0) + statRows.reduce((a, r) => a + r.c, 0))
          const cols = tableColumns(db, table)
          const hasLocal = cols.has('local_id')
          const select = 'SELECT create_time, message_content, local_type' + (hasLocal ? ', local_id' : '') + ' FROM "' + table + '" WHERE create_time >= ? AND create_time < ? ORDER BY create_time ASC LIMIT ?'
          const rows = db.prepare(select).all(start, end, cap) as Array<Record<string, unknown>>
          for (const r of rows) {
            const t = Number(r['create_time'] ?? 0)
            const lt = Number(r['local_type'] ?? 0)
            const normLt = lt > 4294967296 ? lt % 4294967296 : lt
            // skip system messages (10000/10002)
            if (normLt === 10000 || normLt === 10002) continue
            const raw = decodeCell(r['message_content'])
            const text = stripXml(raw)
            if (isHumanText(text)) {
              picked.push({ t, text })
              if (collectSources) {
                sources.push({
                  index: sources.length,
                  username,
                  localId: hasLocal ? Number(r['local_id'] ?? 0) : 0,
                  time: t,
                  text,
                })
              }
            }
          }
        } catch { /* skip */ }
        if (picked.length >= cap) break
        if (picked.length > 0) {
          sessions += 1
          lines.push('【' + username + '】')
          for (const p of picked) lines.push(p.text)
        }
      }
    } finally { db.close() }
  }
  const topSessions = Array.from(perSession.entries())
    .map(([username, count]) => ({ username, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8)
  return { lines, count: lines.length, sessions, total, types: Object.fromEntries(types), hourly, topSessions, sources }
}

/** Local-date parser used by day/period collection. */
function toStartSeconds(date: string, plusDays = 0): number {
  const parts = date.split('-').map(n => parseInt(n, 10))
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return NaN
  return Math.floor(new Date(parts[0], parts[1] - 1, parts[2] + plusDays).getTime() / 1000)
}

/**
 * Collect one day of messages across sessions (chronological, capped).
 * @param decryptedDir - decrypted data root.
 * @param date - YYYY-MM-DD local date.
 * @param maxPerSession - cap messages per session (default 30).
 * @param groupUsername - optional session filter (only this talker).
 * @returns per-session message lines.
 */
export function collectDayMessages(
  decryptedDir: string,
  date: string,
  maxPerSession?: number,
  groupUsername?: string,
): CollectedSummary {
  const cap = Math.min(maxPerSession ?? 30, 200)
  const start = toStartSeconds(date)
  const end = toStartSeconds(date, 1)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return EMPTY_COLLECTED
  return collectRange(decryptedDir, start, end, cap, groupUsername)
}

/**
 * Collect messages across an inclusive local date range.
 * @param decryptedDir - decrypted data root.
 * @param from - first date (YYYY-MM-DD).
 * @param to - last date (YYYY-MM-DD, inclusive).
 * @param maxPerSession - cap messages per session (default 30).
 * @param groupUsername - optional session filter (only this talker).
 * @returns per-session message lines.
 */
export function collectPeriodMessages(
  decryptedDir: string,
  from: string,
  to: string,
  maxPerSession?: number,
  groupUsername?: string,
): CollectedSummary {
  const cap = Math.min(maxPerSession ?? 30, 200)
  const start = toStartSeconds(from)
  const end = toStartSeconds(to, 1)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return EMPTY_COLLECTED
  return collectRange(decryptedDir, start, end, cap, groupUsername)
}

/**
 * Collect period messages with per-message source (username/localId/time).
 * @param decryptedDir - decrypted data root.
 * @param from - first date (YYYY-MM-DD).
 * @param to - last date (YYYY-MM-DD, inclusive).
 * @param maxPerSession - cap messages per session (default 30).
 * @param groupUsername - optional session filter (only this talker).
 * @returns source-indexed message lines.
 */
export function collectPeriodLinesWithSources(
  decryptedDir: string,
  from: string,
  to: string,
  maxPerSession?: number,
  groupUsername?: string,
): { lines: string[]; sources: SourceLine[] } {
  const cap = Math.min(maxPerSession ?? 30, 200)
  const start = toStartSeconds(from)
  const end = toStartSeconds(to, 1)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return { lines: [], sources: [] }
  const r = collectRange(decryptedDir, start, end, cap, groupUsername, true)
  return { lines: r.lines, sources: r.sources }
}
