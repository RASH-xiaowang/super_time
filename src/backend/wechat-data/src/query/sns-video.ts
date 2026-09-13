/**
 * SNS（朋友圈）视频与封面的离线解析。
 *
 * ## 关键事实（2026-09-13 用真实缓存实测纠正）
 *
 * `cache/<月>/Sns/Video/<xx>/<hash>.mp4|.jpg` 里的 `<hash>` **不是任何标识的哈希**。
 * 旧实现对 39 条视频试了「md5(timelineId_id_2) 等 11 种公式 × 4 种后缀」，与磁盘上
 * 127 个基名**零命中** —— 于是永远取不到文件，用户点播放只看到一朵 `×`。
 *
 * 真正的映射是**内容 md5**：文件内容的 md5 == 朋友圈 XML 里 `<url md5="...">` 的值。
 * 实测 39 条视频里 7 条命中，其余是本机压根没有缓存（没在微信里播放过就不会落盘），
 * 这种情况只能明确告诉用户「未缓存」，不能装作能播。
 *
 * 封面与视频**同目录同名**（只有扩展名不同），所以定位到文件后，兄弟文件就是另一半；
 * 反过来说，任一侧先命中都能推出另一侧。
 *
 * ## 索引
 *
 * 与 `sns-image.ts` 同一套路：按月建「内容 md5 → 路径」索引，按 (mtimeMs,size) 签名
 * 增量重建，月份从新到旧、命中即停；整棵树扫完仍未命中则记住这次「确实没有」，
 * 避免每个未缓存的视频都把 200MB 重新哈希一遍。
 * 视频容器是明文，不需要解密（图片 blob 才需要）。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { decryptSnsHead } from './sns-keystream.ts'

const VIDEO_EXT = ['.mp4', '.mov']
const IMAGE_EXT = ['.jpg', '.jpeg', '.png']
/** 下载中但内容已完整（md5 能对上）的文件也会带 .tmp，同样可用。 */
const MATCHABLE_EXT = [...VIDEO_EXT, ...IMAGE_EXT, '.tmp']

interface MonthEntry {
  mtimeMs: number
  size: number
  byMd5: Map<string, string>
}
interface SnsVideoIndex {
  months: Map<string, MonthEntry>
  /** 已按当前签名扫完全部月份仍未命中的 md5。 */
  misses: Set<string>
}
const snsVideoIndex = new Map<string, SnsVideoIndex>()

/** 结果缓存：一次解析出的 data URL 不再重算。 */
const coverCache = new Map<string, string>()
const videoUrlCache = new Map<string, string>()

function md5OfFile(path: string): string | null {
  try {
    return createHash('md5').update(readFileSync(path)).digest('hex')
  } catch {
    return null
  }
}

/** 列出 `cache/<月>/Sns/Video` 根目录及签名，月份由新到旧。 */
function snsVideoMonthRoots(wechatBaseDir: string): Array<{ month: string; root: string; mtimeMs: number; size: number }> {
  const cacheRoot = join(wechatBaseDir, 'cache')
  const out: Array<{ month: string; root: string; mtimeMs: number; size: number }> = []
  if (!existsSync(cacheRoot)) return out
  let months: string[] = []
  try { months = readdirSync(cacheRoot) } catch { return out }
  for (const month of months.sort().reverse()) {
    const root = join(cacheRoot, month, 'Sns', 'Video')
    if (!existsSync(root)) continue
    try {
      const st = statSync(root)
      out.push({ month, root, mtimeMs: st.mtimeMs, size: st.size })
    } catch { /* skip */ }
  }
  return out
}

/** 扫描一个月份目录，得到「内容 md5 → 文件路径」。 */
function scanMonth(root: string): Map<string, string> {
  const byMd5 = new Map<string, string>()
  for (const sub of safeReaddir(root)) {
    const dir = join(root, sub)
    let isDir = false
    try { isDir = statSync(dir).isDirectory() } catch { continue }
    if (!isDir) continue
    for (const name of safeReaddir(dir)) {
      const low = name.toLowerCase()
      if (!MATCHABLE_EXT.some(ext => low.endsWith(ext))) continue
      const full = join(dir, name)
      const h = md5OfFile(full)
      // 同 md5 只留第一个（同名兄弟文件不会同 md5，这里只是去重）
      if (h && !byMd5.has(h)) byMd5.set(h, full)
    }
  }
  return byMd5
}

function safeReaddir(dir: string): string[] {
  try { return readdirSync(dir) } catch { return [] }
}

/**
 * 按月增量查找 wantMd5（内容 md5），命中即停。
 * @returns 命中的文件路径；`undefined` 表示「当前签名下已扫完全部月份仍没有」。
 */
function findByContentMd5(wechatBaseDir: string, wantMd5: string): string | undefined {
  const roots = snsVideoMonthRoots(wechatBaseDir)
  let idx = snsVideoIndex.get(wechatBaseDir)
  if (!idx) { idx = { months: new Map(), misses: new Set() }; snsVideoIndex.set(wechatBaseDir, idx) }
  const live = new Set(roots.map(r => r.month))
  for (const m of [...idx.months.keys()]) if (!live.has(m)) idx.months.delete(m)
  if (idx.misses.has(wantMd5)) return undefined

  for (const { month, root, mtimeMs, size } of roots) {
    const cached = idx.months.get(month)
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
      const hit = cached.byMd5.get(wantMd5)
      if (hit) return hit
      continue
    }
    const byMd5 = scanMonth(root)
    idx.months.set(month, { mtimeMs, size, byMd5 })
    idx.misses.clear() // 树变了，之前的「没有」结论失效
    const hit = byMd5.get(wantMd5)
    if (hit) return hit
  }
  idx.misses.add(wantMd5)
  return undefined
}

/**
 * 按需从朋友圈 XML 里给出的地址取回视频，并按需解密。
 *
 * 朋友圈的 `<url>` 就是视频地址（`…/snsvideodownload?encfilekey=…&token=…`），
 * 本机没缓存时这是唯一来源。微信 CDN 返回的是**客户端加密流**：前 128KB 需要与
 * `WxIsaac64` 密钥流 XOR（种子 = XML 里 `<enc key="NNNN">`），之后才是明文。
 * 解密后**必须校验**容器头与 md5（md5 来自 XML 的 `<url md5>`），校验不过就如实报错。
 *
 * @param remoteUrl - XML 里的 `<url>`。
 * @param expectMd5 - XML 里 `<url md5>`，取回后用来验证。
 * @param opts - `version` 本机微信版本（UA 必须带 `WeChat/<版本>`，否则 CDN 直接 400）；
 *   `seed` 即 `<enc key>`，用于解密加密头；`timeoutMs` 超时。
 * @returns data URL，或带具体原因的 error。
 */
export async function fetchSnsVideoDataUrl(
  remoteUrl: string,
  expectMd5?: string,
  opts: { version?: string; timeoutMs?: number; seed?: string } = {},
): Promise<{ url?: string; error?: string }> {
  const got = await fetchAndDecodeVideo(remoteUrl, expectMd5, opts)
  if (got.error || !got.bytes) return { error: got.error }
  const mime = got.bytes.subarray(8, 12).toString('latin1').includes('qt') ? 'quicktime' : 'mp4'
  return { url: 'data:video/' + mime + ';base64,' + got.bytes.toString('base64') }
}

/**
 * 取回并解密视频本体字节（不做 base64，供「保存到文件」这类需要原始字节的调用方用）。
 * @param remoteUrl - CDN 地址。
 * @param expectMd5 - XML 里的 `<url md5>`，用于校验。
 * @param opts - UA 版本 / 超时 / `<enc key>` 种子。
 * @returns 字节，或错误说明。
 */
export async function fetchAndDecodeVideo(
  remoteUrl: string,
  expectMd5?: string,
  opts: { version?: string; timeoutMs?: number; seed?: string } = {},
): Promise<{ bytes?: Buffer; error?: string }> {
  const got = await fetchSnsMediaBytes(remoteUrl, opts)
  if (got.error || !got.bytes) return { error: got.error }
  let bytes = got.bytes
  // 不是 MP4 容器 → 是加密流，按 <enc key> 解密前 128KB 再验
  if (!isMp4Container(bytes)) {
    const seed = (opts.seed || '').trim()
    if (!seed) return { error: '微信 CDN 返回的是加密流，但该动态没有 <enc key>，无法解密' }
    try {
      bytes = (await decryptSnsHead(bytes, seed)).bytes
    } catch (e) {
      return { error: `解密失败：${(e as Error)?.message ?? String(e)}` }
    }
    if (!isMp4Container(bytes)) return { error: '解密后仍不是 MP4 容器（<enc key> 可能不匹配）' }
  }
  const got_md5 = createHash('md5').update(bytes).digest('hex')
  const want = (expectMd5 || '').trim().toLowerCase()
  if (want && got_md5 !== want) {
    return { error: `取回的字节与记录不符（md5 ${got_md5.slice(0, 8)}… ≠ ${want.slice(0, 8)}…）` }
  }
  return { bytes }
}

/**
 * 取到视频本体字节：**本机缓存优先**（明文、离线），没有缓存再 CDN 取回并解密。
 * 供播放（转 data URL）与「保存到文件」共用，避免两条路各自实现一遍。
 * @param args - 缓存键（base+trace ids）与远端信息（url/seed/version）。
 * @returns 字节 + 来源，或错误说明。
 */
export async function loadSnsVideoBytes(args: {
  base?: string
  md5?: string
  timelineId?: string
  mediaId?: string
  url?: string
  seed?: string
  version?: string
}): Promise<{ bytes?: Buffer; source?: 'local' | 'remote'; error?: string }> {
  const local = findLocalVideoPath(args.base, args.md5, args.timelineId, args.mediaId)
  if (local.path) {
    try {
      return { bytes: readFileSync(local.path), source: 'local' }
    } catch { /* 读失败则继续走远端 */ }
  }
  const remote = (args.url || '').trim()
  if (!/^https?:\/\//i.test(remote)) return { error: local.error ?? '缺少视频地址' }
  const got = await fetchAndDecodeVideo(remote, args.md5, { version: args.version, seed: args.seed })
  if (got.error || !got.bytes) return { error: got.error }
  return { bytes: got.bytes, source: 'remote' }
}

/** MP4/MOV 容器标识（`ftyp` box）。 */
function isMp4Container(buf: Buffer): boolean {
  return buf.length >= 12 && buf.subarray(4, 8).toString('latin1') === 'ftyp'
}

/** JPEG/PNG 标识。 */
function imageMimeOf(buf: Buffer): 'jpeg' | 'png' | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg'
  if (buf.length >= 8 && buf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'png'
  return null
}

/**
 * 取回朋友圈视频封面（本机没缓存时的远端兜底），同样按需解密。
 * @param remoteUrl - XML 里的 `<thumb>`。
 * @param opts - 同 {@link fetchSnsVideoDataUrl}。
 * @returns data URL，或错误说明。
 */
export async function fetchSnsCoverDataUrl(
  remoteUrl: string,
  opts: { version?: string; timeoutMs?: number; seed?: string } = {},
): Promise<{ url?: string; error?: string }> {
  const got = await fetchSnsMediaBytes(remoteUrl, opts)
  if (got.error || !got.bytes) return { error: got.error }
  let bytes = got.bytes
  let mime = imageMimeOf(bytes)
  if (!mime) {
    const seed = (opts.seed || '').trim()
    if (!seed) return { error: '微信 CDN 返回的是加密流，但该动态没有 <enc key>，无法解密' }
    try {
      bytes = (await decryptSnsHead(bytes, seed)).bytes
    } catch (e) {
      return { error: `解密失败：${(e as Error)?.message ?? String(e)}` }
    }
    mime = imageMimeOf(bytes)
    if (!mime) return { error: '解密后仍不是图片（<enc key> 可能不匹配）' }
  }
  return { url: `data:image/${mime};base64,` + bytes.toString('base64') }
}

/**
 * 下载一次 SNS 媒体字节。
 * @param remoteUrl - CDN 地址。
 * @param opts - UA 版本与超时。
 * @returns 字节，或错误说明。
 */
async function fetchSnsMediaBytes(
  remoteUrl: string,
  opts: { version?: string; timeoutMs?: number },
): Promise<{ bytes?: Buffer; error?: string }> {
  const timeoutMs = opts.timeoutMs ?? 60_000
  const version = (opts.version || '').trim() || '4.1.13'
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(remoteUrl, {
      signal: ctrl.signal,
      headers: {
        // 实测：微信 CDN 认这个 UA 才给 200，浏览器 UA 会 400（0 字节）
        'user-agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) WeChat/${version}`,
        accept: '*/*',
      },
    })
    if (!res.ok) return { error: `从微信 CDN 取回失败：HTTP ${res.status}` }
    const bytes = Buffer.from(await res.arrayBuffer())
    if (bytes.length === 0) return { error: '从微信 CDN 取回的内容为空' }
    return { bytes }
  } catch (e) {
    const code = (e as { cause?: { code?: string } })?.cause?.code ?? ''
    if ((e as Error)?.name === 'AbortError') return { error: `从微信 CDN 取回超时（${Math.round(timeoutMs / 1000)}s）` }
    return { error: `从微信 CDN 取回失败：${(e as Error)?.message ?? String(e)}${code ? `（${code}）` : ''}` }
  } finally {
    clearTimeout(timer)
  }
}

/** 同目录下的兄弟文件（换扩展名）。 */
function sibling(path: string, exts: readonly string[]): string | null {
  const base = path.replace(/\.[^./\\]+$/, '')
  for (const ext of exts) {
    for (const variant of [ext, ext.toUpperCase()]) {
      const p = base + variant
      if (existsSync(p)) return p
    }
  }
  return null
}

/**
 * 聊天视频缓存的直接命中：`msg/video/<md5>.mp4`。
 * 朋友圈里的视频若同时存在聊天缓存（被转发过），这里能免去全树哈希。
 * （旧实现也走过这条路，但它的目录遍历只收集图片扩展名，永远匹配不到 mp4 —— 等于没生效。）
 */
function chatCachePath(wechatBaseDir: string, md5: string, exts: readonly string[]): string | null {
  const dir = join(wechatBaseDir, 'msg', 'video')
  if (!existsSync(dir)) return null
  for (const ext of exts) {
    const p = join(dir, md5 + ext)
    if (existsSync(p)) return p
  }
  return null
}

/** 聊天缓存的封面：`msg/video/<md5>_thumb.jpg`。 */
function chatCacheThumb(wechatBaseDir: string, md5: string): string | null {
  const dir = join(wechatBaseDir, 'msg', 'video')
  for (const ext of IMAGE_EXT) {
    const p = join(dir, md5 + '_thumb' + ext)
    if (existsSync(p)) return p
  }
  return null
}

function isVideoFile(path: string): boolean {
  const low = path.toLowerCase()
  return VIDEO_EXT.some(ext => low.endsWith(ext)) || low.endsWith('.tmp')
}

function dataUrlOfImage(path: string): string | null {
  try {
    const bytes = readFileSync(path)
    const low = path.toLowerCase()
    const mime = low.endsWith('.png') ? 'png' : 'jpeg'
    return 'data:image/' + mime + ';base64,' + bytes.toString('base64')
  } catch {
    return null
  }
}

function dataUrlOfVideo(path: string): string | null {
  try {
    const bytes = readFileSync(path)
    const mime = path.toLowerCase().endsWith('.mov') ? 'quicktime' : 'mp4'
    return 'data:video/' + mime + ';base64,' + bytes.toString('base64')
  } catch {
    return null
  }
}

/**
 * 解析一条朋友圈视频的封面。
 * @param wechatBaseDir - 微信账号根目录（rawWechatBase）。
 * @param md5 - 朋友圈 XML 里 `<url md5>`，即媒体内容 md5。
 * @returns data URL，或带说明的 error。
 */
export function resolveSnsVideoCoverDataUrl(
  wechatBaseDir: string | undefined,
  md5?: string,
  _timelineId?: string,
  _mediaId?: string,
): { url?: string; error?: string } {
  const want = (md5 || '').trim().toLowerCase()
  if (!want) return { error: '缺少视频标识（XML 未给出 md5）' }
  const cached = coverCache.get(want)
  if (cached) return { url: cached }
  if (!wechatBaseDir) return { error: '未配置微信原始目录，无法离线解码' }

  const found = findByContentMd5(wechatBaseDir, want) ?? chatCachePath(wechatBaseDir, want, IMAGE_EXT)
  if (!found) return { error: '本机缓存里没有这条视频（在微信里播放一次后即可离线观看）' }
  const imagePath = isVideoFile(found)
    ? (sibling(found, IMAGE_EXT) ?? chatCacheThumb(wechatBaseDir, want))
    : found
  if (!imagePath) return { error: '找到视频但缺少同名封面' }
  const data = dataUrlOfImage(imagePath)
  if (!data) return { error: '封面读取失败' }
  coverCache.set(want, data)
  return { url: data }
}

/**
 * 解析一条朋友圈视频本体（base64 data URL，供 <video> 内联播放）。
 * @param wechatBaseDir - 微信账号根目录（rawWechatBase）。
 * @param md5 - 朋友圈 XML 里 `<url md5>`，即媒体内容 md5。
 * @returns data URL，或带说明的 error。
 */
export function resolveSnsVideoDataUrl(
  wechatBaseDir: string | undefined,
  md5?: string,
  _timelineId?: string,
  _mediaId?: string,
): { url?: string; error?: string } {
  const want = (md5 || '').trim().toLowerCase()
  if (!want) return { error: '缺少视频标识（XML 未给出 md5）' }
  const cached = videoUrlCache.get(want)
  if (cached) return { url: cached }
  const local = findLocalVideoPath(wechatBaseDir, md5, _timelineId, _mediaId)
  if (!local.path) return { error: local.error }
  const data = dataUrlOfVideo(local.path)
  if (!data) return { error: '视频读取失败' }
  videoUrlCache.set(want, data)
  return { url: data }
}

/**
 * 在本机缓存里定位某条视频的本体路径（不解码、不 base64）。
 * @param wechatBaseDir - 微信账号根目录。
 * @param md5 - XML 的 `<url md5>`（即明文内容 md5）。
 * @returns 命中的路径，或错误说明。
 */
export function findLocalVideoPath(
  wechatBaseDir: string | undefined,
  md5?: string,
  _timelineId?: string,
  _mediaId?: string,
): { path?: string; error?: string } {
  const want = (md5 || '').trim().toLowerCase()
  if (!want) return { error: '缺少视频标识（XML 未给出 md5）' }
  if (!wechatBaseDir) return { error: '未配置微信原始目录，无法离线解码' }
  const found = findByContentMd5(wechatBaseDir, want) ?? chatCachePath(wechatBaseDir, want, VIDEO_EXT)
  if (!found) return { error: '本机缓存里没有这条视频（在微信里播放一次后即可离线观看）' }
  // 命中的可能是封面（XML 的 md5 是封面图时），此时按同名兄弟文件找视频本体。
  const videoPath = isVideoFile(found) ? found : sibling(found, VIDEO_EXT)
  if (!videoPath) return { error: '本机只缓存了封面，没有视频本体' }
  return { path: videoPath }
}
