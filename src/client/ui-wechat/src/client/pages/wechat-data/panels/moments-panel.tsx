/**
 * `Moments.tsx` 的「面板本体：MomentsPanel 的取数、筛选、媒体与视频加载、渲染」部分（M21 拆分）。
 *
 * 从原模块原样搬出，**行为逐字节不变**；原文件继续以 `export *` 转发
 * ⇒ 所有既有 import 一行都不用改。
 *
 * @module moments-panelx
 */

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ListSentinel, ListSkeleton, useProgressiveList, useTransientNotice } from './hooks.tsx'
import { readRenderCache, writeRenderCache } from '../api.ts'
import { useWechatDataUpdated } from './hooks.tsx'
import { apiDecryptAllDatabases, apiExportMoments, apiExportSnsVideo, apiGetArticleCover, apiGetAvatar, apiGetMoments, apiGetMomentsAuthors, apiGetMomentsMonthly, apiGetSelfUsername, apiGetSnsImageDataUrl, apiGetSnsVideoCoverDataUrl, apiGetSnsVideoDataUrl, apiOpenPath, apiSaveFileDialog, pickDirectory, snsMediaCacheGet, snsMediaCacheGetMany, snsMediaCacheSet } from '../api.ts'
import type { MomentItem, MomentsMonthlyRow } from '@deepseek-ai/dsh-wechat-data/types'
import { clickableKey, PanelHeader, SearchInput, useDialogFocus, useEscapeToClose } from '../ui/kit.tsx'
import { MomentsCard } from './moments-card.tsx'
import { MomentsSidebar } from './moments-sidebar.tsx'
import { MomentsDetail, MomentsExportDialog, MomentsImageViewer } from './moments-portals.tsx'
import { cacheBounded, capRecord } from '../utils/misc.ts'
import { cspSafeSrc } from '../utils/url.ts'
import css from './moments.module.css'
import kitCss from '../ui/kit.module.css'
import { ARTICLE_COVER_CACHE_MAX, MediaFilter, SNS_IMG_CACHE_MAX, VIDEO_SRC_CACHE_MAX, fmtSyncTime, groupByDate, imgKey } from './moments-support.tsx'

/**
 * Render the moments (朋友圈) panel.
 * @param props - optional author filter (from contact profile "TA 的朋友圈")
 *   and a callback to clear it.
 * @returns the moments element tree.
 */
export function MomentsPanel({ author, onClearAuthor }: { author?: string | null; onClearAuthor?: () => void }): React.JSX.Element {
  const [moments, setMoments] = useState<readonly MomentItem[]>([])
  const [search, setSearch] = useState('')
  const deferredSearch = useDeferredValue(search)
  const [mediaFilter, setMediaFilter] = useState<MediaFilter>('all')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [total, setTotal] = useState(0)
  const [monthlyData, setMonthlyData] = useState<ReadonlyArray<MomentsMonthlyRow>>([])
  const [privacy, setPrivacy] = useState(false)
  const [expandedTextByCard, setExpandedTextByCard] = useState<Set<string>>(new Set())
  const [expandedSocialByCard, setExpandedSocialByCard] = useState<Set<string>>(new Set())
  const [commentCounts, setCommentCounts] = useState<Record<string, number>>({})
  const [commentSortByCard, setCommentSortByCard] = useState<Record<string, 'asc' | 'desc'>>({})
  const [selfUsername, setSelfUsername] = useState<string | null>(null)
  const [fullAuthors, setFullAuthors] = useState<Array<{ name: string; count: number }> | null>(null)
  const [monthlyDataForAuthor, setMonthlyDataForAuthor] = useState<ReadonlyArray<MomentsMonthlyRow>>([])
  const [onlyMineComments, setOnlyMineComments] = useState(false)
  const [videoSrcs, setVideoSrcs] = useState<Record<string, string>>({})
  const [videoFailed, setVideoFailed] = useState<Set<string>>(new Set())
  /** 每个取视频失败的原因（悬停提示用），来自后端：未缓存 / CDN 加密流 / 出站被拦等。 */
  const [videoErr, setVideoErr] = useState<Map<string, string>>(new Map())
  /** 已播放视频的真实宽高比（`onLoadedMetadata` 填），播放器按它定尺寸以消除黑边。 */
  const [videoMeta, setVideoMeta] = useState<Record<string, { w: number; h: number }>>({})
  const videoFetching = useRef<Set<string>>(new Set())
  const [monthFilter, setMonthFilter] = useState<string | null>(null)
  const [mineFilter, setMineFilter] = useState<'all' | 'mine' | 'others'>('all')
  const [authorFilter, setAuthorFilter] = useState<string | null>(null)
  const [showAllAuthors, setShowAllAuthors] = useState(false)
  const [sortOrder, setSortOrder] = useState<'desc' | 'asc'>('desc')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [detail, setDetail] = useState<{ m: MomentItem } | null>(null)
  const [viewer, setViewer] = useState<{
    images: Array<{ thumb?: string; url?: string; md5?: string; timelineId?: string; id?: string }>
    index: number
    author: string
  } | null>(null)
  const [viewZoom, setViewZoom] = useState(1)
  const [viewPan, setViewPan] = useState({ x: 0, y: 0 })
  const [viewFailed, setViewFailed] = useState(false)
  const [viewRotate, setViewRotate] = useState(0)
  const [viewOriginal, setViewOriginal] = useState(false)
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null)
  const pinchRef = useRef<{ dist: number; zoom: number } | null>(null)
  const lightboxWrapRef = useRef<HTMLDivElement | null>(null)
  const viewZoomRef = useRef(1)
  const [exportOpen, setExportOpen] = useState(false)
  const [expFormat, setExpFormat] = useState('html')
  const [expFrom, setExpFrom] = useState('')
  const [expTo, setExpTo] = useState('')
  const [expDir, setExpDir] = useState('')
  const [expImages, setExpImages] = useState(false)
  const [expZip, setExpZip] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [lastSync, setLastSync] = useState(0)
  const [pickingDir, setPickingDir] = useState(false)
  const [exporting, setExporting] = useState(false)
  // 提示语自动消失（L20）：原手写的 3 处 `setTimeout(…, 6000)` 已由 hook 统一管理。
  // 复制结果与各类失败提示改前不带定时器（一直留着），所以走 hold 而不是 flash。
  const { notice, flash, hold, clear } = useTransientNotice(6000)
  const [exportedPath, setExportedPath] = useState<string | null>(null)
  const [snsImgs, setSnsImgs] = useState<Record<string, string>>({})
  const snsFetched = useRef(new Set<string>())
  const [articleCovers, setArticleCovers] = useState<Record<string, string>>({})
  const coverAttempts = useRef<Map<string, number>>(new Map())
  const [coverTick, setCoverTick] = useState(0)
  const [failedImgs, setFailedImgs] = useState<Set<string>>(new Set())
  const countRef = useRef(0)
  const totalRef = useRef(0)
  const [loadingAll, setLoadingAll] = useState(false)

  const load = useCallback(async (reset = true): Promise<void> => {
    setError(null)
    // 渲染缓存按“全量/该作者”上下文分开存储，避免刷新后串用上次过滤视图的缓存。
    const cacheKey = 'moments:' + (author || 'all')
    if (reset) {
      // 先用上次渲染的列表秒开,后台同步最新分页
      const cached = readRenderCache<readonly MomentItem[]>(cacheKey)
      if (cached && cached.length > 0) {
        setMoments(cached)
        countRef.current = cached.length
        setTotal(cached.length)
        setLoading(false)
      } else {
        setLoading(true)
      }
    }
    try {
      const opts: { limit: number; offset?: number; author?: string } = { limit: 500 }
      if (!reset) opts.offset = countRef.current
      if (author) opts.author = author
      const env = await apiGetMoments(opts)
      setMoments(prev => (reset ? env.moments : [...prev, ...env.moments]))
      countRef.current = reset ? env.moments.length : countRef.current + env.moments.length
      setTotal(env.total)
      totalRef.current = env.total
      if (reset) writeRenderCache(cacheKey, env.moments.slice(0, 200))
      // Full-history monthly distribution only on (re)load — not per page.
      if (reset) {
        void apiGetMomentsMonthly(author ? { author } : undefined)
          .then((rows) => { setMonthlyData(rows) })
          .catch(() => { /* fall back to frontend month aggregation */ })
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [author])

  useEffect(() => { void load() }, [load])

  // 拉取当前账号自己的 username，用于「仅看我的回复」。
  useEffect(() => {
    void apiGetSelfUsername().then((u) => { setSelfUsername(u || null) }).catch(() => { /* ignore */ })
  }, [])

  // 拉取全量作者条数（反映全量排名）。
  useEffect(() => {
    void apiGetMomentsAuthors().then((list) => { setFullAuthors(list) }).catch(() => { /* 回退已加载统计 */ })
  }, [])

  // 选中某作者（作者牌）时，按该作者重算「全部月份动态」；清除后回退到全量月度数据。
  useEffect(() => {
    if (!authorFilter) { setMonthlyDataForAuthor([]); return }
    let cancelled = false
    setMonthlyDataForAuthor([]) // 先清空，避免显示上一个作者的数据
    void apiGetMomentsMonthly({ authorName: authorFilter })
      .then((rows) => { if (!cancelled) setMonthlyDataForAuthor(rows) })
      .catch(() => { if (!cancelled) setMonthlyDataForAuthor([]) }) // 失败时也清空，触发 fallback 聚合
    return () => { cancelled = true }
  }, [authorFilter])

  /** 一次性拉取剩余全部朋友圈（每页 500 串行，避免压垮后端 XML 解析）。 */
  const loadAll = useCallback(async (): Promise<void> => {
    if (loadingAll) return
    setLoadingAll(true)
    setError(null)
    moreInFlight.current = true
    try {
      while (countRef.current < totalRef.current) {
        const opts: { limit: number; offset: number; author?: string } = { limit: 500, offset: countRef.current }
        if (author) opts.author = author
        const env = await apiGetMoments(opts)
        if (env.moments.length === 0) break
        setMoments(prev => [...prev, ...env.moments])
        countRef.current += env.moments.length
        totalRef.current = env.total
        setTotal(env.total)
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      moreInFlight.current = false
      setLoadingAll(false)
    }
  }, [author, loadingAll])

  // 数据落地后安静刷新：空列表时全量加载；已加载时做「增量刷新」——拉取最新一页，
  // 只把尚未出现过的新动态前插，不折叠已有列表（避免滚动大跳动）。
  useWechatDataUpdated(() => {
    if (moments.length === 0) { void load(); return }
    void (async () => {
      try {
        const env = await apiGetMoments({ limit: 200, author: author || undefined })
        const existing = new Set(moments.map(m => m.tid))
        const fresh = env.moments.filter(m => !existing.has(m.tid))
        if (fresh.length > 0) {
          setMoments(prev => [...fresh, ...prev])
          writeRenderCache('moments:' + (author || 'all'), [...fresh, ...moments].slice(0, 200))
        }
        setTotal(env.total)
        totalRef.current = env.total
      } catch { /* 增量刷新失败时静默，保持当前列表 */ }
    })()
  })

  // 懒加载媒体：只有图片/视频封面的占位块接近视口时才解密（IntersectionObserver），
  // 避免一次性解密数百张离线图片造成卡顿；已取到的 data URL 通过 snsImgs 合入。
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const mediaKeySpec = useRef(new Map<string, { md5: string; timelineId?: string; mediaId?: string; kind: 'img' | 'video' | 'comment'; seed?: string; thumb?: string }>())
  const mediaQueue = useRef<Array<{ key: string; md5: string; timelineId?: string; mediaId?: string; kind: 'img' | 'video' | 'comment'; seed?: string; thumb?: string }>>([])
  const mediaFetching = useRef(false)
  const mediaObserved = useRef<IntersectionObserver | null>(null)

  const drainMedia = async (): Promise<void> => {
    if (mediaFetching.current) return
    mediaFetching.current = true
    try {
      while (mediaQueue.current.length > 0) {
        const batch = mediaQueue.current.splice(0, 8)
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
    const todo: string[] = []
    for (const m of moments) {
      if (m.contentType !== 3 || !m.link_url) continue
      const cover = m.images[0]
      const localKey = cover ? imgKey(cover) : ''
      if (localKey && snsImgs[localKey]) continue
      if (articleCovers[m.link_url]) continue
      const attempt = coverAttempts.current.get(m.link_url) ?? 0
      if (attempt >= 3) continue
      coverAttempts.current.set(m.link_url, attempt + 1)
      todo.push(m.link_url)
    }
    for (const url of todo) {
      void apiGetArticleCover({ contentUrl: url })
        .then((r) => {
          if (r.url) {
            setArticleCovers(prev => capRecord({ ...prev, [url]: r.url ?? '' }, ARTICLE_COVER_CACHE_MAX))
          } else {
            setTimeout(() => { setCoverTick(t => t + 1) }, 2500)
          }
        })
        .catch(() => {
          setTimeout(() => { setCoverTick(t => t + 1) }, 2500)
        })
    }
  }, [moments, snsImgs, articleCovers, coverTick])

  // Search scope is intentionally broader than the legacy author/text/location set:
  // it also matches link title/url, 公众号 source, liker nicknames and comment text.
  const filtered = useMemo(() => {
    const q = deferredSearch.trim().toLowerCase()
    if (!q) return moments
    return moments.filter(m =>
      m.author.toLowerCase().includes(q)
      || m.text.toLowerCase().includes(q)
      || m.location.toLowerCase().includes(q)
      || m.link_title.toLowerCase().includes(q)
      || (m.link_url ?? '').toLowerCase().includes(q)
      || (m.sourceNickName ?? '').toLowerCase().includes(q)
      || (m.publicUserName ?? '').toLowerCase().includes(q)
      || m.likes.some(l => (l.nickname || l.username).toLowerCase().includes(q))
      || m.comments.some(c => (c.nickname || c.username).toLowerCase().includes(q) || c.content.toLowerCase().includes(q)))
  }, [moments, deferredSearch])

  const mediaFiltered = useMemo(() => {
    if (mediaFilter === 'all') return filtered
    return filtered.filter((m) => {
      switch (mediaFilter) {
        case 'image': return m.images.length > 0
        case 'video': return m.videos.length > 0
        case 'link': return !!m.link_title || m.contentType === 3 || m.contentType === 28
        case 'location': return !!m.location
        case 'text': return m.images.length === 0 && m.videos.length === 0 && !m.link_title
        default: return true
      }
    })
  }, [filtered, mediaFilter])

  // 独立作者筛选（作者 chips）：按显示名精确匹配，不污染搜索框。
  const authorScoped = useMemo(() => {
    if (!authorFilter) return mediaFiltered
    return mediaFiltered.filter(m => m.author === authorFilter)
  }, [mediaFiltered, authorFilter])

  // 只看我 / 只看他人 scope.
  const mineFiltered = useMemo(() => {
    if (mineFilter === 'all') return authorScoped
    return authorScoped.filter(m => (mineFilter === 'mine' ? m.is_self : !m.is_self))
  }, [authorScoped, mineFilter])

  // 月度时间导航：选中某个月时只看该月（基于 ts 的 YYYY-MM 键）。
  const monthFiltered = useMemo(() => {
    if (monthFilter === null) return mineFiltered
    return mineFiltered.filter((m) => {
      if (!m.ts) return false
      const d = new Date(m.ts * 1000)
      const k = String(d.getFullYear()) + '-' + String(d.getMonth() + 1).padStart(2, '0')
      return k === monthFilter
    })
  }, [mineFiltered, monthFilter])

  // 自由日期范围筛选（YYYY-MM-DD）。
  const dateScoped = useMemo(() => {
    const from = dateFrom ? Math.floor(new Date(dateFrom + 'T00:00:00').getTime() / 1000) : 0
    const to = dateTo ? Math.floor(new Date(dateTo + 'T23:59:59').getTime() / 1000) : 0
    if (!from && !to) return monthFiltered
    return monthFiltered.filter(m => (from <= 0 || m.ts >= from) && (to <= 0 || m.ts <= to))
  }, [monthFiltered, dateFrom, dateTo])

  // 时间排序（默认最新在前）；用了拷贝，避免原地改动 memos 返回的数组。
  const scoped = useMemo(() => {
    const arr = [...dateScoped]
    if (sortOrder === 'asc') arr.sort((a, b) => (a.ts || 0) - (b.ts || 0))
    else arr.sort((a, b) => (b.ts || 0) - (a.ts || 0))
    return arr
  }, [monthFiltered, sortOrder])

  const insight = useMemo(() => {
    const count = (p: (m: MomentItem) => boolean): number => moments.filter(p).length
    return {
      withImages: count(m => m.images.length > 0),
      withVideos: count(m => m.videos.length > 0),
      withLocation: count(m => !!m.location),
      withLink: count(m => !!m.link_title),
    }
  }, [moments])

  const topAuthors = useMemo<Array<[string, number]>>(() => {
    // 优先用全量作者条数（SQL 聚合，真实反映全量排名）；查询失败则回退到已加载子集统计。
    if (fullAuthors && fullAuthors.length > 0) return fullAuthors.slice(0, 20).map(a => [a.name, a.count])
    const map = new Map<string, number>()
    for (const m of moments) map.set(m.author, (map.get(m.author) ?? 0) + 1)
    return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
  }, [fullAuthors, moments])

  const monthly = useMemo(() => {
    // 选中作者时使用该作者的全量月度分布；否则用全量（或 prop 作者）的月度分布。
    const raw = authorFilter ? monthlyDataForAuthor : monthlyData
    if (raw.length > 0) {
      return [...raw].sort((a, b) => a.month.localeCompare(b.month)).map(m => ({ key: m.month, label: m.month, count: m.count }))
    }
    // Fallback: aggregate the currently-loaded page (e.g. monthly fetch failed).
    const map = new Map<string, number>()
    const scope = authorFilter ? moments.filter(m => m.author === authorFilter) : moments
    for (const m of scope) {
      if (!m.ts) continue
      const d = new Date(m.ts * 1000)
      const k = String(d.getFullYear()) + '-' + String(d.getMonth() + 1).padStart(2, '0')
      map.set(k, (map.get(k) ?? 0) + 1)
    }
    return [...map.keys()].sort().map(k => ({ key: k, label: k, count: map.get(k) ?? 0 }))
  }, [monthlyData, monthlyDataForAuthor, authorFilter, moments])
  const monthMax = Math.max(1, ...monthly.map(m => m.count))

  const groups = useMemo(() => groupByDate(scoped), [scoped])
  const { count: grpCount, sentinelRef: grpSentinel } = useProgressiveList(groups.length, 25)
  const moreRef = useRef<HTMLDivElement | null>(null)
  const moreInFlight = useRef(false)

  // 新渲染/新分组挂载后再观察对应的媒体占位块。
  useEffect(() => {
    const root = scrollRef.current
    const ob = mediaObserved.current
    if (!root || !ob) return
    root.querySelectorAll<HTMLElement>('[data-sns-key]').forEach((el) => {
      if (!el.dataset.snsObs) { el.dataset.snsObs = '1'; ob.observe(el) }
    })
  }, [groups, grpCount])


  // 进入面板时从 IndexedDB 恢复已解密媒体：命中即秒显，不再并发解密。
  useEffect(() => {
    const keys: string[] = []
    const seen = new Set<string>()
    for (const m of moments) {
      for (const im of m.images) {
        const k = imgKey(im)
        if (k && !seen.has(k) && !snsFetched.current.has(k)) { seen.add(k); keys.push(k) }
      }
      for (const v of m.videos) {
        const k = v.md5 ? 'v:' + v.md5 : (v.timelineId && v.id ? 'v:' + v.timelineId + ':' + v.id : '')
        if (k && !seen.has(k) && !snsFetched.current.has(k)) { seen.add(k); keys.push(k) }
      }
      for (const c of m.comments) {
        const k = c.image?.md5 || ''
        if (k && !seen.has(k) && !snsFetched.current.has(k)) { seen.add(k); keys.push(k) }
      }
    }
    if (keys.length === 0) return
    void snsMediaCacheGetMany(keys).then((cached) => {
      const found = Object.keys(cached)
      if (found.length === 0) return
      for (const k of found) snsFetched.current.add(k)
      setSnsImgs(prev => capRecord({ ...prev, ...cached }, SNS_IMG_CACHE_MAX))
    })
  }, [moments])


  // 滚动到底部附近时自动加载下一页朋友圈（懒加载分页）。
  useEffect(() => {
    const el = moreRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const ob = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting && !moreInFlight.current && moments.length < total) {
          moreInFlight.current = true
          void load(false).finally(() => { moreInFlight.current = false })
        }
      }
    }, { root: scrollRef.current, rootMargin: '400px 0px' })
    ob.observe(el)
    return () => { ob.disconnect() }
  }, [moments.length, total, load])
  const curImg = viewer ? viewer.images[viewer.index] : undefined

  // Reset lightbox transform/failed state whenever a viewer opens or its index moves.
  useEffect(() => {
    setViewZoom(1)
    setViewPan({ x: 0, y: 0 })
    setViewFailed(false)
    setViewRotate(0)
    setViewOriginal(false)
  }, [viewer])

  // Keep a ref mirror of the zoom for the native wheel listener (attached once per open).
  useEffect(() => { viewZoomRef.current = viewZoom }, [viewZoom])

  // Native non-passive wheel listener: React's onWheel is passive, so preventDefault
  // would be ignored letting the page scroll behind the lightbox; this suppresses it.
  useEffect(() => {
    const el = lightboxWrapRef.current
    if (!el || !viewer) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const cur = viewZoomRef.current
      const n = Math.min(5, Math.max(1, cur * (e.deltaY < 0 ? 1.1 : 0.9)))
      setViewZoom(n)
      if (n === 1) setViewPan({ x: 0, y: 0 })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => { el.removeEventListener('wheel', onWheel) }
  }, [viewer])

  // 灯箱当前图离线解码缺失时按需解析（与卡片共用 key：md5 或 timelineId:mediaId），并清除失败态。
  useEffect(() => {
    const im = viewer ? viewer.images[viewer.index] : undefined
    if (!im) return
    const key = imgKey(im)
    if (!key || snsImgs[key] || snsFetched.current.has(key)) return
    snsFetched.current.add(key)
    void apiGetSnsImageDataUrl({ md5: im.md5 || '', timelineId: im.timelineId, mediaId: im.id })
      .then((r) => {
        if (r.url) {
          setSnsImgs(prev => capRecord({ ...prev, [key]: r.url as string }, SNS_IMG_CACHE_MAX))
          setViewFailed(false)
        }
      })
      .catch(() => { /* 保留 CDN 兜底 */ })
  }, [viewer, snsImgs])

  // Keyboard control while the lightbox is open: arrows switch image（Esc 交给共享 hook）。
  useEffect(() => {
    if (!viewer) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowLeft') setViewer(v => (v ? { ...v, index: Math.max(0, v.index - 1) } : v))
      if (e.key === 'ArrowRight') setViewer(v => (v ? { ...v, index: Math.min(v.images.length - 1, v.index + 1) } : v))
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [viewer])

  // Esc 关闭走 kit 的共享栈：灯箱与详情同时打开时，一次 Esc 只关最上层（原来两个监听会一起关）
  useEscapeToClose(viewer !== null, () => { setViewer(null) })
  useEscapeToClose(detail !== null, () => { setDetail(null) })
  useEscapeToClose(exportOpen, () => { setExportOpen(false) })
  // 焦点管理：进入移入、Tab 循环、关闭还原（手写弹窗没有 Radix 的那套）
  useDialogFocus(viewer !== null, '[data-st-dialog="moments-viewer"]')
  useDialogFocus(detail !== null, '[data-st-dialog="moments-detail"]')
  useDialogFocus(exportOpen, '[data-st-dialog="moments-export"]')

  // Save the currently displayed image (data URL → download).
  const saveCurrentImage = (): void => {
    const src = (curImg && snsImgs[imgKey(curImg)]) || cspSafeSrc(curImg?.url, curImg?.thumb)
    if (!src) return
    let ext = 'jpg'
    const dataMatch = src.match(/^data:image\/(\w+)[;,]/)
    if (dataMatch) ext = dataMatch[1] === 'jpeg' ? 'jpg' : (dataMatch[1] ?? 'jpg')
    else {
      try {
        const path = new URL(src, location.href).pathname
        const seg = path.split('.').pop()?.toLowerCase() ?? ''
        if (/^[a-z0-9]{2,5}$/.test(seg)) ext = seg
      } catch { /* keep jpg */ }
    }
    const a = document.createElement('a')
    a.href = src
    a.download = 'moments-' + String(viewer?.index ?? 0) + '.' + ext
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  const setViewerIndex = (index: number): void => {
    setViewer(v => (v ? { ...v, index: Math.max(0, Math.min(v.images.length - 1, index)) } : v))
  }

  // Copy the currently displayed image's source (CDN url preferred, else data URL).
  const copyCurrentLink = (): void => {
    const src = cspSafeSrc(curImg?.url, curImg?.thumb) || (curImg && snsImgs[imgKey(curImg)]) || ''
    if (!src) return
    const clip = (navigator as { clipboard?: Clipboard }).clipboard
    if (clip && typeof clip.writeText === 'function') {
      void clip.writeText(src).then(() => { hold('已复制图片链接') }).catch(() => { /* clipboard denied */ })
    } else {
      hold('当前环境不支持复制')
    }
  }

  const openExport = (): void => { setExportOpen(true) }

  // Copy arbitrary text to the clipboard.
  const copyText = (text: string): void => {
    if (!text) return
    const clip = (navigator as { clipboard?: Clipboard }).clipboard
    if (clip && typeof clip.writeText === 'function') {
      void clip.writeText(text).then(() => { hold('已复制') }).catch(() => { /* clipboard denied */ })
    } else {
      hold('当前环境不支持复制')
    }
  }

  // 手动重新同步：触发宿主重解密并派发更新事件（面板随后刷新）。
  const doSync = async (): Promise<void> => {
    if (syncing) return
    setSyncing(true)
    clear()
    try {
      await apiDecryptAllDatabases()
      setLastSync(Date.now())
      window.dispatchEvent(new Event('dsh-wechat-data-updated'))
      void load()
      flash('已重新同步解密数据')
    } catch (e) {
      hold('同步失败: ' + (e as Error).message)
    } finally {
      setSyncing(false)
    }
  }

  const pickDir = async (): Promise<void> => {
    if (pickingDir) return
    setPickingDir(true)
    try {
      const dir = await pickDirectory()
      if (dir) setExpDir(dir)
    } finally {
      setPickingDir(false)
    }
  }

  const doExport = async (): Promise<void> => {
    setExporting(true)
    clear()
    try {
      const opts: {
        format: string
        username?: string
        authorName?: string
        q?: string
        images?: boolean
        media?: string
        month?: string
        mine?: string
        zip?: boolean
        from?: number
        to?: number
        dir?: string
      } = { format: expFormat }
      // username = 微信用户名（user_name，深链“TA 的朋友圈”）；authorName = 作者显示名（作者牌）。
      if (author) opts.username = author
      if (authorFilter) opts.authorName = authorFilter
      const term = search.trim()
      if (term) opts.q = term
      // 导出与列表当前筛选一致（媒体类型/月份/范围）。
      if (mediaFilter !== 'all') opts.media = mediaFilter
      if (monthFilter) opts.month = monthFilter
      if (mineFilter !== 'all') opts.mine = mineFilter
      if (expImages) opts.images = true
      if (expZip) opts.zip = true
      if (expFrom) opts.from = Math.floor(new Date(expFrom + 'T00:00:00').getTime() / 1000)
      if (expTo) opts.to = Math.floor(new Date(expTo + 'T23:59:59').getTime() / 1000)
      if (expDir) opts.dir = expDir
      const r = await apiExportMoments(opts)
      flash('已导出 ' + String(r.count) + ' 条动态 → ' + r.path)
      setExportedPath(r.path)
      setExportOpen(false)
    } catch (e) {
      hold('导出失败: ' + (e as Error).message)
    } finally {
      setExporting(false)
    }
  }

  // 视频本体：本地缓存优先（离线、最快）；没有缓存时后端会按朋友圈 XML 里的
  // <url> 从微信 CDN 按需取回，并校验取回的字节真的是 MP4 —— 实测 CDN 返回的是
  // 微信客户端加密流，所以不能把原始 URL 直接当 src（CSP 会拦，且那是密文）。
  const loadVideo = useCallback((vk: string, v: { md5?: string; timelineId?: string; id?: string; url?: string; key?: string }): void => {
    if (!vk || videoSrcs[vk] || videoFetching.current.has(vk)) return
    videoFetching.current.add(vk)
    void (async () => {
      try {
        const r = await apiGetSnsVideoDataUrl({ md5: v.md5, timelineId: v.timelineId, mediaId: v.id, url: v.url, key: v.key })
        if (r.url) {
          setVideoSrcs(prev => capRecord({ ...prev, [vk]: r.url as string }, VIDEO_SRC_CACHE_MAX))
        } else {
          setVideoFailed(prev => new Set(prev).add(vk))
          if (r.error) setVideoErr(prev => { const n = new Map(prev); n.set(vk, r.error as string); return n })
        }
      } catch (e) {
        setVideoFailed(prev => new Set(prev).add(vk))
        setVideoErr(prev => { const n = new Map(prev); n.set(vk, (e as Error).message); return n })
      } finally {
        videoFetching.current.delete(vk)
      }
    })()
  }, [videoSrcs])

  // 播放器按视频真实宽高比定尺寸：容器与画面同比例，`object-fit: contain` 就没有黑边
  // （早先是固定 280×180 的横框，竖屏视频左右两条黑边）。
  const fullscreenVideo = (tile: Element | null): void => {
    const v = tile?.querySelector('video')
    if (!v) return
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => { /* 忽略 */ })
    else if (typeof v.requestFullscreen === 'function') void v.requestFullscreen().catch(() => { /* 被拒则保持内联 */ })
  }

  /** 收起播放器，回到封面（清掉已解析的 src 与失败标记）。 */
  const closeVideo = (vk: string): void => {
    setVideoSrcs((prev) => { const n = { ...prev }; delete n[vk]; return n })
    setVideoFailed((prev) => { const n = new Set(prev); n.delete(vk); return n })
    setVideoErr((prev) => { const n = new Map(prev); n.delete(vk); return n })
    setVideoMeta((prev) => { const n = { ...prev }; delete n[vk]; return n })
  }

  // Esc 退出全屏：Chromium 对「元素全屏」的默认 Esc 处理在本应用里不生效（实测按了没反应），
  // 页面层自己接一次，避免用户点进全屏后出不来。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || !document.fullscreenElement) return
      e.preventDefault()
      void document.exitFullscreen().catch(() => { /* 忽略 */ })
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [])

  // 保存视频：先在主进程弹保存对话框选路径，再由**后端**取字节写盘。
  // 渲染端的 `<a download>` 在这个 Electron 里落不了盘（实测点了没反应）；
  // 把几十 MB 的 base64 经 IPC 传回主进程也不合适，所以写盘放在后端做。
  const saveVideo = (v: { md5?: string; timelineId?: string; id?: string; url?: string; key?: string }): void => {
    void (async () => {
      const picked = await apiSaveFileDialog({
        defaultName: `朋友圈视频-${(v.md5 || 'export').slice(0, 8)}.mp4`,
        title: '保存视频',
        filters: [{ name: 'MP4 视频', extensions: ['mp4'] }],
      })
      if (picked.canceled || !picked.path) return
      try {
        const r = await apiExportSnsVideo({ md5: v.md5, timelineId: v.timelineId, mediaId: v.id, url: v.url, key: v.key, dest: picked.path })
        if (!r.ok) { hold('保存失败: ' + (r.error || '未知错误')); return }
        flash(`已保存视频（${Math.round((r.bytes ?? 0) / 1048576)} MB）`)
        setExportedPath(picked.path)
      } catch (e) {
        hold('保存失败: ' + (e as Error).message)
      }
    })()
  }

  const toggleText = (tid: string): void => {
    setExpandedTextByCard((prev) => {
      const next = new Set(prev)
      if (next.has(tid)) next.delete(tid); else next.add(tid)
      return next
    })
  }

  const toggleSocial = (tid: string): void => {
    setExpandedSocialByCard((prev) => {
      const next = new Set(prev)
      if (next.has(tid)) next.delete(tid); else next.add(tid)
      return next
    })
  }

  const clearFilters = (): void => { setSearch(''); setMediaFilter('all'); setMonthFilter(null); setMineFilter('all'); setAuthorFilter(null); setDateFrom(''); setDateTo('') }

  return (
    <div className={css.panel}>
      <PanelHeader
        title={(
          <>
            朋友圈
            <span className={css.count}>共 {total} 条</span>
            {author && onClearAuthor && (
              <button type="button" className={css.btn} onClick={onClearAuthor} title="返回全部动态">✕ 仅看 {author}</button>
            )}
          </>
        )}
        /* 页头口径（U12）：标题 + 一句"这页是什么/数据从哪来" + 操作三件套，
           与其它面板保持一致（此前这里是唯一一个没有 desc 的面板）。 */
        desc={`本机朋友圈动态 · 图片/视频/链接/评论互动，共 ${total} 条；统计范围只含已解密的部分`}
        actions={(
          <>
            <SearchInput value={search} onChange={(v) => { setSearch(v) }} placeholder="搜索作者 / 内容 / 位置 / 评论" ariaLabel="搜索朋友圈" />
            <button type="button" className={css.btn} data-on={privacy || undefined} onClick={() => { setPrivacy(v => !v) }} title="隐私模式：模糊头像与内容，悬停查看">🔒 隐私</button>
            <button type="button" className={css.btn} onClick={() => { void load() }} disabled={loading}>刷新</button>
            <button type="button" className={css.btn} data-on={syncing || undefined} onClick={() => { void doSync() }} disabled={syncing}>{syncing ? '同步中…' : '↻ 同步'}</button>
            {lastSync > 0 && <span className={css.syncStatus} title="最近一次手动重同步时间">最近同步 {fmtSyncTime(lastSync)}</span>}
            <button type="button" className={css.btn} onClick={openExport}>导出</button>
          </>
        )}
      />

      <div className={css.layout}>
        <MomentsSidebar
          search={search}
          clearFilters={clearFilters}
          topAuthors={topAuthors}
          showAllAuthors={showAllAuthors}
          setShowAllAuthors={setShowAllAuthors}
          authorFilter={authorFilter}
          setAuthorFilter={setAuthorFilter}
          mediaFilter={mediaFilter}
          setMediaFilter={setMediaFilter}
          mineFilter={mineFilter}
          setMineFilter={setMineFilter}
          sortOrder={sortOrder}
          setSortOrder={setSortOrder}
          dateFrom={dateFrom}
          setDateFrom={setDateFrom}
          dateTo={dateTo}
          setDateTo={setDateTo}
          monthFilter={monthFilter}
          setMonthFilter={setMonthFilter}
          monthly={monthly}
          monthMax={monthMax}
          loadedCount={moments.length}
          total={total}
          insight={insight}
        />

        <div className={css.main}>
          <div ref={scrollRef} className={css.scroll}>
            {moments.length < total && <div className={css.insightNote}>统计中的图片/视频/位置/链接为已加载部分；全量 {total} 条。</div>}

            {search && moments.length < total && !loading && !error && (
              <div className={css.searchBanner}>
                <span>搜索仅覆盖已加载 {moments.length} / {total} 条</span>
                <button type="button" className={css.btn} onClick={() => { void loadAll() }} disabled={loadingAll}>{loadingAll ? '加载中…' : '加载全部以覆盖全量'}</button>
              </div>
            )}

            {loading && moments.length === 0 && <ListSkeleton rows={10} />}
            {error && <div className={kitCss.error} role="alert">⚠️ 朋友圈数据加载失败（{error}）</div>}
            {!loading && !error && groups.length === 0 && (
              <div className={kitCss.emptyInline}>
                {(() => {
                  if (search && mediaFilter === 'all' && monthFilter === null && mineFilter === 'all' && authorFilter === null) {
                    return moments.length < total ? '已加载范围无匹配（共 ' + String(total) + ' 条，当前只加载了 ' + String(moments.length) + ' 条）' : '无匹配动态'
                  }
                  if (search) return '无匹配动态'
                  if (mediaFilter !== 'all' || monthFilter !== null || mineFilter !== 'all' || authorFilter !== null || dateFrom || dateTo) return '当前筛选无匹配动态'
                  return '暂无朋友圈动态'
                })()}
              </div>
            )}
            {!loading && !error && groups.slice(0, grpCount).map(g => (
              <div key={g.day} className={css.dayGroup}>
                <div className={css.dayLabel}>{g.day}</div>
                {g.items.map((m) => (
                  <MomentsCard
                    key={m.tid}
                    m={m}
                    privacy={privacy}
                    snsImgs={snsImgs}
                    articleCovers={articleCovers}
                    expandedTextByCard={expandedTextByCard}
                    expandedSocialByCard={expandedSocialByCard}
                    commentCounts={commentCounts}
                    commentSortByCard={commentSortByCard}
                    onlyMineComments={onlyMineComments}
                    selfUsername={selfUsername}
                    failedImgs={failedImgs}
                    setFailedImgs={setFailedImgs}
                    videoSrcs={videoSrcs}
                    videoMeta={videoMeta}
                    setVideoMeta={setVideoMeta}
                    videoFailed={videoFailed}
                    videoErr={videoErr}
                    mediaKeySpec={mediaKeySpec}
                    setViewer={setViewer}
                    setDetail={setDetail}
                    setAuthorFilter={setAuthorFilter}
                    setOnlyMineComments={setOnlyMineComments}
                    setCommentCounts={setCommentCounts}
                    setCommentSortByCard={setCommentSortByCard}
                    toggleText={toggleText}
                    toggleSocial={toggleSocial}
                    copyText={copyText}
                    loadVideo={loadVideo}
                    saveVideo={saveVideo}
                    fullscreenVideo={fullscreenVideo}
                    closeVideo={closeVideo}
                  />
                ))}
              </div>
            ))}
            {!loading && !error && moments.length > 0 && moments.length < total && (
              <div className={css.moreRow}>
                <button type="button" className={css.moreBtn} onClick={() => { void loadAll() }} disabled={loadingAll}>
                  {loadingAll ? '加载中…' : `加载全部（剩余 ${total - moments.length} 条）`}
                </button>
              </div>
            )}
            {!loading && !error && groups.length > grpCount && <ListSentinel refFn={grpSentinel} />}
          </div>
          {typeof document !== 'undefined' && createPortal(
            <button
              type="button"
              className={css.backTop}
              onClick={() => { scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' }); if (window.scrollY > 0) window.scrollTo({ top: 0, behavior: 'smooth' }) }}
              title="回到顶部"
              aria-label="回到顶部"
            >↑</button>,
            document.body,
          )}
        </div>
      </div>
      {notice && <div className={css.hint}>{notice}</div>}
      {exportedPath && (
        <div className={css.exportResult}>
          <span className={css.exportResultPath} title={exportedPath}>📄 {exportedPath}</span>
          <button type="button" className={css.btn} onClick={() => { void apiOpenPath(exportedPath).catch(() => { hold('无法打开文件') }) }}>打开导出文件</button>
        </div>
      )}

      {/* 图片查看器 */}
      <MomentsImageViewer
        viewer={viewer}
        setViewer={setViewer}
        setViewerIndex={setViewerIndex}
        curImg={curImg}
        snsImgs={snsImgs}
        copyCurrentLink={copyCurrentLink}
        saveCurrentImage={saveCurrentImage}
        viewOriginal={viewOriginal}
        setViewOriginal={setViewOriginal}
        viewRotate={viewRotate}
        setViewRotate={setViewRotate}
        viewZoom={viewZoom}
        setViewZoom={setViewZoom}
        viewPan={viewPan}
        setViewPan={setViewPan}
        viewFailed={viewFailed}
        setViewFailed={setViewFailed}
        lightboxWrapRef={lightboxWrapRef}
        pinchRef={pinchRef}
        viewZoomRef={viewZoomRef}
        dragRef={dragRef}
      />

      {/* 单条动态详情 */}
      <MomentsDetail
        detail={detail}
        setDetail={setDetail}
        setViewer={setViewer}
        setAuthorFilter={setAuthorFilter}
        failedImgs={failedImgs}
        setFailedImgs={setFailedImgs}
        snsImgs={snsImgs}
        videoSrcs={videoSrcs}
        videoMeta={videoMeta}
        setVideoMeta={setVideoMeta}
        videoFailed={videoFailed}
        videoErr={videoErr}
        loadVideo={loadVideo}
        saveVideo={saveVideo}
        fullscreenVideo={fullscreenVideo}
        closeVideo={closeVideo}
      />

      <MomentsExportDialog
        {...{ exportOpen, setExportOpen, authorFilter, author, search, mediaFilter, monthFilter, mineFilter, expFormat, setExpFormat, expFrom, setExpFrom, expTo, setExpTo, expDir, pickDir, pickingDir, expImages, setExpImages, expZip, setExpZip, doExport, exporting }}
      />
    </div>
  )
}
