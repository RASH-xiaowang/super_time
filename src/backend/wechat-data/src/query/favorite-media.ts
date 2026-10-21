/**
 * 微信收藏媒体解析。
 *
 * 收藏 XML 给出的是明文内容 MD5，而微信 4.x 把收藏附件放在
 * `<账号根>/business/favorite/{data,mid,thumb}`，文件名是**不透明哈希**，
 * 与 XML 里的 MD5 无关。这里按明文 MD5 建索引，避免把 CDN 协议字段误当成
 * 普通 HTTP 地址。
 */
import { createDecipheriv, createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs'
import { basename, join } from 'node:path'
import type { ImageDataUrlResult } from '../types.ts'

type FavoriteBucket = 'data' | 'mid' | 'thumb' | 'temp'
type FavoriteKind = 'image' | 'video' | 'audio' | 'file' | 'unknown'

interface IndexEntry {
  path: string
  /** 原始文件名；`temp` 下微信会保留用户可见的文件名。 */
  name: string
  format: string
  /** 解密后的字节数，用于同名文件消歧。 */
  size: number
}

interface FavoriteMediaIndex {
  byMd5: Map<string, IndexEntry>
  byNameSize: Map<string, IndexEntry>
}

interface IndexState {
  rootsKey: string
  keyPair: string
  index: FavoriteMediaIndex
}

const BUCKETS: readonly FavoriteBucket[] = ['data', 'mid', 'thumb', 'temp']
const MD5_RE = /^[0-9a-f]{32}$/i
const MAX_INDEX_BYTES = 128 * 1024 * 1024
const IMAGE_FORMATS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tif', 'tiff'])
const VIDEO_FORMATS = new Set(['mp4', 'mov', 'm4v'])
const AUDIO_FORMATS = new Set(['mp3', 'wav', 'm4a', 'silk'])

let cachedIndex: IndexState | null = null

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  m4v: 'video/mp4',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  silk: 'audio/silk',
  pdf: 'application/pdf',
  zip: 'application/zip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

function md5(bytes: Uint8Array): string {
  return createHash('md5').update(bytes).digest('hex')
}

function extensionOf(path: string): string {
  const base = path.replace(/\\/g, '/').split('/').pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

/** 文件名匹配使用 NFC + 小写；Windows 大小写不敏感，用户原名可能由不同来源给出。 */
function normalizeFileName(name: string): string {
  return basename(name.replace(/\\/g, '/')).normalize('NFC').trim().toLowerCase()
}

function nameSizeKey(name: string, size: number): string {
  return normalizeFileName(name) + '|' + String(size)
}

function formatOf(path: string, bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg'
  if (bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).toString('hex') === '89504e470d0a1a0a') return 'png'
  if (bytes.length >= 4 && bytes.subarray(0, 4).toString() === 'GIF8') return 'gif'
  if (bytes.length >= 12 && Buffer.from(bytes.subarray(8, 12)).toString() === 'WEBP') return 'webp'
  if (bytes.length >= 8 && Buffer.from(bytes.subarray(4, 8)).toString() === 'ftyp') {
    return bytes.length >= 12 && Buffer.from(bytes.subarray(8, 12)).toString() === 'qt  ' ? 'mov' : 'mp4'
  }
  if (bytes.length >= 4 && bytes.subarray(0, 4).toString() === 'RIFF') {
    if (bytes.length >= 12 && Buffer.from(bytes.subarray(8, 12)).toString() === 'WAVE') return 'wav'
  }
  if (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return 'mp3'
  if (bytes.length >= 2 && bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0) return 'mp3'
  if (bytes.length >= 4 && bytes.subarray(0, 4).toString() === 'SILK') return 'silk'
  if (bytes.length >= 5 && Buffer.from(bytes.subarray(0, 5)).toString() === '%PDF-') return 'pdf'
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return 'zip'
  return extensionOf(path)
}

function mimeOf(format: string, kind: FavoriteKind): string {
  const known = MIME_BY_EXT[format]
  if (known !== undefined) return known
  if (kind === 'image') return 'image/jpeg'
  if (kind === 'video') return 'video/mp4'
  if (kind === 'audio') return 'audio/mpeg'
  return 'application/octet-stream'
}

function filesUnder(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 3) return
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      try {
        if (entry.isDirectory()) walk(path, depth + 1)
        else if (entry.isFile()) out.push(path)
      } catch {
        // 微信正在写的文件可能瞬时不可读，跳过即可。
      }
    }
  }
  walk(root, 0)
  return out
}

function favoriteRoots(wechatBaseDir: string | undefined): string[] {
  const base = String(wechatBaseDir ?? '').trim()
  if (base === '') return []
  const roots = [join(base, 'business', 'favorite')]
  // 兼容把账号根指向 db_storage 父目录、或直接指向 favorite 目录的配置。
  if (/[\\/]business[\\/]favorite$/i.test(base)) roots.unshift(base)
  return roots.filter((root, i) => roots.indexOf(root) === i && existsSync(root))
}

function readPlain(path: string, aesKey: string | undefined, xorKey: number): { bytes: Uint8Array; format: string } | null {
  let raw: Uint8Array
  try {
    raw = new Uint8Array(readFileSync(path))
  } catch {
    return null
  }
  if (raw.length === 0 || raw.length > MAX_INDEX_BYTES) return null
  const signature = Array.from(raw.subarray(0, 6))
  const encrypted = signature.length === 6 && signature[0] === 0x07 && signature[1] === 0x08
  if (!encrypted) {
    return { bytes: raw, format: formatOf(path, raw) }
  }
  // 收藏资源不只有图片：视频、PDF、压缩包解出来后都不是图片魔数，
  // 不能复用只接受图片的 decodeDatPayload，否则这些文件会被索引漏掉。
  const decrypted = decryptV2(raw, aesKey, xorKey)
  if (decrypted === null) return null
  return { bytes: decrypted, format: formatOf(path, decrypted) }
}

function decryptV2(raw: Uint8Array, aesKey: string | undefined, xorKey: number): Uint8Array | null {
  if (raw.length < 15) return null
  const aesSize = (raw[6] ?? 0) | ((raw[7] ?? 0) << 8) | ((raw[8] ?? 0) << 16) | ((raw[9] ?? 0) << 24)
  const xorSize = (raw[10] ?? 0) | ((raw[11] ?? 0) << 8) | ((raw[12] ?? 0) << 16) | ((raw[13] ?? 0) << 24)
  const aligned = aesSize % 16 === 0 ? aesSize + 16 : aesSize + (16 - (aesSize % 16))
  const offset = 15
  if (offset + aligned > raw.length || xorSize > raw.length - offset - aligned) return null
  if (!aesKey || aesKey.trim() === '') return null
  try {
    const decipher = createDecipheriv('aes-128-ecb', Buffer.from(aesKey, 'ascii').subarray(0, 16), null)
    decipher.setAutoPadding(false)
    const aesBlock = Buffer.concat([
      decipher.update(Buffer.from(raw.subarray(offset, offset + aligned))),
      decipher.final(),
    ])
    const pad = aesBlock[aesBlock.length - 1] ?? 0
    const aesPlain = pad > 0 && pad <= 16 && aesBlock.subarray(aesBlock.length - pad).every((b) => b === pad)
      ? aesBlock.subarray(0, aesBlock.length - pad)
      : aesBlock
    const middle = raw.subarray(offset + aligned, raw.length - xorSize)
    const tail = raw.subarray(raw.length - xorSize)
    const out = new Uint8Array(aesPlain.length + middle.length + tail.length)
    out.set(aesPlain, 0)
    out.set(middle, aesPlain.length)
    for (let i = 0; i < tail.length; i += 1) out[aesPlain.length + middle.length + i] = (tail[i] ?? 0) ^ xorKey
    return out
  } catch {
    return null
  }
}

function buildIndexEntry(path: string, aesKey: string | undefined, xorKey: number): { md5: string; entry: IndexEntry } | null {
  const plain = readPlain(path, aesKey, xorKey)
  if (plain === null) return null
  const digest = md5(plain.bytes)
  if (!MD5_RE.test(digest)) return null
  return {
    md5: digest,
    entry: {
      path,
      name: basename(path),
      format: plain.format || extensionOf(path),
      size: plain.bytes.length,
    },
  }
}

function buildIndex(roots: readonly string[], aesKey: string | undefined, xorKey: number): FavoriteMediaIndex {
  const byMd5 = new Map<string, IndexEntry>()
  const byNameSize = new Map<string, IndexEntry>()
  for (const root of roots) {
    for (const bucket of BUCKETS) {
      for (const path of filesUnder(join(root, bucket))) {
        const row = buildIndexEntry(path, aesKey, xorKey)
        if (row === null) continue
        if (!byMd5.has(row.md5)) byMd5.set(row.md5, row.entry)
        const key = nameSizeKey(row.entry.name, row.entry.size)
        if (!byNameSize.has(key)) byNameSize.set(key, row.entry)
      }
    }
  }
  return { byMd5, byNameSize }
}

function indexFor(roots: readonly string[], aesKey: string | undefined, xorKey: number): FavoriteMediaIndex {
  const rootsKey = roots.join('|')
  const keyPair = String(aesKey ?? '') + '|' + String(xorKey)
  if (cachedIndex !== null && cachedIndex.rootsKey === rootsKey && cachedIndex.keyPair === keyPair) {
    return cachedIndex.index
  }
  const index = buildIndex(roots, aesKey, xorKey)
  cachedIndex = { rootsKey, keyPair, index }
  return index
}

/**
 * 在索引里查 MD5；索引未覆盖某张图时再对全目录做一次增量扫描。
 *
 * 这里刻意不用“每次请求都重建签名”：收藏目录可能有上万个不透明文件，
 * 递归 stat 一遍就足够让抽屉首开卡住。完整索引在第一次缺页时建立一次，
 * 之后所有收藏共用。
 */
function lookupIndexed(
  roots: readonly string[],
  wanted: readonly string[],
  aesKey: string | undefined,
  xorKey: number,
): Array<{ md5: string; entry: IndexEntry }> {
  const index = indexFor(roots, aesKey, xorKey)
  const hits: Array<{ md5: string; entry: IndexEntry }> = []
  for (const digest of wanted) {
    const hit = index.byMd5.get(digest)
    if (hit !== undefined) hits.push({ md5: digest, entry: hit })
  }
  // 直接命中失败后再扫一次；补入所有新命中的候选，交给调用方按类型筛选。
  for (const root of roots) {
    for (const bucket of BUCKETS) {
      for (const path of filesUnder(join(root, bucket))) {
        const row = buildIndexEntry(path, aesKey, xorKey)
        if (row === null || !wanted.includes(row.md5)) continue
        const key = nameSizeKey(row.entry.name, row.entry.size)
        if (!index.byNameSize.has(key)) index.byNameSize.set(key, row.entry)
        if (index.byMd5.has(row.md5)) continue
        index.byMd5.set(row.md5, row.entry)
        hits.push(row)
      }
    }
  }
  return hits
}

/** 按文件名 + 解密后体积查找 `business/favorite/temp` 中的原件。 */
function lookupByNameSize(
  roots: readonly string[],
  fileName: string | undefined,
  size: number | undefined,
  aesKey: string | undefined,
  xorKey: number,
): IndexEntry | null {
  const name = normalizeFileName(String(fileName ?? ''))
  const wantedSize = Number.isFinite(size) && (size ?? 0) > 0 ? Math.trunc(size as number) : 0
  if (!name || wantedSize === 0) return null
  const index = indexFor(roots, aesKey, xorKey)
  return index.byNameSize.get(nameSizeKey(name, wantedSize)) ?? null
}

function requestedMd5(options: { md5?: string; thumbMd5?: string; fullMd5?: string }): string[] {
  // 图片/视频优先完整内容 MD5；文件/语音也先按 XML 的主 md5。
  // `md5` 由后端按类型设置（图片/视频通常是缩略图，未知资源可能是主内容），
  // 所以把它放在 full 之后仍能保留“原图优先”的语义。
  const values = [options.fullMd5, options.md5, options.thumbMd5]
    .map((v) => String(v ?? '').trim().toLowerCase())
    .filter((v) => MD5_RE.test(v))
  return values.filter((v, i) => values.indexOf(v) === i)
}

/**
 * 校验候选文件的真实类型。
 *
 * 收藏 XML 的 MD5 有时指向同名资源的封面（实测视频 fullMd5 命中 JPG），
 * 只按 MD5 直接返回会把图片塞进 `<video>`，或把视频塞进 `<img>`。
 */
function acceptsKind(entry: IndexEntry, options: {
  kind?: FavoriteKind
  ext?: string
}): boolean {
  const format = (entry.format || extensionOf(entry.path)).toLowerCase()
  if (options.kind === undefined || options.kind === 'unknown') return true
  if (options.kind === 'image') return IMAGE_FORMATS.has(format)
  if (options.kind === 'video') return VIDEO_FORMATS.has(format)
  if (options.kind === 'audio') return AUDIO_FORMATS.has(format)
  const ext = String(options.ext ?? '').trim().toLowerCase()
  return ext === '' || format === ext || format === ''
}

/**
 * 按内容 MD5 读取一个收藏资源。
 * @param wechatBaseDir - 微信账号根目录。
 * @param options - XML 里的 md5 / 类型提示。
 * @param aesKey - 当前账号的图片 AES 密钥。
 * @param xorKey - 当前账号的 XOR 字节。
 * @returns data URL 或可读错误；本地收藏缓存没有时返回 error。
 */
export function resolveFavoriteMediaDataUrl(
  wechatBaseDir: string | undefined,
  options: {
    md5?: string
    thumbMd5?: string
    fullMd5?: string
    kind?: FavoriteKind
    ext?: string
    fileName?: string
    size?: number
  },
  aesKey: string | undefined,
  xorKey: number,
): ImageDataUrlResult {
  const roots = favoriteRoots(wechatBaseDir)
  if (roots.length === 0) return { error: '未找到微信收藏缓存目录' }
  // 收藏目录可能暂时只有 data/mid 而无 thumb；不要因为空目录就提前报错。
  if (!roots.some((root) => BUCKETS.some((bucket) => existsSync(join(root, bucket))))) {
    return { error: '微信收藏缓存目录中还没有资源' }
  }
  const wanted = requestedMd5(options)
  // MD5 是首选，但 XML 里也可能残留旧 MD5 / 错误 MD5。只要调用方提供了
  // 文件名和体积，在 MD5 候选全部失败后仍应能回退到 temp 里的可见原名原件。
  const named = lookupByNameSize(roots, options.fileName, options.size, aesKey, xorKey)
  if (wanted.length === 0 && named === null) return { error: '缺少收藏资源 MD5 或文件名' }
  const hits = wanted.length > 0 ? lookupIndexed(roots, wanted, aesKey, xorKey) : []
  if (named !== null && !hits.some((hit) => hit.entry.path === named.path)) {
    hits.push({ md5: '', entry: named })
  }
  let sawWrongKind = false
  for (const hit of hits) {
    const dec = readPlain(hit.entry.path, aesKey, xorKey)
    if (dec === null || (hit.md5 !== '' && md5(dec.bytes) !== hit.md5)) continue
    if (!acceptsKind({ ...hit.entry, format: dec.format || hit.entry.format }, options)) {
      sawWrongKind = true
      continue
    }
    return dataUrlOf(hit.entry.path, dec, options)
  }
  if (sawWrongKind) return { error: '缓存中的文件类型与收藏资源不一致' }
  return { error: '微信收藏缓存中未找到该资源' }
}

function dataUrlOf(
  path: string,
  dec: { bytes: Uint8Array; format: string },
  options: {
    md5?: string
    thumbMd5?: string
    fullMd5?: string
    kind?: FavoriteKind
    ext?: string
    fileName?: string
    size?: number
  },
): ImageDataUrlResult {
  const format = dec.format || extensionOf(path) || options.ext || ''
  const kind: FavoriteKind = options.kind
    ?? (IMAGE_FORMATS.has(format) ? 'image' : VIDEO_FORMATS.has(format) ? 'video' : AUDIO_FORMATS.has(format) ? 'audio' : 'unknown')
  const mime = mimeOf(format, kind)
  return {
    url: 'data:' + mime + ';base64,' + Buffer.from(dec.bytes).toString('base64'),
    format: format || undefined,
  }
}

/** 只供测试/账号切换时清空内存索引。 */
export function clearFavoriteMediaIndex(): void {
  cachedIndex = null
}
