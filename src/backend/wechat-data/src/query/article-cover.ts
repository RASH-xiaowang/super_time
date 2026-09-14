/**
 * 公众号文章封面解析：抓取微信文章页，取 og:image（或首个 mmbiz 图片），
 * 下载后转成 base64 data URL，并落盘到本地目录，下次直接读本地文件。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { boundedSet } from './meta.ts'

const coverCache = new Map<string, string>()

/**
 * 瞬时失败的**短暂**负缓存：key → 到期时间戳。
 *
 * 为什么不是「失败就永久负缓存」（改前的行为）也不是「失败完全不缓存」：
 *   · 永久负缓存会把一次网络抖动变成「这个链接永久坏掉」（`boundedSet` 只在容量满时淘汰），
 *     上层的「数据更新后重试」也因此永远失效；
 *   · 完全不缓存则让**永久 404 的链接**按面板渲染节奏反复抓（每次 20s 超时）。
 * 折中：只挡 60 秒，过期就允许重试。
 */
const coverFailUntil = new Map<string, number>()
const FAIL_TTL_MS = 60_000

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Referer': 'https://mp.weixin.qq.com/',
}

function sniffImageFormat(data: Uint8Array): string {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpeg'
  if (data.length >= 4 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'png'
  if (data.length >= 4 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) return 'gif'
  if (data.length >= 12 && data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return 'webp'
  return 'jpeg'
}

/** Fetch text with a timeout; throws on failure. */
async function fetchText(url: string, timeoutMs: number): Promise<string> {
  const res = await fetch(url, { headers: FETCH_HEADERS, signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error('HTTP ' + String(res.status))
  return res.text()
}

/** Fetch image bytes with a timeout; throws on failure. */
async function fetchBytes(url: string, timeoutMs: number): Promise<Uint8Array> {
  const res = await fetch(url, { headers: FETCH_HEADERS, signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error('HTTP ' + String(res.status))
  return new Uint8Array(await res.arrayBuffer())
}

/** Extract the article cover image URL (og:image first, then first mmbiz image). */
function articleCoverUrl(html: string): string | null {
  const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
    ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)
  if (og && og[1]) return og[1]
  const m = html.match(/mmbiz\.qpic\.cn\/[^"'\s>]+/)
  return m ? m[0] : null
}

/** Local cache file for one article cover (md5(contentUrl)). */
function coverFile(cacheDir: string | undefined, key: string): string | null {
  if (!cacheDir) return null
  const hash = createHash('md5').update(Buffer.from(key, 'utf8')).digest('hex')
  return join(cacheDir, 'article-covers', hash + '.img')
}

/**
 * Resolve a 公众号 article cover to a base64 data URL（本地缓存优先，再走网络并落盘）。
 * @param contentUrl - mp.weixin.qq.com article URL from the moments XML.
 * @param cacheDir - persistent cache directory (decoded_images), optional.
 * @returns ImageDataUrlResult-like result.
 */
export async function resolveArticleCoverDataUrl(contentUrl: string, cacheDir?: string): Promise<{ url?: string; error?: string }> {
  const key = (contentUrl || '').trim()
  if (!key) return { error: '缺少文章链接' }
  if (coverCache.has(key)) {
    const cached = coverCache.get(key) ?? ''
    return cached ? { url: cached } : { error: '文章封面暂不可用' }
  }
  // 刚刚失败过（60s 内）就不再抓：见 coverFailUntil 的说明
  if ((coverFailUntil.get(key) ?? 0) > Date.now()) return { error: '文章或封面获取失败' }
  const file = coverFile(cacheDir, key)
  if (file && existsSync(file)) {
    try {
      const bytes = readFileSync(file)
      if (bytes.length >= 16) {
        const fmt = sniffImageFormat(new Uint8Array(bytes))
        const data = 'data:image/' + fmt + ';base64,' + bytes.toString('base64')
        boundedSet(coverCache, key, data)
        return { url: data }
      }
    } catch {
      // 本地文件损坏时走网络重新下载
    }
  }
  try {
    const html = await fetchText(key, 20000)
    const raw = articleCoverUrl(html)
    if (!raw) {
      boundedSet(coverCache, key, '')
      return { error: '文章中未找到封面图片' }
    }
    const imgUrl = raw.startsWith('http://') ? 'https://' + raw.slice(7) : raw
    const bytes = await fetchBytes(imgUrl, 20000)
    if (bytes.length < 16) throw new Error('empty image')
    const fmt = sniffImageFormat(bytes)
    const data = 'data:image/' + fmt + ';base64,' + Buffer.from(bytes).toString('base64')
    if (file) {
      try {
        mkdirSync(join(cacheDir ?? '', 'article-covers'), { recursive: true })
        writeFileSync(file, Buffer.from(bytes))
      } catch {
        // 落盘失败不影响本次展示
      }
    }
    boundedSet(coverCache, key, data)
    return { url: data }
  } catch {
    // 瞬时失败（网络超时/对端 5xx）：只挡 60s，**不**写进 coverCache（那等于永久坏掉）。
    boundedSet(coverFailUntil, key, Date.now() + FAIL_TTL_MS)
    return { error: '文章或封面获取失败' }
  }
}
