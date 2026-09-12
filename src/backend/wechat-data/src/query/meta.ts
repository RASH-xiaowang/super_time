/**
 * Shared in-process metadata caches for the WeChat read path.
 *
 * The decrypted snapshot is an external read-only DB tree that the realtime
 * sync loop rewrites in place (atomic rename). Every cache here keys on the
 * owning file's mtime+size fingerprint, so a rewritten file invalidates the
 * entry naturally; callers never see data older than the file that produced
 * it. A short max-age bounds fingerprint drift on the same file.
 */

import { DatabaseSync } from 'node:sqlite'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const MAX_AGE_MS = 5_000

interface Entry {
  at: number
  sig: string
  value: unknown
}

const entries = new Map<string, Entry>()

function decode(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol') return String(v)
  if (v instanceof Uint8Array) return new TextDecoder('utf-8', { fatal: false }).decode(v)
  return ''
}

function fileSig(path: string): string {
  try {
    const st = statSync(path)
    return `${st.mtimeMs}:${st.size}`
  } catch {
    return ''
  }
}

function dirSig(dir: string): string {
  try {
    const st = statSync(dir)
    return `${st.mtimeMs}:${st.size}`
  } catch {
    return ''
  }
}

function get<T>(key: string, sig: string, loader: () => T, maxAgeMs = MAX_AGE_MS): T {
  const hit = entries.get(key)
  if (hit && hit.sig === sig && hit.at + maxAgeMs > Date.now()) return hit.value as T
  const value = loader()
  entries.set(key, { at: Date.now(), sig, value })
  return value
}

function tableColumns(db: DatabaseSync, table: string): Set<string> {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    return new Set(rows.map(r => r.name))
  } catch {
    return new Set()
  }
}

/** Contact meta: display names, pinned usernames, official-account types. */
export interface ContactMeta {
  names: Map<string, string>
  pinned: Set<string>
  bizTypes: Map<string, number>
}

/**
 * Read contact.db once and derive all contact metadata.
 * @param decryptedDir - decrypted data root.
 * @returns contact names (remark > nick > username), pinned set, biz types.
 */
export function contactMeta(decryptedDir: string): ContactMeta {
  const p = join(decryptedDir, 'contact', 'contact.db')
  const sig = fileSig(p)
  return get<ContactMeta>('contact-meta:' + decryptedDir, sig, () => {
    const names = new Map<string, string>()
    const pinned = new Set<string>()
    const bizTypes = new Map<string, number>()
    if (!sig) return { names, pinned, bizTypes }
    try {
      const db = new DatabaseSync(p, { readOnly: true })
      try {
        const cols = tableColumns(db, 'contact')
        const userCol = cols.has('username') ? 'username' : cols.has('UserName') ? 'UserName' : ''
        const remarkCol = cols.has('remark') ? 'remark' : cols.has('Remark') ? 'Remark' : ''
        const nickCol = cols.has('nick_name') ? 'nick_name' : cols.has('NickName') ? 'NickName' : 'nickName'
        const flagCol = cols.has('flag') ? 'flag' : cols.has('Flag') ? 'Flag' : ''
        if (userCol) {
          const remarkSel = remarkCol || "''"
          const nickSel = nickCol
          const rows = db.prepare(
            `SELECT ${userCol} AS u, ${remarkSel} AS r, ${nickSel} AS n, ${flagCol || '0'} AS f FROM contact`,
          ).all() as Array<Record<string, unknown>>
          for (const row of rows) {
            const u = decode(row.u)
            if (!u) continue
            const remark = decode(row.r).trim()
            const nick = decode(row.n).trim()
            names.set(u, remark || nick || u)
            const flag = Number(row.f ?? 0)
            if ((flag & 0x800) !== 0) pinned.add(u)
          }
        }
        const biCols = tableColumns(db, 'biz_info')
        if (biCols.has('username') && biCols.has('type')) {
          const rows = db.prepare('SELECT username AS u, type AS t FROM biz_info').all() as Array<{ u: unknown; t: unknown }>
          for (const row of rows) {
            const u = decode(row.u)
            if (u) bizTypes.set(u, Number(row.t ?? 0))
          }
        }
      } finally {
        db.close()
      }
    } catch { /* contact.db unavailable: keep empty maps */ }
    return { names, pinned, bizTypes }
  })
}

/** SenderName2Id fallback (message_resource.db rowid -> wxid). */
export function senderNameMap(decryptedDir: string): Map<number, string> {
  const p = join(decryptedDir, 'message', 'message_resource.db')
  const sig = fileSig(p)
  return get<Map<number, string>>('sender-names:' + decryptedDir, sig, () => {
    const map = new Map<number, string>()
    if (!sig) return map
    try {
      const db = new DatabaseSync(p, { readOnly: true })
      try {
        const rows = db.prepare('SELECT rowid AS id, user_name AS u FROM SenderName2Id').all() as Array<{ id: number; u: unknown }>
        for (const row of rows) {
          const u = decode(row.u).trim()
          if (u) map.set(row.id, u)
        }
      } catch { /* table absent */ } finally {
        db.close()
      }
    } catch { /* resource db unavailable */ }
    return map
  })
}

/** One cached shard entry: which file holds a table and its columns/name map. */
export interface ShardMeta {
  file: string
  tables: Map<string, { cols: Set<string>; name2id: Map<number, string> }>
}

function loadShardMeta(dbFile: string): ShardMeta {
  const tables = new Map<string, { cols: Set<string>; name2id: Map<number, string> }>()
  try {
    const db = new DatabaseSync(dbFile, { readOnly: true })
    try {
      const name2id = new Map<number, string>()
      for (const t of ['Name2Id', 'name2id']) {
        try {
          const rows = db.prepare('SELECT rowid AS id, user_name AS u FROM ' + t).all() as Array<{ id: number; u: unknown }>
          for (const row of rows) {
            const u = decode(row.u).trim()
            if (u) name2id.set(row.id, u)
          }
          if (name2id.size > 0) break
        } catch { /* try the other casing */ }
      }
      const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'").all() as Array<{ name: string }>
      for (const row of rows) {
        tables.set(row.name, { cols: tableColumns(db, row.name), name2id })
      }
    } finally {
      db.close()
    }
  } catch { /* skip file */ }
  return { file: dbFile, tables }
}

/**
 * Cached message shard catalog across one or more sub-directories (message,
 * bizchat, ...). Returns the Msg_% tables each file holds.
 * @param decryptedDir - decrypted data root.
 * @param dirs - sub-directory names to scan (default ['message']).
 * @returns shard metadata keyed by file path (cache invalidated by file sigs).
 */
export function shardCatalogDirs(decryptedDir: string, dirs: ReadonlyArray<string>): ShardMeta[] {
  const key = 'shard-catalog:' + decryptedDir + ':' + dirs.join('|')
  const sigParts: string[] = []
  const entries: Array<{ file: string }> = []
  for (const dirName of dirs) {
    const dir = join(decryptedDir, dirName)
    const dSig = dirSig(dir)
    if (!dSig) continue
    sigParts.push(`${dirName}:${dSig}`)
    let files: string[] = []
    try {
      files = readdirSync(dir).filter(f => f.endsWith('.db') && !f.includes('_shm') && !f.includes('_wal') && !f.includes('monitor_cache') && !f.includes('fts') && !f.includes('resource') && !f.includes('media')).sort()
    } catch {
      continue
    }
    for (const f of files) {
      const full = join(dir, f)
      const fs = fileSig(full)
      sigParts.push(`${f}:${fs}`)
      entries.push({ file: full })
    }
  }
  return get<ShardMeta[]>(key, sigParts.join('|'), () => entries.map(e => loadShardMeta(e.file)))
}

/** Convenience: message-directory-only catalog (the chat hot path). */
export function shardCatalog(decryptedDir: string): ShardMeta[] {
  return shardCatalogDirs(decryptedDir, ['message'])
}

/** Signature string for the directories a catalog covers (cache keys). */
export function shardCatalogSig(decryptedDir: string, dirs: ReadonlyArray<string>): string {
  const parts: string[] = []
  for (const dirName of dirs) {
    const dir = join(decryptedDir, dirName)
    parts.push(`${dirName}:${dirSig(dir)}`)
    let files: string[] = []
    try {
      files = readdirSync(dir).filter(f => f.endsWith('.db') && !f.includes('_shm') && !f.includes('_wal') && !f.includes('monitor_cache') && !f.includes('fts') && !f.includes('resource') && !f.includes('media')).sort()
    } catch {
      continue
    }
    for (const f of files) parts.push(`${f}:${fileSig(join(dir, f))}`)
  }
  return parts.join('|')
}

/** Signature of one file (mtime+size); '' when absent. */
export function fileSigOf(path: string): string {
  return fileSig(path)
}

/** Generic mtime/fingerprint-bounded process cache (see {@link get}). */
export function cachedBySig<T>(key: string, sig: string, loader: () => T, maxAgeMs = MAX_AGE_MS): T {
  return get(key, sig, loader, maxAgeMs)
}

/** Insert with a simple FIFO capacity bound (evicts the oldest key). */
export function boundedSet<K, V>(map: Map<K, V>, key: K, value: V, cap = 300): void {
  if (!map.has(key) && map.size >= cap) {
    const first = map.keys().next()
    if (!first.done && first.value !== undefined) map.delete(first.value)
  }
  map.set(key, value)
}

/** Drop every cached snapshot (called after a rewrite event when needed). */
export function invalidateWechatMeta(): void {
  entries.clear()
}
