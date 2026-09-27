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
import { PanelHeader, SearchInput, useDialogFocus, useEscapeToClose } from '../ui/kit.tsx'
import { MomentsCard } from './moments-card.tsx'
import { MomentsSidebar } from './moments-sidebar.tsx'
import { MomentsDetail, MomentsExportDialog, MomentsImageViewer } from './moments-portals.tsx'
import { buildMomentRows, momentsEmptyText } from './moments-rows.ts'
import { MomentsTimeline } from './moments-timeline.tsx'
import { imageDownloadName, pickImageSrc, toggleInSet } from './moments-actions.ts'
import { copyTextToClipboard } from '../utils/misc.ts'
import { proxyableSrc } from '../utils/url.ts'
import css from './moments.module.css'
import { MediaFilter, fmtSyncTime, groupByDate, imgKey } from './moments-support.tsx'
import { useMomentsScope } from './moments-scope.ts'

/** 一行的估计高度：日期标签一行、卡片按"头像 + 正文两行"量级（真实高度由 `measureElement` 回灌）。 */
const MOMENT_DAY_ROW_PX = 30
const MOMENT_CARD_PX = 220
import { useMomentsMedia } from './moments-media.ts'
import { useMomentsExport } from './moments-export.ts'
import { useMomentsVideos } from './moments-videos.ts'
import { imageExtOf, useMomentsViewer } from './moments-viewer.ts'
import { useMomentsData } from './moments-data.ts'

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
  // 灯箱状态 + 缩放/平移/旋转/原图 + 方向键切图，交给 moments-viewer.ts。
  // 位置有约束：必须在 useMomentsMedia 之前（媒体层要按 viewer 决定给哪一张做离线解码）。
  const { viewer, setViewer, viewZoom, setViewZoom, viewPan, setViewPan, viewRotate, setViewRotate,
    viewOriginal, setViewOriginal, dragRef, pinchRef, lightboxWrapRef, viewZoomRef, curImg, setViewerIndex } =
    useMomentsViewer()
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
   * 卡片高度差得厉害（纯文字 vs 九宫格 vs 视频），所以 `estimateSize` 只是起点，
   * 真实高度靠 `measureElement` 回灌。
   */
  const momentRows = useMemo(() => buildMomentRows(groups), [groups])
  const momentVirtualizer = useVirtualizer({
    count: momentRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (momentRows[i]?.kind === 'day' ? MOMENT_DAY_ROW_PX : MOMENT_CARD_PX),
    overscan: 4,
  })
  const momentWindowItems = momentVirtualizer.getVirtualItems()
  /** 渲染窗口指纹：窗口一动，媒体层就重新观察一遍新挂载的占位块（见 `moments-media.ts`）。 */
  const momentRenderKey = momentWindowItems.length > 0
    ? String(momentWindowItems[0]?.index ?? 0) + '-' + String(momentWindowItems[momentWindowItems.length - 1]?.index ?? 0)
    : 'none'

  // 离线媒体层（滚动懒解密 / 封面兜底 / IDB 恢复 / 灯箱按需解析）整个交给 moments-media.ts。
  const { snsImgs, articleCovers, mediaKeySpec } = useMomentsMedia({
    moments,
    viewer,
    scrollRef,
    groups,
    renderKey: momentRenderKey,
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
  useEscapeToClose(viewer !== null, () => { setViewer(null) })
  useEscapeToClose(detail !== null, () => { setDetail(null) })
  useEscapeToClose(exportOpen, () => { setExportOpen(false) })
  // 焦点管理：进入移入、Tab 循环、关闭还原（手写弹窗没有 Radix 的那套）
  useDialogFocus(viewer !== null, '[data-st-dialog="moments-viewer"]')
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
          )}
        />
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
