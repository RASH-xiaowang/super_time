/**
 * 朋友圈媒体层：本地缓存优先、懒解密、公众号封面兜底、灯箱按需解析。
 *
 * ## 为什么单独成模块（第三批 #18 第二步）
 *
 * 这一族原先散在 `moments-panel.tsx` 的五个位置（state 一处、观察器一处、封面兜底一处、
 * 重挂载观察一处、IDB 恢复一处、灯箱一处），加起来约 140 行，是那个 900 多行组件里最大的一块。
 * 它们共享同一份状态（`snsImgs` / `snsFetched` / `mediaKeySpec`），拆开后互相能看见 ——
 * 于是收成一个钩子：状态、去重集合、队列与观察器都由本模块持有，外面只拿返回值。
 *
 * ## 一条不能被「顺手优化」掉的约定
 *
 * 「哪一格该去本机解码」是 IntersectionObserver 按 DOM 上的 `data-sns-key` 认的，
 * 而那张 `mediaKeySpec` 表**由卡片在 render 里登记**（`moments-card.tsx` 的三处 `.set`）。
 * 面板只读它。所以这个 ref 必须在 render 期间就能被卡片写到 —— 把它挪进 `useEffect`
 * 会让观察器永远查不到 spec，表现是「滚动到图片也不解密」。
 *
 * ## 取图口径：**本地优先、CDN 兜底**（2026-10-19 用户口径变更）
 *
 * 进面板先批量从 IndexedDB 恢复**原图**（`wantOriginal` 把缩略图当未命中），本地有就
 * 直接显示、不再出网；单格同样先查 IndexedDB 原图，命中就跳过 RPC。只有本地没有原图时
 * 才走 `getSnsImageDataUrl`，而后端也按「长期归档 → 解码缓存 → 本机目录 → CDN」的顺序。
 *
 * 这与旧口径（有网先 CDN、只有无网才看 IndexedDB）相反 —— 旧口径下每次进入都会重新
 * 出网，本地已经落盘的高清图被跳过；用户明确要求「先用本地显示，然后再使用 CDN」。
 * md5 是内容寻址，本地那份只要是原图就与 CDN 同一张，先看本地不会看到旧图。
 *
 * 网络状态取自 `navigator.onLine`（与 `remote-img.tsx` 的离线短路同一个信号），由
 * {@link isOffline} 在**取图那一刻**读一次并随 RPC 传给后端。不做成 state：它变了不必
 * 重排已显示的图，而做成 state 会在断网瞬间把整屏图片重置成「正在取」。
 *
 * @module moments-media
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MomentItem } from '@deepseek-ai/dsh-wechat-data/types'
import {
  apiGetArticleCovers,
  apiGetSnsImageDataUrl,
  apiGetSnsVideoCoverDataUrl,
  snsMediaCacheGet,
  snsMediaCacheGetMany,
  snsMediaCacheSet,
} from '../api.ts'
import { capRecord } from '../utils/misc.ts'
import { ARTICLE_COVER_CACHE_MAX, SNS_IMG_CACHE_MAX, imgKey } from './moments-support.tsx'

/**
 * 取图失败的重试状态（2026-09-29 修「有的图片加载不出来」）。
 *
 * 依据（真机自检）：**解码缓存 154 张 / 43.5MB**，而媒体资源 **175,963 项 / 16.8GB**
 * ⇒ 绝大多数朋友圈图不在缓存里，必须走"按需 `.dat` 解密 + hardlink 定位"这条慢路径
 * （`backend-rpc.spec.ts` 记录：缓存未命中时实测 12–21s）。缓存与解密的**首次失败往往是暂时性的**
 * （文件正在被写、hardlink 还没建好、这一次超时），而原实现把 catch 分支留成空注释
 * 、直接吞掉：不重试、不记录、不告诉用户。
 *
 * 这里做两件事：① 失败的键**自动重试**（最多 2 次，间隔 1.5s，不忙等）；
 * ② 超过重试上限才 `console.warn` 出**具体原因**（后端 `resolveSnsImageDataUrl` 会给出
 * 「缺少图片标识」「未配置微信原始目录，无法离线解码」这类文本，原实现直接丢掉了）。
 */
const MEDIA_RETRY_MAX = 2
const MEDIA_RETRY_DELAY_MS = 1500
/**
 * 媒体键元数据上限。长列表「加载全部」或持续滚动时，卡片会在 render 中登记每个见过的
 * 媒体键；只靠 data URL 的 200 条 LRU 并不能限制这些只有字符串/对象的键表。
 */
export const MOMENTS_MEDIA_KEY_CACHE_MAX = 4000
/** 待解密队列与媒体键表同界；超出的远端项撤回去重标记，等再次进入视口再排。 */
export const MOMENTS_MEDIA_QUEUE_MAX = MOMENTS_MEDIA_KEY_CACHE_MAX
/** 公众号链接只重试 3 次；持久失败链接的尝试表同样必须有界。 */
export const MOMENTS_COVER_ATTEMPT_MAX = 500
/** 失败原因记录跟随图片缓存上界，不能比实际可见资源保留更久。 */
const SNS_ERR_CACHE_MAX = 200
import type { ViewerState } from './moments-portals.tsx'

/**
 * FIFO 上界 Set：重复 add 会移到队尾，超限优先淘汰最老的非保护项。
 * 保护项用于队列中、请求中或等待重试的媒体键，避免 fetched 表先把自己仍在处理的键淘汰。
 */
export class BoundedMediaSet<T> extends Set<T> {
  constructor(
    private readonly max: number,
    private readonly protectedValues?: () => ReadonlySet<T> | undefined,
  ) {
    super()
  }

  override add(value: T): this {
    this.delete(value)
    super.add(value)
    while (this.size > this.max) {
      const protectedSet = this.protectedValues?.()
      let victim: T | undefined
      let found = false
      for (const candidate of this) {
        if (!protectedSet?.has(candidate)) {
          victim = candidate
          found = true
          break
        }
      }
      if (!found) break
      this.delete(victim as T)
    }
    return this
  }
}

/** FIFO 上界 Map；媒体键重复登记时移动到队尾，避免正在渲染的键先被淘汰。 */
class BoundedMediaMap<K, V> extends Map<K, V> {
  constructor(private readonly max: number) {
    super()
  }

  override set(key: K, value: V): this {
    this.delete(key)
    super.set(key, value)
    while (this.size > this.max) {
      const oldest = this.keys().next().value
      if (oldest === undefined) break
      this.delete(oldest)
    }
    return this
  }
}

/**
 * 图片/视频的离线解码请求描述。
 * 定义在这里（而不是卡片里）：面板的钩子与卡片的 props 共用同一个形状，只有一份出处。
 */
export interface SnsImageSource {
  /** 库里存的 CDN 地址（`http://…/0`）：给了就走 CDN 通路（见后端 `sns-cdn-image.ts`）。 */
  url?: string
  /** 媒体标签上的 `token`：CDN 必需（实测 `token+idx=1` 才 200）。 */
  token?: string
  md5?: string
  timelineId?: string
  id?: string
  mediaId?: string
  seed?: string
  /** 卡片 XML 的 `<enc key>`；即主图 `seed` 的别名。 */
  key?: string
  thumb?: string
  /** 原图预期尺寸/字节数（后端按这些字段选择真实的 `/0` 原图）。 */
  originalWidth?: number
  originalHeight?: number
  originalBytes?: number
  /** XML `<uhd>` 的独立 CDN 三件套；它和主图 `url/token/seed` 不是同一份。 */
  uhdUrl?: string
  uhdToken?: string
  uhdSeed?: string
  uhdMd5?: string
}

export interface MediaKeySpec extends SnsImageSource {
  md5: string
  kind: 'img' | 'video' | 'comment'
}

/** 灯箱按需解析时用的最小图结构（与 `MomentsImageViewer` 传进来的形状兼容）。 */
type ViewerImage = SnsImageSource

export interface SnsImageRequestOptions {
  md5: string
  timelineId?: string
  mediaId?: string
  url?: string
  token?: string
  seed?: string
  thumb?: string
  originalWidth?: number
  originalHeight?: number
  originalBytes?: number
  uhdUrl?: string
  uhdToken?: string
  uhdSeed?: string
  offline?: boolean
}

export interface SnsImageEntry {
  url: string
  original: boolean
}

export type SnsImageEntries = Record<string, SnsImageEntry>

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function positiveCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : undefined
}

/**
 * 把图片记录里的原图元数据收成请求字段。
 *
 * 网格与灯箱都必须走这里：UHD 的 md5/token/seed 与普通图不同，尤其 `uhdSeed`
 * 必须来自 `<uhd key>`；漏一个字段后端就只能退到低清图。
 */
export function snsImageMetadata(source: SnsImageSource): Pick<
  MediaKeySpec,
  'originalWidth' | 'originalHeight' | 'originalBytes' | 'uhdUrl' | 'uhdToken' | 'uhdSeed'
> {
  const originalWidth = positiveCount(source.originalWidth)
  const originalHeight = positiveCount(source.originalHeight)
  const originalBytes = positiveCount(source.originalBytes)
  const uhdUrl = nonEmpty(source.uhdUrl)
  const uhdToken = nonEmpty(source.uhdToken)
  const uhdSeed = nonEmpty(source.uhdSeed)
  return {
    ...(originalWidth !== undefined ? { originalWidth } : {}),
    ...(originalHeight !== undefined ? { originalHeight } : {}),
    ...(originalBytes !== undefined ? { originalBytes } : {}),
    ...(uhdUrl !== undefined ? { uhdUrl } : {}),
    ...(uhdToken !== undefined ? { uhdToken } : {}),
    ...(uhdSeed !== undefined ? { uhdSeed } : {}),
  }
}

/**
 * 把一条朋友圈图片记录登记成取图描述。
 *
 * 文章链接卡会隐藏九宫格，但 `images[0]` 仍是公众号封面的 SNS 副本；它同样需要
 * `timelineId + id + url + token + seed` 才能被后端定位。卡片与详情共用这一份，
 * 避免某一处漏字段后静默退化成空白封面。
 * @param im - 朋友圈图片记录。
 * @returns 有可用媒体键时返回取图描述，否则 null。
 */
export function momentImageSpec(im: MomentItem['images'][number]): MediaKeySpec | null {
  if (imgKey(im) === '') return null
  return {
    md5: im.md5 || '',
    kind: 'img',
    ...(im.timelineId ? { timelineId: im.timelineId } : {}),
    ...(im.id ? { mediaId: im.id } : {}),
    ...(im.url ? { url: im.url } : {}),
    ...(im.token ? { token: im.token } : {}),
    ...(im.key ? { seed: im.key } : {}),
    ...(im.uhdMd5 ? { uhdMd5: im.uhdMd5 } : {}),
    ...snsImageMetadata(im),
  }
}

/**
 * 只保留能定位的九宫格图片。
 *
 * 视频号分享的 `<finderFeed><media>` 没有 md5/id，旧解析器会把它塞进 `images`，
 * 界面于是显示「这条媒体没有 md5/id，无法定位」的假图片格。这里按 `imgKey`
 * 过滤，既挡住新数据，也让尚未重放归档的旧数据不再出现伪图片。
 * @param m - 至少带 `images` 的动态。
 * @returns 有可用媒体键的图片列表。
 */
export function momentGridImages(m: Pick<MomentItem, 'images'>): MomentItem['images'] {
  return m.images.filter((im) => imgKey(im) !== '')
}

/**
 * 朋友圈链接卡片的展示规则。
 *
 * 视频号分享（`contentType === 28`）的 `<finderFeed>` 里也有 `<media>`，但那是视频
 * 播放源/封面，不是九宫格图片；旧解析器会把它误挂到 `images`，于是界面出现
 * 「这条媒体没有 md5/id」的假图片格。这里把视频号从图片网格中排除，并优先使用
 * `<finderFeed>` 的封面地址；普通动态仍保持九宫格。
 */
export function momentLinkCardView(
  m: Pick<MomentItem, 'images' | 'link_url' | 'sourceNickName'>
    & Partial<Pick<MomentItem, 'contentType' | 'link_thumb' | 'link_title'>>,
  snsImgs: Readonly<Record<string, string>>,
  articleCovers: Readonly<Record<string, string>> = {},
): { showImages: boolean; coverSrc: string; label: string; title: string } {
  // `sourceNickName === '视频号'` 是对旧归档的兜底：更早的 payload 可能没有 contentType。
  const videoChannel = m.contentType === 28 || (m.sourceNickName ?? '').trim() === '视频号'
  const images = momentGridImages(m)
  const cover = images[0]
  const coverKey = cover ? imgKey(cover) : ''
  const localCover = coverKey !== '' ? (snsImgs[coverKey] ?? '') : ''
  const articleCover = m.link_url ? (articleCovers[m.link_url] ?? '') : ''
  const rawTitle = m.link_title ?? ''
  // 微信旧客户端会把视频号标题写成兼容性占位；归档还没重放时也不要把它当正文标题。
  const title = videoChannel && (rawTitle === '' || /当前微信版本不支持展示该内容|请升级至最新版本/.test(rawTitle))
    ? '视频号内容'
    : rawTitle
  // 文章页封面是公众号的正式封面；已经拿到时优先它，未拿到时仍可用本机 SNS 副本先顶上。
  const coverSrc = m.contentType === 3 && articleCover !== ''
    ? articleCover
    : (localCover || articleCover || m.link_thumb || '')
  return {
    showImages: images.length > 0 && m.contentType !== 3 && !videoChannel,
    coverSrc,
    label: videoChannel ? '视频号' : (m.sourceNickName ? '公众号 · ' + m.sourceNickName : '链接'),
    title,
  }
}

/**
 * 构造朋友圈单图请求。主图三件套与 `<uhd>` 三件套分别透传，绝不互相顶替。
 * @param source - 卡片/灯箱里的图片记录。
 * @param offline - 取图时的网络状态。
 */
export function buildSnsImageRequestOptions(
  source: SnsImageSource,
  offline = isOffline(),
): SnsImageRequestOptions {
  const timelineId = nonEmpty(source.timelineId)
  const mediaId = nonEmpty(source.id) ?? nonEmpty(source.mediaId)
  const url = nonEmpty(source.url)
  const token = nonEmpty(source.token)
  const seed = nonEmpty(source.seed) ?? nonEmpty(source.key)
  const thumb = nonEmpty(source.thumb)
  return {
    md5: nonEmpty(source.md5) ?? '',
    ...(timelineId !== undefined ? { timelineId } : {}),
    ...(mediaId !== undefined ? { mediaId } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(token !== undefined ? { token } : {}),
    ...(seed !== undefined ? { seed } : {}),
    ...(thumb !== undefined ? { thumb } : {}),
    ...snsImageMetadata(source),
    offline,
  }
}

/**
 * 一批出队解码的条数。
 *
 * ⚠️ **必须 ≤ 后端重活队列容量**（`src/backend/http-queue.js` 的 `HEAVY_QUEUE_MAX = 4`）。
 * `getSnsImageDataUrl` / `getSnsVideoCoverDataUrl` 都在 `remote-policy.js` 的
 * `HEAVY_CALL_LEDGER` 里（缓存未命中时退化成 12–21s 的读+解密+哈希），因此每个请求都占
 * 一个**重活**名额；后端重活车道是「1 个在跑 + 4 个排队」，超出的立刻回 `REMOTE_BUSY`。
 *
 * 2026-10-16 真机实测：原值 8 时，朋友圈首屏一批 8 个请求里有 3–4 个被拒
 * （日志刷屏 `重任务排队已满（已有 1 个在跑、4 个在排队）`），重试机制虽救回大部分，
 * 但仍有零星图片永久失败（`[moments-media] 取图失败（已重试 2 次，放弃）`）。
 * 降到 4 后每批都能进队列，不再触发 `REMOTE_BUSY`。
 *
 * 别再往上调：批越大越容易撞队列上限，而**吞吐并不由这里决定** —— 后端重活并发恒为 1，
 * 前端发再多也只是排队或被拒。
 */
const MEDIA_BATCH = 4

/**
 * 进面板时一次从 IndexedDB 批量恢复的上限。
 *
 * 不能把 `moments` 里的全部键（真实数据 1000+）一次恢复：`snsImgs` 只有 200 条上限，
 * `capRecord` 超限会淘汰**最早插入**的键。真机实测一次 `getMany` 返回 555 条，结果
 * 首屏最先入表的几张被挤出内存，界面一直显示「正在取原图」——而滚动到后面的图正常。
 * 只恢复开头 80 个够覆盖首屏；后面的图懒加载时按单张 `snsMediaCacheGet` 命中。
 */
const SNS_IMG_RESTORE_MAX = 80

/**
 * 一批发出的封面请求条数（A2，2026-09-28 性能修复）。
 *
 * 改前是「`todo` 里有多少就一次全发」—— 一屏 30 篇 = 30 个并发 RPC 打向后端
 * （日志里 `getArticleCover` 1221 次 / 均 1.9s 就是这么来的）。分批是为了不形成尖峰。
 *
 * ⚠️ 别再"把这里提到后端并发上限（16）"当成优化：2026-09-29 试过，真机逐接口时间线里
 * `getArticleCovers` 的**调用次数没有变化**（仍是 3 次）—— 说明**约束在"每趟待办有多少条"**
 * （`pendingCovers` 的返回），不是这里的批大小。要再动它，先量出每趟到底带了几条
 * （后端日志不记入参，得先补一条带着条数的打点）。
 */
const COVER_BATCH = 8

/**
 * 视频（及其封面）的缓存键。
 * **这是 DOM 契约的一部分**：卡片把它挂到 `data-sns-key`，观察器再按同一个键反查 spec，
 * 灯箱与详情也用它取 `videoSrcs` —— 三处必须一字不差，所以只允许这一份实现。
 * @param v - 视频项（`md5` 优先，其次 `timelineId`+`id`）。
 * @returns `v:<md5>` / `v:<timelineId>:<id>` / 空串（两者都没有）。
 */
export function videoCoverKey(v: { md5?: string; timelineId?: string; id?: string }): string {
  return v.md5 ? 'v:' + v.md5 : (v.timelineId && v.id ? 'v:' + v.timelineId + ':' + v.id : '')
}

/**
 * 收集列表里所有「可能已经在本机解出过」的媒体键，用于进面板时先从 IndexedDB 捞一遍。
 * @param moments - 已加载的动态。
 * @returns 去重后的键列表（顺序稳定，便于测试对照）。
 */
export function collectMediaKeys(moments: readonly MomentItem[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (k: string): void => {
    if (k && !seen.has(k)) { seen.add(k); out.push(k) }
  }
  for (const m of moments) {
    for (const im of m.images) push(imgKey(im))
    for (const v of m.videos) push(videoCoverKey(v))
    for (const c of m.comments) push(c.image?.md5 || '')
  }
  return out
}

/**
 * 找出「本地 SNS 缓存没有、又还没试过（或试不满 3 次）」的公众号文章链接。
 * @param moments - 已加载的动态。
 * @param snsImgs - 已解出的本地媒体。
 * @param articleCovers - 已抓到的封面。
 * @param attempts - 各链接已试次数（只读；调用方在实际发送请求时累加）。
 * @returns 本轮要抓的链接列表。
 */
export function pendingCovers(
  moments: readonly MomentItem[],
  snsImgs: Record<string, string>,
  articleCovers: Record<string, string>,
  attempts: Map<string, number>,
  inflight?: ReadonlySet<string>,
): string[] {
  const todo: string[] = []
  for (const m of moments) {
    if (m.contentType !== 3 || !m.link_url) continue
    const cover = m.images[0]
    const localKey = cover ? imgKey(cover) : ''
    // 本机能解出就别去打网络（隐私闸门关着时这条尤其重要）。
    if (localKey && snsImgs[localKey]) continue
    if (articleCovers[m.link_url]) continue
    if (inflight?.has(m.link_url)) continue
    const attempt = attempts.get(m.link_url) ?? 0
    if (attempt >= 3) continue
    todo.push(m.link_url)
  }
  return todo
}

/**
 * 补观察所有还没取过的 `[data-sns-key]` 格子（已取过的跳过，不重复观察）。
 *
 * 现象（2026-10-08 修）：往下滚动时**新出现的朋友圈图片一直不出来**（旧的一屏正常）。
 * 原因：建 IO 的那个 effect 从未 `.observe()` 任何元素 —— 只有挂载那一刻已在 DOM 里的占位格
 * 会被观察，滚动进来（列表变长 / 虚拟化重建）的格子永远不入队、也就永远不解码。
 *
 * ⚠️ 查询范围是 `document` 而不是滚动容器（2026-10-09 改）：**详情浮层与灯箱都 portal 到
 * `document.body`**（见 `moments-portals.tsx` 的两处 `createPortal`），只扫容器就永远扫不到
 * 浮层里的评论图格子，于是没人触发取图、恒显示 [图]。交集判定仍然交给 IO（它的 `root` 仍是
 * 滚动容器），所以扩大查询范围不会把屏外的格子拉去取图；而 `data-sns-key` 只有朋友圈在用
 * （全仓仅 `moments-card.tsx` / `moments-portals.tsx`），不会误伤别的面板。
 *
 * 调用点还要带 `detailKey` 依赖：浮层里的格子只在**打开浮层那一刻**才进 DOM，而列表本身
 * （`moments`）并没有变 ⇒ 只依赖 `moments` 的那次补观察扫不到它们。
 *
 * 独立成函数而不是内联在 hook 里：hook 紧贴 `function-size-ratchet` 的 250 行线，
 * 而这段的说明比代码本身长得多。
 */
function sweepSnsKeys(ob: IntersectionObserver, fetched: Set<string>): void {
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-sns-key]'))) {
    const key = el.dataset.snsKey || ''
    if (key !== '' && !fetched.has(key)) ob.observe(el)
  }
}

/**
 * 这个格子此刻是否**真的在视口里**（而不是只在 IO 的预取边距内）。
 *
 * 为什么要区分：IO 的 `rootMargin` 是**预取**边距（提前解码，滚到时已经好了），
 * 但后端重活车道只有「1 个在跑 + 4 个排队」（见 {@link MEDIA_BATCH}），
 * 所以**队列顺序就是用户等待顺序**。若把预取区的格子与视口内的格子一视同仁地 FIFO 排队，
 * 用户正看着的那几张会排在「下一屏还没滚到的」后面 —— 表现为「滚到哪儿哪儿都在转圈」。
 *
 * 判据用 `getBoundingClientRect()` 与滚动容器的矩形相交，而不是 `entry.intersectionRatio`：
 * IO 的 ratio 是相对**加了 rootMargin 的扩展矩形**算的，在预取区里也是 1，区分不出来。
 * @param el - 媒体占位格。
 * @param root - 滚动容器（`null` 时退回视口）。
 * @returns 与容器矩形相交则为 true。
 */
function isInViewport(el: HTMLElement, root: HTMLElement | null): boolean {
  const r = el.getBoundingClientRect()
  const box = root ? root.getBoundingClientRect() : { top: 0, bottom: window.innerHeight }
  return r.bottom > box.top && r.top < box.bottom
}

/**
 * 把一批刚相交的媒体格子按「视口内 / 预取区」分派进队列。
 *
 * 视口内的**插队到队首**，预取区的追加到队尾。理由见 {@link isInViewport}。
 *
 * 同一批 entries 里先收集再入队：IO 一次回调可能带多个格子，逐个 `unshift` 会把
 * 顺序**倒过来**（后 unshift 的排更前），而 DOM 顺序才是用户从上往下看的顺序。
 *
 * 独立成函数而不是内联在 hook 里：hook 紧贴 `function-size-ratchet` 的 250 行线。
 * @param entries - IO 回调给的相交项。
 * @param specOf - 按 key 查媒体请求描述。
 * @param active - 已在队列、请求中或等待重试的键（本函数会就地累加）。
 * @param fetched - 已登记的键（本函数会就地累加）。
 * @param queue - 待办队列（本函数会就地插入）。
 * @param root - 滚动容器。
 * @returns 是否真的入队了（调用方据此决定要不要触发 drain）。
 */
export function enqueueIntersecting(
  entries: readonly IntersectionObserverEntry[],
  specOf: Map<string, MediaKeySpec>,
  fetched: Set<string>,
  active: Set<string>,
  queue: React.MutableRefObject<Array<{ key: string } & MediaKeySpec>>,
  root: HTMLElement | null,
): boolean {
  const urgent: Array<{ key: string } & MediaKeySpec> = []
  const lazy: Array<{ key: string } & MediaKeySpec> = []
  for (const e of entries) {
    if (!e.isIntersecting) continue
    const el = e.target as HTMLElement
    const key = el.dataset.snsKey || ''
    if (!key || active.has(key) || fetched.has(key)) continue
    const spec = specOf.get(key)
    if (!spec) continue
    active.add(key)
    fetched.add(key)
    ;(isInViewport(el, root) ? urgent : lazy).push({ key, ...spec })
  }
  if (urgent.length === 0 && lazy.length === 0) return false
  // `unshift(...urgent)` 保持 urgent 内部顺序（DOM 顺序 = 用户从上往下看的顺序）。
  if (urgent.length > 0) queue.current.unshift(...urgent)
  if (lazy.length > 0) queue.current.push(...lazy)
  // 队列与 spec 表保持同一上界。被挤掉的是最远的预取项：撤回去重标记，
  // 下次滚到它时还会重新入队，而不是永久记为「已取过」。
  if (queue.current.length > MOMENTS_MEDIA_QUEUE_MAX) {
    for (const dropped of queue.current.splice(MOMENTS_MEDIA_QUEUE_MAX)) {
      active.delete(dropped.key)
      fetched.delete(dropped.key)
    }
  }
  return true
}

/**
 * 取图失败后**延迟**放回队列，而不是立即 `push`。
 *
 * ## 为什么必须延迟（2026-10-16 真机实测）
 *
 * 立即放回是忙等：`drainMedia` 的 `while` 循环会马上把这一条连同下一批一起再发，
 * 而后端重活车道只有「1 个在跑 + 4 个排队」（`src/backend/http-queue.js` 的
 * `HEAVY_QUEUE_MAX = 4`；`getSnsImageDataUrl` 在 `remote-policy.js` 的 `HEAVY_CALL_LEDGER` 里）。
 * 于是失败 → 立即重发 → 再失败，形成 `REMOTE_BUSY` 风暴：日志被
 * `重任务排队已满（已有 1 个在跑、4 个在排队）` 刷屏，严重时渲染进程崩溃
 * （`[render-process-gone] {"reason":"crashed"}`）。
 *
 * `MEDIA_RETRY_DELAY_MS` 这个常量此前**定义了却从未使用**（注释写着"间隔 1.5s，不忙等"，
 * 实现却是立即放回）—— 这里把它接上：等 1.5s 让后端队列排空，再放回并重新触发 drain。
 *
 * 独立成函数而不是内联在 hook 里：hook 紧贴 `function-size-ratchet` 的 250 行线。
 *
 * @param it - 失败的那条媒体请求。
 * @param queue - 待办队列（放回它）。
 * @param active - 正在排队、请求中或等待重试的键。
 * @param fetched - 已登记的媒体键。
 * @param unmounted - 组件是否已卸载（卸载后早退，避免后台自激）。
 * @param timers - 延迟 timer 集合。
 * @param drain - 重新触发排空的回调。
 */
export function requeueAfterDelay(
  it: { key: string } & MediaKeySpec,
  queue: React.MutableRefObject<Array<{ key: string } & MediaKeySpec>>,
  active: Set<string>,
  fetched: Set<string>,
  unmounted: React.MutableRefObject<boolean>,
  timers: React.MutableRefObject<Set<number>>,
  drain: () => void,
): void {
  const timer = window.setTimeout(() => {
    timers.current.delete(timer)
    if (unmounted.current) return
    if (queue.current.length >= MOMENTS_MEDIA_QUEUE_MAX) {
      // 单次定时器策略：淘汰队尾预取项后立即让重试项入队，不递归续期制造 timer 峰值。
      const dropped = queue.current.pop()
      if (dropped && dropped.key !== it.key) {
        active.delete(dropped.key)
        fetched.delete(dropped.key)
      }
    }
    // 重试优先于新到的预取项，避免刚回到队列又被尾部截断。
    queue.current.unshift(it)
    drain()
  }, MEDIA_RETRY_DELAY_MS)
  timers.current.add(timer)
}

/** `useMomentsMedia` 的输入。 */
export interface MomentsMediaInput {
  moments: readonly MomentItem[]
  viewer: ViewerState | null
  /**
   * 滚动容器。由面板持有并注入：虚拟化要在**建虚拟器之前**拿到它（`getScrollElement`），
   * 而媒体层的窗口补查又依赖虚拟窗口 —— 让 hook 自己造这个 ref 就会绕成环。
   */
  scrollRef: React.MutableRefObject<HTMLDivElement | null>
  /**
   * 当前渲染的分组（虚拟化之后是"视口附近那几组"）。
   */
  groups: readonly unknown[]
  /**
   * 详情浮层当前那条动态的 tid（浮层关闭时为空串）。
   *
   * 为什么要单独一个信号：详情浮层与灯箱都 portal 到 `document.body`，浮层里的评论图格子
   * 只在**打开浮层那一刻**才出现在 DOM 里，而列表本身（`moments`）并没有变 ⇒ 只依赖
   * `moments` 的那次补观察永远扫不到它们，评论图就一直不取图（恒显示 [图]）。
   */
  detailKey: string
  /**
   * 渲染窗口的指纹（虚拟化：窗口一动就重新观察一遍新挂载的占位块）。
   * 原先这里传的是"渐进窗口已渲染到第几组"，虚拟化之后渲染的是一个**区间**，
   * 所以改成一个只要变化就能代表"DOM 换了一批元素"的键（面板传 `首下标-尾下标`）。
   */
  renderKey: string
}

/**
 * 重活 RPC 的串行车道（2026-10-19 修 REMOTE_BUSY）。
 *
 * 后端 `http-queue.js` 的重活车道只有 1 个运行位 + 4 个排队位；朋友圈一屏多张图同时
 * 请求时，缺 CDN 三件套的那些会落进重活车道，排队一满就 `REMOTE_BUSY`（真机日志
 * 「重任务排队已满（已有 1 个在跑、4 个在排队）」）。这里把可能走重活车道的请求串成
 * 一条链：一次只有 1 个在飞，其余在本地排队，不再把后端队列塞满。
 *
 * 注意：串行的是 RPC，不是渲染 —— 已经命中的 IndexedDB 原图不会进这条链。
 * @param cancelled - 执行前读取的取消标记。
 * @returns 串行执行器。
 */
export function createCancellableHeavyRpcLane(
  cancelled: () => boolean,
): <T>(task: () => Promise<T>) => Promise<T> {
  let chain: Promise<void> = Promise.resolve()
  return <T,>(task: () => Promise<T>): Promise<T> => {
    const invoke = (): Promise<T> => {
      if (cancelled()) return Promise.reject(new Error('朋友圈媒体请求已取消'))
      return task()
    }
    const run = chain.then(invoke, invoke)
    chain = run.then(() => undefined, () => undefined)
    return run
  }
}

/**
 * 这条媒体 RPC 会不会进后端重活车道（决定是否要串行）。
 *
 * 判据与 `call-priority.js` 的 `downgradeHeavyByArgs` 对齐：视频封面恒重；图片只有
 * 「在线 + CDN 三件套齐」才会被降到普通车道，其余都按重活处理。
 * @param item - 媒体请求。
 * @param offline - 当前是否无网。
 * @returns true = 需要走串行车道。
 */
function needsHeavyRpcLane(item: MediaKeySpec, offline: boolean): boolean {
  if (item.kind === 'video' || offline) return true
  return !(typeof item.url === 'string' && item.url !== ''
    && typeof item.token === 'string' && item.token !== ''
    && typeof item.seed === 'string' && item.seed !== '')
}

function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false
}

function mergeSnsImageEntries(current: SnsImageEntries, incoming: SnsImageEntries): SnsImageEntries {
  let next = current
  let changed = false
  for (const [key, entry] of Object.entries(incoming)) {
    const previous = next[key]
    // 原图不能被迟到的缩略图降级；这是网格与灯箱并发回包时最容易出现的覆盖。
    if (previous?.original === true && !entry.original) continue
    if (previous?.url === entry.url && previous.original === entry.original) continue
    if (!changed) {
      next = { ...current }
      changed = true
    }
    next[key] = entry
  }
  return changed ? capRecord(next, SNS_IMG_CACHE_MAX) : current
}

function imageUrlsOf(entries: SnsImageEntries): Record<string, string> {
  return Object.fromEntries(Object.entries(entries).map(([key, entry]) => [key, entry.url]))
}

function originalKeysOf(entries: SnsImageEntries): ReadonlySet<string> {
  return new Set(Object.entries(entries)
    .filter(([, entry]) => entry.original)
    .map(([key]) => key))
}

interface SnsOriginalResolverDeps {
  current: (key: string) => SnsImageEntry | undefined
  commit: (key: string, url: string, original: boolean) => void
  alive: () => boolean
  runHeavy: <T>(task: () => Promise<T>) => Promise<T>
}

/**
 * 原图请求的身份。不能只用 md5：同一张图第一次可能只有普通三件套，随后
 * 归档 payload 才补上 `<uhd>`/`<size>`。这些字段一变就应允许重新回源，
 * 否则早先一次缩略图结果会把补齐后的高清元数据永久挡住。
 */
function snsOriginalAttemptKey(image: ViewerImage): string {
  return JSON.stringify([
    imgKey(image),
    image.md5 ?? '',
    image.timelineId ?? '',
    image.id ?? image.mediaId ?? '',
    image.url ?? '',
    image.token ?? '',
    image.seed ?? image.key ?? '',
    image.originalWidth ?? 0,
    image.originalHeight ?? 0,
    image.originalBytes ?? 0,
    image.uhdUrl ?? '',
    image.uhdToken ?? '',
    image.uhdSeed ?? '',
  ])
}

/**
 * 为灯箱创建一次性的原图解析器。
 *
 * 与网格的 `snsFetched` 完全分开：网格写过缩略图只代表「有图可显示」，不阻塞这里回源。
 * `attempted` 是失败闸门——原图请求失败后只回退当前缩略图，自动渲染或重试都不会无限打后端。
 */
export function createSnsOriginalResolver(
  deps: SnsOriginalResolverDeps,
): (image: ViewerImage) => Promise<string> {
  // 用户可能看很多张；失败闸门跟媒体键表同界，避免长时间浏览后无界增长。
  const attempted = new BoundedMediaSet<string>(MOMENTS_MEDIA_KEY_CACHE_MAX)
  const inflight = new Map<string, Promise<string>>()
  // 只回退已经解出来的本地图；`image.thumb` 是 CDN 密文地址，不能交给灯箱渲染。
  const fallbackOf = (key: string): string => deps.current(key)?.url ?? ''

  return async (image: ViewerImage): Promise<string> => {
    const key = imgKey(image)
    if (key === '') throw new Error('缺少朋友圈图片标识，无法取原图')
    const known = deps.current(key)
    if (known?.original === true) return known.url
    const attemptKey = snsOriginalAttemptKey(image)
    const pending = inflight.get(attemptKey)
    if (pending !== undefined) return pending
    const fallback = fallbackOf(key)
    if (attempted.has(attemptKey)) {
      if (fallback !== '') return fallback
      throw new Error('朋友圈原图已尝试获取，本次不再自动重试')
    }
    attempted.add(attemptKey)

    const task = (async (): Promise<string> => {
      const cached = await snsMediaCacheGet(key, true)
      if (cached !== null) {
        if (!deps.alive()) throw new Error('朋友圈媒体请求已取消')
        deps.commit(key, cached, true)
        return cached
      }
      const offline = isOffline()
      const options = buildSnsImageRequestOptions(image, offline)
      const request = (): ReturnType<typeof apiGetSnsImageDataUrl> => apiGetSnsImageDataUrl(options)
      const spec: MediaKeySpec = {
        md5: options.md5,
        kind: 'img',
        ...(options.url !== undefined ? { url: options.url } : {}),
        ...(options.token !== undefined ? { token: options.token } : {}),
        ...(options.seed !== undefined ? { seed: options.seed } : {}),
      }
      const result = needsHeavyRpcLane(spec, offline)
        ? await deps.runHeavy(request)
        : await request()
      if (!deps.alive()) throw new Error('朋友圈媒体请求已取消')
      if (!result.url) throw new Error(result.error ?? '后端未返回原图')
      const original = result.thumb !== true
      deps.commit(key, result.url, original)
      void snsMediaCacheSet(key, result.url, !original)
      if (original) return result.url
      const best = deps.current(key)
      return best?.original === true ? best.url : result.url
    })().catch((error: unknown): string => {
      const fallback = fallbackOf(key)
      if (fallback !== '') return fallback
      throw error
    }).finally(() => {
      inflight.delete(attemptKey)
    })
    inflight.set(attemptKey, task)
    return task
  }
}

function useArticleCoverFallback(
  moments: readonly MomentItem[],
  snsImgs: Record<string, string>,
  unmountedRef: React.MutableRefObject<boolean>,
): Record<string, string> {
  const [articleCovers, setArticleCovers] = useState<Record<string, string>>({})
  // `snsImgs` 每次有新图上屏都会换对象；它只用于判断本机是否已有封面，
  // 不能进 effect 依赖，否则一屏图片陆续完成时会把正在进行的封面请求反复取消。
  const snsImgsRef = useRef(snsImgs)
  snsImgsRef.current = snsImgs
  const attempts = useRef<Map<string, number>>(new BoundedMediaMap(MOMENTS_COVER_ATTEMPT_MAX))
  const inflight = useRef<Set<string>>(new BoundedMediaSet(MOMENTS_COVER_ATTEMPT_MAX))
  const retryTimer = useRef<number | null>(null)
  const [coverTick, setCoverTick] = useState(0)

  const scheduleRetry = useCallback((): void => {
    if (unmountedRef.current || retryTimer.current !== null) return
    retryTimer.current = window.setTimeout(() => {
      retryTimer.current = null
      if (!unmountedRef.current) setCoverTick(t => t + 1)
    }, 2500)
  }, [unmountedRef])

  useEffect(() => () => {
    if (retryTimer.current !== null) window.clearTimeout(retryTimer.current)
  }, [])

  useEffect(() => {
    const todo = pendingCovers(moments, snsImgsRef.current, articleCovers, attempts.current, inflight.current)
    if (todo.length === 0) return
    let cancelled = false
    const run = async (): Promise<void> => {
      for (let i = 0; i < todo.length; i += COVER_BATCH) {
        if (cancelled || unmountedRef.current) return
        const batch = todo.slice(i, i + COVER_BATCH)
        for (const url of batch) {
          inflight.current.add(url)
          attempts.current.set(url, (attempts.current.get(url) ?? 0) + 1)
        }
        try {
          const r = await apiGetArticleCovers({ urls: batch })
          if (unmountedRef.current) return
          if (cancelled) {
            for (const url of batch) inflight.current.delete(url)
            setCoverTick(t => t + 1)
            return
          }
          const found: Record<string, string> = {}
          let missed = false
          for (const it of r.items ?? []) {
            if (it.dataUrl) found[it.url] = it.dataUrl
            else missed = true
          }
          if (Object.keys(found).length > 0) {
            setArticleCovers(prev => capRecord({ ...prev, ...found }, ARTICLE_COVER_CACHE_MAX))
          }
          if (missed) scheduleRetry()
        } catch {
          if (unmountedRef.current) return
          if (cancelled) {
            for (const url of batch) inflight.current.delete(url)
            setCoverTick(t => t + 1)
          } else {
            scheduleRetry()
          }
        } finally {
          for (const url of batch) inflight.current.delete(url)
        }
      }
    }
    void run()
    return () => { cancelled = true }
  }, [moments, articleCovers, coverTick, scheduleRetry, unmountedRef])

  return articleCovers
}

function useRestoreCachedSnsImages(
  moments: readonly MomentItem[],
  snsFetched: React.MutableRefObject<Set<string>>,
  commit: (entries: SnsImageEntries) => void,
): void {
  useEffect(() => {
    const keys = collectMediaKeys(moments)
      .filter((k) => !snsFetched.current.has(k))
      .slice(0, SNS_IMG_RESTORE_MAX)
    if (keys.length === 0) return
    let cancelled = false
    void snsMediaCacheGetMany(keys, true).then((cached) => {
      if (cancelled) return
      const found = Object.keys(cached)
      if (found.length === 0) return
      for (const k of found) snsFetched.current.add(k)
      commit(Object.fromEntries(found.map((key) => [key, { url: cached[key] as string, original: true }])))
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [moments, snsFetched, commit])
}

/**
 * 朋友圈媒体层钩子：滚动懒解密 + 封面兜底 + IDB 恢复 + 灯箱按需解析。
 * @param input - 见 {@link MomentsMediaInput}。
 * @returns 面板与卡片要用的两份状态与一个引用。
 */
export function useMomentsMedia(input: MomentsMediaInput): {
  snsImgs: Record<string, string>
  /** 已确认是原图的键；`snsImgs` 里其余值可能只是缩略图。 */
  snsOriginals: ReadonlySet<string>
  articleCovers: Record<string, string>
  mediaKeySpec: React.MutableRefObject<Map<string, MediaKeySpec>>
  /** 取图**失败**的原因（key → 后端给的原因）。空对象 = 没有失败。 */
  snsErrs: Record<string, string>
  /** 灯箱专用：按原图语义取图；失败时返回当前缩略图。 */
  resolveSnsOriginal: (image: ViewerImage) => Promise<string>
} {
  const { moments, viewer, scrollRef, groups, renderKey, detailKey } = input
  const [snsImageEntries, setSnsImageEntries] = useState<SnsImageEntries>({})
  const snsImageEntriesRef = useRef(snsImageEntries)
  snsImageEntriesRef.current = snsImageEntries
  const snsImgs = useMemo(() => imageUrlsOf(snsImageEntries), [snsImageEntries])
  const snsOriginals = useMemo(() => originalKeysOf(snsImageEntries), [snsImageEntries])
  /** 已在队列、请求中或等待重试的键；snsFetched 淘汰时必须跳过这些保护项。 */
  const mediaActive = useRef<Set<string>>(new Set())
  /** 已经取过（或已经决定不再取）的键 —— 去重靠它，别改成 state（每次 render 都换身份会让效果重跑）。 */
  const snsFetched = useRef<Set<string>>(
    new BoundedMediaSet(MOMENTS_MEDIA_KEY_CACHE_MAX, () => mediaActive.current),
  )

  const mediaKeySpec = useRef<Map<string, MediaKeySpec>>(new BoundedMediaMap(MOMENTS_MEDIA_KEY_CACHE_MAX))
  const mediaQueue = useRef<Array<{ key: string } & MediaKeySpec>>([])
  const mediaFetching = useRef(false)
  const mediaObserved = useRef<IntersectionObserver | null>(null)
  /** 只属于当前挂载实例的重试计数；与媒体键表同界，卸载即释放。 */
  const mediaRetryCount = useRef<Map<string, number>>(new BoundedMediaMap(MOMENTS_MEDIA_KEY_CACHE_MAX))
  /** 延迟重试的 timer；卸载时必须主动清掉，回调闭包不能继续持有面板与队列。 */
  const mediaRetryTimers = useRef<Set<number>>(new Set())
  /** 组件是否已卸载：延迟重试的 `setTimeout` 回调据此早退，避免卸载后自激（见 catch 分支）。 */
  const mediaUnmounted = useRef(false)
  /** 重活 RPC 串行链：一次只发一个，且卸载后跳过尚未开始的排队任务。 */
  const runHeavyRpc = useRef(createCancellableHeavyRpcLane(() => mediaUnmounted.current)).current
  const commitSnsImages = useCallback((incoming: SnsImageEntries): void => {
    const next = mergeSnsImageEntries(snsImageEntriesRef.current, incoming)
    if (next === snsImageEntriesRef.current) return
    snsImageEntriesRef.current = next
    setSnsImageEntries(next)
  }, [])
  const resolveSnsOriginal = useRef(createSnsOriginalResolver({
    current: (key) => snsImageEntriesRef.current[key],
    commit: (key, url, original) => { commitSnsImages({ [key]: { url, original } }) },
    alive: () => !mediaUnmounted.current,
    runHeavy: runHeavyRpc,
  })).current
  const articleCovers = useArticleCoverFallback(moments, snsImgs, mediaUnmounted)
  useRestoreCachedSnsImages(moments, snsFetched, commitSnsImages)

  const drainMedia = async (): Promise<void> => {
    if (mediaFetching.current) return
    mediaFetching.current = true
    try {
      while (mediaQueue.current.length > 0) {
        if (mediaUnmounted.current) return
        const batch = mediaQueue.current.splice(0, MEDIA_BATCH)
        const offline = isOffline()
        await Promise.all(batch.map(async (it) => {
          if (mediaUnmounted.current) return
          const imageOpts = buildSnsImageRequestOptions(it, offline)
          const videoOpts = {
            md5: it.md5,
            ...(it.timelineId ? { timelineId: it.timelineId } : {}),
            ...(it.mediaId ? { mediaId: it.mediaId } : {}),
            ...(it.seed ? { key: it.seed } : {}),
            ...(it.thumb ? { thumb: it.thumb } : {}),
            offline,
          }
          // 本地优先（2026-10-19 用户口径）：先查 IndexedDB 里的**原图**（`wantOriginal`
          // 会把缩略图当未命中）。命中就直接显示、不再出网；只有本地确实没有原图才走
          // 后端（后端同样先查长期归档/本机，最后才 CDN）。
          try {
            const cached = await snsMediaCacheGet(it.key, true)
            if (mediaUnmounted.current) return
            if (cached) {
              // 逐条上屏，不能等 `Promise.all` 全部结束：同一批里只要有一张 RPC 卡住，
              // 其余几张**已经命中的本地原图**也会一起被压住（真机实测：IDB 里明明有
              // 3 张，界面却一直显示「正在取原图」）。
              commitSnsImages({ [it.key]: { url: cached, original: true } })
              setSnsErrs(prev => { const next = { ...prev }; delete next[it.key]; return next })
              mediaActive.current.delete(it.key)
              mediaRetryCount.current.delete(it.key)
              return
            }
            // 重活车道判定：视频恒重；图片只有「在线 + CDN 三件套齐」才走普通车道，其余串行。
            const needsHeavyLane = needsHeavyRpcLane(it, offline)
            const rpc = () => (it.kind === 'video'
              ? apiGetSnsVideoCoverDataUrl(videoOpts)
              : apiGetSnsImageDataUrl(imageOpts))
            const r = needsHeavyLane ? await runHeavyRpc(rpc) : await rpc()
            if (mediaUnmounted.current) return
            if (r.url) {
              const original = r.thumb !== true
              commitSnsImages({ [it.key]: { url: r.url, original } })
              setSnsErrs(prev => { const next = { ...prev }; delete next[it.key]; return next })
              // 把「这次是不是缩略图」一起存下去：后端降级给缩略图时标上，
              // 下一轮就能跳过它去换原图（而不是把缩略图当成最终结果永久缓存）。
              void snsMediaCacheSet(it.key, r.url, !original)
              mediaActive.current.delete(it.key)
              mediaRetryCount.current.delete(it.key)
            } else {
              // 后端**给了原因**（`{ url?, error? }`），原实现把它丢掉了 ⇒ 这里带上原因再抛
              throw new Error(r.error ?? '后端未返回图片地址')
            }
          } catch (e) {
            if (mediaUnmounted.current) return
            /**
             * 不再静默：暂时性失败（文件正在写 / 刚建 hardlink / 这一次超时）**放回队列再试**，
             * 最多 `MEDIA_RETRY_MAX` 次；超限才记录**具体原因**。
             * 用户看到的不该是"无解释的空白"。
             */
            const n = (mediaRetryCount.current.get(it.key) ?? 0) + 1
            mediaRetryCount.current.set(it.key, n)
            if (n <= MEDIA_RETRY_MAX) {
              // 延迟放回（理由见 `requeueAfterDelay` 的文件头）：立即放回会形成 REMOTE_BUSY 风暴。
              requeueAfterDelay(
                it,
                mediaQueue,
                mediaActive.current,
                snsFetched.current,
                mediaUnmounted,
                mediaRetryTimers,
                () => { void drainMedia() },
              )
            } else {
              const reason = (e as Error).message
              // 永久失败也不保留计数：这一条不会再自动重试，留着只会随失败媒体数无界增长。
              mediaActive.current.delete(it.key)
              mediaRetryCount.current.delete(it.key)
              console.warn('[moments-media] 取图失败（已重试 ' + String(MEDIA_RETRY_MAX) + ' 次，放弃）:', it.key, reason)
              setSnsErrs(prev => capRecord({ ...prev, [it.key]: reason }, SNS_ERR_CACHE_MAX))
            }
          }
        }))
      }
    } finally {
      mediaFetching.current = false
    }
  }

  // 懒加载媒体：只有图片/视频封面的占位块接近视口时才解密（IntersectionObserver），
  // 避免一次性解密数百张离线图片造成卡顿；已取到的 data URL 通过 snsImgs 合入。
  useEffect(() => {
    // StrictMode 会 effect → cleanup → effect；重新 setup 必须恢复可重试状态。
    mediaUnmounted.current = false
    const cleanup = (): void => {
      mediaUnmounted.current = true
      for (const timer of mediaRetryTimers.current) window.clearTimeout(timer)
      mediaRetryTimers.current.clear()
      mediaRetryCount.current.clear()
    }
    if (typeof IntersectionObserver === 'undefined') {
      // 兜底：不支持 IO 时退回整页解密已挂载的媒体。
      const all = Array.from(mediaKeySpec.current.entries())
      for (const [key, spec] of all) {
        if (mediaQueue.current.length >= MOMENTS_MEDIA_QUEUE_MAX) break
        if (snsFetched.current.has(key) || mediaActive.current.has(key)) continue
        mediaActive.current.add(key)
        snsFetched.current.add(key)
        mediaQueue.current.push({ key, ...spec })
      }
      void drainMedia()
      return cleanup
    }
    const ob = new IntersectionObserver((entries) => {
      // 视口内的插队到队首、预取区的排到队尾（理由见 `enqueueIntersecting`）。
      if (enqueueIntersecting(
        entries,
        mediaKeySpec.current,
        snsFetched.current,
        mediaActive.current,
        mediaQueue,
        scrollRef.current,
      )) {
        void drainMedia()
      }
    }, { root: scrollRef.current, rootMargin: '480px 0px' })
    mediaObserved.current = ob
    return () => {
      ob.disconnect()
      mediaObserved.current = null
      cleanup()
    }
  }, [])

  /** 观察新出现的格子；为什么必须扫 `document`、为什么还要一个 `detailKey`，见 {@link sweepSnsKeys}。 */
  useEffect(() => {
    const ob = mediaObserved.current
    if (!ob || !scrollRef.current) return
    sweepSnsKeys(ob, snsFetched.current)
  }, [moments, detailKey])

  /**
   * 渲染窗口换了一批元素 ⇒ 重新观察一遍当前 DOM 里的媒体占位块。
   * 虚拟化之后每一行会反复挂载/卸载，所以这里**先 disconnect 再整批 observe**：
   * 观察器留着已卸载元素没有意义（它们永远不会再相交），而 `observe()` 对当前相交的
   * 元素会立刻补一次回调 —— 正好把"新挂载的这一批该解码"这条路走通。
   * 重复请求由 `snsFetched` 挡住，所以整批重观察不会把后端敲第二遍。
   */
  useEffect(() => {
    const root = scrollRef.current
    const ob = mediaObserved.current
    if (!root || !ob) return
    const cells = Array.from(root.querySelectorAll<HTMLElement>('[data-sns-key]'))
    ob.disconnect()
    for (const el of cells) ob.observe(el)
  }, [groups, renderKey])

  const viewerImage = viewer ? viewer.images[viewer.index] as ViewerImage | undefined : undefined
  const viewerRequestKey = viewerImage
    ? JSON.stringify([
        imgKey(viewerImage),
        viewerImage.md5 ?? '',
        viewerImage.timelineId ?? '',
        viewerImage.id ?? '',
        viewerImage.url ?? '',
        viewerImage.token ?? '',
        viewerImage.seed ?? viewerImage.key ?? '',
        viewerImage.thumb ?? '',
        viewerImage.originalWidth ?? 0,
        viewerImage.originalHeight ?? 0,
        viewerImage.originalBytes ?? 0,
        viewerImage.uhdUrl ?? '',
        viewerImage.uhdToken ?? '',
        viewerImage.uhdSeed ?? '',
      ])
    : ''
  const viewerKey = viewerImage ? imgKey(viewerImage) : ''
  // 「有图」不等于「原图」：网格可能只写进了 thumb。只有原图确认表能阻止灯箱回源。
  const viewerResolved = viewerKey !== '' && snsOriginals.has(viewerKey)

  // 灯箱当前图独立回源；网格的 snsFetched 只负责网格去重，不能挡住这里。
  useEffect(() => {
    const im = viewerImage
    if (!im) return
    if (viewerResolved) return
    void resolveSnsOriginal(im).catch(() => undefined)
  }, [viewerRequestKey, viewerResolved])

  /* 取图失败的原因（key → 后端给的原因）。**可加性**输出：调用方暂时可以不理会，
     下一条改动会在占位上把它显示出来（用户："朋友圈图片加载不出来" —— 不该只看到空白）。 */
  const [snsErrs, setSnsErrs] = useState<Record<string, string>>({})

  return { snsImgs, snsOriginals, articleCovers, mediaKeySpec, snsErrs, resolveSnsOriginal }
}
