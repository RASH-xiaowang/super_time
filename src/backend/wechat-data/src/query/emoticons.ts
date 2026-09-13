/**
 * Emoticon queries over emoticon.db, mirroring the Rust modules/emoticons.rs:
 * custom emoticons from kNonStoreEmoticonTable and store packages from
 * kStoreEmoticonPackageTable (+ per-package file counts). Static bundled
 * emoticons have no DSH counterpart (source ships them in public/wechat/).
 *
 * 展示顺序（第 36 轮修正）
 * ----------------------
 * `kNonStoreEmoticonTable` 的**内置行序不是**用户在微信里看到的顺序。
 * 真正的顺序在 `kFavEmoticonOrderTable`（只有 `md5` 一列，行序即排列顺序）。
 * 实测本机：两张表恰好是同一组 30 个 md5（交集 30/30、无重复），但逐位比较
 * **只有 1/30 相同** —— 也就是说修复前面板展示的顺序基本是错的。
 * （同库的 `kCustomEmoticonOrderTable` 与 `kExpressRecentUseEemoticonTable` 均为 0 行，
 *   故 `kFavEmoticonOrderTable` 是唯一的排序来源。）
 * 排序在 SQL 侧完成，所以 LIMIT/OFFSET 分页仍然正确；不在顺序表里的表情排在最后，
 * 并保持内置行序，保证结果**确定**（原来的查询没有 ORDER BY，顺序其实是不确定的）。
 */
import { DatabaseSync } from 'node:sqlite'
import { cachedBySig, fileSigOf } from './meta.ts'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { EmoticonsSnapshot, EmoticonItem } from '../types.ts'

/** Coerce a DB cell to a string (null -> '', else String()). */
function cellStr(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === null || v === undefined) return ''
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol') return String(v)
  return ''
}

function tableColumns(db: DatabaseSync, table: string): Set<string> {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    return new Set(rows.map(r => r.name))
  } catch { return new Set() }
}

/** Pick the first present column among candidates; null when none exist. */
function col(cols: Set<string>, cands: string[]): string | null {
  for (const c of cands) if (cols.has(c)) return c
  return null
}

/**
 * Read custom emoticons + store packages.
 * @param decryptedDir - decrypted data root.
 * @param limit - max custom rows.
 * @returns the emoticons snapshot.
 */
export function queryEmoticons(decryptedDir: string, limit?: number, offset: number = 0): EmoticonsSnapshot {
  // Cache keyed on emoticon.db's signature; recomputed when the realtime sync
  // rewrites it, otherwise served from the 5s bounded cache.
  return cachedBySig(
    'emoticons:' + decryptedDir + ':' + String(limit ?? '') + ':' + String(offset),
    fileSigOf(join(decryptedDir, 'emoticon', 'emoticon.db')),
    () => computeEmoticons(decryptedDir, limit, offset),
  )
}

function computeEmoticons(decryptedDir: string, limit?: number, offset: number = 0): EmoticonsSnapshot {
  const path = join(decryptedDir, 'emoticon', 'emoticon.db')
  if (!existsSync(path)) return { custom: [], static: [], packages: [], total: 0, orderedBy: 'builtin' }
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const custom: EmoticonItem[] = []
    let customOrderedBy: 'wechat' | 'builtin' = 'builtin'
    const cCols = tableColumns(db, 'kNonStoreEmoticonTable')
    if (cCols.size > 0) {
      const md5Col = col(cCols, ['md5', 'MD5', 'md5_'])
      const typeCol = col(cCols, ['type', 'Type', 'type_'])
      const captionCol = col(cCols, ['caption', 'Caption', 'caption_'])
      // CDN 地址：面板要显示真图，而本地表情缓存是**加密**文件（见 media-image.ts 的
      // fetchEmoticonRemote 注释），只能靠这几个 URL 取图。实测 30 行里 cdn_url 全覆盖。
      const cdnCol = col(cCols, ['cdn_url', 'cdnurl', 'cdn_Url'])
      const thumbCol = col(cCols, ['thumb_url', 'thumburl', 'tp_url'])
      if (md5Col) {
        const cap = Math.min(limit ?? 500, 2000)
        const sel = [
          `t.${md5Col} AS md5`,
          typeCol ? `t.${typeCol} AS item_type` : `0 AS item_type`,
          captionCol ? `t.${captionCol} AS caption` : `'' AS caption`,
          cdnCol ? `t.${cdnCol} AS cdn_url` : `'' AS cdn_url`,
          thumbCol ? `t.${thumbCol} AS thumb_url` : `'' AS thumb_url`,
        ].join(', ')
        const plain = `SELECT ${sel} FROM kNonStoreEmoticonTable t ORDER BY t.rowid LIMIT ? OFFSET ?`
        // 顺序表可用时按它排序；任何异常都退回确定性最弱的「内置行序」，不让面板整体失败。
        const hasOrder = tableColumns(db, 'kFavEmoticonOrderTable').has('md5')
        let rows: Array<{ md5?: unknown; item_type?: unknown; caption?: unknown; cdn_url?: unknown; thumb_url?: unknown }>
        let orderedBy: 'wechat' | 'builtin' = 'builtin'
        if (hasOrder) {
          const ordered = `SELECT ${sel} FROM kNonStoreEmoticonTable t
            LEFT JOIN (SELECT md5 AS omd5, MIN(rowid) AS ord FROM kFavEmoticonOrderTable GROUP BY md5) o
              ON o.omd5 = t.${md5Col}
            ORDER BY (o.ord IS NULL), o.ord, t.rowid LIMIT ? OFFSET ?`
          try { rows = db.prepare(ordered).all(cap, offset) as typeof rows; orderedBy = 'wechat' }
          catch { rows = db.prepare(plain).all(cap, offset) as typeof rows }
        } else {
          rows = db.prepare(plain).all(cap, offset) as typeof rows
        }
        customOrderedBy = orderedBy
        for (const r of rows) {
          const md5 = cellStr(r.md5 ?? '').trim()
          if (!md5) continue
          const item: EmoticonItem = { md5, item_type: Number(r.item_type ?? 0) }
          const caption = cellStr(r.caption ?? '').trim()
          if (caption) item.caption = caption
          // 取图用的 CDN 地址（cdn_url 优先，回退 thumb_url/tp_url）；值里可能带 XML 实体
          const cdnUrl = (cellStr(r.cdn_url ?? '').trim() || cellStr(r.thumb_url ?? '').trim())
            .replace(/&amp;/g, '&').replace(/&#x26;/gi, '&')
          if (cdnUrl) item.cdnUrl = cdnUrl
          custom.push(item)
        }
      }
    }

    const packages: EmoticonsSnapshot['packages'] = []
    const pCols = tableColumns(db, 'kStoreEmoticonPackageTable')
    if (pCols.size > 0) {
      const idCol = col(pCols, ['package_id_', 'package_id', 'product_id_', 'product_id', 'id_'])
      const nameCol = col(pCols, ['package_name_', 'name_', 'title_', 'name', 'title'])
      if (idCol && nameCol) {
        // 表情包本身带 sort_order_（真实列），按它排；无该列时退回确定性的 rowid 序。
        const sortCol = col(pCols, ['sort_order_', 'sort_order', 'order_', 'sort'])
        const orderBy = sortCol ? ` ORDER BY ${sortCol}, rowid` : ' ORDER BY rowid'
        const rows = db.prepare(`SELECT ${idCol} AS pid, ${nameCol} AS name FROM kStoreEmoticonPackageTable${orderBy} LIMIT 500`).all() as Array<{ pid?: unknown; name?: unknown }>
        for (const r of rows) {
          const pid = cellStr(r.pid ?? '').trim()
          const name = cellStr(r.name ?? '').trim() || pid || '未命名表情包'
          let count = 0
          if (pid) {
            try {
              const fcols = tableColumns(db, 'kStoreEmoticonFilesTable')
              if (fcols.size > 0) {
                const fpid = col(fcols, ['package_id_', 'package_id', 'product_id_', 'product_id'])
                if (fpid) {
                  count = (db.prepare(`SELECT COUNT(*) AS n FROM kStoreEmoticonFilesTable WHERE ${fpid} = ?`).get(pid) as { n: number }).n
                }
              }
            } catch { count = 0 }
          }
          packages.push({ name, count })
        }
      }
    }

    let total = custom.length
    if (cCols.size > 0) {
      try {
        total = (db.prepare('SELECT COUNT(*) AS n FROM kNonStoreEmoticonTable').get() as { n: number }).n
      } catch { /* keep batch count */ }
    }

    return { custom, static: [], packages, total, orderedBy: customOrderedBy }
  } finally {
    db.close()
  }
}
