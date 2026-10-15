/**
 * Official account content assets: for each public account (gh_*), count total
 * messages, article-type (local_type 49) messages and the latest article time.
 */
import { createHash } from 'node:crypto'
import { DatabaseSync } from './db-open.ts'
import { withDb } from './db-open.ts'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { decompress } from 'fzstd'
import { cachedBySigAsync, fileSigOf, INSIGHTS_TTL_MS, shardCatalogSig } from './meta.ts'
import { YIELD_EVERY_ROWS, yieldToLoop } from './search-build.ts'
import type { OfficialAssetsSnapshot, OfficialAssetRow } from '../types.ts'

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

function tableColumns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return new Set(rows.map(r => r.name))
}

function loadOfficialUsernames(decryptedDir: string): string[] {
  const p = join(decryptedDir, 'session', 'session.db')
  if (!existsSync(p)) return []
  try {
    return withDb(p, (db) => {
      const out: string[] = []
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(r => r.name)
      const table = tables.includes('SessionTable') ? 'SessionTable' : tables.includes('Session') ? 'Session' : ''
      if (table) {
        const rows = db.prepare(`SELECT username FROM "${table}"`).all() as Array<Record<string, unknown>>
        for (const r of rows) {
          const u = decodeCell(r['username']).trim()
          if (u.startsWith('gh_')) out.push(u)
        }
      }
      return out
    })
  } catch { /* ignore */ }
  return []
}

function loadNames(decryptedDir: string): Map<string, string> {
  const p = join(decryptedDir, 'contact', 'contact.db')
  if (!existsSync(p)) return new Map()
  try {
    return withDb(p, (db) => {
      const map = new Map<string, string>()
      const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='contact'").get() !== undefined
      if (has) {
        const cols = tableColumns(db, 'contact')
        if (cols.has('username')) {
          const remark = cols.has('remark') ? 'remark' : cols.has('Remark') ? 'Remark' : 'NULL'
          const nick = cols.has('nick_name') ? 'nick_name' : cols.has('NickName') ? 'NickName' : 'NULL'
          const rows = db.prepare(`SELECT username, COALESCE(NULLIF(${remark}, ''), ${nick}) AS n FROM contact`).all() as Array<Record<string, unknown>>
          for (const r of rows) {
            const u = decodeCell(r['username']).trim()
            const n = decodeCell(r['n']).trim()
            if (u && n) map.set(u, n)
          }
        }
      }
      return map
    })
  } catch { /* ignore */ }
  return new Map()
}

/**
 * Compute official account content assets.
 * @param decryptedDir - decrypted data root.
 * @returns the official-assets snapshot.
 */
export async function queryOfficialAssets(decryptedDir: string): Promise<OfficialAssetsSnapshot> {
  const sig = [
    fileSigOf(join(decryptedDir, 'session', 'session.db')),
    fileSigOf(join(decryptedDir, 'contact', 'contact.db')),
    shardCatalogSig(decryptedDir, ['message']),
  ].join('|')
  // 2026-09-28：同步 `cachedBySig` → async 版 —— 冷算实测 39ms 且**一次都不让出**
  // （真实数据 `working/probe-stall.txt`）。
  return cachedBySigAsync('official-assets:' + decryptedDir, sig, () => computeOfficialAssets(decryptedDir), INSIGHTS_TTL_MS)
}

async function computeOfficialAssets(decryptedDir: string): Promise<OfficialAssetsSnapshot> {
  const usernames = loadOfficialUsernames(decryptedDir)
  const names = loadNames(decryptedDir)
  const per = new Map<string, { messages: number; articles: number; lastArticleTime: number | null }>()
  const dir = join(decryptedDir, 'message')
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (!/^(biz_)?message_\d+\.db$/.test(f)) continue
      let db: DatabaseSync
      try { db = new DatabaseSync(join(dir, f), { readOnly: true }) } catch { continue }
      try {
        const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'").all() as Array<{ name: string }>).map(r => r.name)
        for (const table of tables) {
          const username = usernames.find(u => 'Msg_' + createHash('md5').update(u, 'utf8').digest('hex') === table)
          if (!username) continue
          const cols = tableColumns(db, table)
          if (!cols.has('create_time') || !cols.has('local_type')) continue
          try {
            // 2026-09-28：`.all()` → 游标 + 行级让出。
            // 本机真实数据实测 `queryOfficialAssets` 冷跑 **39ms 且一次都不让出**
            // （`working/probe-stall.txt`，是清零后**受测集里唯一剩下的独占项**）：
            // 它要逐张消息分片把公众号会话的整张 `Msg_*` 拉出来数条数（每行都要判定
            // `local_type === 49`），不打散就是几十毫秒按住整条串行队列。
            const cur = db.prepare(`SELECT create_time, local_type FROM "${table}"`).iterate() as Iterable<Record<string, unknown>>
            let acc = per.get(username)
            if (!acc) { acc = { messages: 0, articles: 0, lastArticleTime: null }; per.set(username, acc) }
            let sinceYield = 0
            for (const r of cur) {
              acc.messages += 1
              const lt = Number(r['local_type'] ?? 0) & 4294967295
              if (lt === 49) {
                acc.articles += 1
                const t = Number(r['create_time'] ?? 0)
                if (t > 0 && (acc.lastArticleTime == null || t > acc.lastArticleTime)) acc.lastArticleTime = t
              }
              sinceYield += 1
              if (sinceYield >= YIELD_EVERY_ROWS) { sinceYield = 0; await yieldToLoop() }
            }
          } catch { /* skip */ }
        }
      } finally { db.close() }
      // 分片级让出：一张分片可以有十几万行。
      await yieldToLoop()
    }
  }
  const rows: OfficialAssetRow[] = Array.from(per.entries())
    .map(([username, v]) => ({ username, name: names.get(username) ?? username, ...v }))
    .filter(r => r.messages > 0)
    .sort((a, b) => b.messages - a.messages)
    .slice(0, 100)
  return { rows, total: rows.length, updatedAt: Math.floor(Date.now() / 1000) }
}
