/**
 * Full moments monthly distribution (all history, unfiltered by pagination).
 * The "all months" histogram counts every timeline row by create-time month, so
 * it reflects the whole feed rather than only the initially loaded page.
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { MomentsMonthlyRow } from '../types.ts'
import { parseSnsXml } from './moments.ts'
import { cachedBySig, contactMeta, fileSigOf } from './meta.ts'

/** Stringify an SQLite cell (TEXT/NUMBER/BLOB) to a string. */
function cellString(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (v instanceof Uint8Array) return new TextDecoder('utf-8', { fatal: false }).decode(v)
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol') return String(v)
  return ''
}

function snsDb(decryptedDir: string): string | null {
  for (const p of [join(decryptedDir, 'sns', 'db_sns', 'sns.db'), join(decryptedDir, 'sns', 'sns.db')]) {
    if (existsSync(p)) return p
  }
  return null
}

/**
 * Compute the full monthly distribution of moments, optionally for one author.
 * @param decryptedDir - decrypted data root.
 * @param author - optional author username filter (all authors when omitted).
 * @param authorName - optional author display-name filter, matching the author
 *   chips (all authors when omitted). Takes precedence over `author` when set.
 * @returns monthly rows sorted ascending by month.
 */
export function queryMomentsMonthly(decryptedDir: string, author?: string, authorName?: string): MomentsMonthlyRow[] {
  const dbPath = snsDb(decryptedDir)
  // 签名覆盖 sns.db 与 contact.db（`authorName` 那条路径会用 contactMeta 解析昵称）。
  // 原先只签 sns.db，靠「事件后整表清空」兜住 —— M8 去掉那层兜底后补齐。
  const sig = [
    dbPath === null ? '' : fileSigOf(dbPath),
    fileSigOf(join(decryptedDir, 'contact', 'contact.db')),
  ].join('|')
  return cachedBySig('moments-monthly:' + decryptedDir + ':' + (author ?? '') + ':' + (authorName ?? ''), sig, () => computeMomentsMonthly(decryptedDir, author, authorName))
}

function computeMomentsMonthly(decryptedDir: string, author?: string, authorName?: string): MomentsMonthlyRow[] {
  const dbPath = snsDb(decryptedDir)
  if (dbPath === null) return []
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='SnsTimeLine'").get() !== undefined
    if (!has) { db.close(); return [] }
    const cols = new Set((db.prepare('PRAGMA table_info(SnsTimeLine)').all() as Array<{ name: string }>).map(r => r.name))
    const userCol = cols.has('user_name') ? 'user_name' : cols.has('userName') ? 'userName' : ''
    const contentCol = cols.has('content') ? 'content' : cols.has('Content') ? 'Content' : ''
    if (!userCol || !contentCol) { db.close(); return [] }
    // Username filter is applied in SQL (sns db is indexed by user); display-name
    // filtering needs the name map, so fetch rows and resolve per-row in JS.
    const where = author && !authorName ? ` WHERE ${userCol} = ?` : ''
    const rows = db.prepare(`SELECT ${userCol} AS u, ${contentCol} AS c FROM SnsTimeLine${where}`).all(...(author && !authorName ? [author] : [])) as Array<{ u: unknown; c: unknown }>
    db.close()
    // Resolve display names only when needed so the unfiltered path stays cheap.
    const names = authorName ? contactMeta(decryptedDir).names : null
    const monthly = new Map<string, number>()
    for (const r of rows) {
      if (authorName) {
        const u = cellString(r.u)
        if ((names?.get(u) || u || '未知') !== authorName) continue
      }
      const xml = cellString(r.c)
      if (!xml) continue
      const createTime = parseSnsXml(xml).createTime
      if (createTime <= 0) continue
      const d = new Date(createTime * 1000)
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      monthly.set(key, (monthly.get(key) ?? 0) + 1)
    }
    return Array.from(monthly.entries())
      .map(([month, count]) => ({ month, count }))
      .sort((a, b) => a.month.localeCompare(b.month))
  } catch {
    // Keep the histogram empty rather than crashing the panel on a bad DB.
    return []
  }
}
