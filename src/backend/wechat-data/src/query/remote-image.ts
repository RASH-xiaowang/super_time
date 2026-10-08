/**
 * 远程图片代理：渲染层要看一张「只存在于微信 CDN 上」的图时，由后端取回、落盘、回 data URL。
 *
 * ## 为什么要它（M23）
 *
 * `index.html` 的 CSP 目前写作 `img-src 'self' data: blob: https: file:` —— 那个 `https:` 通配
 * 意味着**渲染层可以向任意 https 主机发起图片请求**。这些地址全部来自消息 XML / 数据库字段
 * （链接卡、公众号、朋友圈、视频号……的 `thumburl` / `coverurl`），所以「渲染层自己出网」这件事
 * 既不写操作记录、也没有缓存 —— 同一张图每次滚动都会再要一次，且不受主机白名单约束。
 *
 * 走到后端之后就三件事：**留得下审计**（调用方写操作记录）、**存得下盘**
 * （`<decoded>/remote-images/<md5>.<ext>`，第二次渲染不再联网）、**白名单外一律拒**。
 *
 * ## 只认腾讯系主机
 *
 * URL 来自可被离线改写的文件，所以发请求前必须过 {@link wechatCdnHostAllowed}。
 * 副作用要写清楚：**非腾讯系的第三方缩略图（某个链接卡的封面指向站外图床）会不再显示** ——
 * 卡片本身照常可用，只是没有封面。这是这道闸门的目的而不是缺陷，但界面上要给占位而不是破图，
 * 隐私声明里也要如实写出「只有微信系主机的图会被代取」。
 *
 * ## 与既有取图路径的关系
 *
 * 表情（`fetchEmoticonRemote`）、公众号封面（`article-cover.ts`）、聊天原图（`image-original.ts`）
 * 各自已有取回逻辑，本模块**不替换**它们：它们有各自的解码与回退语义（HEVC 标记、og:image 抓取、
 * 按 md5 占槽位）。本模块只服务「手上只有一个 https 地址」这一种需求，也就是渲染层直连的那一批。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fetchWithRetry } from '../../../llm-retry.js'
import { wechatCdnHostAllowed } from './cdn-hosts.ts'
import { detectImageFormat } from './media-image.ts'
import { yieldToLoop } from './search-build.ts'

/** 单张上限：卡片缩略图与朋友圈图都在几十~几百 KB 量级，超过就是异常响应，宁可失败。 */
const MAX_REMOTE_IMAGE_BYTES = 8 * 1024 * 1024
/**
 * 一次批量最多几张（C2，2026-09-28 性能修复：40 → 20）。
 *
 * 现场日志 `getRemoteImages` 127 次 / 均 14s / 峰值 86.5s，与「最坏 40 张 ÷ 6 并发 × 12s 超时 ≈ 80s」
 * 吻合 —— 单次请求要背 40 张的**最坏超时**，任何一张慢就把整批拖到分钟级。降到 20 后最坏值砍半，
 * 而调用方（`drainMedia` 的 `MEDIA_BATCH = 8`）本来就在分批，单次 20 张仍有 2 批余量。
 */
export const MAX_IMAGES_PER_CALL = 20
/**
 * 同时在途的请求数（C2：6 → 10）。
 * 6 是为了避开 CDN 对突发并发回 400 而定的；但一屏几十张时 6 并发太窄。
 * 10 仍远低于「一次性全发」（后者才是 400 的诱因），是并发与友好度之间的折中。
 */
export const FETCH_CONCURRENCY = 10
/** 失败只冷却这么久（与 `article-cover.ts` 同一口径：永久负缓存会把瞬时故障变成永久坏图）。 */
const FAIL_COOLDOWN_MS = 60_000
/**
 * 单张超时（C2：12s → 8s）。
 * 缩略图/朋友圈图都是几十~几百 KB，正常 CDN 往返远在 1s 内；12s 只是把「对端挂着不回」的
 * 代价放大。8s 已足够覆盖慢速网络，同时把整批最坏值再压一档。
 */
const FETCH_TIMEOUT_MS = 8_000
/** 缓存子目录名（导出给清理与测试用口径）。 */
export const REMOTE_IMAGE_CACHE_DIRNAME = 'remote-images'

/** 浏览器能直接画的几种；其余（HEVC / wxgf / 未知）取回来也显示不了。 */
const RENDERABLE_MIME: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
}

/** 落盘扩展名只可能是这四种（`jpeg` 归一成 `jpg`，`bmp` 归一成 `png` 是不做的：直接不缓存）。 */
const CACHE_SUFFIXES: ReadonlySet<string> = new Set(['png', 'jpg', 'gif', 'webp'])

export interface RemoteImageResult {
  /** 请求的那个地址（批量结果里用它当键回给调用方）。 */
  url: string
  /** 取回 / 缓存命中后的 data URL；失败时没有。 */
  dataUrl?: string
  /** 这次是否直接从本机缓存拿到的（审计与「关掉开关后还出不出网」的断言都用它）。 */
  fromCache?: boolean
  /** 给用户看的原因（开关关闭 / 主机不在清单 / 不是可渲染的图片…）。 */
  error?: string
}

/** 瞬时故障的冷却表（进程内，键 = trim 后的 URL）。 */
const failUntil = new Map<string, number>()

/**
 * 已解码结果的内存层（C4，2026-09-28 性能修复）。
 *
 * 此前只有落盘缓存：命中也要 `readFileSync` + `toString('base64')` 重建一次 —— 40 张图一屏
 * 就是 40 次读盘 + 40 次 base64（图越大越贵）。这一层把「同一批 URL 在短时间内被重复问」
 * （虚拟化反复挂载/卸载、切回面板）直接短路成 Map 查找。
 *
 * 容量用 `MAX_MEM_ENTRIES` 封顶而不是无限增长：data URL 是原图字节的 ~1.33 倍，
 * 内存里攒多了会显著抬高常驻。超限时按**插入序**丢最早的一批（Map 保序，够用且零成本，
 * 不必引入真 LRU 的双向链表）。
 */
const MAX_MEM_ENTRIES = 300
const memCache = new Map<string, string>()

function memGet(url: string): string | undefined {
  const v = memCache.get(url)
  if (v === undefined) return undefined
  // 触碰即刷新（简易 LRU 语义）：删了再塞回，把这项挪到队尾。
  memCache.delete(url)
  memCache.set(url, v)
  return v
}

function memSet(url: string, dataUrl: string): void {
  memCache.set(url, dataUrl)
  while (memCache.size > MAX_MEM_ENTRIES) {
    const oldest = memCache.keys().next()
    if (oldest.done === true) break
    memCache.delete(oldest.value)
  }
}

function cacheKey(url: string): string {
  return createHash('md5').update(url, 'utf8').digest('hex')
}

/**
 * 读缓存：先内存、再落盘。
 *
 * C1（2026-09-28 性能修复）：扩展名解析从「对每张图逐个试 4 个扩展名（4 次 `existsSync`）」
 * 改成「每个目录**一次** `readdirSync` 建 `md5 → 扩展名` 索引」。原口径 40 张 = 160 次 stat，
 * 全是同步调用 ⇒ 在事件循环上原地卡住（这也是 `remote-image.ts` 属于「排队放大器」的一半原因）。
 * 索引按目录做进程内缓存（`cacheIndex`），目录 mtime 变了才重建 —— 目录只在写缓存时变更，
 * 而写缓存只走本模块的 tmp+rename 路径。
 * @param url - 原始地址（trim 前）。
 * @param decodedDir - 解码缓存根。
 * @param index - 该目录的 `md5 → 扩展名` 索引（没有缓存目录时为空 Map）。
 */
function readCache(url: string, decodedDir: string, index: ReadonlyMap<string, string>): string | null {
  const hit = memGet(url)
  if (hit !== undefined) return hit
  const suffix = index.get(cacheKey(url))
  if (suffix === undefined) return null
  const file = join(decodedDir, REMOTE_IMAGE_CACHE_DIRNAME, `${cacheKey(url)}.${suffix}`)
  try {
    const dataUrl = `data:${RENDERABLE_MIME[suffix] ?? 'image/png'};base64,${readFileSync(file).toString('base64')}`
    memSet(url, dataUrl)
    return dataUrl
  } catch {
    // 半截文件（上次写到一半被打断）：当作没有，下次重新取。tmp + rename 之后理论上不该出现，
    // 但目录可能被用户手动清过或被别的进程写过，这里不为此抛。
    return null
  }
}

/** 目录索引缓存：dir → { sig, map }。sig 走目录 mtime+size（写缓存才会变）。 */
const cacheIndex = new Map<string, { sig: string; map: Map<string, string> }>()

/**
 * 建（或复用）某个缓存目录的 `md5 → 扩展名` 索引。
 *
 * 一次 `readdirSync` 换掉原来的 4×N 次 `existsSync`。索引里只放本模块写得进去的四种后缀
 * （`CACHE_SUFFIXES`），文件名不合法（少了 `.` 或后缀不在白名单）直接跳过。
 * @param decodedDir - 解码缓存根。
 * @returns 索引（目录不存在时为空 Map，且**不缓存空结果**，以免目录晚建后一直读不到）。
 */
function loadCacheIndex(decodedDir: string): Map<string, string> {
  const dir = join(decodedDir, REMOTE_IMAGE_CACHE_DIRNAME)
  let sig = ''
  try {
    const st = statSync(dir)
    sig = `${String(st.mtimeMs)}:${String(st.size)}`
  } catch {
    // 目录还没建（首次取图前）：返回空索引，别把空结果写进缓存。
    return new Map<string, string>()
  }
  const cached = cacheIndex.get(dir)
  if (cached !== undefined && cached.sig === sig) return cached.map
  const map = new Map<string, string>()
  try {
    for (const name of readdirSync(dir)) {
      const dot = name.lastIndexOf('.')
      if (dot <= 0) continue
      const suffix = name.slice(dot + 1).toLowerCase()
      if (!CACHE_SUFFIXES.has(suffix)) continue
      map.set(name.slice(0, dot), suffix)
    }
  } catch { /* 读不到就当空目录 */ }
  cacheIndex.set(dir, { sig, map })
  return map
}

function cooledDown(url: string): boolean {
  const until = failUntil.get(url)
  return until !== undefined && Date.now() < until
}

/**
 * 取一张远程图片（缓存优先，未命中才出网）。
 * @param rawUrl - 消息里的图片地址；http(s) 且主机在微信 CDN 清单内才会被请求。
 * @param decodedDir - 解码缓存根（`<数据根>/decoded_images`）。
 * @param opts - `cacheIndex`：可选的缓存索引快照（缺省时本函数自己建）。
 */
export async function fetchRemoteImage(
  rawUrl: string,
  decodedDir: string,
  opts: { cacheIndex?: ReadonlyMap<string, string> } = {},
): Promise<RemoteImageResult> {
  const url = String(rawUrl ?? '').trim()
  if (url === '') return { url, error: '图片地址为空' }
  // 缓存优先：本机已有的图直接返回，不联网
  const hit = readCache(url, decodedDir, opts.cacheIndex ?? loadCacheIndex(decodedDir))
  if (hit !== null) return { url, dataUrl: hit, fromCache: true }
  // 协议单独判一次：`wechatCdnHostAllowed` 只看主机，`file://x/qpic.cn/...` 这种形状它会给过
  if (!/^https?:\/\//i.test(url)) return { url, error: '图片地址不是 http(s)' }
  if (!wechatCdnHostAllowed(url)) return { url, error: '图片主机不在微信 CDN 清单内，已拒绝请求' }
  if (cooledDown(url)) return { url, error: '这张图刚才取失败过，稍后会自动重试' }
  try {
    const res = await fetchWithRetry(fetch, url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, { timeoutMs: FETCH_TIMEOUT_MS })
    if (!res.ok) {
      failUntil.set(url, Date.now() + FAIL_COOLDOWN_MS)
      return { url, error: '取图失败 HTTP ' + String(res.status) }
    }
    const bytes = new Uint8Array(await res.arrayBuffer())
    if (bytes.length === 0) return { url, error: '取回来是空文件' }
    if (bytes.length > MAX_REMOTE_IMAGE_BYTES) return { url, error: '图片超过 8MB 上限，已丢弃' }
    const fmt = detectImageFormat(bytes.subarray(0, 16))
    const mime = RENDERABLE_MIME[fmt]
    if (mime === undefined) return { url, error: `取回的不是可渲染的图片格式（${fmt}）` }
    const dataUrl = `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`
    const suffix = fmt === 'jpeg' ? 'jpg' : fmt
    if (!CACHE_SUFFIXES.has(suffix)) return { url, dataUrl, fromCache: false }
    const index = opts.cacheIndex
    try {
      const dir = join(decodedDir, REMOTE_IMAGE_CACHE_DIRNAME)
      mkdirSync(dir, { recursive: true })
      // tmp + rename：不留半截文件，下次读到的要么是旧的要不是新的
      const file = join(dir, `${cacheKey(url)}.${suffix}`)
      const tmp = `${file}.tmp-${String(process.pid)}`
      writeFileSync(tmp, Buffer.from(bytes))
      renameSync(tmp, file)
      // 索引是「每目录一次 readdir」的快照，新写入的这一项要跟上，否则同一次调用里
      // 后续的 readCache 会看不到刚落的盘（写盘成功但索引旧 ⇒ 缓存形同没有）。
      if (index !== undefined && index instanceof Map) index.set(cacheKey(url), suffix)
    } catch {
      // 字节已经拿到了：写缓存失败不该让这张图消失，本次照样回 data URL（下次再试）
    }
    memSet(url, dataUrl)
    return { url, dataUrl, fromCache: false }
  } catch (e) {
    failUntil.set(url, Date.now() + FAIL_COOLDOWN_MS)
    return { url, error: '取图失败：' + String((e as Error)?.message ?? e) }
  }
}

/**
 * 批量取图（一屏卡片或朋友圈一次问完，避免每张一个 RPC）。
 * @param urls - 待取地址；去重后最多 {@link MAX_IMAGES_PER_CALL} 张，超出的直接回错误。
 * @param decodedDir - 解码缓存根。
 */
export async function fetchRemoteImages(
  urls: readonly string[],
  decodedDir: string,
): Promise<RemoteImageResult[]> {
  const wanted: string[] = []
  const seen = new Set<string>()
  for (const raw of urls) {
    const url = String(raw ?? '').trim()
    if (url === '' || seen.has(url)) continue
    seen.add(url)
    wanted.push(url)
  }
  const taken = wanted.slice(0, MAX_IMAGES_PER_CALL)
  const overflow: RemoteImageResult[] = wanted.slice(MAX_IMAGES_PER_CALL)
    .map((url) => ({ url, error: `单次最多 ${String(MAX_IMAGES_PER_CALL)} 张，其余请分批再取` }))
  const out: RemoteImageResult[] = []
  // C1：整批共用**一次**目录索引（原来每张各自试 4 个扩展名 ⇒ 40 张 160 次同步 stat）。
  const index = loadCacheIndex(decodedDir)
  // 分批而不是 allSettled 全发：CDN 对突发并发回 400（`sns-video.ts` 为此专门带微信 UA）
  for (let i = 0; i < taken.length; i += FETCH_CONCURRENCY) {
    // C3（2026-09-28 性能修复）：批次之间让出事件循环。`readFileSync`/`statSync` 是同步的，
    // 而这一整个请求在日志里出现过 86.5s —— 不让出就等于把本进程的其它请求一起钉死。
    if (i > 0) await yieldToLoop()
    const batch = taken.slice(i, i + FETCH_CONCURRENCY)
    out.push(...await Promise.all(batch.map((u) => fetchRemoteImage(u, decodedDir, { cacheIndex: index }))))
  }
  return [...out, ...overflow]
}
