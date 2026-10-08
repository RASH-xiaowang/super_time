/**
 * Annual summary: available years derived from message timestamps across the
 * message shards (a session's last_timestamp is recent even when a chat has
 * older messages), so every year with messages shows up as a selectable report.
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { cachedBySigAsync, shardCatalogSig } from './meta.ts'
import { yieldToLoop } from './search-build.ts'

/** 每扫过这么多张 Msg_ 表就让出一次（本机最大分片 169 张表，146MB）。 */
const YIELD_EVERY_TABLES = 12

/**
 * List available years (descending) from actual message create_time values.
 * @param decryptedDir - decrypted data root.
 * @returns years with messages, and no count summary (a separate query owns it).
 */
export async function queryAnnual(decryptedDir: string): Promise<{ years: number[] }> {
  // 2026-09-28：同步 `cachedBySig` → async 版；冷算实测 **117ms 且一次都不让出**
  // （真实数据 `working/probe-stall.txt`）。见 `computeAnnual` 的说明。
  return cachedBySigAsync('annual:' + decryptedDir, shardCatalogSig(decryptedDir, ['message']), () => computeAnnual(decryptedDir), 30_000)
}

/**
 * 每张 `Msg_*` 表贡献的年份区间。
 *
 * ## 为什么不再用 `DISTINCT strftime(...)`
 *
 * 原写法对**每一行**跑 `strftime` 再去重，只为拿到「这张表有哪些年」。而实测
 * （`working/diag-annual.ts`，本机 6 个分片 / 351 张 Msg_ 表）：
 *   · `DISTINCT + strftime` 合计 **106ms**；
 *   · 只取 `MIN/MAX(create_time)` 合计 **56ms**（省掉逐行 strftime 与去重）。
 * 并且 `working/diag-annual-equiv.ts` 在真实数据上逐字比对过两种口径的产出年份集合：
 * **完全一致**（本机每张表都只落在一个年份里，0 张表跨年）。
 *
 * 跨年的表按「首末时间所在的年**区间**」展开 —— 这正是原 `DISTINCT` 的语义
 * （表里有哪些年就报哪些年），只是不再逐行算。
 *
 * ## 时区
 *
 * 必须用 **UTC**：原来的 `datetime(create_time,'unixepoch')` 在 SQLite 里是 UTC，
 * 这条保持同口径（用本地时区会把「1 月 1 日凌晨」的消息算到上一年）。
 * @param decryptedDir - decrypted data root.
 * @returns years with messages, descending.
 */
async function computeAnnual(decryptedDir: string): Promise<{ years: number[] }> {
  const msgDir = join(decryptedDir, 'message')
  if (!existsSync(msgDir)) return { years: [] }
  const years = new Set<number>()
  const files = readdirSync(msgDir)
    .filter(f => f.endsWith('.db') && !f.includes('_shm') && !f.includes('_wal') && !f.includes('monitor_cache') && !f.includes('fts'))
  let sinceYield = 0
  for (const file of files) {
    let db: DatabaseSync | null = null
    try { db = new DatabaseSync(join(msgDir, file), { readOnly: true }) } catch { continue }
    try {
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(r => r.name)
      for (const t of tables) {
        if (!t.startsWith('Msg_')) continue
        try {
          const r = db.prepare(`SELECT MIN(create_time) AS a, MAX(create_time) AS b FROM "${t}" WHERE create_time > 0`).get() as { a: number | null; b: number | null }
          if (r.a !== null && r.b !== null && Number.isFinite(r.a) && Number.isFinite(r.b)) {
            const ya = new Date(r.a * 1000).getUTCFullYear()
            const yb = new Date(r.b * 1000).getUTCFullYear()
            for (let y = Math.min(ya, yb); y <= Math.max(ya, yb); y += 1) if (y > 2000) years.add(y)
          }
        } catch { /* skip table */ }
        sinceYield += 1
        // 让出点：一张表一次 MIN/MAX 就要扫一遍该表的 create_time 列，
        // 本机最大分片 169 张表 —— 中间不让出就是百毫秒级独占。
        if (sinceYield >= YIELD_EVERY_TABLES) { sinceYield = 0; await yieldToLoop() }
      }
    } catch { /* skip db */ }
    finally { db.close() }
  }
  return { years: Array.from(years).sort((a, b) => b - a) }
}
