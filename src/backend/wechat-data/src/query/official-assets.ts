/**
 * Official account content assets: for each public account (gh_*), count total
 * messages, article-type (local_type 49) messages and the latest article time.
 */
import { DatabaseSync } from './db-open.ts'
import { withDb } from './db-open.ts'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { decompress } from 'fzstd'
import { cachedBySigAsync, fileSigOf, INSIGHTS_TTL_MS, shardCatalogSig } from './meta.ts'
import { yieldToLoop } from './search-build.ts'
import type { OfficialAssetsSnapshot, OfficialAssetRow } from '../types.ts'
import { displayNameForUsername, messageTableName } from './message-identity.ts'

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
  const byTable = new Map<string, string>()
  for (const username of usernames) byTable.set(messageTableName(username), username)
  const dir = join(decryptedDir, 'message')
  if (existsSync(dir) && byTable.size > 0) {
    for (const f of readdirSync(dir)) {
      if (!/^(biz_)?message_\d+\.db$/.test(f)) continue
      let db: DatabaseSync
      try { db = new DatabaseSync(join(dir, f), { readOnly: true }) } catch { continue }
      try {
        const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'").all() as Array<{ name: string }>).map(r => r.name)
        for (const table of tables) {
          const username = byTable.get(table)
          if (!username) continue
          const cols = tableColumns(db, table)
          if (!cols.has('create_time') || !cols.has('local_type')) continue
          try {
            // 一条聚合代替逐行把整张 Msg_* 拉进 JS。公众号会话可以有十几万行，
            // 行循环会按住后端队列，面板点击后一直停在「统计中」。
            const row = db.prepare(
              `SELECT COUNT(*) AS messages,
                      SUM(CASE WHEN (local_type & 4294967295) = 49 THEN 1 ELSE 0 END) AS articles,
                      MAX(CASE WHEN (local_type & 4294967295) = 49 AND create_time > 0 THEN create_time END) AS lastArticleTime
                 FROM "${table}"`,
            ).get() as { messages: number; articles: number | null; lastArticleTime: number | null } | undefined
            if (!row || row.messages <= 0) continue
            per.set(username, {
              messages: row.messages,
              articles: Number(row.articles ?? 0),
              lastArticleTime: row.lastArticleTime && row.lastArticleTime > 0 ? row.lastArticleTime : null,
            })
          } catch { /* skip */ }
        }
      } finally { db.close() }
      await yieldToLoop()
    }
  }
  const rows: OfficialAssetRow[] = Array.from(per.entries())
    .map(([username, v]) => ({ username, name: displayNameForUsername(username, names), ...v }))
    .filter(r => r.messages > 0)
    .sort((a, b) => b.messages - a.messages)
    .slice(0, 100)
  return { rows, total: rows.length, updatedAt: Math.floor(Date.now() / 1000) }
}
