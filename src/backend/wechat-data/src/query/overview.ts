/**
 * Overview (数据总览) aggregate stats over st_control's decrypted DBs.
 * Mirrors the Rust get_wechat_data_overview: one-screen asset summary.
 */
import { DatabaseSync } from './db-open.ts'
import { raiseAnalyticsCache } from '../sqlite-connection.ts'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { cachedBySigAsync, contactMeta, fileSigOf, shardCatalogSig } from './meta.ts'
import { YIELD_EVERY_ROWS, yieldToLoop } from './search-build.ts'
import { queryTraceBegin, queryTraceMark } from './query-trace.ts'
import { loadSigCached, saveSigCached } from './sig-disk-cache.ts'

/**
 * 「签名 + 结果」磁盘缓存位置：`<数据根>/cache/overview.v1.json`。
 *
 * 冷算实测 ~98ms（resource 聚合 41ms 最大）；同一份解密数据第二次启动还要重算纯属浪费。
 * 命中判断靠签名（含资源库/分片目录），数据一变自动失效。
 */
function overviewCachePath(dec: string): string {
  return join(dirname(dec), 'cache', 'overview.v1.json')
}
import { classifyPacked } from './resource-classify.ts'
import { withDb, withDbAsync } from './db-open.ts'
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
    return withDb(path, (db) => {
      const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined
      if (!has) return 0
      const sql = `SELECT COUNT(*) AS n FROM ${table}${where ? ' WHERE ' + where : ''}`
      const r = db.prepare(sql).get() as { n: number }
      return r.n
    })
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
async function countRevokedAcrossShards(dec: string): Promise<number> {
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
    // 2026-09-28：分片级让出。本机真实数据实测 `queryOverview` 冷跑 **78ms 且一次都不让出**
    // （`working/probe-stall.txt`，是最后一个"整段独占"接口），这一段要逐张打开全部
    // 消息分片（146MB + 46MB + …）找反撤回表 —— 不打散就是几十毫秒按住整条队列。
    await yieldToLoop()
  }
  return total
}

/**
 * Aggregate the overview stats.
 * @param decryptedDir - decrypted data root.
 * @returns the overview result.
 */
export async function queryOverview(decryptedDir: string): Promise<OverviewResult> {
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
  return cachedBySigAsync('overview:' + dec, sig, () => computeOverview(dec, sig), 30_000)
}

async function computeOverview(dec: string, sig: string): Promise<OverviewResult> {
  queryTraceBegin('overview')
  // 跨启动复用：签名一致直接返回上次结果（跳过下面全部扫描）。
  const diskHit = loadSigCached<OverviewResult>(overviewCachePath(dec), sig)
  if (diskHit !== null) {
    queryTraceMark('overview', 'disk-hit')
    return diskHit
  }
  const cstats = queryContacts(dec).stats
  queryTraceMark('overview', 'contacts')
  const sessions = countRows(join(dec, 'session', 'session.db'), 'SessionTable')
  const groups = cstats.group ?? 0
  const contacts = cstats.friend ?? 0
  const official = (cstats.official ?? 0) + (cstats.service ?? 0)
  const moments = countRows(join(dec, 'sns', 'sns.db'), 'SnsTimeLine')
  const favorites = countRows(join(dec, 'favorite', 'favorite.db'), 'fav_db_item')
  const emoticons = countRows(join(dec, 'emoticon', 'emoticon.db'), 'kNonStoreEmoticonTable')
  queryTraceMark('overview', 'counts')
  const revoked = await countRevokedAcrossShards(dec)
  queryTraceMark('overview', 'revoked', revoked)

  // storage
  let total_size = 0
  let total_count = 0
  const categories: StorageCategory[] = []
  const resourcePath = join(dec, 'message', 'message_resource.db')
  if (existsSync(resourcePath)) {
    try {
      withDb(resourcePath, (db) => {
        // 分析型查询（29MB 资源库 GROUP BY type）：全局读缓存 256KB 会反复打穿，
        // 只给这条连接临时抬高（与 getStorageStats 同一口径）。
        raiseAnalyticsCache(db)
        const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='MessageResourceDetail'").get() !== undefined
        if (!has) return
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
      })
    } catch { /* resource db unavailable */ }
  }
  queryTraceMark('overview', 'resource', total_count)

  // moments authors (Top 20)
  const moments_authors: MomentsAuthorStat[] = []
  const snsPath = existsSync(join(dec, 'sns', 'db_sns', 'sns.db')) ? join(dec, 'sns', 'db_sns', 'sns.db') : join(dec, 'sns', 'sns.db')
  if (existsSync(snsPath)) {
    try {
      // `withDbAsync`（不是 `withDb`）：下面游标要 `await yieldToLoop()`，而同步版的
      // `finally` 会在第一次让出时就把连接关掉（见 `db-open.ts:70-83`）。
      await withDbAsync(snsPath, async (db) => {
        const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='SnsTimeLine'").get() !== undefined
        if (!has) return
        const cols = new Set(db.prepare('PRAGMA table_info(SnsTimeLine)').all().map(r => r.name))
        const uname = cols.has('user_name') ? 'user_name' : 'userName'
        const cname = cols.has('content') ? 'content' : 'Content'
        const names = contactMeta(dec).names
        const authorMap = new Map<string, { name: string; posts: number }>()
        // 游标读（N8）：`SnsTimeLine` 随朋友圈条数增长，`.all()` 会把整表先物化成数组，
        // 而这里只是逐条累加一个 Map —— 读完即释放。
        const sql = `SELECT ${uname} AS u, ${cname} AS c FROM SnsTimeLine`
        let sinceYield = 0
        for (const r of db.prepare(sql).iterate() as Iterable<{ u: string; c?: unknown }>) {
          const u = cellStr(r.u)
          if (!u) continue
          const cur = authorMap.get(u)
          if (cur) cur.posts += 1
          else authorMap.set(u, { name: names.get(u) || xmlNickname(cellStr(r.c)) || u, posts: 1 })
          // 2026-09-28：行级让出（同 `wordcloud.ts` 的双阈值口径）。
          sinceYield += 1
          if (sinceYield >= YIELD_EVERY_ROWS) { sinceYield = 0; await yieldToLoop() }
        }
        const sorted = Array.from(authorMap.entries())
          .map(([username, v]) => ({ username, name: v.name, posts: v.posts }))
          .sort((a, b) => b.posts - a.posts)
          .slice(0, 20)
        for (const a of sorted) moments_authors.push(a)
      })
    } catch { /* no sns */ }
  }
  queryTraceMark('overview', 'sns', moments_authors.length)

  const result: OverviewResult = {
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
  queryTraceMark('overview', 'done')
  // 落盘纯缓存：签名一致时下次启动直接命中（写失败只影响下次重算）。
  saveSigCached(overviewCachePath(dec), sig, result)
  return result
}
