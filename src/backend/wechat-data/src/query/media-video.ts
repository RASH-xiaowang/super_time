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
 * Resolve one video message: MD5 from packed_info_data, then the cover +
 * the video body from wherever they actually live.
 *
 * 封面与实体都在**真实微信目录**里，不在解密快照中：
 *   <base>/msg/video/<YYYY-MM>/<md5>_thumb.jpg  ← 封面（明文 JPG，直接可读）
 *   <base>/msg/video/<YYYY-MM>/<md5>.mp4        ← 实体（只有本机播放/下载过才有）
 * 只查 decoded_images/<username>/<md5> 是找不到的 —— 实测本机 6771 个封面里
 * 绝大多数都不在解码缓存里，于是每个视频消息都退化成「不在本地快照」的纯文本。
 *
 * @param decryptedDir - decrypted data root.
 * @param decodedDir - decoded image cache root.
 * @param username - conversation username.
 * @param localId - message local id.
 * @param wechatBaseDir - raw WeChat data root (…/xwechat_files/<wxid>_<hash>)，用来定位 msg/video。
 * @returns cover data URL (jpg) when available, plus the on-disk video path.
 */
export function resolveVideoInfo(
  decryptedDir: string,
  decodedDir: string,
  username: string,
  localId: number,
  wechatBaseDir?: string,
): { available: boolean; md5?: string; coverUrl?: string; videoPath?: string; error?: string } {
  const md5 = resolveVideoMd5(decryptedDir, username, localId)
  if (!md5) return { available: false, error: '未找到视频 MD5' }
  const found = findVideoArtifacts(wechatBaseDir, md5)
  // 1. 全局解码缓存（与图片同源：批量解密产物，md5 独占、与用户名无关）
  for (const ext of ['jpg', 'jpeg', 'png', 'webp']) {
    const p = join(decodedDir, md5 + '.' + ext)
    if (!existsSync(p)) continue
    try { return { available: true, md5, coverUrl: toJpegDataUrl(readFileSync(p), ext), ...(found.video ? { videoPath: found.video } : {}) } } catch { /* 继续往下找 */ }
  }
  // 2. 会话内的解码缓存（旧产物路径）
  const userDir = join(decodedDir, username)
  if (existsSync(userDir)) {
    for (const ext of ['jpg', 'jpeg', 'png', 'webp']) {
      const p = join(userDir, md5 + '.' + ext)
      if (!existsSync(p)) continue
      try { return { available: true, md5, coverUrl: toJpegDataUrl(readFileSync(p), ext), ...(found.video ? { videoPath: found.video } : {}) } } catch { /* 继续往下找 */ }
    }
    if (existsSync(join(userDir, md5 + '.hevc'))) {
      if (found.video) return { available: false, md5, videoPath: found.video, error: 'hevc-unsupported' }
      return { available: false, md5, error: 'hevc-unsupported' }
    }
  }
  // 3. 真实微信目录的封面（最强来源）
  if (found.thumb) {
    try {
      return { available: true, md5, coverUrl: toJpegDataUrl(readFileSync(found.thumb), 'jpg'), ...(found.video ? { videoPath: found.video } : {}) }
    } catch { /* 落到兜底 */ }
  }
  // 4. 没有封面但有实体：仍把路径交出去，界面可以交给系统播放器
  if (found.video) return { available: false, md5, videoPath: found.video, error: '封面不在本地' }
  return { available: false, md5, error: '封面与视频文件都不在本地，在微信里打开一次后会缓存' }
}

/** Message MD5 for one video message, scanned across the message shards. */
function resolveVideoMd5(decryptedDir: string, username: string, localId: number): string | null {
  const table = msgTableName(username)
  for (const shard of messageShardFiles(decryptedDir)) {
    let db: DatabaseSync | null = null
    try { db = new DatabaseSync(shard, { readOnly: true }) } catch { continue }
    try {
      const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined
      if (!has) continue
      const cols = (db.prepare('PRAGMA table_info("' + table + '")').all() as Array<{ name: string }>).map(r => r.name)
      const packed = cols.find(c => c.toLowerCase().includes('packed'))
      if (!packed) continue
      const row = db.prepare('SELECT "' + packed + '" AS p FROM "' + table + '" WHERE local_id = ? AND (local_type = 43 OR local_type % 4294967296 = 43) LIMIT 1').get(localId) as { p?: unknown } | undefined
      const md5 = row ? extractMd5FromPacked(row.p) : null
      if (md5) return md5
    } catch { /* 换下一个分片 */ } finally { db.close() }
  }
  return null
}

/**
 * Locate the cover thumbnail and the video body under `<base>/msg/video/<YYYY-MM>/`.
 * 月份目录只有 8 个左右，逐个 existsSync 比预建索引更简单，也不会因为新视频而变陈旧。
 */
function findVideoArtifacts(baseDir: string | undefined, md5: string): { thumb?: string; video?: string } {
  if (!baseDir) return {}
  const root = join(baseDir, 'msg', 'video')
  if (!existsSync(root)) return {}
  let thumb: string | undefined
  let video: string | undefined
  for (const month of readdirSync(root)) {
    const dir = join(root, month)
    if (!thumb) {
      const t = join(dir, md5 + '_thumb.jpg')
      if (existsSync(t)) thumb = t
    }
    if (!video) {
      const v = join(dir, md5 + '.mp4')
      if (existsSync(v)) video = v
    }
    if (thumb && video) break
  }
  return { thumb, ...(video ? { video } : {}) }
}

/** JPEG/PNG bytes → data URL. */
function toJpegDataUrl(bytes: Buffer, ext: string): string {
  const mime = ext === 'jpg' ? 'jpeg' : ext
  return 'data:image/' + mime + ';base64,' + Buffer.from(bytes).toString('base64')
}

