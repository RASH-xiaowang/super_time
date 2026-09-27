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
 * @module moments-media
 */
import { useEffect, useRef, useState } from 'react'
import type { MomentItem } from '@deepseek-ai/dsh-wechat-data/types'
import {
  apiGetArticleCover,
  apiGetSnsImageDataUrl,
  apiGetSnsVideoCoverDataUrl,
  snsMediaCacheGet,
  snsMediaCacheGetMany,
  snsMediaCacheSet,
} from '../api.ts'
import { capRecord } from '../utils/misc.ts'
import { ARTICLE_COVER_CACHE_MAX, SNS_IMG_CACHE_MAX, imgKey } from './moments-support.tsx'
import type { ViewerState } from './moments-portals.tsx'

/**
 * 图片/视频的离线解码请求描述。
 * 定义在这里（而不是卡片里）：面板的钩子与卡片的 props 共用同一个形状，只有一份出处。
 */
export interface MediaKeySpec {
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

  const drainMedia = async (): Promise<void> => {
    if (mediaFetching.current) return
    mediaFetching.current = true
    try {
      while (mediaQueue.current.length > 0) {
        const batch = mediaQueue.current.splice(0, MEDIA_BATCH)
        const updates: Record<string, string> = {}
        await Promise.all(batch.map(async (it) => {
          const opts: { md5: string; timelineId?: string; mediaId?: string; key?: string; thumb?: string } = { md5: it.md5 }
          if (it.timelineId) opts.timelineId = it.timelineId
          if (it.mediaId) opts.mediaId = it.mediaId
          if (it.seed) opts.key = it.seed
          if (it.thumb) opts.thumb = it.thumb
          try {
            const cached = await snsMediaCacheGet(it.key)
            if (cached) { updates[it.key] = cached; return }
            const r = it.kind === 'video'
              ? await apiGetSnsVideoCoverDataUrl(opts)
              : await apiGetSnsImageDataUrl(opts)
            if (r.url) { updates[it.key] = r.url; void snsMediaCacheSet(it.key, r.url) }
          } catch { /* 保留缩略图/CDN 兜底 */ }
        }))
        if (Object.keys(updates).length > 0) setSnsImgs(prev => capRecord({ ...prev, ...updates }, SNS_IMG_CACHE_MAX))
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

  // 公众号文章封面兜底：本地 SNS 缓存没有时，抓取文章页 og:image 转 data URL；
  // 失败后自动重试（最多 3 次），避免首次加载失败只能靠刷新才能显示。
  useEffect(() => {
    const todo = pendingCovers(moments, snsImgs, articleCovers, coverAttempts.current)
    for (const url of todo) {
      void apiGetArticleCover({ contentUrl: url })
        .then((r) => {
          if (r.url) {
            setArticleCovers(prev => capRecord({ ...prev, [url]: r.url as string }, ARTICLE_COVER_CACHE_MAX))
          } else {
            setTimeout(() => { setCoverTick(t => t + 1) }, 2500)
          }
        })
        .catch(() => {
          setTimeout(() => { setCoverTick(t => t + 1) }, 2500)
        })
    }
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

  // 进入面板时从 IndexedDB 恢复已解密媒体：命中即秒显，不再并发解密。
  useEffect(() => {
    const keys = collectMediaKeys(moments)
      .filter((k) => !snsFetched.current.has(k))
    if (keys.length === 0) return
    void snsMediaCacheGetMany(keys).then((cached) => {
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

  return { snsImgs, articleCovers, mediaKeySpec }
}
