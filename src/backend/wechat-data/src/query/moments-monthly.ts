/**
 * Full moments monthly distribution (all history, unfiltered by pagination).
 * The "all months" histogram counts every timeline row by create-time month, so
 * it reflects the whole feed rather than only the initially loaded page.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { MomentsMonthlySnapshot } from '../types.ts'
import { withDbAsync } from './db-open.ts'
import { parseSnsXml } from './moments.ts'
import { cachedBySigAsync, contactMeta, fileSigOf, INSIGHTS_TTL_MS } from './meta.ts'
import { YIELD_EVERY_ROWS, yieldToLoop } from './search-build.ts'

/** 与 `moments-insights.ts` 同一口径的字符级阈值（见那边的取值依据）。 */
const MOMENTS_YIELD_EVERY_CHARS = 1 << 20

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
 * @returns 月度快照：只有**确认读到过**才回空的 `months`；读失败时 `readError` 非空。
 */
export async function queryMomentsMonthly(decryptedDir: string, author?: string, authorName?: string): Promise<MomentsMonthlySnapshot> {
  const dbPath = snsDb(decryptedDir)
  // 签名覆盖 sns.db 与 contact.db（`authorName` 那条路径会用 contactMeta 解析昵称）。
  // 原先只签 sns.db，靠「事件后整表清空」兜住 —— M8 去掉那层兜底后补齐。
  const sig = [
    dbPath === null ? '' : fileSigOf(dbPath),
    fileSigOf(join(decryptedDir, 'contact', 'contact.db')),
  ].join('|')
  // 2026-09-28：同步 `cachedBySig` → async 版（游标要让出，见 computeMomentsMonthly 内注释）。
  return cachedBySigAsync('moments-monthly:' + decryptedDir + ':' + (author ?? '') + ':' + (authorName ?? ''), sig, () => computeMomentsMonthly(decryptedDir, author, authorName), INSIGHTS_TTL_MS)
}

async function computeMomentsMonthly(decryptedDir: string, author?: string, authorName?: string): Promise<MomentsMonthlySnapshot> {
  const dbPath = snsDb(decryptedDir)
  // 压根没有 sns.db = 这台机器从没拉过朋友圈：**确认空**，不是读失败（别拿它吓用户）。
  if (dbPath === null) return { months: [] }
  try {
    // `await` 是**必须**的（2026-09-28 踩过）：回退成 `return withDbAsync(...)` 时，
    // 坏库那条路上 `db.prepare()` 的同步抛错**不会**被下面这个 catch 接住 ——
    // 实测表现是 `queryMomentsMonthly` 直接 reject，而不是回 `{months:[], readError}`，
    // 于是「库读不动」又被当成异常冒到渲染层（正是 P1-1/#9 要消灭的那件事）。
    // `read-failure-contract.spec.ts` 的坏库用例就是这个形状的守卫。
    return await withDbAsync(dbPath, async (db) => {
      const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='SnsTimeLine'").get() !== undefined
      if (!has) return { months: [] }
      const cols = new Set((db.prepare('PRAGMA table_info(SnsTimeLine)').all() as Array<{ name: string }>).map(r => r.name))
      const userCol = cols.has('user_name') ? 'user_name' : cols.has('userName') ? 'userName' : ''
      const contentCol = cols.has('content') ? 'content' : cols.has('Content') ? 'Content' : ''
      if (!userCol || !contentCol) return { months: [] }
      // Username filter is applied in SQL (sns db is indexed by user); display-name
      // filtering needs the name map, so fetch rows and resolve per-row in JS.
      const where = author && !authorName ? ` WHERE ${userCol} = ?` : ''
      // 2026-09-28：`.all()` → 游标 + 双阈值让出。
      // 覆盖面探针（`working/probe-coverage.txt`）测出本接口冷跑 **165ms 且一次都不让出**
      // —— 是当时**唯一**超过 50ms 的独占项（此前只量了 12 个接口，它从没被测到）。
      // 这里逐行要跑 `parseSnsXml` 取 createTime，是纯 CPU 的重活，必须打散。
      const rows = db.prepare(`SELECT ${userCol} AS u, ${contentCol} AS c FROM SnsTimeLine${where}`).iterate(...(author && !authorName ? [author] : [])) as Iterable<{ u: unknown; c: unknown }>
      // Resolve display names only when needed so the unfiltered path stays cheap.
      const names = authorName ? contactMeta(decryptedDir).names : null
      const monthly = new Map<string, number>()
      let sinceYield = 0
      let charsSinceYield = 0
      for (const r of rows) {
        const xml = cellString(r.c)
        sinceYield += 1
        charsSinceYield += xml.length
        if (sinceYield >= YIELD_EVERY_ROWS || charsSinceYield >= MOMENTS_YIELD_EVERY_CHARS) {
          sinceYield = 0
          charsSinceYield = 0
          await yieldToLoop()
        }
        if (authorName) {
          const u = cellString(r.u)
          if ((names?.get(u) || u || '未知') !== authorName) continue
        }
        if (!xml) continue
        const createTime = parseSnsXml(xml).createTime
        if (createTime <= 0) continue
        const d = new Date(createTime * 1000)
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
        monthly.set(key, (monthly.get(key) ?? 0) + 1)
      }
      return {
        months: Array.from(monthly.entries())
          .map(([month, count]: [string, number]) => ({ month, count }))
          .sort((a, b) => a.month.localeCompare(b.month)),
      }
    })
  } catch (e) {
    // P1-1/#9：这里以前只回空数组 —— 面板于是画成「这个月一条都没有」，而真实原因是
    // 快照损坏 / 库被占用。空直方图与「读不到」必须是两件事。
    const msg = e instanceof Error ? e.message : String(e)
    console.warn('[moments-monthly] 读取失败：' + dbPath + ': ' + msg)
    return { months: [], readError: '朋友圈月度分布读取失败：' + msg }
  }
}
