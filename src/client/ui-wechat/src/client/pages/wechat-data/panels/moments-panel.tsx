/**
 * `Moments.tsx` 的「面板本体：MomentsPanel 的取数、筛选、媒体与视频加载、渲染」部分（M21 拆分）。
 *
 * 从原模块原样搬出，**行为逐字节不变**；原文件继续以 `export *` 转发
 * ⇒ 所有既有 import 一行都不用改。
 *
 * @module moments-panelx
 */

import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useTransientNotice } from './hooks.tsx'
import { apiOpenPath } from '../api.ts'
import type { MomentItem } from '@deepseek-ai/dsh-wechat-data/types'
import { Drawer, SearchInput, useDialogFocus, useEscapeToClose } from '../ui/kit.tsx'
import { desktopAction, desktopActionProps } from '../ui/desktop-only.tsx'
import { MomentsCard } from './moments-card.tsx'
import { MomentsSidebar } from './moments-sidebar.tsx'
import { MomentsDetail, MomentsExportDialog, MomentsImageViewer } from './moments-portals.tsx'
import { buildMomentRows, momentsEmptyText, type MomentRow } from './moments-rows.ts'
import { MomentsTimeline } from './moments-timeline.tsx'
import { imageDownloadName, pickImageSrc, toggleInSet } from './moments-actions.ts'
import { copyTextToClipboard } from '../utils/misc.ts'
import { proxyableSrc } from '../utils/url.ts'
import css from './moments.module.css'
import { MediaFilter, groupByDate, imgKey } from './moments-support.tsx'
import { fmtHourMinuteMs } from '../utils/format.ts'
import { useMomentsScope } from './moments-scope.ts'

/** 一行的估计高度：日期标签一行、卡片按"头像 + 正文两行"量级（真实高度由 `measureElement` 回灌）。 */
const MOMENT_DAY_ROW_PX = 30
const MOMENT_CARD_PX = 220

/**
 * 时间线虚拟化的稳定行 key。
 *
 * 为什么必须给：不给时 `@tanstack/react-virtual` 用**下标**当 key，而 `measureElement`
 * 量到的真实高度是**按 key 缓存**的。筛选/排序一变，同一行下标指向另一条动态 ——
 * 缓存的高度就串到别人身上，接着整窗重新测量；滚动时窗口一移动，新进场的行
 * 又都是"没量过"的，于是每帧都在测量 + 重排。真机实测朋友圈滚动 p50 9ms、
 * p90 14ms、p99 29ms、单帧最长 97ms，并伴随一次 92ms 长任务（CDP 滚动探针），
 * 而它的节点数只有 148 —— 卡的不是节点多，是测量。
 *
 * 消息流（`Chats.tsx`）从一开始就带着 `getItemKey: msgItemKey`，这里补齐同一形状。
 * 日期行用 `day`（同一天只会有一行），动态行用 `tid`（朋友圈的稳定主键）。
 * @param row - `buildMomentRows` 的产物。
 * @returns 虚拟化与 React 共用的 key。
 */
function momentRowKey(row: MomentRow | undefined): string {
  if (!row) return 'nil'
  return row.kind === 'day' ? 'day-' + row.day : 'm-' + String(row.m.tid)
}
import { useMomentsMedia } from './moments-media.ts'
import { useMomentsExport } from './moments-export.ts'
import { useMomentsVideos } from './moments-videos.ts'
import { imageExtOf, useMomentsViewer } from './moments-viewer.ts'
import { useMomentsData } from './moments-data.ts'

/**
 * 朋友圈工具行：搜索 + 共 N 条（灰字）+ 更多 ▾。
 * 隐私/刷新/同步/导出/筛选都收在「更多」里 —— 页头只留两个可见动作。
 */
function MomentsToolbar(props: {
  search: string
  onSearch: (v: string) => void
  total: number
  author?: string | null | undefined
  onClearAuthor?: (() => void) | undefined
  privacy: boolean
  loading: boolean
  syncing: boolean
  lastSync: number
  onTogglePrivacy: () => void
  onRefresh: () => void
  onSync: () => void
  openExport: () => void
  onOpenFilter: () => void
}): React.JSX.Element {
  const { search, onSearch, total, author, onClearAuthor, privacy, loading, syncing, lastSync, onTogglePrivacy, onRefresh, onSync, openExport, onOpenFilter } = props
  const [moreOpen, setMoreOpen] = useState(false)
  const barRef = useRef<HTMLDivElement | null>(null)
  // 点外面 / 按 Esc 关闭「更多」菜单。
  useEffect(() => {
    if (!moreOpen) return
    const onDown = (e: MouseEvent): void => {
      if (barRef.current !== null && !barRef.current.contains(e.target as Node)) setMoreOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setMoreOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [moreOpen])
  return (
    <div className={css.momentBar} ref={barRef}>
      <SearchInput value={search} onChange={onSearch} placeholder="搜索作者 / 内容 / 位置 / 评论" ariaLabel="搜索朋友圈" className={css.hdSearch} />
      <span className={css.countText}>共 {total} 条</span>
      {author && onClearAuthor && (
        <button type="button" className={css.btn} onClick={onClearAuthor} title="返回全部动态">仅看 {author} ✕</button>
      )}
      <span className={css.barSpacer} />
      <div className={css.moreWrap}>
        <button
          type="button"
          className={css.btn}
          aria-haspopup="menu"
          aria-expanded={moreOpen}
          onClick={() => { setMoreOpen(v => !v) }}
        >更多 ▾</button>
        {moreOpen && (
          <div className={css.moreMenu} role="menu" aria-label="朋友圈更多操作">
            <button type="button" role="menuitem" className={css.menuItem} onClick={() => { setMoreOpen(false); onOpenFilter() }}>筛选…</button>
            <button type="button" role="menuitem" className={css.menuItem} data-on={privacy || undefined} onClick={() => { setMoreOpen(false); onTogglePrivacy() }} title="隐私模式：模糊头像与内容，悬停查看">{privacy ? '关闭隐私模式' : '隐私模式'}</button>
            <button type="button" role="menuitem" className={css.menuItem} onClick={() => { setMoreOpen(false); onRefresh() }} disabled={loading}>刷新</button>
            <button type="button" role="menuitem" className={css.menuItem} data-on={syncing || undefined} onClick={() => { setMoreOpen(false); onSync() }} disabled={syncing}>{syncing ? '同步中…' : '重新同步'}</button>
            {lastSync > 0 && <span className={css.syncStatus}>最近同步 {fmtHourMinuteMs(lastSync)}</span>}
            <button type="button" role="menuitem" className={css.menuItem} onClick={openExport} {...desktopActionProps()}>{desktopAction() ? '导出（仅电脑）' : '导出'}</button>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Render the moments (朋友圈) panel.
 * @param props - optional author filter (from contact profile "TA 的朋友圈")
 *   and a callback to clear it.
 * @returns the moments element tree.
 */
export function MomentsPanel({ author, onClearAuthor }: { author?: string | null; onClearAuthor?: () => void }): React.JSX.Element {
  const [search, setSearch] = useState('')
  const deferredSearch = useDeferredValue(search)
  const [mediaFilter, setMediaFilter] = useState<MediaFilter>('all')
  const [privacy, setPrivacy] = useState(false)
  /** 右栏筛选改成抽屉（时间线因此可以满宽）。 */
  const [filterOpen, setFilterOpen] = useState(false)
  const [expandedTextByCard, setExpandedTextByCard] = useState<Set<string>>(new Set())
  const [expandedSocialByCard, setExpandedSocialByCard] = useState<Set<string>>(new Set())
  const [commentCounts, setCommentCounts] = useState<Record<string, number>>({})
  const [commentSortByCard, setCommentSortByCard] = useState<Record<string, 'asc' | 'desc'>>({})
  const [onlyMineComments, setOnlyMineComments] = useState(false)
  const [monthFilter, setMonthFilter] = useState<string | null>(null)
  const [mineFilter, setMineFilter] = useState<'all' | 'mine' | 'others'>('all')
  const [authorFilter, setAuthorFilter] = useState<string | null>(null)
  const [showAllAuthors, setShowAllAuthors] = useState(false)
  const [sortOrder, setSortOrder] = useState<'desc' | 'asc'>('desc')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [detail, setDetail] = useState<{ m: MomentItem } | null>(null)
  // 灯箱状态：切换/索引/旋转交给 moments-viewer.ts；缩放/拖拽/方向键由共享 MediaViewer 负责
  // （`keyboard:false` 关掉旧的方向键监听，避免与共享壳双跳）。位置仍在 useMomentsMedia 之前
  // —— 媒体层要按 viewer 决定给哪一张做离线解码。
  const { viewer, setViewer, viewRotate, setViewRotate, curImg, setViewerIndex } =
    useMomentsViewer({ keyboard: false })
  // 提示语自动消失（L20）：原手写的 3 处 `setTimeout(…, 6000)` 已由 hook 统一管理。
  // 复制结果与各类失败提示改前不带定时器（一直留着），所以走 hold 而不是 flash。
  const { notice, flash, hold, clear } = useTransientNotice(6000)

  // 取数（分页 / 渲染缓存秒开 / 全量 / 静默增量刷新 + 三份侧栏附赠数据）交给 moments-data.ts。
  const { moments, loading, loadingAll, error, total, monthlySnap, monthlySnapForAuthor,
    selfUsername, fullAuthors, countRef, totalRef, moreInFlight, load, loadAll } =
    useMomentsData({ author, authorFilter })

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
  /** 时间线的滚动容器（媒体层的观察器与虚拟器共用它；由面板持有，见 `moments-media.ts` 那条注释）。 */
  const scrollRef = useRef<HTMLDivElement | null>(null)
  /**
   * 时间线虚拟化（#22 最后一处长列表）。行 = 日期标签 + 该天每条动态各一行
   * （摊平在 `moments-rows.ts`，两套下标只会长出"最后一天的标签不见了"那种错）。
   * 卡片高度差得厉害（纯文字 vs 九宫格 vs 视频），所以 `estimateSize` 只是起点，真实高度靠 `measureElement` 回灌。
   */
  const momentRows = useMemo(() => buildMomentRows(groups), [groups])
  const momentVirtualizer = useVirtualizer({
    count: momentRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (momentRows[i]?.kind === 'day' ? MOMENT_DAY_ROW_PX : MOMENT_CARD_PX),
    overscan: 4,
    getItemKey: (i) => momentRowKey(momentRows[i]),
  })
  const momentWindowItems = momentVirtualizer.getVirtualItems()
  /** 渲染窗口指纹：窗口一动，媒体层就重新观察一遍新挂载的占位块（见 `moments-media.ts`）。 */
  const momentRenderKey = momentWindowItems.length > 0
    ? String(momentWindowItems[0]?.index ?? 0) + '-' + String(momentWindowItems[momentWindowItems.length - 1]?.index ?? 0)
    : 'none'

  // 离线媒体层（滚动懒解密 / 封面兜底 / IDB 恢复 / 灯箱按需解析）整个交给 moments-media.ts。
  const { snsImgs, snsErrs, articleCovers, mediaKeySpec } = useMomentsMedia({
    moments,
    viewer,
    scrollRef,
    groups,
    renderKey: momentRenderKey,
    detailKey: detail?.m.tid ?? '',
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
  // Esc 关闭走 kit 的共享栈：灯箱与详情同时打开时，一次 Esc 只关最上层（原来两个监听会一起关）
  useEscapeToClose(detail !== null, () => { setDetail(null) })
  useEscapeToClose(exportOpen, () => { setExportOpen(false) })
  // 焦点管理：进入移入、Tab 循环、关闭还原（手写弹窗没有 Radix 的那套）
  useDialogFocus(detail !== null, '[data-st-dialog="moments-detail"]')
  useDialogFocus(exportOpen, '[data-st-dialog="moments-export"]')

  /** 灯箱当前那张图的两个源；两个动作各取一个当首选（口径与理由见 `moments-actions.ts`）。 */
  const viewerLocalSrc = (): string => (curImg ? snsImgs[imgKey(curImg)] || '' : '')
  const viewerRemoteSrc = (): string => proxyableSrc(curImg?.url, curImg?.thumb) || ''

  // Save the currently displayed image (data URL → download).
  const saveCurrentImage = (): void => {
    const src = pickImageSrc(viewerLocalSrc(), viewerRemoteSrc(), 'local')
    if (!src) return
    const a = document.createElement('a')
    a.href = src
    a.download = imageDownloadName(viewer?.index ?? 0, imageExtOf(src))
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  // Copy the currently displayed image's source (CDN url preferred, else data URL).
  const copyCurrentLink = (): void => {
    const src = pickImageSrc(viewerLocalSrc(), viewerRemoteSrc(), 'remote')
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

  const toggleText = (tid: string): void => { setExpandedTextByCard(prev => toggleInSet(prev, tid)) }

  const toggleSocial = (tid: string): void => { setExpandedSocialByCard(prev => toggleInSet(prev, tid)) }

  const clearFilters = (): void => { setSearch(''); setMediaFilter('all'); setMonthFilter(null); setMineFilter('all'); setAuthorFilter(null); setDateFrom(''); setDateTo('') }

  return (
    <div className={css.panel}>
      {/* 页头压缩成一条工具行：搜索 + 共 N 条（灰字）+ 更多。
          标题「朋友圈」已由分段条承载，这里不再重复；隐私/刷新/同步/导出/筛选全部收进「更多」。 */}
      <MomentsToolbar
        search={search} onSearch={setSearch} total={total}
        author={author} onClearAuthor={onClearAuthor}
        privacy={privacy} loading={loading} syncing={syncing} lastSync={lastSync}
        onTogglePrivacy={() => { setPrivacy(v => !v) }}
        onRefresh={() => { void load() }}
        onSync={() => { void doSync() }}
        openExport={openExport}
        onOpenFilter={() => { setFilterOpen(true) }}
      />

      {/* 读失败必须与「没有动态」分开说（P1-1/#9）：月度直方图空着的时候，用户看到的
          一直是「我这个月没发过朋友圈」，而真实原因可能是快照损坏或库被占用。 */}
      {monthlyReadError !== '' && (
        <div className={css.insightNote} role="status">{monthlyReadError}</div>
      )}

      <div className={css.layout}>
        <MomentsTimeline
          rows={momentRows}
          virtualizer={momentVirtualizer}
          scrollRef={scrollRef}
          loading={loading}
          error={error}
          loaded={moments.length}
          total={total}
          searching={!!search}
          loadingAll={loadingAll}
          onLoadAll={() => { void loadAll() }}
          emptyText={momentsEmptyText({ search, mediaFilter, monthFilter, mineFilter, authorFilter, dateFrom, dateTo, loaded: moments.length, total })}
          renderCard={(m) => (
            <MomentsCard
              m={m}
              privacy={privacy}
              snsImgs={snsImgs} snsErrs={snsErrs}
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
          )}
        />
      </div>

      {/* 右栏筛选改抽屉：时间线满宽，筛选不再长期占掉 1/3 宽度。 */}
      <Drawer open={filterOpen} onClose={() => { setFilterOpen(false) }} title="筛选" width={460}>
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
      </Drawer>
      {notice && <div className={css.hint}>{notice}</div>}
      {exportedPath && (
        <div className={css.exportResult}>
          <span className={css.exportResultPath} title={exportedPath}>{exportedPath}</span>
          <button type="button" className={css.btn} onClick={() => { void apiOpenPath(exportedPath).then((r) => { if (!r.ok) hold(r.error ?? '无法打开文件') }).catch(() => { hold('无法打开文件') }) }} {...desktopActionProps()}>打开导出文件</button>
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
        viewRotate={viewRotate}
        setViewRotate={setViewRotate}
      />

      {/* 单条动态详情 */}
      <MomentsDetail
        detail={detail}
        setDetail={setDetail}
        setViewer={setViewer}
        setAuthorFilter={setAuthorFilter}
        snsImgs={snsImgs}
        mediaKeySpec={mediaKeySpec}
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
