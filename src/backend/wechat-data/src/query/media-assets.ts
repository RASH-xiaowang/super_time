/**
 * Media assets inventory over hardlink.db: per-category file/size stats and
 * duplicate md5 detection across image/file/video hardlink tables.
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { cachedBySig, fileSigOf } from './meta.ts'
import type { MediaAssetsSnapshot, MediaAssetCategory, MediaAssetDuplicate } from '../types.ts'

const MEDIA_TABLES: ReadonlyArray<[string, string]> = [
  ['image_hardlink_info_v4', '图片'],
  ['file_hardlink_info_v4', '文件'],
  ['video_hardlink_info_v4', '视频'],
]

function tableColumns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return new Set(rows.map(r => r.name))
}

/**
 * Compute the media assets snapshot.
 * @param decryptedDir - decrypted data root.
 * @returns the media assets snapshot.
 */
export function queryMediaAssets(decryptedDir: string): MediaAssetsSnapshot {
  return cachedBySig('media-assets:' + decryptedDir, fileSigOf(join(decryptedDir, 'hardlink', 'hardlink.db')), () => computeMediaAssets(decryptedDir), 30_000)
}

function computeMediaAssets(decryptedDir: string): MediaAssetsSnapshot {
  const p = join(decryptedDir, 'hardlink', 'hardlink.db')
  const categories: MediaAssetCategory[] = []
  const duplicates = new Map<string, { count: number; size: number }>()
  let totalFiles = 0
  let totalBytes = 0
  if (existsSync(p)) {
    try {
      const db = new DatabaseSync(p, { readOnly: true })
      for (const [table, label] of MEDIA_TABLES) {
        const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined
        if (!has) continue
        const cols = tableColumns(db, table)
        const md5Col = cols.has('md5') ? 'md5' : cols.has('MD5') ? 'MD5' : ''
        const sizeCol = cols.has('file_size') ? 'file_size' : '0'
        const statRows = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(${sizeCol}), 0) AS s FROM ${table}`).all() as Array<{ n: number; s: number }>
        const stat = statRows[0] ?? { n: 0, s: 0 }
        const count = stat.n
        const size = stat.s
        categories.push({ category: label, count, size })
        totalFiles += count
        totalBytes += size
        if (md5Col) {
          try {
            const dupRows = db.prepare(`SELECT ${md5Col} AS m, COUNT(*) AS n, COALESCE(SUM(CAST(${sizeCol} AS INTEGER)), 0) AS s FROM ${table} WHERE ${md5Col} IS NOT NULL AND ${md5Col} != '' GROUP BY ${md5Col} HAVING COUNT(*) > 1`).all() as Array<{ m: unknown; n: number; s: number }>
            for (const r of dupRows) {
              const md5 = typeof r.m === 'string' ? r.m : ''
              if (md5) duplicates.set(md5, { count: r.n, size: r.s })
            }
          } catch { /* duplicates optional */ }
        }
      }
      db.close()
    } catch { /* keep empty */ }
  }
  let duplicateFiles = 0
  let duplicateBytes = 0
  let reclaimBytes = 0
  const allDups: MediaAssetDuplicate[] = Array.from(duplicates.entries())
    .map(([md5, d]) => ({
      md5,
      count: d.count,
      size: d.size,
      reclaimBytes: d.count > 1 ? Math.round((d.size * (d.count - 1)) / d.count) : 0,
    }))
    .sort((a, b) => b.count - a.count)
  // 合计必须遍历**全部**重复组；只有返回给界面展示的列表才截断。
  // 原实现先 slice(0, 50) 再累加：实测本机有 200 个重复组，
  // 于是「可回收」被少报成 36,677,568 字节（真实 116,665,515 字节，差 3.2 倍），
  // 「重复文件数」被少报成 255（真实 574）。
  for (const d of allDups) {
    duplicateFiles += d.count
    duplicateBytes += d.size
    reclaimBytes += d.reclaimBytes
  }
  return {
    categories,
    duplicates: allDups.slice(0, 50),
    totalFiles,
    totalBytes,
    duplicateFiles,
    duplicateBytes,
    reclaimBytes,
    updatedAt: Math.floor(Date.now() / 1000),
  }
}
