/**
 * Data health view: walks the decrypted tree for SQLite files/WAL/SHM sizes,
 * reads the search-index status, and reports plugin store files plus the
 * decoded-image cache footprint.
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { DbHealthSnapshot, DbHealthStore } from '../types.ts'
import { getSearchIndexStatus } from './search.ts'
import { cachedBySig } from './meta.ts'

/** Recursively count .db/-wal/-shm sizes under a directory (depth 4). */
function walkSqlite(dir: string, depth: number): { dbCount: number; dbBytes: number; walCount: number; shmCount: number } {
  let dbCount = 0
  let dbBytes = 0
  let walCount = 0
  let shmCount = 0
  if (depth > 4 || !existsSync(dir)) return { dbCount, dbBytes, walCount, shmCount }
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      const sub = walkSqlite(p, depth + 1)
      dbCount += sub.dbCount
      dbBytes += sub.dbBytes
      walCount += sub.walCount
      shmCount += sub.shmCount
    } else {
      try {
        const size = statSync(p).size
        if (e.name.endsWith('.db')) { dbCount += 1; dbBytes += size }
        else if (e.name.endsWith('-wal') || e.name.endsWith('.db-wal')) walCount += 1
        else if (e.name.endsWith('-shm') || e.name.endsWith('.db-shm')) shmCount += 1
      } catch { /* skip unreadable */ }
    }
  }
  return { dbCount, dbBytes, walCount, shmCount }
}

/** Count/size of a directory (decoded image cache). */
function dirStats(dir: string): { count: number; bytes: number } {
  let count = 0
  let bytes = 0
  if (!existsSync(dir)) return { count, bytes }
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      try {
        if (e.isDirectory()) {
          const sub = dirStats(p)
          count += sub.count
          bytes += sub.bytes
        } else {
          count += 1
          bytes += statSync(p).size
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return { count, bytes }
}

/**
 * Compute the data-health snapshot (cached ~5s so repeated open/close does
 * not rescan the whole decrypted tree).
 * @param decryptedDir - decrypted data root.
 * @returns the health snapshot.
 */
export function queryDbHealth(decryptedDir: string): DbHealthSnapshot {
  const key = 'db-health:' + decryptedDir
  return cachedBySig(key, 'fs-snapshot-v1', () => computeDbHealth(decryptedDir))
}

function computeDbHealth(decryptedDir: string): DbHealthSnapshot {
  const sqlite = walkSqlite(decryptedDir, 0)
  const root = dirname(decryptedDir)
  const stores: DbHealthStore[] = []
  for (const name of ['wechat_tasks.db', 'daily_summary.db', 'message_edits.db', 'wechat_search.db', 'config.json', 'all_keys.json']) {
    const p = join(root, name)
    try {
      if (existsSync(p)) stores.push({ name, size: statSync(p).size })
    } catch { /* skip */ }
  }
  const images = dirStats(join(root, 'decoded_images'))
  return {
    dbFiles: sqlite.dbCount,
    dbBytes: sqlite.dbBytes,
    walFiles: sqlite.walCount,
    shmFiles: sqlite.shmCount,
    searchIndex: getSearchIndexStatus(decryptedDir),
    stores,
    decodedImagesCount: images.count,
    decodedImagesBytes: images.bytes,
    updatedAt: Math.floor(Date.now() / 1000),
  }
}
