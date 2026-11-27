/**
 * 其他表情的硬盘档案。
 *
 * 清单放在解密数据根旁边的 `emoticon-archive.db`（不放进 `decoded_images`，
 * 清图片缓存或换密钥时不会把目录一起删掉）。图片仍写进 `decoded_images/<md5>.<ext>`，
 * 和原来的取图路径是同一份文件。主键是 md5：重复出现只更新次数和缺失的 CDN 地址。
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from './db-open.ts'
import { fileSigOf } from './meta.ts'
import type { EmoticonItem } from '../types.ts'

const IMAGE_EXTS = ['gif', 'png', 'jpg', 'jpeg', 'webp', 'bmp'] as const
const IMAGE_EXT_SET = new Set<string>(IMAGE_EXTS)

/** 一次扫目录，给已有文件的表情带上相对路径。网格用这个路径直接显示。 */
export function withSavedEmoticonFiles(decodedDir: string, items: readonly EmoticonItem[]): EmoticonItem[] {
  if (!decodedDir || items.length === 0) return items.slice()
  let names: string[] = []
  try { names = readdirSync(decodedDir) } catch { return items.slice() }
  const byMd5 = new Map<string, string>()
  for (const name of names) {
    const dot = name.lastIndexOf('.')
    if (dot <= 0) continue
    const ext = name.slice(dot + 1).toLowerCase()
    if (!IMAGE_EXT_SET.has(ext)) continue
    const md5 = name.slice(0, dot).toLowerCase()
    if (!byMd5.has(md5)) byMd5.set(md5, name)
  }
  return items.map((item) => {
    const file = byMd5.get(item.md5.toLowerCase())
    return file === undefined ? item : { ...item, file }
  })
}

/** 档案库路径：`<数据根>/emoticon-archive.db`，数据根是 `decoded_images` 的上一级。 */
export function emoticonArchivePath(decodedDir: string): string {
  return join(decodedDir, '..', 'emoticon-archive.db')
}

function withArchive<T>(decodedDir: string, fn: (db: DatabaseSync) => T): T {
  const path = emoticonArchivePath(decodedDir)
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS emoticon_other (
      md5 TEXT PRIMARY KEY,
      count INTEGER NOT NULL,
      cdn_url TEXT NOT NULL DEFAULT '',
      caption TEXT NOT NULL DEFAULT ''
    )`)
    db.exec(`CREATE TABLE IF NOT EXISTS emoticon_shard (
      name TEXT PRIMARY KEY,
      sig TEXT NOT NULL
    )`)
    return fn(db)
  } finally {
    try { db.close() } catch { /* 关闭失败不影响已经读到的结果 */ }
  }
}

/** 读出已归档的其他表情，按出现次数从高到低。库不存在或读失败时返回空数组。 */
export function readArchivedOthers(decodedDir: string): EmoticonItem[] {
  if (!decodedDir || !existsSync(emoticonArchivePath(decodedDir))) return []
  try {
    return withArchive(decodedDir, (db) => {
      const rows = db.prepare('SELECT md5, count, cdn_url, caption FROM emoticon_other ORDER BY count DESC, md5').all() as Array<{ md5?: unknown; count?: unknown; cdn_url?: unknown; caption?: unknown }>
      const items: EmoticonItem[] = []
      for (const row of rows) {
        const md5 = String(row.md5 ?? '').trim().toLowerCase()
        if (!md5) continue
        const item: EmoticonItem = { md5, item_type: 0, caption: String(row.caption ?? '') }
        const cdn = String(row.cdn_url ?? '').trim()
        if (cdn) item.cdnUrl = cdn
        items.push(item)
      }
      return items
    })
  } catch {
    return []
  }
}

/** 按 md5 合并进档案。已有的行保留较大的次数，并补上原来缺失的 CDN 地址。 */
export function upsertArchivedOthers(decodedDir: string, items: readonly EmoticonItem[]): void {
  if (!decodedDir || items.length === 0) return
  withArchive(decodedDir, (db) => {
    const stmt = db.prepare(`INSERT INTO emoticon_other (md5, count, cdn_url, caption)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(md5) DO UPDATE SET
        cdn_url = CASE WHEN emoticon_other.cdn_url = '' THEN excluded.cdn_url ELSE emoticon_other.cdn_url END,
        caption = CASE WHEN excluded.count > emoticon_other.count THEN excluded.caption ELSE emoticon_other.caption END,
        count = MAX(emoticon_other.count, excluded.count)`)
    db.exec('BEGIN')
    try {
      for (const item of items) {
        const md5 = item.md5.trim().toLowerCase()
        if (!md5) continue
        stmt.run(md5, Number(item.caption?.match(/\d+/)?.[0] ?? 0) || 0, item.cdnUrl ?? '', item.caption ?? '')
      }
      db.exec('COMMIT')
    } catch (error) {
      try { db.exec('ROLLBACK') } catch { /* 回滚失败时连接会在 finally 关掉 */ }
      throw error
    }
  })
}

export interface MessageShardSig { name: string; sig: string }

/** 当前消息分片的文件签名（mtime + size）。 */
export function listMessageShardSigs(decryptedDir: string): MessageShardSig[] {
  const dir = join(decryptedDir, 'message')
  if (!existsSync(dir)) return []
  const out: MessageShardSig[] = []
  for (const name of readdirSync(dir)) {
    if (!/^(biz_)?message_\d+\.db$/.test(name)) continue
    out.push({ name, sig: fileSigOf(join(dir, name)) })
  }
  return out
}

/** 还没记过、或签名变了的分片。这些才需要再扫一遍找新表情。 */
export function staleMessageShards(decodedDir: string, decryptedDir: string): string[] {
  const current = listMessageShardSigs(decryptedDir)
  let known = new Map<string, string>()
  if (existsSync(emoticonArchivePath(decodedDir))) {
    try {
      known = withArchive(decodedDir, (db) => {
        const rows = db.prepare('SELECT name, sig FROM emoticon_shard').all() as Array<{ name?: unknown; sig?: unknown }>
        return new Map(rows.map((row) => [String(row.name ?? ''), String(row.sig ?? '')]))
      })
    } catch { known = new Map() }
  }
  return current.filter((shard) => known.get(shard.name) !== shard.sig).map((shard) => shard.name)
}

/** 把扫过的分片签名写上，下次签名没变就不再打开这些库。 */
export function rememberMessageShards(decodedDir: string, decryptedDir: string, names: readonly string[]): void {
  if (!decodedDir || names.length === 0) return
  const wanted = new Set(names)
  const rows = listMessageShardSigs(decryptedDir).filter((shard) => wanted.has(shard.name))
  if (rows.length === 0) return
  withArchive(decodedDir, (db) => {
    const stmt = db.prepare('INSERT INTO emoticon_shard (name, sig) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET sig = excluded.sig')
    db.exec('BEGIN')
    try {
      for (const row of rows) stmt.run(row.name, row.sig)
      db.exec('COMMIT')
    } catch (error) {
      try { db.exec('ROLLBACK') } catch { /* 同上 */ }
      throw error
    }
  })
}

/** 已落盘表情的相对路径（`md5.ext`）。没有文件时返回空串。 */
export function savedEmoticonRelPath(decodedDir: string, md5: string): string {
  const key = md5.trim().toLowerCase()
  if (!key || !decodedDir) return ''
  for (const ext of IMAGE_EXTS) {
    if (existsSync(join(decodedDir, key + '.' + ext))) return key + '.' + ext
  }
  return ''
}

/** 这张表情图是否已经在 decoded_images 里。同 md5 不重复下载。 */
export function emoticonImageSaved(decodedDir: string, md5: string): boolean {
  return savedEmoticonRelPath(decodedDir, md5) !== ''
}

const pendingImages = new Set<string>()
let imagePump: Promise<void> | null = null

/**
 * 把还没有落盘的表情图排队下载。已有文件的 md5 直接跳过。
 * 下载在后台进行，不挡住列表返回。
 */
export function scheduleEmoticonImageSave(decodedDir: string, items: readonly EmoticonItem[]): void {
  if (!decodedDir || process.env.VITEST === 'true') return
  for (const item of items) {
    const md5 = item.md5.trim().toLowerCase()
    const url = item.cdnUrl ?? ''
    if (!md5 || !url || emoticonImageSaved(decodedDir, md5)) continue
    pendingImages.add(md5 + '\n' + url)
  }
  if (imagePump !== null) return
  imagePump = pumpEmoticonImages(decodedDir).finally(() => { imagePump = null })
}

async function pumpEmoticonImages(decodedDir: string): Promise<void> {
  const { fetchEmoticonRemote } = await import('./media-image.ts')
  while (pendingImages.size > 0) {
    const batch: string[] = []
    for (const key of pendingImages) {
      batch.push(key)
      if (batch.length === 2) break
    }
    for (const key of batch) pendingImages.delete(key)
    await Promise.all(batch.map(async (key) => {
      const splitAt = key.indexOf('\n')
      const md5 = key.slice(0, splitAt)
      const url = key.slice(splitAt + 1)
      if (emoticonImageSaved(decodedDir, md5)) return
      await fetchEmoticonRemote(url, decodedDir, md5)
    }))
  }
}
