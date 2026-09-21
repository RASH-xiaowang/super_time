/**
 * WeChat image resolution and decoding, rewritten from st_control image.rs
 * (image/{crypto,resolve}.rs). Chain: (username, local_id) -> image MD5 from
 * the message shards (packed_info_data protobuf) or message_resource.db, then
 * a pre-decoded image in decoded_images/<username>/<md5>.<ext>, then raw .dat
 * XOR / V1 / V2 decoding. Returns a base64 data URL for the browser.
 * wxgf/HEVC images are reported as hevc-unsupported (needs a system decoder).
 */
import { createDecipheriv } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
// 宿主层的 CommonJS 重试封装（无类型声明：这里的 `fetchWithRetry` 按 any 用）
import { fetchWithRetry } from '../../../llm-retry.js'
import { CDN_DISABLED_MESSAGE, cdnFetchAllowed } from './cdn-policy.ts'
import { shardCatalogDirs } from './meta.ts'

const V2_MAGIC = [0x07, 0x08, 0x56, 0x32]
const V1_MAGIC_FULL = [0x07, 0x08, 0x56, 0x31, 0x08, 0x07]
const V2_MAGIC_FULL = [0x07, 0x08, 0x56, 0x32, 0x08, 0x07]
const V1_AES_KEY = new TextEncoder().encode('cfcd208495d565ef')
const IMAGE_MAGIC: Array<[string, number[]]> = [
  ['png', [0x89, 0x50, 0x4e, 0x47]],
  ['gif', [0x47, 0x49, 0x46, 0x38]],
  ['tif', [0x49, 0x49, 0x2a, 0x00]],
  ['webp', [0x52, 0x49, 0x46, 0x46]],
  ['jpg', [0xff, 0xd8, 0xff]],
]

/** Msg_<md5(username)> table name for a talker. */
function msgTableName(username: string): string {
  return 'Msg_' + createHash('md5').update(username, 'utf8').digest('hex')
}

/** Convert a comma-separated decimal byte list (st_control BLOB text form) to bytes. */
function commaBytesToBytes(text: string): Uint8Array | null {
  const parts = text.split(',').map(n => parseInt(n, 10))
  if (parts.length === 0 || parts.some(n => Number.isNaN(n))) return null
  return Uint8Array.from(parts)
}

/**
 * Extract the 32-char hex image MD5 from a packed_info protobuf value.
 * Accepts a raw BLOB, or the st_control comma-separated byte-list TEXT form.
 * @param value - packed_info cell value (BLOB or comma-separated byte-list TEXT).
 * @returns the 32-char hex image MD5, or null when none is found.
 */
export function extractMd5FromPacked(value: unknown): string | null {
  let bytes: Uint8Array | null = null
  if (value instanceof Uint8Array) {
    bytes = value
  } else if (typeof value === 'string' && value) {
    if (value.includes(',')) {
      bytes = commaBytesToBytes(value)
    } else {
      // plain text (rare): try hex string or raw ascii
      const m = value.match(/[0-9a-f]{32}/)
      return m ? m[0] : null
    }
  }
  if (!bytes) return null
  const buf = bytes
  // protobuf marker then 32 hex (st_control primary)
  const marker = [0x12, 0x22, 0x0a, 0x20]
  for (let i = 0; i + marker.length + 32 <= buf.length; i += 1) {
    if (marker.every((b, j) => buf[i + j] === b)) {
      const s = String.fromCharCode(...buf.slice(i + marker.length, i + marker.length + 32))
      if (/^[0-9a-f]{32}$/.test(s)) return s
    }
  }
  // generic: 0x22 0x20 then 32 hex (protobuf field 4, length 32)
  for (let i = 0; i + 34 <= buf.length; i += 1) {
    if (buf[i] === 0x22 && buf[i + 1] === 32) {
      const s = String.fromCharCode(...buf.slice(i + 2, i + 34))
      if (/^[0-9a-f]{32}$/.test(s)) return s
    }
  }
  // last resort: any 32 consecutive ascii hex digits
  let s = ''
  for (let i = 0; i < buf.length; i += 1) {
    const c = String.fromCharCode(buf[i] ?? 0)
    if (/[0-9a-f]/i.test(c)) {
      s += c
      if (s.length === 32) return s.toLowerCase()
    } else {
      s = ''
    }
  }
  return null
}

/**
 * Resolve image MD5 + MessageResourceDetail.data_index for (username, local_id):
 * message shard packed_info_data first, then message_resource.db
 * (ChatName2Id -> MessageResourceInfo -> MessageResourceDetail).
 * @param decryptedDir - decrypted data root.
 * @param username - conversation username.
 * @param localId - message local id.
 * @returns the 32-char hex image MD5 (or null) and the detail data_index hint.
 */
export function resolveImageResourceHint(
  decryptedDir: string,
  username: string,
  localId: number,
): { md5: string | null; dataIndex: string } {
  const table = msgTableName(username)
  // 分片目录缓存直接定位持有该表的分片，逐图解析不再每次遍历打开所有分片库。
  for (const shard of shardCatalogDirs(decryptedDir, ['message'])) {
    const tableMeta = shard.tables.get(table)
    if (!tableMeta) continue
    let db: DatabaseSync | null = null
    try { db = new DatabaseSync(shard.file, { readOnly: true }) } catch { continue }
    try {
      const packed = [...tableMeta.cols].find(c => c.toLowerCase().includes('packed'))
      if (packed) {
        try {
          const row = db.prepare('SELECT "' + packed + '" AS p FROM "' + table + '" WHERE local_id = ? AND (local_type = 3 OR local_type % 4294967296 = 3) LIMIT 1').get(localId) as { p?: unknown } | undefined
          if (row) {
            const md5 = extractMd5FromPacked(row.p)
            if (md5) return { md5, dataIndex: '' }
          }
        } catch { /* try the resource fallback */ }
      }
    } finally {
      db.close()
    }
  }
  // fallback: message_resource.db (info -> detail)
  let dataIndex = ''
  const resDb = join(decryptedDir, 'message', 'message_resource.db')
  if (existsSync(resDb)) {
    try {
      const db = new DatabaseSync(resDb, { readOnly: true })
      const chat = db.prepare('SELECT rowid FROM ChatName2Id WHERE user_name = ?').get(username) as { rowid: number } | undefined
      if (chat) {
        const info = db.prepare('SELECT message_id, packed_info AS p FROM MessageResourceInfo WHERE chat_id = ? AND message_local_id = ? AND (message_local_type = 3 OR message_local_type % 4294967296 = 3) ORDER BY message_create_time DESC LIMIT 1').get(chat.rowid, localId) as { message_id?: number; p?: unknown } | undefined
        if (info) {
          const md5 = extractMd5FromPacked(info.p)
          if (md5) { db.close(); return { md5, dataIndex: '' } }
          if (info.message_id !== undefined) {
            const details = db.prepare('SELECT packed_info AS p, data_index AS di FROM MessageResourceDetail WHERE message_id = ? ORDER BY resource_id DESC LIMIT 20').all(info.message_id) as Array<{ p?: unknown; di?: unknown }>
            for (const d of details) {
              const dm = extractMd5FromPacked(d.p)
              if (dm) { db.close(); return { md5: dm, dataIndex: dataIndexOf(d.di) } }
              const di = dataIndexOf(d.di)
              if (di && !dataIndex) dataIndex = di
            }
          }
        }
      }
      db.close()
    } catch { /* resource db unavailable */ }
  }
  return { md5: null, dataIndex }
}

/** Normalize a MessageResourceDetail.data_index cell to a non-empty string. */
function dataIndexOf(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v.trim()
  if (v instanceof Uint8Array) return new TextDecoder('utf-8', { fatal: false }).decode(v).trim()
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v).trim()
  return ''
}

/**
 * Resolve the image MD5 for (username, local_id).
 * @param decryptedDir - decrypted data root.
 * @param username - conversation username.
 * @param localId - message local id.
 * @returns the 32-char hex image MD5, or null when not found.
 */
export function resolveImageMd5(decryptedDir: string, username: string, localId: number): string | null {
  return resolveImageResourceHint(decryptedDir, username, localId).md5
}

/**
 * Detect an image format from a decrypted header.
 * @param header - leading bytes of the (decrypted) image.
 * @returns the format name ('png' / 'jpg' / 'gif' / ...), or 'bin' when unknown.
 */
export function detectImageFormat(header: Uint8Array): string {
  for (const [fmt, magic] of IMAGE_MAGIC) {
    if (header.length >= magic.length && magic.every((b, i) => header[i] === b)) return fmt
  }
  if (header.length >= 2 && header[0] === 0x42 && header[1] === 0x4d) return 'bmp'
  return 'bin'
}

/**
 * Detect a single-byte XOR key by matching image magic bytes.
 * @param data - raw .dat bytes.
 * @returns the XOR key byte, or null when no magic matches.
 */
export function detectXorKey(data: Uint8Array): number | null {
  if (data.length < 4) return null
  if (
    (data[0] ?? 0) === V2_MAGIC[0] &&
    (data[1] ?? 0) === V2_MAGIC[1] &&
    (data[2] ?? 0) === V2_MAGIC[2] &&
    (data[3] ?? 0) === V2_MAGIC[3]
  ) return null
  for (const [, magic] of IMAGE_MAGIC) {
    const key = (data[0] ?? 0) ^ (magic[0] ?? 0)
    let ok = true
    for (let i = 0; i < magic.length && i < data.length; i += 1) {
      if (((data[i] ?? 0) ^ key) !== (magic[i] ?? 0)) { ok = false; break }
    }
    if (ok) return key
  }
  return null
}

/** AES-128-ECB decrypt (no padding). */
function aes128EcbDecrypt(key: Uint8Array, data: Uint8Array): Uint8Array {
  if (key.length < 16) throw new Error('AES key 长度不足 16 字节')
  const decipher = createDecipheriv('aes-128-ecb', Buffer.from(key), null)
  decipher.setAutoPadding(false)
  const out = Buffer.concat([decipher.update(Buffer.from(data)), decipher.final()])
  return new Uint8Array(out)
}

/** Strip PKCS7 padding (defensive). */
function pkcs7Unpad(data: Uint8Array): Uint8Array {
  if (data.length === 0) return data
  const pad = data[data.length - 1] ?? 0
  if (pad === 0 || pad > 16 || pad > data.length) return data
  if (data.slice(data.length - pad).every(b => b === pad)) return data.slice(0, data.length - pad)
  return data
}

/** PKCS7 aligned block size. */
function alignedAesBlockSize(aesSize: number): number {
  return aesSize % 16 === 0 ? aesSize + 16 : aesSize + (16 - (aesSize % 16))
}

/**
 * Decode raw .dat bytes (XOR / V1 / V2).
 * @param data - raw .dat file bytes.
 * @param aesKey - V2 AES key (raw bytes), optional.
 * @param xorKey - XOR key byte for the XOR tail.
 * @returns decrypted bytes + format, or an error description.
 */
export function decodeDatBytes(
  data: Uint8Array,
  aesKey: Uint8Array | string | null,
  xorKey: number,
): { bytes: Uint8Array; format: string } | { error: string } {
  if (data.length < 6) return { error: '文件太小' }
  const sig = Array.from(data.slice(0, 6))
  const isV2 = sig.every((b, i) => b === V2_MAGIC_FULL[i])
  const isV1 = sig.every((b, i) => b === V1_MAGIC_FULL[i])
  let decrypted: Uint8Array
  if (isV2 || isV1) {
    const rawKey = typeof aesKey === 'string' && aesKey.length > 0 ? Buffer.from(aesKey, 'ascii') : aesKey
    const key: Uint8Array | null = isV1 ? V1_AES_KEY : (rawKey instanceof Uint8Array ? rawKey : null)
    if (!key) return { error: 'V2 格式需要 AES key' }
    if (key.length < 16) return { error: 'AES key 长度不足 16 字节' }
    if (data.length < 15) return { error: 'V2 文件头不完整' }
    const aesSize = (data[6] ?? 0) | ((data[7] ?? 0) << 8) | ((data[8] ?? 0) << 16) | ((data[9] ?? 0) << 24)
    const xorSize = (data[10] ?? 0) | ((data[11] ?? 0) << 8) | ((data[12] ?? 0) << 16) | ((data[13] ?? 0) << 24)
    const aligned = alignedAesBlockSize(aesSize)
    let offset = 15
    if (offset + aligned > data.length) return { error: '数据不足 AES 块' }
    const decAes = pkcs7Unpad(aes128EcbDecrypt(key, data.slice(offset, offset + aligned)))
    offset += aligned
    const rawEnd = data.length - xorSize
    const raw = offset < rawEnd ? data.slice(offset, Math.max(offset, rawEnd)) : new Uint8Array(0)
    offset = Math.max(offset, rawEnd)
    const xorPart = data.slice(offset).map(b => b ^ xorKey)
    const out = new Uint8Array(decAes.length + raw.length + xorPart.length)
    out.set(decAes, 0)
    out.set(raw, decAes.length)
    out.set(xorPart, decAes.length + raw.length)
    decrypted = out
  } else {
    const key = detectXorKey(data)
    if (key === null) return { error: '无法检测 XOR key' }
    decrypted = data.map(b => b ^ key)
  }
  // wxgf -> HEVC container (needs system decoder)
  if (decrypted.length >= 4 && decrypted[0] === 0x77 && decrypted[1] === 0x78 && decrypted[2] === 0x67 && decrypted[3] === 0x66) {
    return { bytes: decrypted, format: 'hevc' }
  }
  const hdr = decrypted.length > 16 ? decrypted.slice(0, 16) : decrypted
  const fmt = detectImageFormat(hdr)
  if (fmt === 'bin') return { error: '解密后无法识别图片格式 (可能是密钥错误)' }
  return { bytes: decrypted, format: fmt }
}

/** Decode bytes to a base64 data URL for a renderable format. */
function toDataUrl(format: string, bytes: Uint8Array): string {
  const mime = format === 'jpg' ? 'jpeg' : format
  return 'data:image/' + mime + ';base64,' + Buffer.from(bytes).toString('base64')
}

/** Renderable image extensions (decoded cache). */
const RENDERABLE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tif']

/**
 * 读一个目录下的解码缓存。**两个槽位**：
 *   `<md5>.<ext>`   = 本机最好的一份（原图，或 `getImageOriginal` 取回的那一份）
 *   `<md5>.t.<ext>` = 缩略/中图兜底（`_t.dat` / `_h.dat` 解出来的）
 *
 * 分成两个名字是 2026-09-20 修的缺陷：原先只有一个槽位，**谁先解出来谁永久占住**，
 * 于是缩略图一旦先缓存，用户之后在微信里点开的原图（attach 里多出一个大得多的 .dat）
 * 就再也读不到 —— 实测 106 条缓存里 35 条本机已有 2 倍以上大的 .dat（31 条大 8 倍以上），
 * 症状正是「我明明在微信里看过原图，这里还是糊的」。
 *
 * @param dir - 缓存目录（全局槽或按用户名的槽）。
 * @param md5 - 图片 md5（`packed_info_data` 那份）。
 * @returns 带 data URL 的结果（缩略槽命中时多一个 `thumb: true`），未命中返回 null。
 */
function cachedImage(dir: string, md5: string): { url?: string; format?: string; thumb?: boolean } | null {
  for (const thumb of [false, true]) {
    for (const ext of RENDERABLE_EXTS) {
      const p = join(dir, md5 + (thumb ? '.t.' : '.') + ext)
      if (!existsSync(p)) continue
      try {
        const bytes = readFileSync(p)
        const fmt = ext === 'jpeg' ? 'jpg' : ext
        return { url: toDataUrl(fmt, new Uint8Array(bytes)), format: fmt, ...(thumb ? { thumb: true } : {}) }
      } catch {
        // 读缓存失败不再直接报错：落到下面的 .dat 重解，解出来会顺手把这个坏条目覆盖掉
        return null
      }
    }
  }
  return null
}

/**
 * 清掉一张图的全部解码缓存（两个槽位都删）。
 * @param decodedDir - 解码缓存根。
 * @param username - 会话 username（按用户名的那个槽）。
 * @param md5 - 图片 md5。
 * @returns 删掉的条目数。
 */
export function clearDecodedImageCache(decodedDir: string, username: string, md5: string): number {
  if (!md5) return 0
  let removed = 0
  for (const dir of [decodedDir, join(decodedDir, username)]) {
    for (const ext of [...RENDERABLE_EXTS, 'hevc']) {
      for (const thumb of [false, true]) {
        const p = join(dir, md5 + (thumb ? '.t.' : '.') + ext)
        try {
          if (existsSync(p)) { rmSync(p); removed += 1 }
        } catch { /* 删不掉就留着，下一次照样能读 */ }
      }
    }
  }
  return removed
}

/**
 * Resolve and decode a message image to a base64 data URL.
 * @param decryptedDir - decrypted data root.
 * @param decodedDir - decoded image cache root (data/wechat/decoded_images).
 * @param username - conversation username.
 * @param localId - message local id.
 * @param wechatBaseDir - optional raw WeChat install dir for .dat fallback.
 * @param aesKey - optional V2 AES key (16-char ASCII string or raw bytes).
 * @param xorKey - XOR key byte, defaults to 0xFF.
 * @returns data URL + format（`thumb: true` 表示这次给的是缩略/中图那一份）, or an error description.
 */
export function decodeImageDataUrl(
  decryptedDir: string,
  decodedDir: string,
  username: string,
  localId: number,
  wechatBaseDir?: string,
  aesKey?: string | Uint8Array,
  xorKey?: number,
): { url?: string; format?: string; thumb?: boolean; error?: string } {
  const hint = resolveImageResourceHint(decryptedDir, username, localId)
  const md5 = hint.md5
  if (!md5 && !hint.dataIndex) return { error: '无法找到图片 MD5' }
  // 1a/1. 已解码缓存：全局槽（批量解密产物，与用户名无关）优先，再看按用户名的槽。
  //       每个槽里都先要「最好的一份」，再退到 `.t.` 的缩略兜底 —— 见 `cachedImage` 的注释。
  if (md5) {
    const hit = cachedImage(decodedDir, md5) ?? cachedImage(join(decodedDir, username), md5)
    if (hit) return hit
    const hevc = join(decodedDir, username, md5 + '.hevc')
    if (existsSync(hevc)) return { error: 'hevc-unsupported' }
  }
  // 2. raw .dat decode (requires the raw WeChat base dir)
  if (wechatBaseDir && md5) {
    const attach = join(wechatBaseDir, 'msg', 'attach', msgTableName(username).replace(/^Msg_/, ''))
    const dats = findDatFiles(attach, md5)
    if (dats.length > 0) {
      // The original is often wxgf/HEVC in wechat 4.x; prefer a renderable
      // candidate (thumbnail _t / _h), falling back to the original only when
      // it decodes to a browser-renderable format.
      const aesBytes = typeof aesKey === 'string' && aesKey.length > 0 ? Buffer.from(aesKey, 'ascii') : (aesKey ?? null)
      const ordered = [...dats].sort((a, b) => scoreDatPath(a) - scoreDatPath(b))
      for (const f of ordered) {
        try {
          const bytes = readFileSync(f)
          const dec = decodeDatBytes(new Uint8Array(bytes), aesBytes, xorKey ?? 0xff)
          if ('error' in dec) continue
          if (dec.format === 'hevc') continue
          // `_t`/`_h` 解出来的是缩略/中图：必须写进 `.t.` 那个兜底槽，不能占住「最好的一份」
          const thumb = scoreDatPath(f) > 0
          try {
            writeDecodedCache(decodedDir, username, md5, dec.format, dec.bytes, thumb)
          } catch { /* cache best-effort */ }
          return { url: toDataUrl(dec.format, dec.bytes), format: dec.format, ...(thumb ? { thumb: true } : {}) }
        } catch { /* try next candidate */ }
      }
      return { error: 'hevc-unsupported' }
    }
  }
  // 3. hardlink 定位表兜底 (MessageResourceDetail.data_index / md5 → .dat 路径)
  if (wechatBaseDir) {
    const hd = resolveImageFilePath(decryptedDir, wechatBaseDir, md5 ?? '', hint.dataIndex)
    if (hd) {
      const aesBytes = typeof aesKey === 'string' && aesKey.length > 0 ? Buffer.from(aesKey, 'ascii') : (aesKey ?? null)
      try {
        const bytes = readFileSync(hd)
        const dec = decodeDatBytes(new Uint8Array(bytes), aesBytes, xorKey ?? 0xff)
        if (!('error' in dec) && dec.format !== 'hevc') {
          const thumb = scoreDatPath(hd) > 0
          try {
            writeDecodedCache(decodedDir, username, md5 || 'data-' + hint.dataIndex, dec.format, dec.bytes, thumb)
          } catch { /* cache best-effort */ }
          return { url: toDataUrl(dec.format, dec.bytes), format: dec.format, ...(thumb ? { thumb: true } : {}) }
        }
      } catch { /* unreadable dat fall through */ }
    }
  }
  return { error: md5 ? '找不到 .dat 文件 (MD5=' + md5 + ')' : '无法定位图片文件 (data_index=' + hint.dataIndex + ')' }
}

/**
 * Resolve a file-library image (hardlink_info md5) from the decoded cache only.
 * 只读取已解密 JPG（decoded_images/<md5>.jpg|.jpeg），不做任何 .dat 解密，
 * 未命中直接报错，前端保持占位图标。
 */
export function decodeFileImageDataUrl(
  decryptedDir: string,
  decodedDir: string,
  wechatBaseDir: string | undefined,
  md5: string | undefined,
  aesKey?: string | Uint8Array,
  xorKey = 0xff,
): { url?: string; error?: string } {
  const m = (md5 ?? '').trim().toLowerCase()
  if (!/^[0-9a-f]{32}$/.test(m)) return { error: '缺少图片 MD5' }
  for (const ext of ['jpg']) {
    const p = join(decodedDir, m + '.' + ext)
    if (existsSync(p)) {
      try {
        const bytes = readFileSync(p)
        return { url: toDataUrl(ext === 'jpeg' ? 'jpg' : ext, new Uint8Array(bytes)) }
      } catch (e) {
        return { error: '读取已解码图片失败: ' + (e as Error).message }
      }
    }
  }
  return { error: '未找到已解密图片（decoded_images/' + m + '.jpg 不存在）' }
}

/**
 * Resolve a custom emoticon (sticker) md5 to a base64 data URL.
 *
 * 自定义表情文件不在会话消息目录下，而是散落在 `msg/attach/<hash>/<YYYY-MM>/Img/<md5>.dat`
 * （同一条表情可能被多个会话各缓存一份）。策略：
 *  1. 先读 `decoded_images/<md5>.<ext>`（批量解密/上次解码缓存）；
 *  2. 再扫 `msg/attach` 找 `<md5>.dat` / `<md5>_t.dat`，优先缩略图（小、可渲染）；
 *  3. 解码成功后写回 decoded 缓存，避免重复全量扫描。
 * @param decryptedDir - decrypted data root（仅用于缓存路径约定）。
 * @param decodedDir - decoded image cache root.
 * @param wechatBaseDir - raw WeChat account root (contains msg/attach).
 * @param md5 - emoticon md5 from message XML.
 * @param aesKey - V2 AES key.
 * @param xorKey - XOR key byte.
 * @returns data URL or error.
 */
export function decodeEmoticonDataUrl(
  decryptedDir: string,
  decodedDir: string,
  wechatBaseDir: string | undefined,
  md5: string | undefined,
  aesKey?: string | Uint8Array,
  xorKey = 0xff,
): { url?: string; format?: string; error?: string } {
  const m = (md5 ?? '').trim().toLowerCase()
  if (!/^[0-9a-f]{32}$/.test(m)) return { error: '缺少表情 MD5' }
  for (const ext of RENDERABLE_EXTS) {
    const p = join(decodedDir, m + '.' + ext)
    if (existsSync(p)) {
      try {
        const bytes = readFileSync(p)
        return { url: toDataUrl(ext === 'jpeg' ? 'jpg' : ext, new Uint8Array(bytes)), format: ext === 'jpeg' ? 'jpg' : ext }
      } catch (e) {
        return { error: '读取已解码表情失败: ' + (e as Error).message }
      }
    }
  }
  if (!wechatBaseDir) return { error: '表情未缓存且缺少原始微信目录' }
  const attachRoot = join(wechatBaseDir, 'msg', 'attach')
  if (!existsSync(attachRoot)) return { error: '表情未缓存且找不到 msg/attach' }
  const dats: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 4 || dats.length > 8) return
    let entries: Array<{ name: string; isDir: boolean }> = []
    try {
      entries = readdirSync(dir, { withFileTypes: true }).map(e => ({ name: e.name, isDir: e.isDirectory() }))
    } catch { return }
    for (const e of entries) {
      if (dats.length > 8) return
      const p = join(dir, e.name)
      if (e.isDir) {
        walk(p, depth + 1)
      } else if ((e.name === m + '_t.dat' || e.name === m + '.dat') && e.name.endsWith('.dat')) {
        dats.push(p)
      }
    }
  }
  walk(attachRoot, 0)
  if (dats.length === 0) return { error: '未找到表情文件 (MD5=' + m + ')' }
  const aesBytes = typeof aesKey === 'string' && aesKey.length > 0 ? Buffer.from(aesKey, 'ascii') : (aesKey ?? null)
  // Prefer thumbnails (_t) — smaller and usually already a still frame; original may be HEVC.
  const ordered = [...dats].sort((a, b) => scoreDatPath(a) - scoreDatPath(b))
  for (const f of ordered) {
    try {
      const bytes = readFileSync(f)
      const dec = decodeDatBytes(new Uint8Array(bytes), aesBytes, xorKey)
      if ('error' in dec) continue
      if (dec.format === 'hevc') continue
      try {
        writeFileSync(join(decodedDir, m + '.' + dec.format), Buffer.from(dec.bytes))
      } catch { /* cache best-effort */ }
      return { url: toDataUrl(dec.format, dec.bytes), format: dec.format }
    } catch { /* try next */ }
  }
  return { error: '表情文件无法解码为浏览器可渲染格式' }
}

/**
 * 远端取一张自定义表情并落进 decoded 缓存（本地缓存解不开时的兜底）。
 *
 * 为什么需要：微信把表情图放在 `business/emoticon/*` 与 `cache/<月>/Emoticon/*`，
 * 那些文件是**加密**的（16 字节对齐；单字节 XOR、配置里的 image_aes_key、
 * 消息里的 aeskey 都试过解不开，见 `output/probe-sticker-crypt*.mjs`）。
 * 而消息 XML 里的 `cdnurl` 提供的是**未加密**的那一份：实测
 * （`output/probe-sticker-cdn2.mjs`）去掉 `&amp;` 转义后 6/6 返回 200 与明文
 * GIF/PNG/JPEG，体积与消息里的 `len` 逐字节一致。
 *
 * 取到后按 `<decoded>/<md5>.<ext>` 落盘，于是**下次（含离线）就走本地解码路径**，
 * 网络只花一次。失败一律返回 error，界面退回占位芯片。
 * @param url - the sticker CDN url from the message XML (`<emoji cdnurl>`).
 * @param decodedDir - decoded cache dir.
 * @param md5 - sticker md5 (used as the cache file name).
 * @param opts - `cdnEnabled`：关闭「自动获取原图（CDN）」时**不发起请求**（N24）。
 * @returns a data URL + format, or an error message.
 */
export async function fetchEmoticonRemote(
  url: string,
  decodedDir: string,
  md5: string,
  opts: { cdnEnabled?: boolean } = {},
): Promise<{ url?: string; format?: string; error?: string }> {
  // 用户关掉开关时连请求都不发（不是「发了再失败」）：这既是开关的承诺，也让「有没有出网」可判定
  if (!cdnFetchAllowed(opts)) return { error: CDN_DISABLED_MESSAGE }
  if (!/^https?:\/\//i.test(url)) return { error: '表情链接不是 http(s)' }
  try {
    // N13：远端取图走有界重试（一次网络抖动 = 一个失败的表情很可惜）；
    // 超时交给重试层逐次计时（自己传 AbortSignal.timeout 会让重试在第一次超时后直接停）。
    const res = await fetchWithRetry(fetch, url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, { timeoutMs: 10_000 })
    if (!res.ok) return { error: '表情下载失败 HTTP ' + String(res.status) }
    const bytes = new Uint8Array(await res.arrayBuffer())
    const fmt = detectImageFormat(bytes.subarray(0, 16))
    if (fmt === 'bin') return { error: '表情下载回来不是图片' }
    try {
      mkdirSync(decodedDir, { recursive: true })
      writeFileSync(join(decodedDir, md5 + '.' + fmt), Buffer.from(bytes))
    } catch { /* cache best-effort */ }
    return { url: toDataUrl(fmt, bytes), format: fmt }
  } catch (e) {
    return { error: '表情下载失败: ' + (e as Error).message }
  }
}

/** Prefer originals over thumbnails: 0 = .dat, 1 = _h.dat, 2 = _t.dat. */
function scoreDatPath(p: string): number {
  if (p.endsWith('_t.dat')) return 2
  if (p.endsWith('_h.dat')) return 1
  return 0
}

/**
 * Write a decoded image into the cache so later lookups hit instantly.
 * @param thumb - true 表示这是 `_t`/`_h` 解出来的缩略/中图，写进 `<md5>.t.<ext>` 兜底槽，
 *   不占「本机最好的一份」那个槽（否则原图后到也会被永久遮蔽，见 `cachedImage`）。
 */
function writeDecodedCache(decodedDir: string, username: string, md5: string, format: string, bytes: Uint8Array, thumb = false): void {
  const dir = join(decodedDir, username)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, md5 + (thumb ? '.t.' : '.') + format), Buffer.from(bytes))
}

/** Recursively find .dat files whose name starts with the image MD5. */
function findDatFiles(attachRoot: string, fileMd5: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return
    let entries: Array<{ name: string; isDir: boolean }> = []
    try { entries = readdirSync(dir, { withFileTypes: true }).map(e => ({ name: e.name, isDir: e.isDirectory() })) } catch { return }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDir) {
        walk(p)
      } else if (e.name.startsWith(fileMd5) && e.name.endsWith('.dat')) {
        out.push(p)
      }
    }
  }
  walk(attachRoot)
  return out
}

/** Stringify an SQLite cell (TEXT/NUMBER/BLOB) to a string. */
function cellText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (v instanceof Uint8Array) return new TextDecoder('utf-8', { fatal: false }).decode(v)
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol') return String(v)
  return ''
}

/** Read dir2id (rowid → directory name) from the decrypted hardlink.db. */
function readDir2id(db: DatabaseSync): Map<number, string> {
  const map = new Map<number, string>()
  const rows = db.prepare('SELECT rowid, username FROM dir2id').all() as Array<{ rowid: number; username: unknown }>
  for (const r of rows) map.set(r.rowid, cellText(r.username).trim())
  return map
}

/** Candidate disk paths for a hardlink image file (mirrors ST candidate_paths). */
function imageCandidatePaths(baseDir: string, file: string, n1: string, n2: string): string[] {
  const out: string[] = []
  const push = (p: string): void => {
    if (!out.includes(p)) out.push(p)
  }
  const pairs: Array<[string, string]> = [[n1, n2], [n2, n1]]
  for (const [a, b] of pairs) {
    push(join(baseDir, 'msg', 'attach', a, b, 'Img', file))
    push(join(baseDir, 'msg', 'attach', a, b, file))
  }
  push(join(baseDir, 'msg', 'attach', n1, 'Img', file))
  push(join(baseDir, 'msg', 'attach', n1, file))
  push(join(baseDir, 'msg', 'attach', n2, file))
  return out
}

/**
 * `image_hardlink_info_v4` 的一行（file_name 是 TEXT/BLOB，dir1/dir2 是 dir2id 行号）。
 *
 * 用 type 而不是 interface：`db.prepare(...).all()` 返回的是 `Record<string, SQLOutputValue>[]`，
 * 只有**匿名对象类型**能靠隐式索引签名与它比较（interface 不会，断言会报 TS2352）。
 */
type ImageHardlinkRow = {
  file_name: unknown
  dir1: number
  dir2: number
}

/** 单个 md5 的候选行上限（与旧实现的 `LIMIT 8` 一致；同一条消息的多个副本按时间倒序取最近的几个）。 */
const HARDLINK_ROWS_PER_MD5 = 8

/** 一批 `IN (...)` 里的 md5 个数上限（分块查询，避免语句过长/计划过大）。 */
const HARDLINK_MD5_CHUNK = 400

/**
 * 把候选行按 dir2id 映射成磁盘路径，返回第一个**真实存在**的。
 * @param wechatBaseDir - 微信原始目录。
 * @param rows - 候选行（顺序即优先级）。
 * @param dirs - dir2id 映射。
 * @returns 绝对路径，或 null。
 */
function firstExistingDatPath(wechatBaseDir: string, rows: readonly ImageHardlinkRow[], dirs: Map<number, string>): string | null {
  for (const r of rows) {
    const file = cellText(r.file_name).trim()
    if (!file || !file.endsWith('.dat')) continue
    const n1 = dirs.get(r.dir1) ?? ''
    const n2 = dirs.get(r.dir2) ?? ''
    for (const p of imageCandidatePaths(wechatBaseDir, file, n1, n2)) {
      if (existsSync(p)) return p
    }
  }
  return null
}

/**
 * **一次**查询解析多张图的 .dat 路径（N16）。
 *
 * 为什么要有批量入口：`WHERE lower(md5) = ?` 在 `image_hardlink_info_v4` 上没有可用索引
 * （`EXPLAIN QUERY PLAN` = `SCAN ... USING INDEX image_hardlink_info_v4_MODIFY_TIME`，
 * 即走 modify_time 索引再逐行过滤，等价全表扫）。实测本机 3309 行 0.30ms/次、
 * 合成 20 万行 17.27ms/次 —— 30 张图各查一次 ≈518ms。`IN (...)` 只扫一次。
 *
 * 分批：一批最多 {@link HARDLINK_MD5_CHUNK} 个 md5（远小于 SQLite 的参数上限，
 * 只为了让语句长度与计划大小可控，与 `ledger.ts` 的分块同款）。
 *
 * **接线状态**：网关目前只有「一张图一次 RPC」（`getImageDataUrl`），要吃到这个批量入口
 * 需要一次批量 RPC（接口变更，不在本轮范围）—— 见 `docs/RELEASE-PLAN.md` 的 N16。
 * @param decryptedDir - 解密库目录。
 * @param wechatBaseDir - 微信原始目录（候选路径的根）。
 * @param md5s - 图片 md5 列表（非 32 位十六进制的项会被忽略，重复项只查一次）。
 * @returns md5（小写）→ 命中的 .dat 路径；没命中的 md5 不会出现在结果里。
 */
export function resolveImageFilePathsByMd5(
  decryptedDir: string,
  wechatBaseDir: string,
  md5s: readonly string[],
): Map<string, string> {
  const out = new Map<string, string>()
  const wanted = [...new Set(md5s.map(m => (m ?? '').trim().toLowerCase()).filter(m => m.length === 32))]
  if (wanted.length === 0) return out
  const dbPath = join(decryptedDir, 'hardlink', 'hardlink.db')
  if (!existsSync(dbPath)) return out
  let db: DatabaseSync | null = null
  try { db = new DatabaseSync(dbPath, { readOnly: true }) } catch { return out }
  try {
    const dirs = readDir2id(db)
    for (let i = 0; i < wanted.length; i += HARDLINK_MD5_CHUNK) {
      const chunk = wanted.slice(i, i + HARDLINK_MD5_CHUNK)
      const placeholders = chunk.map(() => '?').join(', ')
      const rows = db.prepare(
        `SELECT lower(md5) AS m, file_name, dir1, dir2 FROM image_hardlink_info_v4 WHERE lower(md5) IN (${placeholders}) ORDER BY modify_time DESC`,
      ).all(...chunk) as Array<ImageHardlinkRow & { m: unknown }>
      const byMd5 = new Map<string, ImageHardlinkRow[]>()
      for (const r of rows) {
        const key = cellText(r.m).trim().toLowerCase()
        const list = byMd5.get(key)
        if (list) {
          if (list.length < HARDLINK_ROWS_PER_MD5) list.push(r)
        } else {
          byMd5.set(key, [r])
        }
      }
      for (const md5 of chunk) {
        const found = firstExistingDatPath(wechatBaseDir, byMd5.get(md5) ?? [], dirs)
        if (found) out.set(md5, found)
      }
    }
  } catch { /* db unreadable */ } finally {
    try { db.close() } catch { /* already closed */ }
  }
  return out
}

/**
 * Resolve an image's on-disk .dat path via the decrypted hardlink.db:
 * image_hardlink_info_v4 is queried by md5 (and by MessageResourceDetail
 * data_index rowid when given), then dir1/dir2 are mapped through dir2id to
 * the real msg/attach directory names. Returns the first existing path.
 *
 * 单张图走的就是批量入口（见 {@link resolveImageFilePathsByMd5}）—— 语义与改前一致：
 * 先按 md5 的行、再按 data_index 的行，取第一个真实存在的路径。
 * @param decryptedDir - decrypted data root.
 * @param wechatBaseDir - raw WeChat install dir (current account root).
 * @param md5 - 32-char image md5 (optional when dataIndex is given).
 * @param dataIndex - MessageResourceDetail.data_index (rowid hint, optional).
 * @returns absolute .dat path, or null when not resolvable.
 */
export function resolveImageFilePath(
  decryptedDir: string,
  wechatBaseDir: string,
  md5?: string,
  dataIndex?: string,
): string | null {
  const md5l = (md5 ?? '').trim().toLowerCase()
  const di = (dataIndex ?? '').trim()
  const byMd5 = md5l.length === 32 ? resolveImageFilePathsByMd5(decryptedDir, wechatBaseDir, [md5l]).get(md5l) : undefined
  if (byMd5) return byMd5
  if (!di || !/^\d+$/.test(di)) return null
  const dbPath = join(decryptedDir, 'hardlink', 'hardlink.db')
  if (!existsSync(dbPath)) return null
  let db: DatabaseSync | null = null
  try { db = new DatabaseSync(dbPath, { readOnly: true }) } catch { return null }
  try {
    const dirs = readDir2id(db)
    const byRow = db.prepare('SELECT file_name, dir1, dir2 FROM image_hardlink_info_v4 WHERE _rowid_ = ? LIMIT 1').all(Number(di)) as ImageHardlinkRow[]
    return firstExistingDatPath(wechatBaseDir, byRow, dirs)
  } catch {
    return null
  } finally {
    try { db.close() } catch { /* already closed */ }
  }
}
