/**
 * 公众号文章封面解析：抓取微信文章页，取 og:image（或首个 mmbiz 图片），
 * 下载后转成 base64 data URL，并落盘到本地目录，下次直接读本地文件。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fetchWithRetry } from '../net/fetch-retry.ts'
import { cdnHostOf, wechatArticleUrlAllowed, wechatCdnHostAllowed } from './cdn-hosts.ts'
import { boundedSet } from './meta.ts'
import { yieldToLoop } from './search-build.ts'

const coverCache = new Map<string, string>()
/**
 * **正在抓**的文章链接 → 那一次抓取的 promise（2026-09-29 加）。
 *
 * 为什么：`coverCache` 只在抓完之后才写，所以「上一批还在跑、下一批又来了」
 * （快速翻页、两个面板同时要同一批封面）会对同一链接重复出两次网络往返。
 * 合并"网络那一段"即可，缓存判定仍在各自调用里先做完。
 */
const coverInFlight = new Map<string, Promise<{ url?: string; error?: string }>>()
/**
 * 「本机 index 里有没有这张图」的探测函数（A4，2026-09-28 性能修复）。
 *
 * 由调用方注入而不是这里 import：`article-cover.ts` 不认识微信目录/AES 密钥，
 * 而 `moments-media.ts` 两边都有。返回非空字符串表示**本机确实有**（值本身只用于日志）。
 */
export type LocalCoverProbe = (contentUrl: string) => Promise<string | undefined>

/**
 * 封面本地优先（A4）。
 *
 * 为什么：公众号文章的封面图**同时**躺在朋友圈媒体库里（同一批 mmbiz 链接，本机
 * `msg/attach` / `cache/<月>/Sns/Img` 里已有解码好的那份）。改前一律抓 HTML → 抓图，
 * 一屏 30 篇就是 60 次网络往返；而只要按月索引里能确认「本机有」，这两步都可以省。
 *
 * ⚠ 口径是「**索引命中才截流**」（用户 2026-09-28 明确选定）：
 *   · 没给探测函数 ⇒ 行为与加这个分支之前**完全一致**；
 *   · 探测函数返回 undefined（索引没建好 / 没命中 / 读不动）⇒ 照旧出网，绝不因为优化
 *     而让用户看不到封面。
 * 位置在两次缓存查找之后：本地已有图时优先用本机那份。
 * @param probe - {@link LocalCoverProbe}。
 * @param key - contentUrl。
 * @returns data URL；没有本机副本时 undefined（调用方继续走网络）。
 */
async function localCoverHit(probe: LocalCoverProbe | undefined, key: string): Promise<string | undefined> {
  if (!probe) return undefined
  try {
    const hit = await probe(key)
    return hit ? hit : undefined
  } catch {
    // 探测本身出问题（目录读不动等）绝不能让封面拿不到 ⇒ 一律退回原路径。
    return undefined
  }
}

/**
 * 瞬时失败的**短暂**负缓存：key → 到期时间戳。
 *
 * 为什么不是「失败就永久负缓存」（改前的行为）也不是「失败完全不缓存」：
 *   · 永久负缓存会把一次网络抖动变成「这个链接永久坏掉」（`boundedSet` 只在容量满时淘汰），
 *     上层的「数据更新后重试」也因此永远失效；
 *   · 完全不缓存则让**永久 404 的链接**按面板渲染节奏反复抓（每次 20s 超时）。
 * 折中：只挡 {@link FAIL_TTL_MS} 一段时间（2026-09-28 起为 5 分钟），过期就允许重试。
 */
const coverFailUntil = new Map<string, number>()
/**
 * 失败负缓存时长（A3：60s → 5min，2026-09-28 性能修复）。
 *
 * 60s 太短：朋友圈一屏 30 篇里有几篇是**永久 404 / 已删除**的，面板每次重渲染（滚动、切回、
 * 虚拟化重挂载）都会再把它们抓一遍，每篇 20s 超时。5 分钟足以跨过「用户在朋友圈里翻几屏」的
 * 节奏，又不会把瞬时抖动记成永久坏图（过了就自动重试）。
 */
const FAIL_TTL_MS = 5 * 60_000

/**
 * 批量解析的并发上限（A1；2026-09-29 由 8 提到 16）。
 *
 * 与 `remote-image.ts` 的 `FETCH_CONCURRENCY` 同量级：单张要 2 次网络往返，并发太高会被 CDN 限流，
 * 太低又退化成串行（那正是「一屏 30 篇慢慢刷」的观感来源）。
 *
 * 为什么从 8 提到 16（`working/probe-covers-network.ts` 实测，本机真实朋友圈链接、空缓存）：
 *   24 条冷批 = **5,102 ms**，正好是 8 条一波 × 3 波 —— 每波 ~1.7 s，与用户日志里
 *   `getArticleCovers` 每次 1.5–2.2 s 完全吻合。这条链路是**纯网络等待**（失败也都是秒级返回，
 *   不是超时），加线程没有意义，**波数**才是瓶颈 ⇒ 把每波容量翻倍。
 * 风险对照：`remote-image.ts` 一直用 16，未见限流；封面单张只抓 2 个请求，16 路仍属温和。
 */
const COVER_CONCURRENCY = 16

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

/**
 * 「封面为什么不需要重试」——**量过，结论是不改**（2026-09-29）。
 *
 * 一度把这里从默认的 3 次尝试降到 1 次，理由是"24 条冷批里 14 条失败，失败还要重试 3 次"。
 * 但**逐条直接抓取**（同一进程、交替 1 次/3 次，抵消网络漂移）量出来：那 24 条**全部 HTTP 200**，
 * 14 条"失败"是**语义**上的（页面里没有 `og:image`），跟重试次数无关；两次独立运行
 * （3 次 3,025ms vs 1 次 4,391ms）的差异只是网络漂移 ±70%。⇒ 这个改动**没有证据支持**，
 * 已还原。真要动它，先量出"确实存在因抖动失败、且重试能救回来"的样本再说。
 */

/**
 * Fetch text with a timeout; throws on failure.
 *
 * N13：走 `fetchWithRetry`（网络抖动 / 408 / 429 / 5xx 有界重试）。超时**交给重试层**
 * 逐次计时 —— 自己传一个 `AbortSignal.timeout()` 会让整段重试共用一个已中止的信号，
 * 于是第一次超时后重试层直接停（那正是最需要重试的场合）。
 * 重试次数**保持默认的 3 次**（见上面那段"量过，结论是不改"）。
 */
async function fetchText(url: string, timeoutMs: number): Promise<string> {
  // 历史数据里有 http 文章链接：像图片一样先升级成 https，再受同一道域名闸门约束。
  const target = url.startsWith('http://') ? 'https://' + url.slice('http://'.length) : url
  if (!wechatArticleUrlAllowed(target)) {
    throw new Error(`公众号文章页主机不在白名单内：${cdnHostOf(url) || '解析不出主机'}`)
  }
  const res = await fetchWithRetry(fetch, target, { headers: FETCH_HEADERS }, { timeoutMs })
  if (!res.ok) throw new Error('HTTP ' + String(res.status))
  return res.text()
}

/** Fetch image bytes with a timeout; throws on failure. */
async function fetchBytes(url: string, timeoutMs: number): Promise<Uint8Array> {
  if (!wechatCdnHostAllowed(url)) {
    throw new Error(`封面图片主机不在微信 CDN 白名单内：${cdnHostOf(url) || '解析不出主机'}`)
  }
  const res = await fetchWithRetry(fetch, url, { headers: FETCH_HEADERS }, { timeoutMs })
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

/**
 * 把页面里提出来、形状各异的封面 URL 归一成**可以出网**的 https 地址。
 *
 * og:image 正常是绝对地址，但也会见到协议相对（`//mmbiz.qpic.cn/...`）或不带协议
 * （`mmbiz.qpic.cn/...`）的形状。无论哪种形状，最终都必须同时满足：
 *   · 协议是 https（历史行为：http 自动升级）；
 *   · 主机过 {@link wechatCdnHostAllowed}（图片 CDN 清单的唯一出处）。
 * 任一条件不满足就回 null —— 调用方拒绝发请求，而不是把 HTML 里的任意地址带出门。
 */
function coverImageFetchUrl(raw: string, articleUrl: string): string | null {
  const value = (raw || '').trim()
  if (value === '') return null
  let candidate = value
  if (candidate.startsWith('//')) {
    candidate = 'https:' + candidate
  } else if (!/^[a-z][a-z0-9+.-]*:/i.test(candidate)) {
    // 看起来像裸主机名的（含 mmbiz.qpic.cn/... 这种 fallback 形状）直接补 https；
    // 相对路径则按文章页地址解析，仍受后面的 CDN 白名单约束。
    if (/^[a-z0-9.-]+\.[a-z]{2,}(?:[/:?#]|$)/i.test(candidate)) candidate = 'https://' + candidate
    else {
      try {
        candidate = new URL(candidate, articleUrl).href
      } catch {
        return null
      }
    }
  }
  if (candidate.startsWith('http://')) candidate = 'https://' + candidate.slice('http://'.length)
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:') return null
  return wechatCdnHostAllowed(candidate) ? candidate : null
}

/** Local cache file for one article cover (md5(contentUrl)). */
function coverFile(cacheDir: string | undefined, key: string): string | null {
  if (!cacheDir) return null
  const hash = createHash('md5').update(Buffer.from(key, 'utf8')).digest('hex')
  return join(cacheDir, 'article-covers', hash + '.img')
}

/**
 * 「这篇文章**页面里就没有封面**」的落盘标记（与图片缓存同一个目录、同一个 key）。
 *
 * ## 为什么必须落盘
 *
 * 真机逐接口时间线（阈值 20ms）量出：**`getArticleCovers` 一项就占了整轮 16 面板 RPC 总时间的 51%**
 * （4,187ms / 8,219ms），而每次调用都是「3 命中 / **5 失败**」——失败的那些是**页面本来就没有
 * `og:image`** 的文章（不是网络问题）。失败结论原先只存在**内存**里（`coverCache.set(key,'')`），
 * 于是**每开一次应用都要为同一批文章重新抓一遍 HTML**（每篇 1 次往返，5 篇 ≈ 1.0–1.5s）。
 *
 * 这里把"没有封面"这个**事实**落盘：下次进程启动时直接命中，一次网络都不出。
 * 带 TTL 是因为文章可能被编辑后补上封面（虽然罕见）；TTL 取 7 天：既省掉绝大多数重复抓取，
 * 又不至于把一个永久结论钉死。
 */
function coverMissFile(cacheDir: string | undefined, key: string): string | null {
  if (!cacheDir) return null
  const hash = createHash('md5').update(Buffer.from(key, 'utf8')).digest('hex')
  return join(cacheDir, 'article-covers', hash + '.miss')
}

/** 「页面里没有封面」这条事实的保鲜期（见 {@link coverMissFile}）。 */
const COVER_MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * 诊断计数（只在 `SUPERTIME_COVER_TRACE=1` 时被打印并清零）。
 *
 * 为什么需要它：只看"3 命中 / 5 失败 + 1.5 秒"分不清钱花在哪一层 —— 是内存缓存没命中、
 * 落盘图片没命中、还是每个都真的出网了。分层的计数一眼就能看出"哪个缓存没生效"。
 */
const coverStats = { mem: 0, img: 0, missFile: 0, local: 0, net: 0, noCover: 0, netErr: 0 }

/** 封面诊断开关（`SUPERTIME_COVER_TRACE=1`）。模块级函数：单张与批量两条路径都要用。 */
function coverTraceOn (): boolean { return process.env.SUPERTIME_COVER_TRACE === '1' }

/**
 * 这个 key 是否已被记为"页面里没有封面"且在保鲜期内。
 * @param file - 标记文件路径（`null` 表示没有缓存目录）。
 */
function missFresh(file: string | null): boolean {
  if (file === null) return false
  try {
    if (!existsSync(file)) return false
    const raw = readFileSync(file, 'utf8').trim()
    const at = Number(raw)
    if (!Number.isFinite(at) || at <= 0) return false
    return Date.now() - at < COVER_MISS_TTL_MS
  } catch {
    return false
  }
}

/**
 * 解析一个封面：本地缓存优先，再走网络（**单张**）。
 *
 * 从 {@link resolveArticleCoverDataUrl} 提出来，好让批量版（{@link resolveArticleCoversDataUrls}）
 * 复用同一套缓存/开关/负缓存语义 —— 两条路径的判定必须逐字一致，否则「开关关掉后批量版还出网」
 * 这类偏差会静默发生。
 */
async function resolveOne(
  key: string,
  cacheDir: string | undefined,
  localCover?: LocalCoverProbe,
): Promise<{ url?: string; error?: string }> {
  // 文章地址先过域名闸门：缓存查找、本机探测和任何网络动作都不能先发生。
  // 消息 XML 是可被离线改写的文件，`contentUrl` 写成站外地址时这里必须一字节都不发。
  if (!wechatArticleUrlAllowed(key)) {
    return { error: `文章地址的主机不在微信白名单内（${cdnHostOf(key) || '解析不出主机'}），已拒绝请求` }
  }
  if (coverCache.has(key)) {
    coverStats.mem += 1
    const cached = coverCache.get(key) ?? ''
    return cached ? { url: cached } : { error: '文章封面暂不可用' }
  }
  // 刚刚失败过（负缓存期内）就不再抓：见 coverFailUntil 的说明
  if ((coverFailUntil.get(key) ?? 0) > Date.now()) return { error: '文章或封面获取失败' }
  // 「页面里本来就没有封面」的**落盘**结论（跨进程有效，见 coverMissFile）
  const missFile = coverMissFile(cacheDir, key)
  if (missFresh(missFile)) {
    coverStats.missFile += 1
    boundedSet(coverCache, key, '')
    return { error: '文章中未找到封面图片' }
  }
  const file = coverFile(cacheDir, key)
  if (file && existsSync(file)) {
    coverStats.img += 1
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
  // A4：本机（朋友圈媒体索引）already 有这张封面 ⇒ 直接用它，不抓 HTML、不抓图。
  const local = await localCoverHit(localCover, key)
  if (local) {
    coverStats.local += 1
    boundedSet(coverCache, key, local)
    return { url: local }
  }
  // 同一篇文章**正在抓**的时候，后来的调用共享同一次抓取（2026-09-29 加）。
  // 为什么需要：`coverCache` 只在**抓完之后**才写，所以"上一批还在跑、下一批又来了"
  // （用户快速翻页/两个面板同时要同一批封面）会对同一个链接重复出两次网络往返。
  // 这里只把**网络那一段**合并；缓存判定仍在上面各自做完（命中就不进这里）。
  const inFlight = coverInFlight.get(key)
  if (inFlight !== undefined) return await inFlight
  const task = (async (): Promise<{ url?: string; error?: string }> => {
    try {
      coverStats.net += 1
      const html = await fetchText(key, 20000)
      const raw = articleCoverUrl(html)
      if (!raw) {
        coverStats.noCover += 1
        // 「页面里没有封面」是**事实**，不是瞬时故障 ⇒ 落盘记住（TTL 7 天），
        // 下次开应用不再为它抓 HTML。见 coverMissFile 的说明。
        try {
          if (missFile !== null) {
            mkdirSync(join(cacheDir ?? '', 'article-covers'), { recursive: true })
            writeFileSync(missFile, String(Date.now()))
            if (coverTraceOn()) console.warn(`[cover-trace] 写无封面标记成功 ${missFile}`)
          } else if (coverTraceOn()) {
            console.warn('[cover-trace] 无封面标记路径为空（cacheDir 缺失？）')
          }
        } catch (e) {
          // 落盘失败不影响本次结果
          if (coverTraceOn()) console.warn(`[cover-trace] 写无封面标记失败：${String((e as Error).message)}`)
        }
        boundedSet(coverCache, key, '')
        return { error: '文章中未找到封面图片' }
      }
      const allowedImgUrl = coverImageFetchUrl(raw, key)
      if (!allowedImgUrl) {
        // 站外/非 https 的封面地址不是「这篇文章没有图」，而是**不能替它去取**。
        // 不写 miss 标记（那是给「页面确实没有 og:image」用的），避免把安全拒绝记成业务事实。
        boundedSet(coverFailUntil, key, Date.now() + FAIL_TTL_MS)
        return { error: `文章封面地址的主机不在微信 CDN 清单内（${cdnHostOf(raw) || '解析不出主机'}），已拒绝请求` }
      }
      const bytes = await fetchBytes(allowedImgUrl, 20000)
      if (bytes.length < 16) throw new Error('empty image')
      const fmt = sniffImageFormat(bytes)
      const data = 'data:image/' + fmt + ';base64,' + Buffer.from(bytes).toString('base64')
      if (file) {
        try {
          mkdirSync(join(cacheDir ?? '', 'article-covers'), { recursive: true })
          writeFileSync(file, Buffer.from(bytes))
          if (coverTraceOn()) console.warn(`[cover-trace] 写图成功 ${file}`)
        } catch (e) {
          // 落盘失败不影响本次展示
          if (coverTraceOn()) console.warn(`[cover-trace] 写图失败 ${file}：${String((e as Error).message)}`)
        }
      }
      boundedSet(coverCache, key, data)
      return { url: data }
    } catch {
      // 瞬时失败（网络超时/对端 5xx）：只挡一段时间，**不**写进 coverCache（那等于永久坏掉）。
      boundedSet(coverFailUntil, key, Date.now() + FAIL_TTL_MS)
      return { error: '文章或封面获取失败' }
    }
  })()
  coverInFlight.set(key, task)
  try {
    return await task
  } finally {
    coverInFlight.delete(key)
  }
}

/**
 * Resolve a 公众号 article cover to a base64 data URL（本地缓存优先，再走网络并落盘）。
 * @param contentUrl - mp.weixin.qq.com article URL from the moments XML.
 * @param cacheDir - persistent cache directory (decoded_images), optional.
 * @param localCover - A4 本机封面探测（见 {@link LocalCoverProbe}）；省略时行为与加它之前一致。
 * @returns ImageDataUrlResult-like result.
 */
export async function resolveArticleCoverDataUrl(
  contentUrl: string,
  cacheDir?: string,
  localCover?: LocalCoverProbe,
): Promise<{ url?: string; error?: string }> {
  const key = (contentUrl || '').trim()
  if (!key) return { error: '缺少文章链接' }
  return resolveOne(key, cacheDir, localCover)
}

/**
 * 批量解析封面（A1，2026-09-28 性能修复）。
 *
 * ## 为什么需要它
 *
 * 现场日志里 `getArticleCover` 是**最高频的慢**：1221 次（占全部慢调用 73.6%）、均 1920ms。
 * 原因是前端逐个发单张 RPC（`moments-media.ts` 的 `for (const url of todo)`），一屏 30 篇
 * 就是 30 个 RPC × 每个 2 次网络往返（抓 HTML + 抓图），且**全部排在同一个同步后端队列里**。
 *
 * 批量版把 N 个 RPC 收成 1 个，并在后端按 {@link COVER_CONCURRENCY} 分批并发；
 * 每批之间让出（{@link yieldToLoop}），不独占事件循环。
 * @param urls - 待解析的文章链接（去重；空格/空串忽略）。
 * @param cacheDir - 解码缓存根（落盘位置）。
 * @param localCover - A4 本机封面探测（见 {@link LocalCoverProbe}）。
 */
export async function resolveArticleCoversDataUrls(
  urls: readonly string[],
  cacheDir?: string,
  localCover?: LocalCoverProbe,
): Promise<Array<{ url: string; dataUrl?: string; error?: string }>> {
  const wanted: string[] = []
  const seen = new Set<string>()
  for (const raw of urls) {
    const key = (raw || '').trim()
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    wanted.push(key)
  }
  const out: Array<{ url: string; dataUrl?: string; error?: string }> = []
  // 诊断（`SUPERTIME_COVER_TRACE=1`）：一次调用**实际带了多少条**、分几波、每波多久。
  // 为什么需要它：真机逐接口时间线只给"3 次调用 / 合计 N ms"，看不出"约束在每趟条数还是网络"。
  // 2026-09-29 就是靠这条量出"客户端每趟只有 8 条、而后端并发是 16"这类结论的前提。
  const trace = process.env.SUPERTIME_COVER_TRACE === '1'
  const callStartedAt = Date.now()
  if (trace) {
    const dir = join(cacheDir ?? '', 'article-covers')
    let n = -1
    try { n = readdirSync(dir).length } catch { n = -1 }
    console.warn(`[cover-trace] 缓存目录=${dir} 存在=${String(existsSync(dir))} 文件数=${String(n)}`)
    console.warn(`[cover-trace] 收到 n=${String(wanted.length)} cacheDir=${String(cacheDir ?? '(未传)')}`)
  }
  let waves = 0
  for (let i = 0; i < wanted.length; i += COVER_CONCURRENCY) {
    // 批次之间让出：单张最坏 40s（两次 20s 超时），批量若一口气跑完会把队列钉死。
    if (i > 0) await yieldToLoop()
    const batch = wanted.slice(i, i + COVER_CONCURRENCY)
    const waveStartedAt = Date.now()
    // 波**开始前**先数一遍这批 key 的缓存状态：这是判断"落盘负缓存到底有没有被用上"的关键，
    // 波后再数会被本波自己写下的标记污染（曾经因此误以为"没有生效"）。
    let preMissN = 0
    let preImgN = 0
    if (trace) {
      for (const k of batch) {
        const h = createHash('md5').update(Buffer.from(k, 'utf8')).digest('hex')
        if (existsSync(join(cacheDir ?? '', 'article-covers', h + '.miss'))) preMissN += 1
        if (existsSync(join(cacheDir ?? '', 'article-covers', h + '.img'))) preImgN += 1
      }
    }
    const settled = await Promise.all(batch.map(async (key) => {
      const r = await resolveOne(key, cacheDir, localCover)
      return r.url !== undefined ? { url: key, dataUrl: r.url } : { url: key, error: r.error ?? '获取失败' }
    }))
    waves += 1
    if (trace) {
      const ok = settled.filter((x) => x.dataUrl !== undefined).length
      // k0 = 首条的**缓存键**（md5(url)）与它是否已有 .miss 标记：跨轮对比就能看出
      // "两次请求的是不是同一批 url"（不是同一批 ⇒ 落盘负缓存当然帮不上忙）。
      const k0 = createHash('md5').update(Buffer.from(batch[0] ?? '', 'utf8')).digest('hex')
      const miss0 = existsSync(join(cacheDir ?? '', 'article-covers', k0 + '.miss'))
      console.warn(`[cover-trace] n=${String(wanted.length)} wave=${String(waves)} size=${String(batch.length)} 命中/失败=${ok}/${batch.length - ok} 本波=${Date.now() - waveStartedAt}ms 累计=${Date.now() - callStartedAt}ms 波前[已有标记=${String(preMissN)} 已有图=${String(preImgN)}] 分层[内存=${coverStats.mem} 落盘图=${coverStats.img} 落盘无封面=${coverStats.missFile} 本机=${coverStats.local} 出网=${coverStats.net} 页面无封面=${coverStats.noCover}]`)
      coverStats.mem = 0
      coverStats.img = 0
      coverStats.missFile = 0
      coverStats.local = 0
      coverStats.net = 0
      coverStats.noCover = 0
      coverStats.netErr = 0
    }
    out.push(...settled)
  }
  if (trace && wanted.length === 0) console.warn('[cover-trace] n=0（这一趟没有待解析的链接）')
  return out
}
