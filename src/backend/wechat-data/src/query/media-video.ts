/**
 * WeChat video message lookup, rewritten from st_control hevc/momentVideo
 * surface. The raw video files live in the WeChat install dir (not the
 * static decrypted snapshot), so this resolves the message MD5 and any
 * decodable cover thumbnail from decoded_images; playback degrades to a
 * placeholder when no cover/file is available.
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { extractMd5FromPacked } from './media-image.ts'

/** Msg_<md5(username)> table name for a talker. */
function msgTableName(username: string): string {
  return 'Msg_' + createHash('md5').update(username, 'utf8').digest('hex')
}

/** Message shard DB files under <decrypted>/message. */
function messageShardFiles(decryptedDir: string): string[] {
  const dir = join(decryptedDir, 'message')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(f => f.endsWith('.db') && !f.includes('_shm') && !f.includes('_wal') && !f.includes('monitor_cache')).sort().map(f => join(dir, f))
}

/**
 * Resolve one video message: MD5 from packed_info_data + a decodable cover
 * thumbnail from the decoded image cache.
 * @param decryptedDir - decrypted data root.
 * @param decodedDir - decoded image cache root.
 * @param username - conversation username.
 * @param localId - message local id.
 * @returns cover data URL (jpg) when available, else an error description.
 */
export function resolveVideoInfo(
  decryptedDir: string,
  decodedDir: string,
  username: string,
  localId: number,
): { available: boolean; md5?: string; coverUrl?: string; error?: string } {
  const table = msgTableName(username)
  let md5: string | null = null
  for (const shard of messageShardFiles(decryptedDir)) {
    let db: DatabaseSync | null = null
    try { db = new DatabaseSync(shard, { readOnly: true }) } catch { continue }
    const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined
    if (!has) { db.close(); continue }
    const cols = (db.prepare('PRAGMA table_info("' + table + '")').all() as Array<{ name: string }>).map(r => r.name)
    const packed = cols.find(c => c.toLowerCase().includes('packed'))
    if (packed) {
      try {
        const row = db.prepare('SELECT "' + packed + '" AS p FROM "' + table + '" WHERE local_id = ? AND (local_type = 43 OR local_type % 4294967296 = 43) LIMIT 1').get(localId) as { p?: unknown } | undefined
        if (row) md5 = extractMd5FromPacked(row.p)
      } catch { /* try next shard */ }
    }
    db.close()
    if (md5) break
  }
  if (!md5) return { available: false, error: '未找到视频 MD5' }
  // cover thumbnail from decoded cache
  const userDir = join(decodedDir, username)
  if (existsSync(userDir)) {
    for (const ext of ['jpg', 'jpeg', 'png', 'webp']) {
      const p = join(userDir, md5 + '.' + ext)
      if (existsSync(p)) {
        try {
          const bytes = readFileSync(p)
          const mime = ext === 'jpg' ? 'jpeg' : ext
          return { available: true, md5, coverUrl: 'data:image/' + mime + ';base64,' + Buffer.from(bytes).toString('base64') }
        } catch { /* fall through */ }
      }
    }
    if (existsSync(join(userDir, md5 + '.hevc'))) return { available: false, md5, error: 'hevc-unsupported' }
  }
  return { available: false, md5, error: '视频文件不在本地快照（原始文件在微信安装目录）' }
}
