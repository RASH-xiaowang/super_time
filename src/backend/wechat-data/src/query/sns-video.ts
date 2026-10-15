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
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { TIMEOUT_ERROR_NAME, fetchWithRetry } from '../net/fetch-retry.ts'
import { wechatCdnHostAllowed } from './cdn-hosts.ts'
import { decryptSnsAll, decryptSnsHead, SNS_HEAD_ENCRYPTED_BYTES } from './sns-keystream.ts'
import { boundedSet } from './meta.ts'
import { yieldToLoop } from './search-build.ts'
import { missWithScanNotes, safeReaddir, snsMonthRoots } from './sns-scan.ts'
import type { ScanNotes } from './sns-scan.ts'

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
/**
 * 同一账号 + 同一月份正在进行的异步索引扫描。
 *
 * 让出之后并发请求真的会撞见同一份冷扫：不合流会把 200MB 的整月哈希跑两份。
 */
const snsMonthScansInFlight = new Map<string, { promise: Promise<Map<string, string>>; notes: ScanNotes }>()
/** 异步月度扫描实际开始次数（测试与诊断用：合流后同一月并发请求应只 +1）。 */
let scanMonthAsyncCalls = 0

/** 结果缓存：一次解析出的 data URL 不再重算。 */
const coverCache = new Map<string, string>()
const videoUrlCache = new Map<string, string>()
/** 封面 data URL 通常只有几十 KB，用条数上限就足够约束。 */
const COVER_CACHE_MAX_ENTRIES = 300
/**
 * 视频本体缓存按**字节**约束：一个 MP4 的 base64 就能到几百 MB，
 * 只按条数封顶会在两条视频间就用掉一个数量级以上的常驻内存。
 */
const VIDEO_URL_CACHE_MAX_BYTES = 64 * 1024 * 1024
let videoUrlCacheBytes = 0
/** 大数据转 base64 时每处理这么多字节让出一次，避免单段 CPU 把 worker 钉住。 */
const BASE64_CHUNK_BYTES = 1024 * 1024
/** 月度媒体索引扫描时，每处理这么多文件让出一次。 */
const SCAN_YIELD_EVERY_FILES = 32

/**
 * 把一条视频 data URL 写进有字节上限的内存缓存。
 *
 * 淘汰按插入序（FIFO）：视频缓存是「最近滚到的那一屏」场景，不做真 LRU 也足够。
 * 单条超过总预算时**不缓存**，宁可下次重读，也不让一次请求钉住几十 MB。
 */
function cacheVideoDataUrl(md5: string, dataUrl: string): void {
  const size = dataUrl.length
  const old = videoUrlCache.get(md5)
  if (old !== undefined) videoUrlCacheBytes -= old.length
  if (size > VIDEO_URL_CACHE_MAX_BYTES) {
    videoUrlCache.delete(md5)
    return
  }
  while (videoUrlCacheBytes + size > VIDEO_URL_CACHE_MAX_BYTES && videoUrlCache.size > 0) {
    const first = videoUrlCache.keys().next()
    if (first.done || first.value === undefined) break
    const key = first.value
    videoUrlCacheBytes -= (videoUrlCache.get(key) ?? '').length
    videoUrlCache.delete(key)
  }
  videoUrlCache.set(md5, dataUrl)
  videoUrlCacheBytes += size
}

function md5OfFile(path: string): string | null {
  try {
    return createHash('md5').update(readFileSync(path)).digest('hex')
  } catch {
    return null
  }
}

/**
 * 流式算文件的 md5，并在大文件分块之间让出事件循环。
 *
 * 与同步 {@link md5OfFile} 结果一致；只把「整份 readFileSync + 一次 update」
 * 拆成 Node 流的分块，让一个几百 MB 的视频不会在哈希阶段独占 worker。
 */
async function md5OfFileAsync(path: string): Promise<string | null> {
  const hash = createHash('md5')
  try {
    let chunks = 0
    for await (const chunk of createReadStream(path)) {
      hash.update(chunk)
      chunks += 1
      if ((chunks & 7) === 0) await yieldToLoop()
    }
    return hash.digest('hex')
  } catch {
    return null
  }
}

/** 把 Buffer 转 base64；大 Buffer 按固定块处理，块间让出。 */
async function toBase64Async(bytes: Buffer): Promise<string> {
  const parts: string[] = []
  for (let at = 0; at < bytes.length; at += BASE64_CHUNK_BYTES) {
    parts.push(bytes.subarray(at, at + BASE64_CHUNK_BYTES).toString('base64'))
    if (at + BASE64_CHUNK_BYTES < bytes.length) await yieldToLoop()
  }
  return parts.join('')
}

/**
 * 扫描一个月份目录，得到「内容 md5 → 文件路径」。
 * @param root - 某个月的媒体根目录（`cache/<月>/Sns/Video`）。
 * @param notes - 扫描注记收集器：调用方比对它有没有变长，就知道这月**扫全了没有**。
 * @returns md5 → 路径的索引。
 */
function scanMonth(root: string, notes: ScanNotes): Map<string, string> {
  const byMd5 = new Map<string, string>()
  for (const sub of safeReaddir(root, notes)) {
    const dir = join(root, sub)
    let isDir = false
    // 单个条目 stat 不动（微信正在改写、链接断了）不算「没扫全」：那是那一个文件的问题，
    // 把它记进 notes 会让整月索引失效，代价远大于收益。
    try { isDir = statSync(dir).isDirectory() } catch { continue }
    if (!isDir) continue
    for (const name of safeReaddir(dir, notes)) {
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

/**
 * {@link scanMonth} 的可让出版：文件 md5 用流式计算，小文件批量之间也会让出。
 *
 * 目录口径与同步版逐行相同；两个驱动器共用同一个结果形状，避免
 * 「同步测试路径看得到、异步生产路径看不到」的目录偏差。
 */
async function scanMonthAsync(root: string, notes: ScanNotes): Promise<Map<string, string>> {
  scanMonthAsyncCalls += 1
  const byMd5 = new Map<string, string>()
  let files = 0
  for (const sub of safeReaddir(root, notes)) {
    const dir = join(root, sub)
    let isDir = false
    try { isDir = statSync(dir).isDirectory() } catch { continue }
    if (!isDir) continue
    for (const name of safeReaddir(dir, notes)) {
      const low = name.toLowerCase()
      if (!MATCHABLE_EXT.some(ext => low.endsWith(ext))) continue
      const full = join(dir, name)
      const h = await md5OfFileAsync(full)
      files += 1
      if ((files & (SCAN_YIELD_EVERY_FILES - 1)) === 0) await yieldToLoop()
      if (h && !byMd5.has(h)) byMd5.set(h, full)
    }
  }
  return byMd5
}

/**
 * 同月同账号的异步冷扫只跑一份。
 *
 * 返回共享扫描的注记，调用方再合入自己的 `notes`，这样并发请求既不会重复扫，
 * 也不会把「这一月没扫全」吞掉。
 */
async function scanMonthShared(
  wechatBaseDir: string,
  month: string,
  root: string,
): Promise<{ byMd5: Map<string, string>; notes: ScanNotes }> {
  const key = wechatBaseDir + '\u0000' + month
  const running = snsMonthScansInFlight.get(key)
  if (running) return { byMd5: await running.promise, notes: running.notes }
  const rec = { notes: [] as ScanNotes, promise: Promise.resolve(new Map<string, string>()) }
  rec.promise = scanMonthAsync(root, rec.notes).finally(() => {
    if (snsMonthScansInFlight.get(key) === rec) snsMonthScansInFlight.delete(key)
  })
  snsMonthScansInFlight.set(key, rec)
  return { byMd5: await rec.promise, notes: rec.notes }
}

/**
 * 按月增量查找 wantMd5（内容 md5），命中即停。
 * @param wechatBaseDir - 微信账号根目录。
 * @param wantMd5 - 要找的内容 md5。
 * @param notes - 扫描注记收集器（调用方用它区分「真没有」与「没扫到」）。
 * @returns 命中的文件路径；`undefined` 表示「当前签名下已扫完全部月份仍没有」。
 */
function findByContentMd5(wechatBaseDir: string, wantMd5: string, notes: ScanNotes): string | undefined {
  return findAllByContentMd5(wechatBaseDir, [wantMd5], notes).get(wantMd5)
}

/**
 * 批量按内容 md5 查找（W2-5.6）。
 *
 * 为什么要批量：`snsMonthRoots` 每次调用都要重列一遍 `cache/` 并 stat 每个月份目录，
 * 而真没命中时还要把整个月扫一遍（每个文件算 md5）。一屏 20 条视频封面逐条解析，
 * 就是 20 次列举 + 最多 20 次全月扫描；批量后不论多少条都只列举一次、每个月至多扫一次
 * （扫完的结果本来就要写进按月索引，所以「逐条」与「批量」的差异完全落在列举这一段上）。
 *
 * 语义与逐条版**逐字一致**：仍是「按月顺序、命中即用该月索引」，
 * 仍是「每个月都扫全了才配把『没有』记进 misses」，扫不全的月份照旧不进索引。
 * @param wechatBaseDir - 微信账号根目录（rawWechatBase）。
 * @param wantMd5s - 要找的内容 md5 列表（内部去重）。
 * @param notes - 扫描注记收集器。
 * @returns 命中的 md5 → 文件路径；没命中的键不在结果里（由调用方按「真没有」处理）。
 */
function findAllByContentMd5(wechatBaseDir: string, wantMd5s: readonly string[], notes: ScanNotes): Map<string, string> {
  const found = new Map<string, string>()
  if (wantMd5s.length === 0) return found
  const roots = snsMonthRoots(wechatBaseDir, 'Video', notes)
  let idx = snsVideoIndex.get(wechatBaseDir)
  if (!idx) { idx = { months: new Map(), misses: new Set() }; snsVideoIndex.set(wechatBaseDir, idx) }
  const live = new Set(roots.map(r => r.month))
  for (const m of [...idx.months.keys()]) if (!live.has(m)) idx.months.delete(m)
  const open = new Set(wantMd5s.filter((h) => h !== "" && !idx.misses.has(h)))

  for (const { month, root, mtimeMs, size } of roots) {
    if (open.size === 0) break
    const cached = idx.months.get(month)
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
      harvest(cached.byMd5, open, found)
      continue
    }
    const before = notes.length
    const byMd5 = scanMonth(root, notes)
    if (notes.length !== before) {
      // 这个月**没扫全**：不写进索引 —— 否则残缺的索引会带着「mtime/size 没变」的理由
      // 被后面每一次查询复用，那个月里的视频从此永远查不到。也不许记「没有」。
      idx.months.delete(month)
      idx.misses.clear()
      continue
    }
    idx.months.set(month, { mtimeMs, size, byMd5 })
    idx.misses.clear() // 树变了，之前的「没有」结论失效
    harvest(byMd5, open, found)
  }
  // P1-1/#9：只有「每个月都扫全了」才配把「没有」缓存下来。
  // 目录读不动时记进 misses，等于把一次临时的 EACCES 变成「这条视频永远找不到」。
  if (notes.length === 0) for (const h of open) idx.misses.add(h)
  return found
}

/**
 * {@link findAllByContentMd5} 的可让出版，语义与索引/负缓存口径逐字相同。
 *
 * 生产路径走这里：整月扫描是 CPU + 磁盘重活，同步版会把同 worker 的其它查询
 * 一起拖住。异步版只在 `scanMonthAsync` 与 `md5OfFileAsync` 内部让出，
 * 月份顺序、命中即停、misses 清除规则都不变。
 */
async function findAllByContentMd5Async(
  wechatBaseDir: string,
  wantMd5s: readonly string[],
  notes: ScanNotes,
): Promise<Map<string, string>> {
  const found = new Map<string, string>()
  if (wantMd5s.length === 0) return found
  const roots = snsMonthRoots(wechatBaseDir, 'Video', notes)
  let idx = snsVideoIndex.get(wechatBaseDir)
  if (!idx) { idx = { months: new Map(), misses: new Set() }; snsVideoIndex.set(wechatBaseDir, idx) }
  const live = new Set(roots.map(r => r.month))
  for (const m of [...idx.months.keys()]) if (!live.has(m)) idx.months.delete(m)
  const open = new Set(wantMd5s.filter((h) => h !== "" && !idx.misses.has(h)))

  for (const { month, root, mtimeMs, size } of roots) {
    if (open.size === 0) break
    const cached = idx.months.get(month)
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
      harvest(cached.byMd5, open, found)
      continue
    }
    const before = notes.length
    const scanned = await scanMonthShared(wechatBaseDir, month, root)
    for (const note of scanned.notes) if (!notes.includes(note)) notes.push(note)
    const byMd5 = scanned.byMd5
    if (notes.length !== before) {
      idx.months.delete(month)
      idx.misses.clear()
      continue
    }
    idx.months.set(month, { mtimeMs, size, byMd5 })
    idx.misses.clear()
    harvest(byMd5, open, found)
  }
  if (notes.length === 0) for (const h of open) idx.misses.add(h)
  return found
}

/** {@link findByContentMd5} 的异步版。 */
async function findByContentMd5Async(
  wechatBaseDir: string,
  wantMd5: string,
  notes: ScanNotes,
): Promise<string | undefined> {
  return (await findAllByContentMd5Async(wechatBaseDir, [wantMd5], notes)).get(wantMd5)
}

/**
 * 把一个月索引里「还欠着的那些」挑走。
 * @param byMd5 - 该月的内容 md5 → 路径。
 * @param open - 尚未命中的 md5 集合（命中者被就地删除）。
 * @param found - 出口（命中者被就地写入）。
 */
function harvest(byMd5: Map<string, string>, open: Set<string>, found: Map<string, string>): void {
  for (const want of [...open]) {
    const hit = byMd5.get(want)
    if (hit) { found.set(want, hit); open.delete(want) }
  }
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
  return { url: 'data:video/' + mime + ';base64,' + await toBase64Async(got.bytes) }
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
 *
 * **主机白名单**：远端那一级只允许腾讯系主机（`query/cdn-hosts.ts`，唯一出处），
 * 判在**本机缓存之后、发请求之前** —— 本机已有的照常导出，站外地址一个字节都不发。
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
  const local = await findLocalVideoPathAsync(args.base, args.md5, args.timelineId, args.mediaId)
  if (local.path) {
    try {
      return { bytes: await readFile(local.path), source: 'local' }
    } catch { /* 读失败则继续走远端 */ }
  }
  const remote = (args.url || '').trim()
  if (!/^https?:\/\//i.test(remote)) return { error: local.error ?? '缺少视频地址' }
  // 2026-09-30 补：导出这条路此前**没有**过主机白名单（播放与封面两条在 remotes/media.ts 判），
  // 等于「导出时后端会去取消息里写的任意主机」。判在发请求之前，且**在本机缓存之后** ——
  // 本机已有那份照常导出，不受影响。消息 XML 是可被离线改写的文件，不能让它的地址决定去哪。
  if (!wechatCdnHostAllowed(remote)) return { error: '视频地址的主机不在微信 CDN 清单内，已拒绝请求' }
  const got = await fetchAndDecodeVideo(remote, args.md5, {
    version: args.version,
    seed: args.seed,
  })
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
 * 结尾标记的搜索窗口，与 `sns-cdn-image.ts` 的 `END_SCAN_WINDOW` 同口径。
 *
 * 为什么要留一个窗口而不是严格要求「最后两字节就是 EOI」：微信 CDN 在 JPEG 的 EOI 之后
 * 恒定挂 24 字节签名块（实测朋友圈图片与评论图都是），严格要求末尾会让**每一张**都判失败。
 */
const COVER_END_SCAN_WINDOW = 256

/** PNG 的 IEND 块固定是这 8 个字节。 */
const PNG_IEND = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])

/**
 * 这段字节是不是一张**完整**图片（结尾标记落在末尾窗口内）。
 *
 * 这条判据是本轮加的：原来 `fetchSnsCoverDataUrl` 只用 `imageMimeOf` 看**头 3 个字节**就放行，
 * 完全没有结尾校验 ⇒ 一张尾部仍是密文的坏图会被当成好图交给渲染层。
 * 找不到结尾标记就返回 false —— 那正是「只解了头」的典型形态。
 */
function coverEndsComplete(b: Buffer, mime: 'jpeg' | 'png'): boolean {
  if (b.length === 0) return false
  if (mime === 'png') {
    const from = Math.max(0, b.length - COVER_END_SCAN_WINDOW - PNG_IEND.length)
    return b.subarray(from).includes(PNG_IEND)
  }
  for (let i = b.length - 2; i >= Math.max(0, b.length - COVER_END_SCAN_WINDOW); i -= 1) {
    if (b[i] === 0xff && b[i + 1] === 0xd9) return true
  }
  return false
}

/**
 * 取回朋友圈视频封面，同样按需解密。
 *
 * ## 为什么不是「一律整份解」（2026-10-09 实测后定的）
 *
 * 现场探针 `sns-video-cover-probe.manual.spec.ts` 在真库真网上量了 12 个封面：
 * **0 个超过 128 KB**，全部密文（头 `4f 44 5a d8`），只解头就拿到 `eoiFromEnd=0` 的完整 JPEG。
 * 也就是说「只解头」对封面**当下是完全正确的**，改成一律整份解等于让每张封面白付约 3 倍 CPU
 * 而收益为零。所以这里改成**按大小分流 + 结尾校验兜底**：
 *
 *   · 实收 > 128 KB ⇒ 只解头**必然**留下密文尾部 ⇒ 直接整份解；
 *   · 实收 ≤ 128 KB ⇒ 只解头就是整份解（省 CPU），再用 `coverEndsComplete` 校验结尾，
 *     万一不完整（历史数据换了加密策略、或将来出现大封面）再回落整份解一次。
 *
 * @param remoteUrl - XML 里的 `<thumb>`（地址自带 `token` 与 `idx=1`，不需要再拼）。
 * @param opts - 同 {@link fetchSnsVideoDataUrl}。
 * @returns data URL，或错误说明。
 */
export async function fetchSnsCoverDataUrl(
  remoteUrl: string,
  opts: { version?: string; timeoutMs?: number; seed?: string } = {},
): Promise<{ url?: string; error?: string }> {
  const got = await fetchSnsMediaBytes(remoteUrl, opts)
  if (got.error || !got.bytes) return { error: got.error }
  const raw = got.bytes
  // 响应体已经是图片（未加密）：原样交出去，但仍要过结尾校验 —— 缺了它就是「坏图照样交付」。
  const plainMime = imageMimeOf(raw)
  if (plainMime) {
    if (!coverEndsComplete(raw, plainMime)) return { error: '微信 CDN 返回的图片结尾不完整，已拒绝交付（否则渲染层会拿到一张画不出来的图）' }
    return { url: `data:image/${plainMime};base64,` + raw.toString('base64') }
  }

  const seed = (opts.seed || '').trim()
  if (!seed) return { error: '微信 CDN 返回的是加密流，但该动态没有 <enc key>，无法解密' }
  const overHeadLine = raw.length > SNS_HEAD_ENCRYPTED_BYTES
  let bytes: Buffer
  try {
    bytes = overHeadLine ? (await decryptSnsAll(raw, seed)).bytes : (await decryptSnsHead(raw, seed)).bytes
  } catch (e) {
    return { error: `解密失败：${(e as Error)?.message ?? String(e)}` }
  }
  let mime = imageMimeOf(bytes)
  if (!mime) return { error: '解密后仍不是图片（<enc key> 可能不匹配）' }
  if (!coverEndsComplete(bytes, mime)) {
    if (overHeadLine) return { error: '整份解密后图片结尾仍不完整，已拒绝交付' }
    // 只解头居然不完整 ⇒ 数据形态与预期不符，退回整份解再判一次。
    try {
      bytes = (await decryptSnsAll(raw, seed)).bytes
    } catch (e) {
      return { error: `整份解密失败：${(e as Error)?.message ?? String(e)}` }
    }
    mime = imageMimeOf(bytes)
    if (!mime) return { error: '整份解密后仍不是图片（<enc key> 可能不匹配）' }
    if (!coverEndsComplete(bytes, mime)) return { error: '整份解密后图片结尾仍不完整，已拒绝交付' }
  }
  return { url: `data:image/${mime};base64,` + bytes.toString('base64') }
}

/**
 * 下载一次 SNS 媒体字节。
 *
 * N13：改走 `fetchWithRetry`（网络抖动 / 408 / 429 / 5xx 有界重试），超时交给重试层
 * **逐次**计时 —— 原先自己 `AbortController + setTimeout` 是整段一次性的：一旦超时，
 * 重试层看到的是已中止的信号，只会立刻放弃（那正好是最该重试的场合）。
 * 超时错误由重试层标成 `TimeoutError`（不是 `AbortError`），所以这里仍能报「超时」。
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
  try {
    const res = await fetchWithRetry(fetch, remoteUrl, {
      headers: {
        // 实测：微信 CDN 认这个 UA 才给 200，浏览器 UA 会 400（0 字节）
        'user-agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) WeChat/${version}`,
        accept: '*/*',
      },
    }, { timeoutMs })
    if (!res.ok) return { error: `从微信 CDN 取回失败：HTTP ${res.status}` }
    const bytes = Buffer.from(await res.arrayBuffer())
    if (bytes.length === 0) return { error: '从微信 CDN 取回的内容为空' }
    return { bytes }
  } catch (e) {
    if ((e as Error)?.name === TIMEOUT_ERROR_NAME) return { error: `从微信 CDN 取回超时（${Math.round(timeoutMs / 1000)}s）` }
    const code = (e as { cause?: { code?: string } })?.cause?.code ?? ''
    return { error: `从微信 CDN 取回失败：${(e as Error)?.message ?? String(e)}${code ? `（${code}）` : ''}` }
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
 * 在 `<base>/msg/video` 下按候选文件名查找：先查根目录，再逐个月份子目录。
 *
 * 为什么必须下钻月份目录：微信把聊天视频按 `<YYYY-MM>/` 分目录存放
 * （同 `media-video.ts` 的 findVideoArtifacts），只查 `msg/video` 根下会**全部落空**。
 * 这处是本轮重写 sns-video.ts 时丢掉的能力：旧实现（提交 4b353fe）在 msg/video 下
 * 递归 depth≤5 并按 basename 前缀匹配，因此 `msg/video/2025-11/<md5>_thumb.jpg`
 * 能被找到；改成只查根目录后，朋友圈视频的聊天缓存兜底路径就成了死代码
 * （由 tests/sns-media.spec.ts 的 thumb 兜底用例发现）。
 */
function findInChatVideoCache(wechatBaseDir: string, names: readonly string[]): string | null {
  const root = join(wechatBaseDir, 'msg', 'video')
  if (!existsSync(root)) return null
  const dirs = [root]
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(join(root, entry.name))
    }
  } catch { /* 枚举失败就只查根目录，不因此放弃 */ }
  for (const dir of dirs) {
    for (const name of names) {
      const p = join(dir, name)
      if (existsSync(p)) return p
    }
  }
  return null
}

/**
 * 聊天视频缓存的直接命中：`msg/video/<月>/<md5>.jpg|.jpeg|.png`。
 * 朋友圈里的视频若同时存在聊天缓存（被转发过），这里能免去全树哈希。
 */
function chatCachePath(wechatBaseDir: string, md5: string, exts: readonly string[]): string | null {
  return findInChatVideoCache(wechatBaseDir, exts.map(ext => md5 + ext))
}

/** 聊天缓存的封面：`msg/video/<月>/<md5>_thumb.jpg`。 */
function chatCacheThumb(wechatBaseDir: string, md5: string): string | null {
  return findInChatVideoCache(wechatBaseDir, IMAGE_EXT.map(ext => md5 + '_thumb' + ext))
}

/**
 * 测试接缝：清掉按月索引与结果缓存。
 *
 * 导出只为基准脚本（`sns-cover-batch.measure.spec.ts`）能在两次测量之间把进程内缓存清干净 ——
 * 否则第二次测的是「第一次已经把月索引建好了」的路径，数字会假绿。
 */
export function snsVideoIndexForTest(): {
  clear: () => void
  stats: () => { coverEntries: number; videoEntries: number; videoBytes: number; asyncMonthScans: number }
} {
  return {
    clear: () => {
      snsVideoIndex.clear()
      snsMonthScansInFlight.clear()
      scanMonthAsyncCalls = 0
      coverCache.clear()
      videoUrlCache.clear()
      videoUrlCacheBytes = 0
    },
    stats: () => ({
      coverEntries: coverCache.size,
      videoEntries: videoUrlCache.size,
      videoBytes: videoUrlCacheBytes,
      asyncMonthScans: scanMonthAsyncCalls,
    }),
  }
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

/** 异步读一张封面并转 data URL（读盘不阻塞，base64 大文件分块让出）。 */
async function dataUrlOfImageAsync(path: string): Promise<string | null> {
  try {
    const bytes = await readFile(path)
    const low = path.toLowerCase()
    const mime = low.endsWith('.png') ? 'png' : 'jpeg'
    return 'data:image/' + mime + ';base64,' + await toBase64Async(bytes)
  } catch {
    return null
  }
}

/** 异步读一条视频并转 data URL（与同步版同样的 mime 判断）。 */
async function dataUrlOfVideoAsync(path: string): Promise<string | null> {
  try {
    const bytes = await readFile(path)
    const mime = path.toLowerCase().endsWith('.mov') ? 'quicktime' : 'mp4'
    return 'data:video/' + mime + ';base64,' + await toBase64Async(bytes)
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
  const got = resolveSnsVideoCoverDataUrls(wechatBaseDir, want === '' ? [] : [want]).get(want)
  return got ?? { error: MISS_NO_ID }
}

/** 缺标识时那条固定的说明（两条入口共用一个字符串，免得文案漂移）。 */
const MISS_NO_ID = '缺少视频标识（XML 未给出 md5）'

/** 本机没配目录 / 本机没缓存 / 找不到同名封面 / 读不动 —— 四条固定文案集中在这里。 */
const NO_BASE = '未配置微信原始目录，无法离线解码'
const MISS_LOCAL = '本机缓存里没有这条视频（在微信里播放一次后即可离线观看）'
const MISS_NO_SIBLING = '找到视频但缺少同名封面'
const READ_FAILED = '封面读取失败'

/**
 * 批量解析朋友圈视频封面（W2-5.6）。
 *
 * 语义与逐条版**逐条一致**，包括「本机没有」那套注记（哪些月份没扫全）。
 * 唯一的差别在列举：`snsMonthRoots` 与每个月的内容 md5 索引在一批里只走一遍，
 * 逐条则每条都要重来一次 —— 那正是本条要省的那一段（数字见 `sns-cover-batch.measure.spec.ts`）。
 *
 * 三级兜底（内容 md5 索引 → 聊天缓存里的同名图片/视频 → 聊天缓存的 `_thumb`）
 * 与逐条版同序；`_thumb` 那一级不能省：只转发过、没在朋友圈播放过的视频，
 * 朋友圈缓存里没有它，但聊天缓存会留下 `<md5>_thumb.jpg`。
 * @param wechatBaseDir - 微信账号根目录（rawWechatBase）。
 * @param md5s - 内容 md5 列表（内部去重、忽略空串）。
 * @returns 每个请求的 md5 → 结果（命中与未命中都在里面，调用方按条取）。
 */
export function resolveSnsVideoCoverDataUrls(
  wechatBaseDir: string | undefined,
  md5s: readonly string[],
): Map<string, { url?: string; error?: string }> {
  const out = new Map<string, { url?: string; error?: string }>()
  const wants: string[] = []
  for (const rawMd5 of md5s) {
    const want = (rawMd5 || '').trim().toLowerCase()
    if (want === '' || out.has(want)) continue
    const cached = coverCache.get(want)
    if (cached !== undefined) { out.set(want, { url: cached }); continue }
    wants.push(want)
  }
  if (wants.length === 0) return out
  if (!wechatBaseDir) {
    for (const want of wants) out.set(want, { error: NO_BASE })
    return out
  }

  const notes: ScanNotes = []
  const byContent = findAllByContentMd5(wechatBaseDir, wants, notes)
  for (const want of wants) {
    const found = byContent.get(want)
    const chat = found ?? chatCachePath(wechatBaseDir, want, IMAGE_EXT) ?? chatCacheThumb(wechatBaseDir, want)
    // 「本机没有」只有在扫得全时才成立；扫不全就照实说（P1-1/#9）。
    if (!chat) { out.set(want, { error: missWithScanNotes(MISS_LOCAL, notes) }); continue }
    const imagePath = isVideoFile(chat)
      ? (sibling(chat, IMAGE_EXT) ?? chatCacheThumb(wechatBaseDir, want))
      : chat
    if (!imagePath) { out.set(want, { error: MISS_NO_SIBLING }); continue }
    const data = dataUrlOfImage(imagePath)
    if (!data) { out.set(want, { error: READ_FAILED }); continue }
    boundedSet(coverCache, want, data, COVER_CACHE_MAX_ENTRIES)
    out.set(want, { url: data })
  }
  return out
}

/**
 * 生产路径使用的批量封面解析：目录扫描与读盘都让出事件循环。
 *
 * 与同步版共享同一份结果缓存与按月索引，所以两条路径命中口径不会分裂。
 */
export async function resolveSnsVideoCoverDataUrlsAsync(
  wechatBaseDir: string | undefined,
  md5s: readonly string[],
): Promise<Map<string, { url?: string; error?: string }>> {
  const out = new Map<string, { url?: string; error?: string }>()
  const wants: string[] = []
  for (const rawMd5 of md5s) {
    const want = (rawMd5 || '').trim().toLowerCase()
    if (want === '' || out.has(want)) continue
    const cached = coverCache.get(want)
    if (cached !== undefined) { out.set(want, { url: cached }); continue }
    wants.push(want)
  }
  if (wants.length === 0) return out
  if (!wechatBaseDir) {
    for (const want of wants) out.set(want, { error: NO_BASE })
    return out
  }

  const notes: ScanNotes = []
  const byContent = await findAllByContentMd5Async(wechatBaseDir, wants, notes)
  for (const want of wants) {
    const found = byContent.get(want)
    const chat = found ?? chatCachePath(wechatBaseDir, want, IMAGE_EXT) ?? chatCacheThumb(wechatBaseDir, want)
    if (!chat) { out.set(want, { error: missWithScanNotes(MISS_LOCAL, notes) }); continue }
    const imagePath = isVideoFile(chat)
      ? (sibling(chat, IMAGE_EXT) ?? chatCacheThumb(wechatBaseDir, want))
      : chat
    if (!imagePath) { out.set(want, { error: MISS_NO_SIBLING }); continue }
    const data = await dataUrlOfImageAsync(imagePath)
    if (!data) { out.set(want, { error: READ_FAILED }); continue }
    boundedSet(coverCache, want, data, COVER_CACHE_MAX_ENTRIES)
    out.set(want, { url: data })
  }
  return out
}

/** {@link resolveSnsVideoCoverDataUrl} 的异步生产版。 */
export async function resolveSnsVideoCoverDataUrlAsync(
  wechatBaseDir: string | undefined,
  md5?: string,
  _timelineId?: string,
  _mediaId?: string,
): Promise<{ url?: string; error?: string }> {
  const want = (md5 || '').trim().toLowerCase()
  const got = (await resolveSnsVideoCoverDataUrlsAsync(wechatBaseDir, want === '' ? [] : [want])).get(want)
  return got ?? { error: MISS_NO_ID }
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
  cacheVideoDataUrl(want, data)
  return { url: data }
}

/** {@link resolveSnsVideoDataUrl} 的异步生产版：定位、读盘、base64 都让出。 */
export async function resolveSnsVideoDataUrlAsync(
  wechatBaseDir: string | undefined,
  md5?: string,
  _timelineId?: string,
  _mediaId?: string,
): Promise<{ url?: string; error?: string }> {
  const want = (md5 || '').trim().toLowerCase()
  if (!want) return { error: '缺少视频标识（XML 未给出 md5）' }
  const cached = videoUrlCache.get(want)
  if (cached) return { url: cached }
  const local = await findLocalVideoPathAsync(wechatBaseDir, md5, _timelineId, _mediaId)
  if (!local.path) return { error: local.error }
  const data = await dataUrlOfVideoAsync(local.path)
  if (!data) return { error: '视频读取失败' }
  cacheVideoDataUrl(want, data)
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
  const notes: ScanNotes = []
  const found = findByContentMd5(wechatBaseDir, want, notes) ?? chatCachePath(wechatBaseDir, want, VIDEO_EXT)
  if (!found) return { error: missWithScanNotes('本机缓存里没有这条视频（在微信里播放一次后即可离线观看）', notes) }
  // 命中的可能是封面（XML 的 md5 是封面图时），此时按同名兄弟文件找视频本体。
  const videoPath = isVideoFile(found) ? found : sibling(found, VIDEO_EXT)
  if (!videoPath) return { error: '本机只缓存了封面，没有视频本体' }
  return { path: videoPath }
}

/** {@link findLocalVideoPath} 的异步生产版，索引扫描会分块让出。 */
export async function findLocalVideoPathAsync(
  wechatBaseDir: string | undefined,
  md5?: string,
  _timelineId?: string,
  _mediaId?: string,
): Promise<{ path?: string; error?: string }> {
  const want = (md5 || '').trim().toLowerCase()
  if (!want) return { error: '缺少视频标识（XML 未给出 md5）' }
  if (!wechatBaseDir) return { error: '未配置微信原始目录，无法离线解码' }
  const notes: ScanNotes = []
  const found = await findByContentMd5Async(wechatBaseDir, want, notes)
    ?? chatCachePath(wechatBaseDir, want, VIDEO_EXT)
  if (!found) return { error: missWithScanNotes('本机缓存里没有这条视频（在微信里播放一次后即可离线观看）', notes) }
  const videoPath = isVideoFile(found) ? found : sibling(found, VIDEO_EXT)
  if (!videoPath) return { error: '本机只缓存了封面，没有视频本体' }
  return { path: videoPath }
}
