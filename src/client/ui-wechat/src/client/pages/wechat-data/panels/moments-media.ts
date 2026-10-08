/**
 * 朋友圈的**离线媒体**层：懒解密、公众号封面兜底、IndexedDB 恢复、灯箱按需解析。
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
 * ## 取图口径：先网后本（2026-10-08 产品规则）
 *
 * **有网**时直接向微信 CDN 要 `/0` 那份**原图**显示，取回即由后端落盘；
 * **只有无网时**才用已下载的本地缓存（先 IndexedDB，再让后端走「已下载原图 → 微信原始目录」）。
 *
 * 因此有网时本模块**不做任何本地判断**：不查 IndexedDB 单张、不查 IndexedDB 批量恢复。
 * 少了这个约束，用户看到的会还是上一次那张（可能是缩略图、可能是旧的），而网络明明是通的 ——
 * 而且界面上看不出任何异常。
 *
 * 网络状态取自 `navigator.onLine`（与 `remote-img.tsx` 的离线短路同一个信号），由
 * {@link isOffline} 在**取图那一刻**读一次并随 RPC 传给后端。不做成 state：它变了不必
 * 重排已显示的图，而做成 state 会在断网瞬间把整屏图片重置成「正在取」。
 *
 * @module moments-media
 */
import { useEffect, useRef, useState } from 'react'
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
const mediaRetryCount = new Map<string, number>()
import type { ViewerState } from './moments-portals.tsx'

/**
 * 图片/视频的离线解码请求描述。
 * 定义在这里（而不是卡片里）：面板的钩子与卡片的 props 共用同一个形状，只有一份出处。
 */
export interface MediaKeySpec {
  /** 库里存的 CDN 地址（`http://…/0`）：给了就走 CDN 通路（见后端 `sns-cdn-image.ts`）。 */
  url?: string
  /** 媒体标签上的 `token`：CDN 必需（实测 `token+idx=1` 才 200）。 */
  token?: string
  md5: string
  timelineId?: string
  mediaId?: string
  kind: 'img' | 'video' | 'comment'
  seed?: string
  thumb?: string
}

/** 灯箱按需解析时用的最小图结构（与 `MomentsImageViewer` 传进来的形状兼容）。 */
type ViewerImage = { thumb?: string; url?: string; md5?: string; timelineId?: string; id?: string }

/** 一批出队解码的条数：太大一顿卡，太小把并发用不满。 */
const MEDIA_BATCH = 8

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
 * @param attempts - 各链接已试次数（会被本函数**就地累加**，与改前的行为一致）。
 * @returns 本轮要抓的链接列表。
 */
export function pendingCovers(
  moments: readonly MomentItem[],
  snsImgs: Record<string, string>,
  articleCovers: Record<string, string>,
  attempts: Map<string, number>,
): string[] {
  const todo: string[] = []
  for (const m of moments) {
    if (m.contentType !== 3 || !m.link_url) continue
    const cover = m.images[0]
    const localKey = cover ? imgKey(cover) : ''
    // 本机能解出就别去打网络（隐私闸门关着时这条尤其重要）。
    if (localKey && snsImgs[localKey]) continue
    if (articleCovers[m.link_url]) continue
    const attempt = attempts.get(m.link_url) ?? 0
    if (attempt >= 3) continue
    attempts.set(m.link_url, attempt + 1)
    todo.push(m.link_url)
  }
  return todo
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
   * 渲染窗口的指纹（虚拟化：窗口一动就重新观察一遍新挂载的占位块）。
   * 原先这里传的是"渐进窗口已渲染到第几组"，虚拟化之后渲染的是一个**区间**，
   * 所以改成一个只要变化就能代表"DOM 换了一批元素"的键（面板传 `首下标-尾下标`）。
   */
  renderKey: string
}

/**
 * 朋友圈媒体层钩子：滚动懒解密 + 封面兜底 + IDB 恢复 + 灯箱按需解析。
 * @param input - 见 {@link MomentsMediaInput}。
 * @returns 面板与卡片要用的两份状态与一个引用。
 */
export function useMomentsMedia(input: MomentsMediaInput): {
  snsImgs: Record<string, string>
  articleCovers: Record<string, string>
  mediaKeySpec: React.MutableRefObject<Map<string, MediaKeySpec>>
  /** 取图**失败**的原因（key → 后端给的原因）。空对象 = 没有失败。 */
  snsErrs: Record<string, string>
} {
  const { moments, viewer, scrollRef, groups, renderKey } = input
  const [snsImgs, setSnsImgs] = useState<Record<string, string>>({})
  /** 已经取过（或已经决定不再取）的键 —— 去重靠它，别改成 state（每次 render 都换身份会让效果重跑）。 */
  const snsFetched = useRef(new Set<string>())
  const [articleCovers, setArticleCovers] = useState<Record<string, string>>({})
  const coverAttempts = useRef<Map<string, number>>(new Map())
  const [coverTick, setCoverTick] = useState(0)

  const mediaKeySpec = useRef(new Map<string, MediaKeySpec>())
  const mediaQueue = useRef<Array<{ key: string } & MediaKeySpec>>([])
  const mediaFetching = useRef(false)
  const mediaObserved = useRef<IntersectionObserver | null>(null)

  /** 当前是否无网。读法与「为什么不做成 state」见文件头「先网后本」。 */
  const isOffline = (): boolean => typeof navigator !== 'undefined' && navigator.onLine === false

  const drainMedia = async (): Promise<void> => {
    if (mediaFetching.current) return
    mediaFetching.current = true
    try {
      while (mediaQueue.current.length > 0) {
        const batch = mediaQueue.current.splice(0, MEDIA_BATCH)
        const updates: Record<string, string> = {}
        const offline = isOffline()
        await Promise.all(batch.map(async (it) => {
          const opts: { md5: string; timelineId?: string; mediaId?: string; key?: string; thumb?: string; url?: string; token?: string; seed?: string; offline?: boolean } = {
    md5: it.md5,
    // 只给图片带 CDN 三件套（视频走另一个 RPC）；有才传 ⇒ 缺省时调用形状逐字不变
    ...(it.kind === 'img' && it.url ? { url: it.url } : {}),
    ...(it.kind === 'img' && it.token ? { token: it.token } : {}),
    ...(it.kind === 'img' && it.seed ? { seed: it.seed } : {}),
  }
          if (it.timelineId) opts.timelineId = it.timelineId
          if (it.mediaId) opts.mediaId = it.mediaId
          if (it.seed) opts.key = it.seed
          if (it.thumb) opts.thumb = it.thumb
          // 先网后本：有网时后端直接去 CDN 要原图并落盘，无网时才用已下载的本地缓存。
          opts.offline = offline
          try {
            // 有网时**不查**本地缓存（产品规则：有网直接取原图，先命中旧缓存就等于什么都没改）
            const cached = offline ? await snsMediaCacheGet(it.key, true) : null
            if (cached) { updates[it.key] = cached; return }
            const r = it.kind === 'video'
              ? await apiGetSnsVideoCoverDataUrl(opts)
              : await apiGetSnsImageDataUrl(opts)
            if (r.url) {
              updates[it.key] = r.url
              // 把「这次是不是缩略图」一起存下去：后端降级给缩略图时标上，
              // 下一轮就能跳过它去换原图（而不是把缩略图当成最终结果永久缓存）。
              void snsMediaCacheSet(it.key, r.url, r.thumb === true)
              mediaRetryCount.delete(it.key)
            } else {
              // 后端**给了原因**（`{ url?, error? }`），原实现把它丢掉了 ⇒ 这里带上原因再抛
              throw new Error(r.error ?? '后端未返回图片地址')
            }
          } catch (e) {
            /**
             * 不再静默：暂时性失败（文件正在写 / 刚建 hardlink / 这一次超时）**放回队列再试**，
             * 最多 `MEDIA_RETRY_MAX` 次；超限才记录**具体原因**。
             * 用户看到的不该是"无解释的空白"。
             */
            const n = (mediaRetryCount.get(it.key) ?? 0) + 1
            mediaRetryCount.set(it.key, n)
            if (n <= MEDIA_RETRY_MAX) {
              mediaQueue.current.push(it) // 放回队列 ⇒ 同一轮内再试（最多 2 次，不会死循环）
            } else {
              const reason = (e as Error).message
              console.warn('[moments-media] 取图失败（已重试 ' + String(MEDIA_RETRY_MAX) + ' 次，放弃）:', it.key, reason)
              setSnsErrs(prev => ({ ...prev, [it.key]: reason }))
            }
          }
        }))
        if (Object.keys(updates).length > 0) {
          setSnsImgs(prev => capRecord({ ...prev, ...updates }, SNS_IMG_CACHE_MAX))
          // 同一格后来成功了 ⇒ 清掉旧错误，避免"已经出图了还挂着失败提示"
          setSnsErrs(prev => {
            const next = { ...prev }
            for (const k of Object.keys(updates)) delete next[k]
            return next
          })
        }
      }
    } finally {
      mediaFetching.current = false
    }
  }

  // 懒加载媒体：只有图片/视频封面的占位块接近视口时才解密（IntersectionObserver），
  // 避免一次性解密数百张离线图片造成卡顿；已取到的 data URL 通过 snsImgs 合入。
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') {
      // 兜底：不支持 IO 时退回整页解密已挂载的媒体。
      const all = Array.from(mediaKeySpec.current.entries())
      for (const [key, spec] of all) {
        if (snsFetched.current.has(key)) continue
        snsFetched.current.add(key)
        mediaQueue.current.push({ key, ...spec })
      }
      void drainMedia()
      return
    }
    const ob = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue
        const el = e.target as HTMLElement
        const key = el.dataset.snsKey || ''
        if (!key || snsFetched.current.has(key)) continue
        const spec = mediaKeySpec.current.get(key)
        if (!spec) continue
        snsFetched.current.add(key)
        mediaQueue.current.push({ key, ...spec })
        void drainMedia()
      }
    }, { root: scrollRef.current, rootMargin: '480px 0px' })
    mediaObserved.current = ob
    return () => { ob.disconnect(); mediaObserved.current = null }
  }, [])

  /**
   * 观察新出现的格子（2026-10-08 修）。
   *
   * 现象：往下滚动时**新出现的朋友圈图片一直不出来**（旧的一屏正常）。
   * 原因：上面那个 effect 建好 IO 后**从未 `.observe()` 任何元素** —— 只有挂载那一刻已在 DOM 里的
   * 占位格会被观察，滚动进来（列表变长/虚拟化重建）的格子永远不入队、也就永远不解码。
   *
   * 依赖 `moments`：列表一变就在容器里补观察尚未取到的 `[data-sns-key]`（已取过的跳过，不重复观察）。
   */
  useEffect(() => {
    const ob = mediaObserved.current
    const root = scrollRef.current
    if (!ob || !root) return
    const nodes = root.querySelectorAll<HTMLElement>('[data-sns-key]')
    for (const el of Array.from(nodes)) {
      const key = el.dataset.snsKey || ''
      if (key !== '' && !snsFetched.current.has(key)) ob.observe(el)
    }
  }, [moments])

  /**
   * 公众号文章封面兜底：本地 SNS 缓存没有时，抓取文章页 og:image 转 data URL；
   * 失败后自动重试（最多 3 次），避免首次加载失败只能靠刷新才能显示。
   *
   * ## A1+A2（2026-09-28 性能修复）
   *
   * 改前是 `for (const url of todo) { void apiGetArticleCover({ contentUrl: url }) }`
   * —— **每个链接一个 RPC、且全部立刻发出**。现场日志据此得到「`getArticleCover` 1221 次
   * （占全部慢调用 73.6%）、均 1920ms」：一屏 30 篇就是 30 个并发 RPC，每个还要 2 次网络往返。
   *
   * 现在：① 走批量接口 `apiGetArticleCovers`（一次一屏）；② 分批发出，每批
   * {@link COVER_BATCH} 条，与前一条的 `drainMedia`/`MEDIA_BATCH` 同一范式 ——
   * 这样即使一次 refresh 命中很多链接，也不会形成瞬时并发尖峰。
   */
  useEffect(() => {
    const todo = pendingCovers(moments, snsImgs, articleCovers, coverAttempts.current)
    if (todo.length === 0) return
    let cancelled = false
    const retry = (): void => {
      // 组件已卸载（或 effect 已换轮）就别再排重试，否则会在后台无限自激。
      if (cancelled) return
      setTimeout(() => { if (!cancelled) setCoverTick(t => t + 1) }, 2500)
    }
    const run = async (): Promise<void> => {
      for (let i = 0; i < todo.length; i += COVER_BATCH) {
        if (cancelled) return
        const batch = todo.slice(i, i + COVER_BATCH)
        try {
          const r = await apiGetArticleCovers({ urls: batch })
          if (cancelled) return
          const found: Record<string, string> = {}
          let missed = false
          for (const it of r.items ?? []) {
            if (it.dataUrl) found[it.url] = it.dataUrl
            else missed = true
          }
          if (Object.keys(found).length > 0) {
            setArticleCovers(prev => capRecord({ ...prev, ...found }, ARTICLE_COVER_CACHE_MAX))
          }
          if (missed) retry()
        } catch {
          retry()
        }
      }
    }
    void run()
    return () => { cancelled = true }
  }, [moments, snsImgs, articleCovers, coverTick])

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

  // 进面板时从 IndexedDB 恢复已解密媒体：**只在无网时做**（有网时不该先拿旧缓存顶上，
  // 视口内那几张随后各自去后端要原图，取到后覆盖写回同一条记录）。理由见文件头。
  useEffect(() => {
    if (!isOffline()) return
    const keys = collectMediaKeys(moments)
      .filter((k) => !snsFetched.current.has(k))
    if (keys.length === 0) return
    void snsMediaCacheGetMany(keys, true).then((cached) => {
      const found = Object.keys(cached)
      if (found.length === 0) return
      for (const k of found) snsFetched.current.add(k)
      setSnsImgs(prev => capRecord({ ...prev, ...cached }, SNS_IMG_CACHE_MAX))
    })
  }, [moments])

  // 灯箱当前图离线解码缺失时按需解析（与卡片共用 key：md5 或 timelineId:mediaId）。
  useEffect(() => {
    const im = viewer ? viewer.images[viewer.index] as ViewerImage | undefined : undefined
    if (!im) return
    const key = imgKey(im)
    if (!key || snsImgs[key] || snsFetched.current.has(key)) return
    snsFetched.current.add(key)
    void apiGetSnsImageDataUrl({ md5: im.md5 || '', timelineId: im.timelineId, mediaId: im.id })
      .then((r) => {
        if (r.url) {
          setSnsImgs(prev => capRecord({ ...prev, [key]: r.url as string }, SNS_IMG_CACHE_MAX))
        }
      })
      .catch(() => { /* 保留 CDN 兜底 */ })
  }, [viewer, snsImgs])

  /* 取图失败的原因（key → 后端给的原因）。**可加性**输出：调用方暂时可以不理会，
     下一条改动会在占位上把它显示出来（用户："朋友圈图片加载不出来" —— 不该只看到空白）。 */
  const [snsErrs, setSnsErrs] = useState<Record<string, string>>({})

  return { snsImgs, articleCovers, mediaKeySpec, snsErrs }
}
