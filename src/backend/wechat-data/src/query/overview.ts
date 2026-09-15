/**
 * Overview (数据总览) aggregate stats over st_control's decrypted DBs.
 * Mirrors the Rust get_wechat_data_overview: one-screen asset summary.
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { cachedBySig, contactMeta, fileSigOf, shardCatalogSig } from './meta.ts'
import { classifyPacked } from './resource-classify.ts'
import { queryContacts } from './contacts.ts'

interface StorageCategory { label: string; count: number; size: number }
interface MomentsAuthorStat { username: string; name: string; posts: number }

/** The one-screen data overview aggregate result. */
export interface OverviewResult {
  sessions: number
  groups: number
  contacts: number
  official: number
  moments: number
  favorites: number
  emoticons: number
  revoked: number
  storage: { total_size: number; total_count: number; categories: StorageCategory[] }
  moments_authors: MomentsAuthorStat[]
}

function countRows(path: string, table: string, where = ''): number {
  if (!existsSync(path)) return 0
  try {
    const db = new DatabaseSync(path, { readOnly: true })
    const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined
    if (!has) { db.close(); return 0 }
    const sql = `SELECT COUNT(*) AS n FROM ${table}${where ? ' WHERE ' + where : ''}`
    const r = db.prepare(sql).get() as { n: number }
    db.close()
    return r.n
  } catch {
    return 0
  }
}

/** Stringify a DB cell. */
function cellStr(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === null || v === undefined) return ''
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol') return String(v)
  if (v instanceof Uint8Array) return new TextDecoder('utf-8', { fatal: false }).decode(v)
  return ''
}

/** 朋友圈 XML 里的第一个 <nickname> 显示名。 */
function xmlNickname(xml: string): string {
  const m = xml.match(/<nickname>([^<]*)<\/nickname>/)
  return m ? (m[1] ?? '').replace(/&amp;/g, '&') : ''
}
/**
 * Count revoked-message cache rows across every message shard. The cache
 * table (`_weflow_anti_revoke_deleted_cache`) lives in whichever shard holds
 * it — hardcoding message_0.db misses revokes recorded in other shards.
 * @param dec - decrypted data root.
 * @returns the total row count across all shards.
 */
function countRevokedAcrossShards(dec: string): number {
  const msgDir = join(dec, 'message')
  if (!existsSync(msgDir)) return 0
  let total = 0
  for (const file of readdirSync(msgDir)) {
    if (!file.endsWith('.db') || file.includes('_shm') || file.includes('_wal') || file.includes('tmp')) continue
    try {
      const db = new DatabaseSync(join(msgDir, file), { readOnly: true })
      try {
        const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(r => r.name)
        const hit = tables.find(t => t.includes('_weflow_anti_revoke_deleted_cache'))
        if (hit) total += (db.prepare(`SELECT COUNT(*) AS n FROM "${hit}"`).get() as { n: number }).n
      } finally {
        db.close()
      }
    } catch { /* skip unreadable shard */ }
  }
  return total
}

/**
 * Aggregate the overview stats.
 * @param decryptedDir - decrypted data root.
 * @returns the overview result.
 */
export function queryOverview(decryptedDir: string): OverviewResult {
  const dec = decryptedDir
  // Fingerprint the databases the aggregate reads; the 5s max-age bounds
  // recomputation while the realtime sync keeps the files fresh.
  const sig = [
    fileSigOf(join(dec, 'session', 'session.db')),
    fileSigOf(join(dec, 'contact', 'contact.db')),
    fileSigOf(join(dec, 'sns', 'sns.db')),
    fileSigOf(join(dec, 'sns', 'db_sns', 'sns.db')),
    fileSigOf(join(dec, 'favorite', 'favorite.db')),
    fileSigOf(join(dec, 'emoticon', 'emoticon.db')),
    fileSigOf(join(dec, 'message', 'message_resource.db')),
    shardCatalogSig(dec, ['message']),
  ].join('|')
  return cachedBySig('overview:' + dec, sig, () => computeOverview(dec), 30_000)
}

function computeOverview(dec: string): OverviewResult {
  const cstats = queryContacts(dec).stats
  const sessions = countRows(join(dec, 'session', 'session.db'), 'SessionTable')
  const groups = cstats.group ?? 0
  const contacts = cstats.friend ?? 0
  const official = (cstats.official ?? 0) + (cstats.service ?? 0)
  const moments = countRows(join(dec, 'sns', 'sns.db'), 'SnsTimeLine')
  const favorites = countRows(join(dec, 'favorite', 'favorite.db'), 'fav_db_item')
  const emoticons = countRows(join(dec, 'emoticon', 'emoticon.db'), 'kNonStoreEmoticonTable')
  const revoked = countRevokedAcrossShards(dec)

  // storage
  let total_size = 0
  let total_count = 0
  const categories: StorageCategory[] = []
  const resourcePath = join(dec, 'message', 'message_resource.db')
  if (existsSync(resourcePath)) {
    try {
      const db = new DatabaseSync(resourcePath, { readOnly: true })
      const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='MessageResourceDetail'").get() !== undefined
      if (has) {
        const agg = db.prepare('SELECT COALESCE(SUM(size), 0) AS s, COUNT(*) AS n FROM MessageResourceDetail').get() as { s: number; n: number }
        total_size = agg.s
        total_count = agg.n
        const rows = db.prepare('SELECT type, COUNT(*) AS c, SUM(size) AS s FROM MessageResourceDetail GROUP BY type').all() as Array<{ type: number; c: number; s: number }>
        const catMap = new Map<string, StorageCategory>()
        for (const r of rows) {
          // look up a sample file name for extension classification
          const sample = db.prepare('SELECT packed_info FROM MessageResourceDetail WHERE type = ? LIMIT 1').get(r.type) as { packed_info?: Uint8Array | null } | undefined
          const label = classifyPacked(r.type, sample?.packed_info)
          const cur = catMap.get(label) ?? { label, count: 0, size: 0 }
          cur.count += r.c
          cur.size += r.s
          catMap.set(label, cur)
        }
        for (const c of catMap.values()) categories.push(c)
      }
      db.close()
    } catch { /* resource db unavailable */ }
  }

  // moments authors (Top 20)
  const moments_authors: MomentsAuthorStat[] = []
  const snsPath = existsSync(join(dec, 'sns', 'db_sns', 'sns.db')) ? join(dec, 'sns', 'db_sns', 'sns.db') : join(dec, 'sns', 'sns.db')
  if (existsSync(snsPath)) {
    try {
      const db = new DatabaseSync(snsPath, { readOnly: true })
      const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='SnsTimeLine'").get() !== undefined
      if (has) {
        const cols = new Set(db.prepare('PRAGMA table_info(SnsTimeLine)').all().map(r => r.name))
        const uname = cols.has('user_name') ? 'user_name' : 'userName'
        const cname = cols.has('content') ? 'content' : 'Content'
        const names = contactMeta(dec).names
        const authorMap = new Map<string, { name: string; posts: number }>()
        // 游标读（N8）：`SnsTimeLine` 随朋友圈条数增长，`.all()` 会把整表先物化成数组，
        // 而这里只是逐条累加一个 Map —— 读完即释放。
        const sql = `SELECT ${uname} AS u, ${cname} AS c FROM SnsTimeLine`
        for (const r of db.prepare(sql).iterate() as Iterable<{ u: string; c?: unknown }>) {
          const u = cellStr(r.u)
          if (!u) continue
          const cur = authorMap.get(u)
          if (cur) cur.posts += 1
          else authorMap.set(u, { name: names.get(u) || xmlNickname(cellStr(r.c)) || u, posts: 1 })
        }
        const sorted = Array.from(authorMap.entries())
          .map(([username, v]) => ({ username, name: v.name, posts: v.posts }))
          .sort((a, b) => b.posts - a.posts)
          .slice(0, 20)
        for (const a of sorted) moments_authors.push(a)
      }
      db.close()
    } catch { /* no sns */ }
  }

  return {
    sessions,
    groups,
    contacts,
    official,
    moments,
    favorites,
    emoticons,
    revoked,
    storage: { total_size, total_count, categories },
    moments_authors,
  }
}
