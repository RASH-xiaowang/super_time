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
import { apiGetMoments, apiGetMomentsAuthors, apiGetMomentsMonthly, apiGetSelfUsername, apiOpenPath } from '../api.ts'
import type { MomentItem, MomentsMonthlySnapshot } from '@deepseek-ai/dsh-wechat-data/types'
import { clickableKey, PanelHeader, SearchInput, useDialogFocus, useEscapeToClose } from '../ui/kit.tsx'
import { MomentsCard } from './moments-card.tsx'
import { MomentsSidebar } from './moments-sidebar.tsx'
import { MomentsDetail, MomentsExportDialog, MomentsImageViewer } from './moments-portals.tsx'
import { copyTextToClipboard } from '../utils/misc.ts'
import { proxyableSrc } from '../utils/url.ts'
import css from './moments.module.css'
import kitCss from '../ui/kit.module.css'
import { MediaFilter, fmtSyncTime, groupByDate, imgKey } from './moments-support.tsx'
import { useMomentsScope } from './moments-scope.ts'
import { useMomentsMedia } from './moments-media.ts'
import { useMomentsExport } from './moments-export.ts'
import { useMomentsVideos } from './moments-videos.ts'

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
  const [monthlySnap, setMonthlySnap] = useState<MomentsMonthlySnapshot>({ months: [] })
  const [privacy, setPrivacy] = useState(false)
  const [expandedTextByCard, setExpandedTextByCard] = useState<Set<string>>(new Set())
  const [expandedSocialByCard, setExpandedSocialByCard] = useState<Set<string>>(new Set())
  const [commentCounts, setCommentCounts] = useState<Record<string, number>>({})
  const [commentSortByCard, setCommentSortByCard] = useState<Record<string, 'asc' | 'desc'>>({})
  const [selfUsername, setSelfUsername] = useState<string | null>(null)
  const [fullAuthors, setFullAuthors] = useState<Array<{ name: string; count: number }> | null>(null)
  const [monthlySnapForAuthor, setMonthlySnapForAuthor] = useState<MomentsMonthlySnapshot>({ months: [] })
  const [onlyMineComments, setOnlyMineComments] = useState(false)
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
  const [viewRotate, setViewRotate] = useState(0)
  const [viewOriginal, setViewOriginal] = useState(false)
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null)
  const pinchRef = useRef<{ dist: number; zoom: number } | null>(null)
  const lightboxWrapRef = useRef<HTMLDivElement | null>(null)
  const viewZoomRef = useRef(1)
  // 提示语自动消失（L20）：原手写的 3 处 `setTimeout(…, 6000)` 已由 hook 统一管理。
  // 复制结果与各类失败提示改前不带定时器（一直留着），所以走 hold 而不是 flash。
  const { notice, flash, hold, clear } = useTransientNotice(6000)
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
          .then((snap) => { setMonthlySnap(snap) })
          .catch(() => { setMonthlySnap({ months: [], readError: '月度分布请求失败（已退回按已加载部分统计）' }) })
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
    if (!authorFilter) { setMonthlySnapForAuthor({ months: [] }); return }
    let cancelled = false
    setMonthlySnapForAuthor({ months: [] }) // 先清空，避免显示上一个作者的数据
    void apiGetMomentsMonthly({ authorName: authorFilter })
      .then((snap) => { if (!cancelled) setMonthlySnapForAuthor(snap) })
      // 失败时也要留一句原因：空数组会被读成「这个作者一条都没有」，而那通常不是事实。
      .catch(() => { if (!cancelled) setMonthlySnapForAuthor({ months: [], readError: '该作者的月度分布请求失败（已退回按已加载部分统计）' }) })
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

  // 八个条件全部交给 `moments-scope.ts`：筛选是纯函数，依赖数组只写在那一个地方，
  // 并由 `moments-scope.spec.ts` 的 AST 判据钉住「criteria 每个字段都必须进依赖」——
  // 这里原先连着七个 memo、每个依赖上一个的数组身份，已经因此漏掉过一次日期筛选。
  const { scoped, insight, topAuthors, monthly, monthMax, monthlyReadError } = useMomentsScope({
    moments,
    criteria: {
      search: deferredSearch,
      media: mediaFilter,
      author: authorFilter,
      mine: mineFilter,
      month: monthFilter,
      dateFrom,
      dateTo,
      order: sortOrder,
    },
    fullAuthors,
    monthlySnap,
    monthlySnapForAuthor,
  })

  const groups = useMemo(() => groupByDate(scoped), [scoped])
  const { count: grpCount, sentinelRef: grpSentinel } = useProgressiveList(groups.length, 25)

  // 离线媒体层（滚动懒解密 / 封面兜底 / IDB 恢复 / 灯箱按需解析）整个交给 moments-media.ts。
  const { scrollRef, snsImgs, articleCovers, mediaKeySpec } = useMomentsMedia({
    moments,
    viewer,
    groups,
    groupCount: grpCount,
  })

  // 导出弹窗 + 手动重同步整个交给 moments-export.ts。
  const exp = useMomentsExport({
    scope: {
      username: author,
      authorName: authorFilter,
      search,
      media: mediaFilter,
      month: monthFilter,
      mine: mineFilter,
    },
    reload: () => load(),
    notify: { flash, hold, clear },
  })
  const { exportOpen, setExportOpen, expFormat, setExpFormat, expFrom, setExpFrom, expTo, setExpTo,
    expDir, setExpDir, expImages, setExpImages, expZip, setExpZip, syncing, lastSync, pickingDir,
    exporting, exportedPath, setExportedPath, openExport, doSync, pickDir, doExport } = exp

  // 视频本体交给 moments-videos.ts（保存成功的落盘路径仍要记回面板那一行）。
  const { videoSrcs, videoFailed, videoErr, videoMeta, setVideoMeta, loadVideo, closeVideo,
    fullscreenVideo, saveVideo } = useMomentsVideos({ notify: { flash, hold, clear }, onSavedPath: setExportedPath })
  const moreRef = useRef<HTMLDivElement | null>(null)
  const moreInFlight = useRef(false)

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

  // Reset lightbox transform whenever a viewer opens or its index moves.
  // （「加载失败」不在这里复位：灯箱现在画的是 RemoteImg 的 failed 占位，状态跟着地址走。）
  useEffect(() => {
    setViewZoom(1)
    setViewPan({ x: 0, y: 0 })
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
    const src = (curImg && snsImgs[imgKey(curImg)]) || proxyableSrc(curImg?.url, curImg?.thumb)
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
    const src = proxyableSrc(curImg?.url, curImg?.thumb) || (curImg && snsImgs[imgKey(curImg)]) || ''
    if (!src) return
    void copyTextToClipboard(src).then((ok) => { if (ok) hold('已复制图片链接'); else hold('复制失败') })
  }

  // Copy arbitrary text to the clipboard.
  const copyText = (text: string): void => {
    if (!text) return
    // 成功与失败各一条 `hold`（而不是 `hold(ok ? … : …)`）：失败提示不许带定时器自动消失，
    // 而 `transient-notice.wiring.spec.ts` 正是按调用点数盯这件事的。
    void copyTextToClipboard(text).then((ok) => { if (ok) hold('已复制'); else hold('复制失败') })
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

      {/* 读失败必须与「没有动态」分开说（P1-1/#9）：月度直方图空着的时候，用户看到的
          一直是「我这个月没发过朋友圈」，而真实原因可能是快照损坏或库被占用。 */}
      {monthlyReadError !== '' && (
        <div className={css.insightNote} role="status">{monthlyReadError}</div>
      )}

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
