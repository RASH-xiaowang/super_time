/**
 * Favorites + emoticon asset insights: favorite counts by type/year, custom
 * and store emoticon counts, and top-used emoticon md5s from message shards.
 */
import { DatabaseSync } from 'node:sqlite'
import { withDb } from './db-open.ts'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { decompress } from 'fzstd'
import { cachedBySigAsync, fileSigOf, shardCatalogSig } from './meta.ts'
import { YIELD_EVERY_ROWS, yieldToLoop } from './search-build.ts'
import type { AssetInsightsSnapshot } from '../types.ts'
import { favTypeLabel } from './favorites.ts'

const ZSTD_MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD])

function decodeCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol') return String(v)
  const raw = Buffer.from(v instanceof Uint8Array ? v : [])
  const decompressed = raw.length >= 4 && raw.subarray(0, 4).equals(ZSTD_MAGIC)
    ? (() => { try { return Buffer.from(decompress(raw)) } catch { return raw } })()
    : raw
  try { return new TextDecoder('utf-8', { fatal: false }).decode(decompressed) } catch { return '' }
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined
}

function tableColumns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return new Set(rows.map(r => r.name))
}

function favoriteStats(decryptedDir: string): AssetInsightsSnapshot['favorites'] {
  const p = join(decryptedDir, 'favorite', 'favorite.db')
  if (!existsSync(p)) return { total: 0, byType: [], byYear: [] }
  try {
    return withDb(p, (db) => {
    const has = tableExists(db, 'fav_db_item')
    if (!has) return { total: 0, byType: [], byYear: [] }
    const cols = tableColumns(db, 'fav_db_item')
    const typeCol = cols.has('type') ? 'type' : cols.has('Type') ? 'Type' : ''
    const timeCol = cols.has('update_time') ? 'update_time' : cols.has('UpdateTime') ? 'UpdateTime' : ''
    const typeRows = typeCol
      ? db.prepare(`SELECT ${typeCol} AS t, COUNT(*) AS n FROM fav_db_item GROUP BY ${typeCol}`).all() as Array<{ t: number; n: number }>
      : []
    const yearRows = timeCol
      ? db.prepare(`SELECT CAST(strftime('%Y', datetime(${timeCol}, 'unixepoch')) AS INTEGER) AS y, COUNT(*) AS n FROM fav_db_item GROUP BY y ORDER BY y DESC`).all() as Array<{ y: number; n: number }>
      : []
    const totalRow = db.prepare('SELECT COUNT(*) AS n FROM fav_db_item').get() as { n: number } | undefined
    return {
      total: totalRow?.n ?? 0,
      byType: typeRows
        .map(r => ({ type: r.t, label: favTypeLabel(r.t), count: r.n }))
        .sort((a, b) => b.count - a.count),
      byYear: yearRows.map(r => ({ year: r.y, count: r.n })),
    }
    })
  } catch {
    return { total: 0, byType: [], byYear: [] }
  }
}

function emoticonStats(decryptedDir: string, topUsages: Array<{ md5: string; count: number }>): AssetInsightsSnapshot['emoticons'] {
  const p = join(decryptedDir, 'emoticon', 'emoticon.db')
  let customCount = 0
  let storePackages = 0
  let captions = 0
  if (existsSync(p)) {
    try {
      withDb(p, (db) => {
        if (tableExists(db, 'kNonStoreEmoticonTable')) customCount = (db.prepare('SELECT COUNT(*) AS n FROM kNonStoreEmoticonTable').get() as { n: number }).n
        if (tableExists(db, 'kStoreEmoticonPackageTable')) storePackages = (db.prepare('SELECT COUNT(*) AS n FROM kStoreEmoticonPackageTable').get() as { n: number }).n
        if (tableExists(db, 'kStoreEmoticonCaptionsTable')) captions = (db.prepare('SELECT COUNT(*) AS n FROM kStoreEmoticonCaptionsTable').get() as { n: number }).n
      })
    } catch { /* keep zeros */ }
  }
  return { customCount, storePackages, captions, topUsed: topUsages }
}

async function topEmoticonUsage(decryptedDir: string, cap: number): Promise<Array<{ md5: string; count: number }>> {
  const counts = new Map<string, number>()
  const dir = join(decryptedDir, 'message')
  if (!existsSync(dir)) return []
  const re = /md5\s*=\s*["']([A-Fa-f0-9]{16,})["']/
  for (const f of readdirSync(dir)) {
    if (!/^(biz_)?message_\d+\.db$/.test(f)) continue
    let db: DatabaseSync
    try { db = new DatabaseSync(join(dir, f), { readOnly: true }) } catch { continue }
    try {
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'").all() as Array<{ name: string }>).map(r => r.name)
      for (const table of tables) {
        const cols = tableColumns(db, table)
        if (!cols.has('local_type') || !cols.has('message_content')) continue
        try {
          // 游标读（N8）：整张 Msg_* 随消息量增长，这里只是挑出 `local_type=47` 的行后计数。
          // 2026-09-28：加**行级让出** —— 本机真实数据实测 `queryAssetInsights` 冷跑
          // **155ms 且一次都不让出**（`working/probe-stall.txt`），是当时"整段独占"清单里最长的一个。
          // 该接口要逐张打开全部消息分片（本机 146MB + 46MB + …），不让出就是按住整条队列。
          const sql = `SELECT local_type, message_content FROM "${table}" WHERE (local_type & 4294967295) = 47`
          let sinceYield = 0
          for (const r of db.prepare(sql).iterate() as Iterable<Record<string, unknown>>) {
            const m = re.exec(decodeCell(r['message_content']))
            const md5 = m ? (m[1] ?? '') : ''
            if (md5) counts.set(md5, (counts.get(md5) ?? 0) + 1)
            sinceYield += 1
            if (sinceYield >= YIELD_EVERY_ROWS) { sinceYield = 0; await yieldToLoop() }
          }
        } catch { /* skip */ }
      }
    } finally { db.close() }
    // 分片级让出：一张分片几百 MB 的表扫完不给别人机会，下一张就不用开了。
    await yieldToLoop()
  }
  return Array.from(counts.entries()).map(([md5, count]) => ({ md5, count })).sort((a, b) => b.count - a.count).slice(0, cap)
}

/**
 * Compute favorites + emoticon asset insights.
 * @param decryptedDir - decrypted data root.
 * @returns the asset insights snapshot.
 */
export async function queryAssetInsights(decryptedDir: string): Promise<AssetInsightsSnapshot> {
  const sig = [
    fileSigOf(join(decryptedDir, 'favorite', 'favorite.db')),
    fileSigOf(join(decryptedDir, 'emoticon', 'emoticon.db')),
    shardCatalogSig(decryptedDir, ['message']),
  ].join('|')
  // 2026-09-28：由同步 `cachedBySig` 换成 async 版 —— 冷算实测 155ms 且**一次都不让出**
  // （真实数据 `working/probe-stall.txt`，是当时"整段独占"清单里最长的一个）。
  return cachedBySigAsync('asset-insights:' + decryptedDir, sig, () => computeAssetInsights(decryptedDir), 30_000)
}

async function computeAssetInsights(decryptedDir: string): Promise<AssetInsightsSnapshot> {
  const favorites = favoriteStats(decryptedDir)
  const topUsed = await topEmoticonUsage(decryptedDir, 10)
  return {
    favorites,
    emoticons: emoticonStats(decryptedDir, topUsed),
    updatedAt: Math.floor(Date.now() / 1000),
  }
}
