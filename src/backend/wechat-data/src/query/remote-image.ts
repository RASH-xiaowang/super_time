/**
 * 远程图片代理：渲染层要看一张「只存在于微信 CDN 上」的图时，由后端取回、落盘、回 data URL。
 *
 * ## 为什么要它（M23）
 *
 * `index.html` 的 CSP 目前写作 `img-src 'self' data: blob: https: file:` —— 那个 `https:` 通配
 * 意味着**渲染层可以向任意 https 主机发起图片请求**。这些地址全部来自消息 XML / 数据库字段
 * （链接卡、公众号、朋友圈、视频号……的 `thumburl` / `coverurl`），所以「渲染层自己出网」这件事
 * 今天既不读「自动获取原图（CDN）」开关、也不写操作记录、更没有缓存 —— 同一张图每次滚动都会
 * 再要一次，而用户在界面上把开关关掉也拦不住它。
 *
 * 走到后端之后就三件事：**开关真的生效**（{@link cdnFetchAllowed}）、**留得下审计**（调用方写
 * 操作记录）、**存得下盘**（`<decoded>/remote-images/<md5>.<ext>`，第二次渲染不再联网）。
 * 这也是把 CSP 里那个 `https:` 通配拿掉的前提。
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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fetchWithRetry } from '../../../llm-retry.js'
import { wechatCdnHostAllowed } from './cdn-hosts.ts'
import { CDN_DISABLED_MESSAGE, cdnFetchAllowed } from './cdn-policy.ts'
import { detectImageFormat } from './media-image.ts'

/** 单张上限：卡片缩略图与朋友圈图都在几十~几百 KB 量级，超过就是异常响应，宁可失败。 */
const MAX_REMOTE_IMAGE_BYTES = 8 * 1024 * 1024
/** 一次批量最多几张：一屏的卡片缩略图用不完，超出的按错误回（调用方分批再取）。 */
const MAX_IMAGES_PER_CALL = 40
/** 同时在途的请求数：CDN 对突发并发会回 400，而一次滚动要几十张是常态。 */
const FETCH_CONCURRENCY = 6
/** 失败只冷却这么久（与 `article-cover.ts` 同一口径：永久负缓存会把瞬时故障变成永久坏图）。 */
const FAIL_COOLDOWN_MS = 60_000
const FETCH_TIMEOUT_MS = 12_000
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

function cacheKey(url: string): string {
  return createHash('md5').update(url, 'utf8').digest('hex')
}

/** 读缓存：扩展名要试四个（写入时按嗅到的格式定），命中即返回 data URL。 */
function readCache(url: string, decodedDir: string): string | null {
  const dir = join(decodedDir, REMOTE_IMAGE_CACHE_DIRNAME)
  const key = cacheKey(url)
  for (const fmt of ['png', 'jpg', 'gif', 'webp']) {
    const file = join(dir, `${key}.${fmt}`)
    if (!existsSync(file)) continue
    try {
      return `data:${RENDERABLE_MIME[fmt] ?? 'image/png'};base64,${readFileSync(file).toString('base64')}`
    } catch {
      // 半截文件（上次写到一半被打断）：当作没有，下次重新取。tmp + rename 之后理论上不该出现，
      // 但目录可能被用户手动清过或被别的进程写过，这里不为此抛。
      return null
    }
  }
  return null
}

function cooledDown(url: string): boolean {
  const until = failUntil.get(url)
  return until !== undefined && Date.now() < until
}

/**
 * 取一张远程图片（缓存优先，未命中才出网）。
 * @param rawUrl - 消息里的图片地址；只有 https 且主机在微信 CDN 清单内才会被请求。
 * @param decodedDir - 解码缓存根（`<数据根>/decoded_images`）。
 * @param opts - `cdnEnabled` 来自界面上的「自动获取原图（CDN）」开关。
 */
export async function fetchRemoteImage(
  rawUrl: string,
  decodedDir: string,
  opts: { cdnEnabled?: boolean } = {},
): Promise<RemoteImageResult> {
  const url = String(rawUrl ?? '').trim()
  if (url === '') return { url, error: '图片地址为空' }
  // 缓存优先：关掉开关之后本机已有的图照常显示（与 `cdn-switch.spec.ts` 钉住的口径一致）
  const hit = readCache(url, decodedDir)
  if (hit !== null) return { url, dataUrl: hit, fromCache: true }
  // 协议单独判一次：`wechatCdnHostAllowed` 只看主机，`file://x/qpic.cn/...` 这种形状它会给过
  if (!/^https:\/\//i.test(url)) return { url, error: '图片地址不是 https' }
  if (!wechatCdnHostAllowed(url)) return { url, error: '图片主机不在微信 CDN 清单内，已拒绝请求' }
  if (!cdnFetchAllowed(opts)) return { url, error: CDN_DISABLED_MESSAGE }
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
    try {
      const dir = join(decodedDir, REMOTE_IMAGE_CACHE_DIRNAME)
      mkdirSync(dir, { recursive: true })
      // tmp + rename：不留半截文件，下次读到的要么是旧的要不是新的
      const file = join(dir, `${cacheKey(url)}.${suffix}`)
      const tmp = `${file}.tmp-${String(process.pid)}`
      writeFileSync(tmp, Buffer.from(bytes))
      renameSync(tmp, file)
    } catch {
      // 字节已经拿到了：写缓存失败不该让这张图消失，本次照样回 data URL（下次再试）
    }
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
 * @param opts - CDN 开关。
 */
export async function fetchRemoteImages(
  urls: readonly string[],
  decodedDir: string,
  opts: { cdnEnabled?: boolean } = {},
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
  // 分批而不是 allSettled 全发：CDN 对突发并发回 400（`sns-video.ts` 为此专门带微信 UA）
  for (let i = 0; i < taken.length; i += FETCH_CONCURRENCY) {
    const batch = taken.slice(i, i + FETCH_CONCURRENCY)
    out.push(...await Promise.all(batch.map((u) => fetchRemoteImage(u, decodedDir, opts))))
  }
  return [...out, ...overflow]
}
