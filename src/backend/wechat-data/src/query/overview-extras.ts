/**
 * Overview extras: trend deltas, a 90-day activity heatmap, and data
 * freshness, computed over the same decrypted shards the overview reads.
 * Cached by file signature so it stays cheap on the live dashboard.
 */
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { contactMeta, shardCatalogDirs, shardCatalogSig, fileSigOf, cachedBySig, dataGenerationSig } from './meta.ts'
import type { OverviewExtras } from '../types.ts'


function cellStr(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === null || v === undefined) return ''
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol') return String(v)
  if (v instanceof Uint8Array) return new TextDecoder('utf-8', { fatal: false }).decode(v)
  return ''
}

function dayKey(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(0, 10)
}

/** Recursively enumerate .db / -wal sizes under a directory. */
function walkDb(dir: string, depth: number, out: { files: number; bytes: number; wal: boolean }): void {
  if (depth > 4 || !existsSync(dir)) return
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      walkDb(p, depth + 1, out)
    } else if (e.name.endsWith('.db') && !e.name.includes('-wal') && !e.name.includes('-shm')) {
      try { out.files += 1; out.bytes += statSync(p).size } catch { /* skip */ }
    } else if (e.name.endsWith('-wal') || e.name.endsWith('.db-wal')) {
      out.wal = true
    }
  }
}

export function queryOverviewExtras(decryptedDir: string): OverviewExtras {
  const dec = decryptedDir
  const sig = [
    shardCatalogSig(dec, ['message', 'bizchat']),
    fileSigOf(join(dec, 'message', 'message_resource.db')),
    // loader 真正读了却没进签名的三处（原先靠「事件后整表清空」兜住，M8 去掉那层兜底后补齐）：
    // contact.db、session.db，以及整树 `walkDb` —— 后者没法用文件签名表达，用数据世代签名。
    fileSigOf(join(dec, 'contact', 'contact.db')),
    fileSigOf(join(dec, 'session', 'session.db')),
    dataGenerationSig(),
  ].join('|')
  return cachedBySig('overview-extras:' + dec, sig, () => computeOverviewExtras(dec), 30_000)
}

function computeOverviewExtras(dec: string): OverviewExtras {
  const now = Math.floor(Date.now() / 1000)
  const day7 = now - 7 * 86400
  const day30 = now - 30 * 86400
  const day60 = now - 60 * 86400
  const day14 = now - 14 * 86400
  const day90 = now - 90 * 86400

  const names = contactMeta(dec).names
  const md5ToUser = new Map<string, string>()
  for (const u of names.keys()) md5ToUser.set(createHash('md5').update(u, 'utf8').digest('hex'), u)
  try {
    const sp = join(dec, 'session', 'session.db')
    if (existsSync(sp)) {
      const db = new DatabaseSync(sp, { readOnly: true })
      if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='SessionTable'").get() !== undefined) {
        for (const r of db.prepare('SELECT username FROM SessionTable').all() as Array<Record<string, unknown>>) {
          const u = cellStr(r['username'])
          if (u) md5ToUser.set(createHash('md5').update(u, 'utf8').digest('hex'), u)
        }
      }
      db.close()
    }
  } catch { /* ignore */ }

  const dayCounts = new Map<string, number>()
  let m7 = 0; let m30 = 0; let m60 = 0; let prev7 = 0; let prev30 = 0
  const contactActive7 = new Set<string>()
  const contactActive30 = new Set<string>()
  const groupActive7 = new Set<string>()
  const groupActive30 = new Set<string>()
  let lastSync = 0

  for (const sh of shardCatalogDirs(dec, ['message', 'bizchat'])) {
    try {
      const db = new DatabaseSync(sh.file, { readOnly: true })
      try {
        for (const [table, meta] of sh.tables) {
          if (!meta.cols.has('create_time')) continue
          const rows = db.prepare(
            'SELECT create_time / 86400 AS d, COUNT(*) AS n FROM ' + table + ' WHERE create_time >= ? GROUP BY d',
          ).all(day90) as Array<{ d: number; n: number }>
          if (rows.length === 0) continue
          const talker = md5ToUser.get(table.slice(4)) ?? table.slice(4)
          const isGroup = talker.includes('@chatroom')
          for (const r of rows) {
            const day = r.d * 86400
            const k = dayKey(day)
            dayCounts.set(k, (dayCounts.get(k) ?? 0) + r.n)
            if (day >= day7) { m7 += r.n; if (!isGroup) contactActive7.add(talker); else groupActive7.add(talker) }
            if (day >= day30) { m30 += r.n; if (!isGroup) contactActive30.add(talker); else groupActive30.add(talker) }
            if (day >= day60) m60 += r.n
            if (day >= day14 && day < day7) prev7 += r.n
            if (day >= day60 && day < day30) prev30 += r.n
            if (day > lastSync) lastSync = day + 86399
          }
        }
      } finally {
        db.close()
      }
    } catch { /* skip shard */ }
  }

  // 90-day heatmap, one entry per day ascending.
  const heatmap: Array<{ d: string; count: number }> = []
  for (let i = 89; i >= 0; i--) {
    const d = new Date((now - i * 86400) * 1000).toISOString().slice(0, 10)
    heatmap.push({ d, count: dayCounts.get(d) ?? 0 })
  }

  // Storage bytes added in the last 30 days.
  let storageBytes30 = 0
  const rp = join(dec, 'message', 'message_resource.db')
  if (existsSync(rp)) {
    try {
      const db = new DatabaseSync(rp, { readOnly: true })
      if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='MessageResourceDetail'").get() !== undefined) {
        const cols = new Set((db.prepare('PRAGMA table_info(MessageResourceDetail)').all() as Array<{ name: string }>).map(r => r.name))
        if (cols.has('create_time')) {
          const r = db.prepare('SELECT COALESCE(SUM(size), 0) AS s FROM MessageResourceDetail WHERE create_time >= ?').get(day30) as { s: number } | undefined
          storageBytes30 = r?.s ?? 0
        }
      }
      db.close()
    } catch { /* ignore */ }
  }

  const dbState = { files: 0, bytes: 0, wal: false }
  walkDb(dec, 0, dbState)

  return {
    trends: {
      messages7: m7,
      messages30: m30,
      messages60: m60,
      messages7Delta: m7 - prev7,
      messages30Delta: m30 - prev30,
      activeContacts7: contactActive7.size,
      activeContacts30: contactActive30.size,
      activeGroups7: groupActive7.size,
      activeGroups30: groupActive30.size,
      storageBytes30,
    },
    heatmap,
    freshness: {
      dbFiles: dbState.files,
      dbBytes: dbState.bytes,
      walPending: dbState.wal,
      ok: m60 > 0 || contactActive30.size > 0,
      lastSync: lastSync ? new Date(lastSync * 1000).toLocaleString('zh-CN') : '',
    },
  }
}
