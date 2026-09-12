/**
 * 朋友圈面板 — React 版，忠实迁移 WeChatPanel 的 moments 页签：工具栏
 * （搜索/刷新/导出）、洞察统计、按日期分组的时间线卡片（文本/媒体/位置/
 * 链接/点赞/评论）。数据经 DSH 后端 Remote（sns.db content XML 解析），
 * 无 HTTP 依赖。
 *
 * Enhancements over the legacy panel:
 * - media-type filter chips + expanded search scope (likes/comments/公众号名/URL)
 * - likes count badge + expandable list, comments with time, reply quote, expand
 * - long-text expand/collapse
 * - lightbox zoom/pan, keyboard nav, per-image save, failure placeholder, thumbs
 * - inline video playback via the offline cached container (base64 data URL)
 * - single pagination control (infinite scroll + "load all")
 */
import { Fragment, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ListSentinel, ListSkeleton, useProgressiveList } from './hooks.tsx'
import { readRenderCache, writeRenderCache } from '../api.ts'
import { useWechatDataUpdated } from './hooks.tsx'
import { apiDecryptAllDatabases, apiExportMoments, apiGetArticleCover, apiGetAvatar, apiGetMoments, apiGetMomentsAuthors, apiGetMomentsMonthly, apiGetSelfUsername, apiGetSnsImageDataUrl, apiGetSnsVideoCoverDataUrl, apiGetSnsVideoDataUrl, apiOpenPath, pickDirectory, snsMediaCacheGet, snsMediaCacheGetMany, snsMediaCacheSet } from '../api.ts'
import type { MomentItem, MomentsMonthlyRow } from '@deepseek-ai/dsh-wechat-data/types'
import { clickableKey, PanelHeader, SearchInput, Segmented, useDialogFocus, useEscapeToClose } from '../ui/kit.tsx'
import { cacheBounded, capRecord } from '../utils/misc.ts'
import { cspSafeSrc } from '../utils/url.ts'
import css from './moments.module.css'
import kitCss from '../ui/kit.module.css'

const avatarCache = new Map<string, string>()
/** 头像缓存上限：模块级缓存生命周期等于渲染进程，必须设上限（值为 base64 data URL）。 */
const AVATAR_CACHE_MAX = 300
/** 已解密图片 data URL 缓存上限（朋友圈缩略图）。 */
const SNS_IMG_CACHE_MAX = 200
/**
 * 已解密视频 data URL 缓存上限。单条 .mp4 的 base64 可达数 MB，
 * 只保留最近播放的几条，否则"播放过的视频"会一直堆在 state 里。
 */
const VIDEO_SRC_CACHE_MAX = 3
/** 公众号封面缓存上限。 */
const ARTICLE_COVER_CACHE_MAX = 100

/** Media-type filter id + user-facing label kept in lockstep with the UI chips. */
type MediaFilter = 'all' | 'image' | 'video' | 'link' | 'location' | 'text'
const MEDIA_LABELS: Record<MediaFilter, string> = {
  all: '全部',
  image: '图片',
  video: '视频',
  link: '链接',
  location: '位置',
  text: '纯文字',
}

/** Stable cache key for one SNS image (md5 first, timelineId+mediaId fallback). */
function imgKey(im: { md5?: string; timelineId?: string; id?: string }): string {
  if (im.md5) return im.md5
  if (im.timelineId && im.id) return im.timelineId + ':' + im.id
  return ''
}

/**
 * CSP 安全的图片地址助手已提取到 `../utils/url.ts`（第 41 轮）：
 * `Contacts.tsx` 的头像也需要同一条规则，而那里原先直接用快照里的 `avatarUrl`，
 * 开启远端头像后一次进入通讯录就产生 16 条 http 的 CSP 违规。
 * 全项目只保留那一份实现，这里直接 import 使用（22 处调用点不变）。
 */

/** Compact relative label for a comment timestamp (tz-safe wall clock). */
function fmtCommentTime(ts: number): string {
  if (!ts) return ''
  const diff = Date.now() - ts * 1000
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`
  if (diff < 172800000) return '昨天'
  const d = new Date(ts * 1000)
  return `${d.getMonth() + 1}-${d.getDate()}`
}

/** Format a timestamp as HH:MM for the sync status label. */
function fmtSyncTime(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

/** Find the original comment a reply targets within the same card (best effort). */
function replyTarget(m: MomentItem, c: MomentItem['comments'][number]): MomentItem['comments'][number] | undefined {
  if (!c.to_username || c.to_username === m.username) return undefined
  for (const other of m.comments) {
    if (other.username === c.to_username && other.content) return other
  }
  return undefined
}

/** 朋友圈作者头像：本地 head_image 优先，失败回退首字色块。 */
function MomentsAvatar({ username, name }: { username: string; name: string }): React.JSX.Element {
  const [src, setSrc] = useState<string | null>(avatarCache.get(username) ?? null)
  useEffect(() => {
    if (src !== null) return
    let cancelled = false
    const opts: { username: string; nickname?: string } = { username }
    if (name) opts.nickname = name
    apiGetAvatar(opts)
      .then((r) => {
        const v = r.kind === 'data' ? (r.data ?? null) : (r.kind === 'url' ? (r.url ?? null) : null)
        cacheBounded(avatarCache, username, v ?? '', AVATAR_CACHE_MAX)
        if (!cancelled) setSrc(v)
      })
      .catch(() => {
        cacheBounded(avatarCache, username, '', AVATAR_CACHE_MAX)
        if (!cancelled) setSrc(null)
      })
    return () => { cancelled = true }
  }, [username, name, src])
  if (src) return <img src={src} alt="" className={css.avatarImg} loading="lazy" referrerPolicy="no-referrer" />
  return <div className={css.avatar}>{(name || '?').slice(0, 1).toUpperCase()}</div>
}

/** 16px mini avatar for likes/comments (缓存与 40px 大头像共享，避免重复请求)。 */
function MomentsMiniAvatar({ username, name }: { username: string; name: string }): React.JSX.Element {
  const [src, setSrc] = useState<string | null>(avatarCache.get(username) ?? null)
  useEffect(() => {
    if (src !== null) return
    let cancelled = false
    apiGetAvatar({ username, nickname: name }).then((r) => {
      const v = r.kind === 'data' ? (r.data ?? null) : (r.kind === 'url' ? (r.url ?? null) : null)
      cacheBounded(avatarCache, username, v ?? '', AVATAR_CACHE_MAX)
      if (!cancelled) setSrc(v)
    }).catch(() => { cacheBounded(avatarCache, username, '', AVATAR_CACHE_MAX); if (!cancelled) setSrc(null) })
    return () => { cancelled = true }
  }, [username, name, src])
  if (src) return <img src={src} alt="" className={css.miniAvatar} loading="lazy" referrerPolicy="no-referrer" />
  return <span className={css.miniAvatarFallback}>{(name || '?').slice(0, 1).toUpperCase()}</span>
}

/** 按日期分组（YYYY-MM-DD），组内保持原有顺序。 */
function groupByDate(moments: readonly MomentItem[]): Array<{ day: string; items: MomentItem[] }> {
  const map = new Map<string, MomentItem[]>()
  for (const m of moments) {
    const d = m.ts ? new Date(m.ts * 1000) : null
    const key = d && !isNaN(d.getTime()) ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : '未知日期'
    const arr = map.get(key) ?? []
    arr.push(m)
    map.set(key, arr)
  }
  return Array.from(map.entries()).map(([day, items]) => ({ day, items }))
}

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
  const [notice, setNotice] = useState<string | null>(null)
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
  const mediaKeySpec = useRef(new Map<string, { md5: string; timelineId?: string; mediaId?: string; kind: 'img' | 'video' | 'comment' }>())
  const mediaQueue = useRef<Array<{ key: string; md5: string; timelineId?: string; mediaId?: string; kind: 'img' | 'video' | 'comment' }>>([])
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
          const opts: { md5: string; timelineId?: string; mediaId?: string } = { md5: it.md5 }
          if (it.timelineId) opts.timelineId = it.timelineId
          if (it.mediaId) opts.mediaId = it.mediaId
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
      void clip.writeText(src).then(() => { setNotice('已复制图片链接') }).catch(() => { /* clipboard denied */ })
    } else {
      setNotice('当前环境不支持复制')
    }
  }

  const openExport = (): void => { setExportOpen(true) }

  // Copy arbitrary text to the clipboard.
  const copyText = (text: string): void => {
    if (!text) return
    const clip = (navigator as { clipboard?: Clipboard }).clipboard
    if (clip && typeof clip.writeText === 'function') {
      void clip.writeText(text).then(() => { setNotice('已复制') }).catch(() => { /* clipboard denied */ })
    } else {
      setNotice('当前环境不支持复制')
    }
  }

  // 手动重新同步：触发宿主重解密并派发更新事件（面板随后刷新）。
  const doSync = async (): Promise<void> => {
    if (syncing) return
    setSyncing(true)
    setNotice(null)
    try {
      await apiDecryptAllDatabases()
      setLastSync(Date.now())
      window.dispatchEvent(new Event('dsh-wechat-data-updated'))
      void load()
      setNotice('已重新同步解密数据')
      setTimeout(() => { setNotice(null) }, 6000)
    } catch (e) {
      setNotice('同步失败: ' + (e as Error).message)
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
    setNotice(null)
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
      setNotice('已导出 ' + String(r.count) + ' 条动态 → ' + r.path)
      setExportedPath(r.path)
      setExportOpen(false)
      setTimeout(() => { setNotice(null) }, 6000)
    } catch (e) {
      setNotice('导出失败: ' + (e as Error).message)
    } finally {
      setExporting(false)
    }
  }

  // Fetch the cached .mp4 body lazily on first play click (prefer offline, fall
  // back to the CDN URL); mark failures once so a missing file isn't retried.
  const loadVideo = useCallback((vk: string, v: { md5?: string; timelineId?: string; id?: string; url?: string }): void => {
    if (!vk || videoSrcs[vk] || videoFetching.current.has(vk)) return
    videoFetching.current.add(vk)
    void (async () => {
      const fallback = cspSafeSrc(v.url)
      try {
        const r = await apiGetSnsVideoDataUrl({ md5: v.md5, timelineId: v.timelineId, mediaId: v.id })
        const src = r.url || fallback
        if (src) setVideoSrcs(prev => capRecord({ ...prev, [vk]: src }, VIDEO_SRC_CACHE_MAX))
        else setVideoFailed(prev => new Set(prev).add(vk))
      } catch {
        if (fallback) setVideoSrcs(prev => capRecord({ ...prev, [vk]: fallback }, VIDEO_SRC_CACHE_MAX))
        else setVideoFailed(prev => new Set(prev).add(vk))
      } finally {
        videoFetching.current.delete(vk)
      }
    })()
  }, [videoSrcs])

  // Request fullscreen on the video inside a playing tile (best effort).
  const fullscreenVideo = (el: Element | null): void => {
    const v = el?.querySelector('video')
    if (v && typeof v.requestFullscreen === 'function') void v.requestFullscreen().catch(() => { /* denied */ })
  }

  // Save a video data URL / CDN src to disk.
  const downloadVideo = (src: string, name?: string): void => {
    if (!src) return
    const a = document.createElement('a')
    a.href = src
    a.download = (name ? 'moments-video-' + name.slice(0, 12) : 'moments-video') + '.mp4'
    document.body.appendChild(a)
    a.click()
    a.remove()
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
        <aside className={css.sidebar}>

          {/* 筛选面板：分组布局（作者 / 类型 / 范围 / 排序 / 月份），作者名截断 */}
          <div className={css.filterPanel}>
            {topAuthors.length > 0 && (
              <div className={css.filterGroup}>
                <span className={css.filterLabel}>作者</span>
                <div className={css.filterChips}>
                  {(showAllAuthors ? topAuthors : topAuthors.slice(0, 8)).map(([name, count]) => (
                    <button key={name} type="button" className={css.authorChip} data-on={authorFilter === name || undefined} title={authorFilter === name ? '清除 ' + name : '只看 ' + name} onClick={() => { setAuthorFilter(authorFilter === name ? null : name) }}>
                      <span className={css.chipName}>{name}</span>
                      <span className={css.chipCount}>{String(count)}</span>
                    </button>
                  ))}
                  {topAuthors.length > 8 && (
                    <button type="button" className={css.authorChip} onClick={() => { setShowAllAuthors(v => !v) }} title={showAllAuthors ? '收起作者' : '更多作者'}>{showAllAuthors ? '↑ 收起' : '… 更多作者'}</button>
                  )}
                  {authorFilter && <button type="button" className={css.authorChip} data-on="" onClick={() => { setAuthorFilter(null) }} title="清除作者筛选">✕ {authorFilter}</button>}
                </div>
              </div>
            )}
            <div className={css.filterGroup}>
              <span className={css.filterLabel}>类型</span>
              <Segmented
                options={(Object.keys(MEDIA_LABELS) as MediaFilter[]).map(f => ({ value: f, label: MEDIA_LABELS[f] }))}
                value={mediaFilter}
                onChange={(v) => { setMediaFilter(v as MediaFilter) }}
                ariaLabel="媒体类型筛选"
              />
            </div>
            <div className={css.filterGroup}>
              <span className={css.filterLabel}>范围</span>
              <Segmented
                options={[
                  { value: 'all', label: '全部' },
                  { value: 'mine', label: '我' },
                  { value: 'others', label: '他人' },
                ]}
                value={mineFilter}
                onChange={(v) => { setMineFilter(v as 'all' | 'mine' | 'others') }}
                ariaLabel="范围筛选"
              />
            </div>
            <div className={css.filterGroup}>
              <span className={css.filterLabel}>排序</span>
              <Segmented
                options={[
                  { value: 'desc', label: '最新在前' },
                  { value: 'asc', label: '最早在前' },
                ]}
                value={sortOrder}
                onChange={(v) => { setSortOrder(v as 'asc' | 'desc') }}
                ariaLabel="排序方向"
              />
            </div>
            <div className={css.filterGroup}>
              <span className={css.filterLabel}>时间</span>
              <div className={css.filterChips}>
                <input type="date" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value) }} className={css.dateInput} />
                <span className={`${css.filterLabel} ${css.filterToLabel}`}>至</span>
                <input type="date" value={dateTo} onChange={(e) => { setDateTo(e.target.value) }} className={css.dateInput} />
                {(dateFrom || dateTo) && <button type="button" className={css.segChip} onClick={() => { setDateFrom(''); setDateTo('') }} title="清除时间">✕</button>}
              </div>
            </div>
            {monthFilter && (
              <div className={css.filterGroup}>
                <span className={css.filterLabel}>月份</span>
                <div className={css.segTrack}>
                  <button type="button" className={css.segChip} data-on="" onClick={() => { setMonthFilter(null) }} title="清除月份筛选">✕ {monthFilter}</button>
                </div>
              </div>
            )}
            {(search || mediaFilter !== 'all' || monthFilter !== null || mineFilter !== 'all' || authorFilter !== null) && (
              <button type="button" className={css.clearBtn} onClick={clearFilters} title="清除所有筛选">✕ 清除</button>
            )}
          </div>

          {/* monthly histogram (click a bar to filter that month) */}
          <div className={css.monthCard}>
            <div className={css.monthTitle}>
              <span>全部月份动态{authorFilter ? '（作者：' + authorFilter + '）' : ''}（{monthly.length} 个月）</span>
              <span className={css.monthHint}>点击柱条按月份筛选</span>
              {monthFilter && <span className={css.monthHint}>{moments.length < total ? '（结果仅覆盖已加载部分）' : null}</span>}
              {monthFilter && <button type="button" className={css.textToggle} onClick={() => { setMonthFilter(null) }}>✕ 清除 {monthFilter}</button>}
            </div>
            <div className={css.monthBars}>
              {monthly.map(m => (
                // 点击目标放在**整列**而非柱子：柱高正比于数量，低数量的月份只有 2px 高，
                // 实测（WCAG 2.2 SC 2.5.8 目标尺寸）该面板 105 个控件里有 80 个小于 24×24，
                // 全部来自这里。整列高度始终包含「数值 + 柱 + 月份标签」，是稳定的目标。
                <div
                  key={m.key}
                  className={[css.monthCol, m.key === monthFilter ? css.monthColActive : ''].filter(Boolean).join(' ')}
                  title={m.key + ' ' + String(m.count) + ' 条'}
                  {...clickableKey(() => { setMonthFilter(m.key === monthFilter ? null : m.key) })}
                >
                  <span className={css.monthValue}>{m.count > 0 ? String(m.count) : ''}</span>
                  <div className={css.monthFill} data-peak={m.count === monthMax || undefined} data-on={m.key === monthFilter || undefined} style={{ height: String(Math.max(2, Math.round((m.count / monthMax) * 30))) + 'px' }} />
                  <span className={css.monthLabel}>{m.label}</span>
                </div>
              ))}
            </div>
          </div>

          {/* insight stats */}
          <div className={css.insight}>
            <div className={css.stat}>
              <span className={css.statIcon}>📊</span>
              <span className={css.statNum} title="服务端全量动态数">{String(total)}</span>
              <span className={kitCss.textCaption}>总动态</span>
            </div>
            <div className={css.stat}>
              <span className={css.statIcon}>🖼</span>
              <span className={css.statNum}>{insight.withImages}</span>
              <span className={kitCss.textCaption}>含图片</span>
            </div>
            <div className={css.stat}>
              <span className={css.statIcon}>🎬</span>
              <span className={css.statNum}>{insight.withVideos}</span>
              <span className={kitCss.textCaption}>含视频</span>
            </div>
            <div className={css.stat}>
              <span className={css.statIcon}>📍</span>
              <span className={css.statNum}>{insight.withLocation}</span>
              <span className={kitCss.textCaption}>带位置</span>
            </div>
            <div className={css.stat}>
              <span className={css.statIcon}>🔗</span>
              <span className={css.statNum}>{insight.withLink}</span>
              <span className={kitCss.textCaption}>分享链接</span>
            </div>
          </div>
        </aside>

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
                {g.items.map((m) => {
                  const cover = m.images[0]
                  const isArticle = m.contentType === 3
                  const coverSrc = (cover && imgKey(cover) && snsImgs[imgKey(cover)]) || (m.link_url && articleCovers[m.link_url]) || cspSafeSrc(cover?.thumb, cover?.url)
                  const textExpanded = expandedTextByCard.has(m.tid)
                  const socialExpanded = expandedSocialByCard.has(m.tid)
                  const commentShown = commentCounts[m.tid] ?? 5
                  const commentSort = commentSortByCard[m.tid] ?? 'asc'
                  let commentList = commentSort === 'desc' ? [...m.comments].reverse() : m.comments
                  if (onlyMineComments && selfUsername) commentList = commentList.filter(c => c.username === selfUsername)
                  const visibleComments = commentList.slice(0, Math.min(commentShown, commentList.length))
                  return (
                    <div key={m.tid} className={[css.card, privacy ? css.blurCard : ''].filter(Boolean).join(' ')}>
                      <div className={css.avatarClick} title="查看详情" {...clickableKey(() => { setDetail({ m }) })}>
                        <MomentsAvatar username={m.username} name={m.author || '?'} />
                      </div>
                      <div className={css.body}>
                        <div className={css.meta} title="查看详情" {...clickableKey(() => { setDetail({ m }) })}>
                          <span className={css.author}>{m.author || '未知'}</span>
                          {m.is_self && <span className={css.selfTag}>我</span>}
                        </div>
                        {m.text && (
                          <div className={css.content}>
                            {textExpanded || m.text.length <= 200 ? m.text : m.text.slice(0, 200) + '…'}
                            {m.text.length > 200 && (<button type="button" className={css.textToggle} onClick={() => { toggleText(m.tid) }}>{textExpanded ? '收起' : '展开'}</button>)}
                          </div>
                        )}
                        {m.images.length > 0 && !isArticle && (
                          <div className={[css.images, m.images.length === 1 ? css.imagesSingle : ''].filter(Boolean).join(' ')}>
                            {m.images.map((im, ii) => {
                              const key = imgKey(im)
                              const dataSrc = key ? snsImgs[key] : undefined
                              const fk = m.tid + ':' + String(ii)
                              const failed = failedImgs.has(fk)
                              if (key) mediaKeySpec.current.set(key, { md5: im.md5 || '', timelineId: im.timelineId, mediaId: im.id, kind: 'img' })
                              const haveSrc = !!(dataSrc || cspSafeSrc(im.thumb, im.url))
                              return (
                                <div key={fk}
                                  className={css.imgWrap}
                                  {...clickableKey(() => { setViewer({ images: m.images, index: ii, author: m.author }) })}
                                  title="点击查看大图"
                                  data-sns-key={key || undefined}
                                  data-sns-md5={im.md5 || undefined}
                                  data-sns-tid={im.timelineId || undefined}
                                  data-sns-mid={im.id || undefined}
                                >
                                  {haveSrc && (!failed || dataSrc) ? (
                                    <img
                                      key={dataSrc ? 'd' : 'c'}
                                      src={dataSrc || cspSafeSrc(im.thumb, im.url)}
                                      alt=""
                                      loading="lazy"
                                      decoding="async"
                                      referrerPolicy="no-referrer"
                                      className={css.img}
                                      onError={() => {
                                        // 如果当前src是CDN URL（非data URL），标记为失败
                                        // 避免反复尝试无法访问的CDN URL
                                        const currentSrc = dataSrc || cspSafeSrc(im.thumb, im.url)
                                        if (!currentSrc.startsWith('data:')) {
                                          setFailedImgs(prev => new Set(prev).add(fk))
                                        }
                                      }}
                                    />
                                  ) : (
                                    <div className={css.imgFallback}>
                                      {failed ? (
                                        <div className={css.imgFallbackContent}>
                                          <span className={css.imgFallbackIcon}>🖼</span>
                                          <span className={css.imgFallbackText}>图片加载失败</span>
                                          <span className={css.imgFallbackHint}>本地缓存未找到</span>
                                        </div>
                                      ) : '加载中'}
                                    </div>
                                  )}
                                </div>
                              )
                            })}
                          </div>
                        )}
                        {m.videos.length > 0 && (
                          <div className={css.videos}>
                            {m.videos.map((v, vi) => {
                              const vk = v.md5 ? 'v:' + v.md5 : (v.timelineId && v.id ? 'v:' + v.timelineId + ':' + v.id : '')
                              const vCover = (vk ? snsImgs[vk] : undefined) || cspSafeSrc(v.thumb)
                              if (vk) mediaKeySpec.current.set(vk, { md5: v.md5 || '', timelineId: v.timelineId, mediaId: v.id, kind: 'video' })
                              const src = vk ? videoSrcs[vk] : undefined
                              const playing = !!src
                              return (
                                <div key={vi} className={[css.videoTile, playing ? css.videoTilePlaying : ''].filter(Boolean).join(' ')} title={v.url || v.md5 || ''}
                                  data-sns-key={vk || undefined}
                                  data-sns-md5={v.md5 || undefined}
                                  data-sns-tid={v.timelineId || undefined}
                                  data-sns-mid={v.id || undefined}
                                  {...(playing ? {} : clickableKey(() => { loadVideo(vk, v) }, { label: '播放视频' }))}
                                >
                                  {playing ? (
                                    <>
                                      <video className={css.videoPlayer} src={src} controls autoPlay poster={vCover || ''} />
                                      <button type="button" className={css.fullscreenBtn} title="全屏" onClick={(e) => { e.stopPropagation(); fullscreenVideo(e.currentTarget.closest('.videoTile')) }}>⛶</button>
                                      <button type="button" className={`${css.fullscreenBtn} ${css.fullscreenBtnSave}`} title="保存视频" onClick={(e) => { e.stopPropagation(); downloadVideo(src, v.md5) }}>⭳</button>
                                    </>
                                  ) : vCover ? (
                                    <>
                                      <img className={css.videoCover} src={vCover} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={(e) => {
                                        // 如果当前src是CDN URL（非data URL），隐藏图片
                                        if (!vCover.startsWith('data:')) {
                                          e.currentTarget.style.display = 'none'
                                        }
                                      }} />
                                      <span className={css.videoPlayBadge}>▶</span>
                                      {v.duration > 0 && <span className={css.videoDur}>{Math.round(v.duration)}s</span>}
                                    </>
                                  ) : (
                                    <>
                                      <span className={css.videoBadge}>{videoFailed.has(vk) ? '×' : '▶'}</span>
                                      {v.duration > 0 && <span className={css.videoDur}>{Math.round(v.duration)}s</span>}
                                    </>
                                  )}
                                </div>
                              )
                            })}
                          </div>
                        )}
                        {m.link_title && (
                          <div className={css.linkCard}>
                            {cover ? (
                              <div className={css.linkCover}>
                                <img
                                  key={coverSrc.startsWith('data:') ? 'd' : 'c'}
                                  src={coverSrc}
                                  alt=""
                                  referrerPolicy="no-referrer"
                                  onError={(e) => {
                                    // 如果当前src是CDN URL（非data URL），隐藏图片
                                    if (!coverSrc.startsWith('data:')) {
                                      e.currentTarget.style.display = 'none'
                                    }
                                  }}
                                />
                              </div>
                            ) : null}
                            <div className={css.linkBody}>
                              {/* 标题被 2 行截断（.linkTitle 的 line-clamp），所以必须给全文入口：
                                  第 60 轮把「纵向截断但无 title」并入截断巡检后，这里立刻被抓出来
                                  （视频号长标题可见 45px、实际 67px，用户无法拿到全文）。 */}
                              {m.link_url
                                ? <a className={css.linkTitle} href={m.link_url} target="_blank" rel="noopener noreferrer" title={m.link_title}>{m.link_title}</a>
                                : <span className={css.linkTitle} title={m.link_title}>{m.link_title}</span>}
                              <div className={kitCss.textMeta}>{m.sourceNickName ? '公众号 · ' + m.sourceNickName : (m.contentType === 28 ? '视频号' : '链接')}</div>
                            </div>
                          </div>
                        )}
                        {m.location && (
                          <div className={css.tags}>
                            <span className={kitCss.textMeta}>📍 {m.location}</span>
                          </div>
                        )}
                        {(m.likes.length > 0 || m.comments.length > 0) && (
                          <div className={css.social}>
                            {m.likes.length > 0 && (
                              <div className={css.likesRow}>
                                <span className={css.likesCount}>❤ {m.likes.length}</span>
                                <span className={css.likeNames}>
                                  {(() => {
                                    const names = socialExpanded ? m.likes : m.likes.slice(0, 8)
                                    return names.map((l, idx) => (
                                      <Fragment key={idx}>
                                        <span className={css.clickableName} title={'只看 ' + (l.nickname || l.username)} {...clickableKey(() => { setAuthorFilter(l.nickname || l.username || null) }, { stopPropagation: true })}>{l.nickname || l.username || '未知'}</span>
                                        {idx < names.length - 1 ? '、' : null}
                                      </Fragment>
                                    ))
                                  })()}
                                  {!socialExpanded && m.likes.length > 8 ? ' 等' : ''}
                                  {m.likes.length > 8 && (
                                    <button type="button" className={css.textToggle} onClick={() => { toggleSocial(m.tid) }}>{socialExpanded ? '收起' : '展开全部 ' + String(m.likes.length) + ' 人'}</button>
                                  )}
                                </span>
                              </div>
                            )}
                            {m.comments.length > 0 && (
                              <div className={css.comments}>
                                {m.comments.length > 1 && (
                                  <div className={css.commentsHead}>
                                    <span className={css.commentsTitle}>评论 {m.comments.length}</span>
                                    <div className={css.commentsHeadActs}>
                                      {selfUsername && (
                                        <button type="button" className={css.textToggle} data-on={onlyMineComments || undefined} onClick={() => { setOnlyMineComments(v => !v) }}>仅看我的</button>
                                      )}
                                      <button type="button" className={css.textToggle} onClick={() => { setCommentSortByCard(prev => ({ ...prev, [m.tid]: commentSort === 'asc' ? 'desc' : 'asc' })) }}>{commentSort === 'asc' ? '最新在前' : '最早在前'}</button>
                                      <button type="button" className={css.textToggle} onClick={() => { copyText(m.comments.map(c => ((c.nickname || c.username) + '：' + (c.content || '')).trim()).join('\n')) }}>复制</button>
                                    </div>
                                  </div>
                                )}
                                {visibleComments.map((c, ci) => {
                                  const target = replyTarget(m, c)
                                  return (
                                    <div key={ci} className={css.comment}>
                                      <span className={css.commentName} title={'只看 ' + (c.nickname || c.username)} {...clickableKey(() => { setAuthorFilter(c.nickname || c.username || null) }, { stopPropagation: true })}>{c.nickname || c.username || '未知'}</span>
                                      {c.to_username && c.to_username !== m.username && (
                                        <span className={css.commentReply}>回复 {c.to_nickname || c.to_username}{target ? '：' : ''}</span>
                                      )}
                                      {target && <span className={kitCss.textCaption}>“{target.content.slice(0, 40)}”</span>}
                                      <span className={css.commentText}>{c.content || ''}</span>
                                      {c.image && (() => {
                                        const img = c.image
                                        const cdata = (img.md5 && snsImgs[img.md5]) || ''
                                        const cfk = m.tid + ':c' + String(ci)
                                        const cfailed = failedImgs.has(cfk)
                                        if (img.md5) mediaKeySpec.current.set(img.md5, { md5: img.md5, kind: 'comment' })
                                        if (cdata || cspSafeSrc(img.thumb, img.url)) return (
                                          <img
                                            key={cdata ? 'd' : 'c'}
                                            src={cdata || cspSafeSrc(img.thumb, img.url)}
                                            alt=""
                                            loading="lazy"
                                            decoding="async"
                                            referrerPolicy="no-referrer"
                                            className={css.commentImg}
                                            data-sns-key={img.md5 || undefined}
                                            data-sns-md5={img.md5 || undefined}
                                            {...clickableKey(() => { setViewer({ images: [{ thumb: img.thumb, url: img.url, md5: img.md5 }], index: 0, author: (c.nickname || c.username || '') }) }, { label: '查看大图' })}
                                            onError={() => {
                                              // 如果当前src是CDN URL（非data URL），标记为失败
                                              const currentSrc = cdata || cspSafeSrc(img.thumb, img.url)
                                              if (!currentSrc.startsWith('data:')) {
                                                setFailedImgs(prev => new Set(prev).add(cfk))
                                              }
                                            }}
                                          />
                                        )
                                        return !cfailed ? <span className={css.commentImgFallback}>[图]</span> : null
                                      })()}
                                      {c.ts > 0 && <span className={css.commentTime}>{fmtCommentTime(c.ts)}</span>}
                                    </div>
                                  )
                                })}
                                {m.comments.length > commentShown && (
                                  <button type="button" className={css.textToggle} onClick={() => { setCommentCounts(prev => ({ ...prev, [m.tid]: Math.min(m.comments.length, commentShown + 10) })) }}>
                                    加载更多评论（剩余 {String(m.comments.length - commentShown)} 条）
                                  </button>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                        <div className={css.timeRow}>
                          <span className={kitCss.textMeta}>{m.time}</span>
                          {m.is_self && <span className={css.delIcon}>🗑</span>}
                        </div>
                      </div>
                    </div>
                  )
                })}
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
          {createPortal(
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
          <button type="button" className={css.btn} onClick={() => { void apiOpenPath(exportedPath).catch(() => { setNotice('无法打开文件') }) }}>打开导出文件</button>
        </div>
      )}

      {/* 图片查看器 */}
      {viewer && createPortal(
        <div className={[css.overlay, css.overlayTop].join(' ')} data-st-dialog="moments-viewer" onClick={() => { setViewer(null) }} role="dialog" aria-modal="true">
          <div className={css.lightbox} onClick={(e) => { e.stopPropagation() }}>
            <div className={css.lightboxHead}>
              <span>{viewer.author} · {String(viewer.index + 1)}/{String(viewer.images.length)}</span>
              <div className={css.lightboxHeadActions}>
                <button type="button" className={css.btn} onClick={copyCurrentLink} disabled={!((curImg?.url) || (curImg && snsImgs[imgKey(curImg)]) || curImg?.thumb)} title="复制链接">复制</button>
                <button type="button" className={css.btn} onClick={saveCurrentImage} disabled={!((curImg && snsImgs[imgKey(curImg)]) || curImg?.url || curImg?.thumb)} title="保存到本地">保存</button>
                <button type="button" className={css.btn} data-on={viewOriginal || undefined} onClick={() => { setViewOriginal(v => !v) }} disabled={!cspSafeSrc(curImg?.url)} title={viewOriginal ? '当前为原始链接，点按回离线解码图' : '切换为原始链接'}>原图</button>
                <button type="button" className={css.btn} onClick={() => { setViewRotate(r => (r + 90) % 360) }} title="旋转90°">↻</button>
                <button type="button" className={css.btn} onClick={() => { setViewZoom(1); setViewPan({ x: 0, y: 0 }) }} disabled={viewZoom === 1} title="重置缩放">1:1</button>
                <button type="button" className={css.btn} onClick={() => { setViewer(null) }} aria-label="关闭">×</button>
              </div>
            </div>
            <div ref={lightboxWrapRef} className={css.lightboxImgWrap}
              onDoubleClick={() => { setViewZoom(z => (z === 1 ? 2.5 : 1)); setViewPan({ x: 0, y: 0 }) }}
              onTouchStart={(e) => {
                const a = e.touches[0]
                const b = e.touches[1]
                if (e.touches.length === 2 && a && b) {
                  const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
                  pinchRef.current = { dist: d, zoom: viewZoomRef.current }
                }
              }}
              onTouchMove={(e) => {
                const p = pinchRef.current
                const a = e.touches[0]
                const b = e.touches[1]
                if (p && e.touches.length === 2 && a && b) {
                  const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
                  const n = Math.min(5, Math.max(1, p.zoom * (d / p.dist)))
                  setViewZoom(n)
                  if (n === 1) setViewPan({ x: 0, y: 0 })
                }
              }}
              onTouchEnd={() => { pinchRef.current = null }}
              onMouseDown={(e) => {
                if (viewZoom <= 1) return
                dragRef.current = { sx: e.clientX, sy: e.clientY, ox: viewPan.x, oy: viewPan.y }
              }}
              onMouseMove={(e) => {
                const d = dragRef.current
                if (d) setViewPan({ x: d.ox + (e.clientX - d.sx), y: d.oy + (e.clientY - d.sy) })
              }}
              onMouseUp={() => { dragRef.current = null }}
              onMouseLeave={() => { dragRef.current = null }}
              style={{ cursor: viewZoom > 1 ? 'move' : 'zoom-in' }}
            >
              {viewFailed ? (
                <div className={css.lightboxFail}>图片加载失败</div>
              ) : (
                <img
                  src={viewOriginal ? (cspSafeSrc(curImg?.url) || (curImg && snsImgs[imgKey(curImg)]) || cspSafeSrc(curImg?.thumb) || '') : ((curImg && snsImgs[imgKey(curImg)]) || cspSafeSrc(curImg?.url, curImg?.thumb) || '')}
                  alt=""
                  referrerPolicy="no-referrer"
                  draggable={false}
                  className={css.lightboxImg}
                  style={{ transform: 'rotate(' + String(viewRotate) + 'deg) scale(' + String(viewZoom) + ') translate(' + String(viewPan.x) + 'px,' + String(viewPan.y) + 'px)' }}
                  onError={() => {
                    // 如果当前src是CDN URL（非data URL），标记为失败
                    const currentSrc = viewOriginal ? (cspSafeSrc(curImg?.url) || (curImg && snsImgs[imgKey(curImg)]) || cspSafeSrc(curImg?.thumb) || '') : ((curImg && snsImgs[imgKey(curImg)]) || cspSafeSrc(curImg?.url, curImg?.thumb) || '')
                    if (!currentSrc.startsWith('data:')) {
                      setViewFailed(true)
                    }
                  }}
                />
              )}
            </div>
            <div className={css.lightboxNav}>
              <button type="button" className={css.btn} disabled={viewer.index <= 0} onClick={() => { setViewerIndex(viewer.index - 1) }}>‹ 上一张</button>
              <button type="button" className={css.btn} disabled={viewer.index >= viewer.images.length - 1} onClick={() => { setViewerIndex(viewer.index + 1) }}>下一张 ›</button>
            </div>
            {viewer.images.length > 1 && (
              <div className={css.lightboxThumbs}>
                {viewer.images.map((im, i) => {
                  const t = (snsImgs[imgKey(im)] || cspSafeSrc(im.thumb, im.url))
                  return (
                    <img
                      key={i}
                      src={t || ''}
                      alt=""
                      className={[css.lightboxThumb, i === viewer.index ? css.lightboxThumbActive : ''].filter(Boolean).join(' ')}
                      {...clickableKey(() => { setViewerIndex(i) }, { label: `查看第 ${i + 1} 张图` })}
                      onError={(e) => {
                        // 如果当前src是CDN URL（非data URL），隐藏缩略图
                        if (!t.startsWith('data:')) {
                          e.currentTarget.style.display = 'none'
                        }
                      }}
                    />
                  )
                })}
              </div>
            )}
          </div>
        </div>,
        document.body,
      )}

      {/* 单条动态详情 */}
      {detail && createPortal(
        <div className={css.overlay} data-st-dialog="moments-detail" onClick={() => { setDetail(null) }} role="dialog" aria-modal="true">
          <div className={css.detailCard} onClick={(e) => { e.stopPropagation() }}>
            <div className={css.lightboxHead}>
              <span>{detail.m.author || '未知'} · {detail.m.time}</span>
              <button type="button" className={css.btn} onClick={() => { setDetail(null) }} aria-label="关闭">×</button>
            </div>
            <div className={css.detailBody}>
              {detail.m.text && <div className={css.content}>{detail.m.text}</div>}
              {detail.m.images.length > 0 && (
                <div className={[css.images, detail.m.images.length === 1 ? css.imagesSingle : ''].filter(Boolean).join(' ')}>
                  {detail.m.images.map((im, ii) => {
                    const key = imgKey(im)
                    const dataSrc = key ? snsImgs[key] : undefined
                    const haveSrc = !!(dataSrc || cspSafeSrc(im.thumb, im.url))
                    return (
                      <div key={ii} className={css.imgWrap} title="点击查看大图" {...clickableKey(() => { setViewer({ images: detail.m.images, index: ii, author: detail.m.author }) })}>
                        {haveSrc
                          ? <img src={dataSrc || cspSafeSrc(im.thumb, im.url)} alt="" loading="lazy" referrerPolicy="no-referrer" className={css.img} onError={(e) => {
                            // 如果当前src是CDN URL（非data URL），隐藏图片
                            const currentSrc = dataSrc || cspSafeSrc(im.thumb, im.url)
                            if (!currentSrc.startsWith('data:')) {
                              e.currentTarget.style.display = 'none'
                            }
                          }} />
                          : <div className={css.imgFallback}>加载中</div>}
                      </div>
                    )
                  })}
                </div>
              )}
              {detail.m.videos.length > 0 && (
                <div className={css.videos}>
                  {detail.m.videos.map((v, vi) => {
                    const vk = v.md5 ? 'v:' + v.md5 : (v.timelineId && v.id ? 'v:' + v.timelineId + ':' + v.id : '')
                    const vCover = (vk ? snsImgs[vk] : undefined) || cspSafeSrc(v.thumb)
                    const src = vk ? videoSrcs[vk] : undefined
                    const playing = !!src
                    return (
                      <div key={vi} className={[css.videoTile, playing ? css.videoTilePlaying : '', playing ? css.videoTileDetail : ''].filter(Boolean).join(' ')} title={v.url || v.md5 || ''} {...(playing ? {} : clickableKey(() => { loadVideo(vk, v) }, { label: '播放视频' }))}>
                        {playing
                          ? <><video className={css.videoPlayer} src={src} controls autoPlay poster={vCover || ''} /><button className={css.fullscreenBtn} title="全屏" onClick={(e) => { e.stopPropagation(); fullscreenVideo(e.currentTarget.closest('.videoTile')) }}>⛶</button></>
                          : vCover
                            ? <><img className={css.videoCover} src={vCover} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(e) => {
                              // 如果当前src是CDN URL（非data URL），隐藏图片
                              if (!vCover.startsWith('data:')) {
                                e.currentTarget.style.display = 'none'
                              }
                            }} /><span className={css.videoPlayBadge}>▶</span>{v.duration > 0 && (
                              <span className={css.videoDur}>{Math.round(v.duration)}s</span>
                            )}</>
                            : <><span className={css.videoBadge}>{videoFailed.has(vk) ? '×' : '▶'}</span>{v.duration > 0 && (
                              <span className={css.videoDur}>{Math.round(v.duration)}s</span>
                            )}</>}
                      </div>
                    )
                  })}
                </div>
              )}
              {detail.m.link_title && (
                <div className={css.linkCard}>
                  <div className={css.linkBody}>
                    {detail.m.link_url
                      ? <a className={css.linkTitle} href={detail.m.link_url} target="_blank" rel="noopener noreferrer" title={detail.m.link_title}>{detail.m.link_title}</a>
                      : <span className={css.linkTitle} title={detail.m.link_title}>{detail.m.link_title}</span>}
                    <div className={kitCss.textMeta}>{detail.m.sourceNickName ? '公众号 · ' + detail.m.sourceNickName : (detail.m.contentType === 28 ? '视频号' : '链接')}</div>
                  </div>
                </div>
              )}
              {detail.m.location && <div className={css.tags}><span className={kitCss.textMeta}>📍 {detail.m.location}</span></div>}
              {detail.m.likes.length > 0 && (
                <div className={css.likesRow}>
                  <span className={css.likesCount}>❤ {detail.m.likes.length}</span>
                  <span className={css.likeNames}>
                    {detail.m.likes.map((l, idx) => (
                      <Fragment key={idx}>
                        <MomentsMiniAvatar username={l.username} name={l.nickname || l.username} />
                        <span className={css.clickableName} title={'只看 ' + (l.nickname || l.username)} {...clickableKey(() => { setAuthorFilter(l.nickname || l.username || null) }, { stopPropagation: true })}>{l.nickname || l.username || '未知'}</span>
                        {idx < detail.m.likes.length - 1 ? '、' : null}
                      </Fragment>
                    ))}
                  </span>
                </div>
              )}
              {detail.m.comments.length > 0 && (
                <div className={css.comments}>
                  {detail.m.comments.map((c, ci) => {
                    const target = replyTarget(detail.m, c)
                    const img = c.image
                    const cdata = (img?.md5 && snsImgs[img.md5]) || ''
                    return (
                      <div key={ci} className={css.comment}>
                        <MomentsMiniAvatar username={c.username} name={c.nickname || c.username} />
                        <span className={css.commentName} title={'只看 ' + (c.nickname || c.username)} {...clickableKey(() => { setAuthorFilter(c.nickname || c.username || null) }, { stopPropagation: true })}>{c.nickname || c.username || '未知'}</span>
                        {c.to_username && c.to_username !== detail.m.username && <span className={css.commentReply}>回复 {c.to_nickname || c.to_username}{target ? '：' : ''}</span>}
                        {target && <span className={kitCss.textCaption}>“{target.content.slice(0, 40)}”</span>}
                        <span className={css.commentText}>{c.content || ''}</span>
                        {img && (cdata || cspSafeSrc(img.thumb, img.url)) && (
                          <img key={'img' + String(ci)} src={cdata || cspSafeSrc(img.thumb, img.url)} alt="" loading="lazy" referrerPolicy="no-referrer" className={css.commentImg} {...clickableKey(() => { setViewer({ images: [{ thumb: img.thumb, url: img.url, md5: img.md5 }], index: 0, author: (c.nickname || c.username || '') }) }, { label: '查看大图' })} />
                        )}
                        {c.ts > 0 && <span className={css.commentTime}>{fmtCommentTime(c.ts)}</span>}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* 导出对话框 */}
      {exportOpen && (
        <div className={css.overlay} data-st-dialog="moments-export" onClick={() => { setExportOpen(false) }} role="dialog" aria-modal="true">
          <div className={css.lightbox} onClick={(e) => { e.stopPropagation() }}>
            <div className={css.lightboxHead}>
              <span>导出朋友圈</span>
              <button type="button" className={css.btn} onClick={() => { setExportOpen(false) }} aria-label="关闭">×</button>
            </div>
            <div className={css.exportForm}>
              <div className={css.exportField}>
                <span className={css.exportLabel}>格式</span>
                <div className={css.exportChips}>
                  {['html', 'json', 'txt', 'csv'].map(f => (
                    <button key={f} type="button" className={css.btn} data-on={expFormat === f || undefined} onClick={() => { setExpFormat(f) }}>{f.toUpperCase()}</button>
                  ))}
                </div>
              </div>
              <div className={css.exportField}>
                <span className={css.exportLabel}>范围</span>
                <span className={css.exportHint}>
                  {(() => {
                    const parts: string[] = []
                    if (authorFilter) parts.push('作者：' + authorFilter)
                    if (author) parts.push('指定用户：' + author)
                    if (search.trim()) parts.push('关键词：' + search.trim())
                    if (mediaFilter !== 'all') parts.push('类型：' + MEDIA_LABELS[mediaFilter])
                    if (monthFilter) parts.push('月份：' + monthFilter)
                    if (mineFilter !== 'all') parts.push('范围：' + (mineFilter === 'mine' ? '我' : '他人'))
                    return (parts.length > 0 ? parts.join(' · ') : '全部联系人') + ' · 服务端全量'
                  })()}
                </span>
              </div>
              <div className={css.exportField}>
                <span className={css.exportLabel}>时间</span>
                <div className={css.exportChips}>
                  <input type="date" value={expFrom} onChange={(e) => { setExpFrom(e.target.value) }} className={css.search} />
                  <span>至</span>
                  <input type="date" value={expTo} onChange={(e) => { setExpTo(e.target.value) }} className={css.search} />
                </div>
              </div>
              <div className={css.exportField}>
                <span className={css.exportLabel}>目录</span>
                <div className={css.exportChips}>
                  <button type="button" className={css.btn} onClick={() => { void pickDir() }} disabled={pickingDir}>选择目录{expDir ? ' ✓' : ''}</button>
                  {expDir && <span className={css.exportHint} title={expDir}>{expDir}</span>}
                </div>
              </div>
              <div className={css.exportField}>
                <span className={css.exportLabel}>媒体</span>
                <div className={css.exportChips}>
                  <label className={css.exportCheck} title="HTML 导出时内嵌离线解码图片（base64），体积较大">
                    <input type="checkbox" checked={expImages} onChange={(e) => { setExpImages(e.target.checked) }} disabled={expFormat !== 'html'} />
                    <span>HTML 内嵌离线图片</span>
                  </label>
                  <label className={css.exportCheck} title="把动态 JSON + 离线图片/视频打包成一个 ZIP（媒体较多时体积大）">
                    <input type="checkbox" checked={expZip} onChange={(e) => { setExpZip(e.target.checked) }} />
                    <span>ZIP 含媒体</span>
                  </label>
                </div>
              </div>
              <button type="button" className={`${css.btn} ${css.btnBottom}`} onClick={() => { void doExport() }} disabled={exporting}>{exporting ? '导出中…' : '导出'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
