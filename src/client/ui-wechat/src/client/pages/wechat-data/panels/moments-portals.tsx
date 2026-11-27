/**
 * 朋友圈的三个浮层：导出对话框 / 图片查看器 / 单条动态详情（M21 第二十三刀自 moments-panel.tsx 拆出）。
 *
 * 拆法：这些块原本长在面板的 return 里，**道具名与面板作用域里的名字完全相同** ⇒ JSX 可以逐行搬过来。
 * 只有两处结构性改动，都写在各组件上方：
 *   · `{cond && (…)}` 换成组件内的「早返回」（否则要包一层 fragment、多一层 DOM 语义）；
 *   · 原来读模块作用域的 `css` / `MEDIA_LABELS` 等改成从 support 模块 import（值一样）。
 * @module moments-portals
 */
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { MomentItem } from '@deepseek-ai/dsh-wechat-data/types'
import { clickableKey, DateRangeField } from '../ui/kit.tsx'
import { SafeExternalLink } from './chats-support.tsx'
import { desktopAction, desktopActionProps } from '../ui/desktop-only.tsx'
import { imgKey, MEDIA_LABELS, type MediaFilter, MomentsMiniAvatar, replyTarget } from './moments-support.tsx'
import { fmtCommentTimeSec } from '../utils/format.ts'
import { momentGridImages, momentImageSpec, momentLinkCardView, videoCoverKey, type MediaKeySpec } from './moments-media.ts'
import { RemoteImg } from './remote-img.tsx'
import { MediaViewer, type ViewerSource } from '../media-viewer/MediaViewer.tsx'
import { MomentLiveAction, MomentLiveBadge, momentLiveKey, momentLivePhoto, type MomentLiveMedia } from './moments-live.tsx'
import { saveMomentsLiveVideo } from './moments-live-download.ts'
import { saveMomentImageOriginal } from './moments-original-export.ts'
import { ExportProgressStatus } from './ExportProgressStatus.tsx'
import { useMediaSaveTask } from './media-save-task.ts'
import { MomentsVideoTile } from './moments-video-tile.tsx'
import css from './moments.module.css'
import kitCss from '../ui/kit.module.css'
import { withEnterprise } from './enterprise-identity.ts'
import type { ExportTaskState } from './export-task.ts'

/** 查看器里的一张图（与面板里 `useState` 的内联类型同构）。 */
export interface ViewerImage {
  thumb?: string
  url?: string
  md5?: string
  timelineId?: string
  id?: string
  mediaId?: string
  token?: string
  seed?: string
  key?: string
  originalWidth?: number
  originalHeight?: number
  originalBytes?: number
  uhdUrl?: string
  uhdToken?: string
  uhdSeed?: string
  uhdMd5?: string
  livePhoto?: MomentLiveMedia
  live?: MomentLiveMedia
}
const EMPTY_VIEWER_IMAGES: ViewerImage[] = []

/** 图片查看器的打开态：整组图 + 当前下标 + 作者。 */
export interface ViewerState { images: ViewerImage[]; index: number; author: string }

/** 视频引用（面板里 `loadVideo` / `saveVideo` 的参数形状）。 */
export interface SnsVideoRef { md5?: string; timelineId?: string; id?: string; url?: string; key?: string }

/** 导出对话框的道具。 */
export interface MomentsExportDialogProps {
  exportOpen: boolean
  setExportOpen: (v: boolean) => void
  authorFilter: string | null
  author: string | null | undefined
  search: string
  mediaFilter: MediaFilter
  monthFilter: string | null
  mineFilter: 'all' | 'mine' | 'others'
  expFormat: string
  setExpFormat: (f: string) => void
  expFrom: string
  setExpFrom: (v: string) => void
  expTo: string
  setExpTo: (v: string) => void
  expDir: string
  pickDir: () => unknown
  pickingDir: boolean
  expImages: boolean
  setExpImages: (v: boolean) => void
  expZip: boolean
  setExpZip: (v: boolean) => void
  expIncludeImages: boolean
  setExpIncludeImages: (v: boolean) => void
  expIncludeVideos: boolean
  setExpIncludeVideos: (v: boolean) => void
  expIncludeLivePhotos: boolean
  setExpIncludeLivePhotos: (v: boolean) => void
  doExport: () => unknown
  exportState: ExportTaskState
  exporting: boolean
  finishing: boolean
  cancelExport: () => void
}

/**
 * 「导出朋友圈」对话框。
 *
 * 原先是 `{exportOpen && (<div …>…)}` —— 这里改成早返回：`exportOpen` 为假时返回 null，
 * 为真时返回同一棵子树（DOM 结构与属性一字未改）。
 */
export function MomentsExportDialog({
  exportOpen, setExportOpen, authorFilter, author, search, mediaFilter, monthFilter, mineFilter,
  expFormat, setExpFormat, expFrom, setExpFrom, expTo, setExpTo, expDir, pickDir, pickingDir,
  expImages, setExpImages, expZip, setExpZip,
  expIncludeImages, setExpIncludeImages, expIncludeVideos, setExpIncludeVideos,
  expIncludeLivePhotos, setExpIncludeLivePhotos, doExport, exportState, exporting, finishing, cancelExport,
}: MomentsExportDialogProps): React.JSX.Element | null {
  if (!exportOpen) return null
  return (
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
              <DateRangeField
                from={expFrom}
                to={expTo}
                onFrom={setExpFrom}
                onTo={setExpTo}
                onClear={() => { setExpFrom(''); setExpTo('') }}
                presets={['today', 'week', 'month', 'last-7', 'last-30']}
                ariaLabel="朋友圈导出时间"
              />
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
              <label className={css.exportCheck} title="默认开启。HTML 会内嵌离线解码后的原图；关闭后只显示图片数量，不再输出不可用的 CDN 破图">
                <input type="checkbox" checked={expImages} onChange={(e) => { setExpImages(e.target.checked) }} disabled={expFormat !== 'html'} />
                <span>HTML 内嵌离线图片（推荐）</span>
              </label>
              <label className={css.exportCheck} title="把动态 JSON + 离线图片/视频打包成一个 ZIP（媒体较多时体积大）">
                <input type="checkbox" checked={expZip} onChange={(e) => { setExpZip(e.target.checked) }} />
                <span>ZIP 含媒体</span>
              </label>
              {expZip && (
                <>
                  <span className={css.exportHint}>包含原始：</span>
                  <label className={css.exportCheck} title="导出朋友圈中的原始图片文件">
                    <input type="checkbox" checked={expIncludeImages} onChange={(e) => { setExpIncludeImages(e.target.checked) }} />
                    <span>图片</span>
                  </label>
                  <label className={css.exportCheck} title="导出朋友圈中的原始视频文件">
                    <input type="checkbox" checked={expIncludeVideos} onChange={(e) => { setExpIncludeVideos(e.target.checked) }} />
                    <span>视频</span>
                  </label>
                  <label className={css.exportCheck} title="导出实况照片中的原始视频文件">
                    <input type="checkbox" checked={expIncludeLivePhotos} onChange={(e) => { setExpIncludeLivePhotos(e.target.checked) }} />
                    <span>实况图</span>
                  </label>
                </>
              )}
            </div>
          </div>
          <ExportProgressStatus state={exportState} onCancel={cancelExport} />
          <button type="button" className={`${css.btn} ${css.btnBottom}`} onClick={() => { void doExport() }} disabled={exporting}>
            {finishing ? '完成中…' : exporting ? '导出中…' : '导出'}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * 图片查看器（灯箱）。
 *
 * 原先是面板 return 里的 `{viewer && createPortal(…)}` —— 这里改成早返回：
 * `viewer` 为假时返回 null，为真时返回同一棵子树（DOM 结构与属性一字未改）。
 * 状态与副作用仍留在面板：重置/滚轮/键盘/按需解码四个 effect 都读面板里的 state，
 * 一起搬会改掉「何时重跑」的时机；只搬 JSX，道具名与面板作用域里的名字完全相同。
 */
/**
 * 朋友圈图片查看器（2026-10-21 接入统一 `MediaViewer`）。
 *
 * 保留朋友圈专属能力：复制链接、保存原图、旋转 90°、缩略图条；
 * 缩放/拖拽/双击/方向键/预取/错误重试走共享壳。
 */
export interface MomentsImageViewerProps {
  viewer: ViewerState | null
  setViewer: (v: ViewerState | null) => void
  setViewerIndex: (index: number) => void
  curImg: ViewerImage | undefined
  snsImgs: Record<string, string>
  snsOriginals: ReadonlySet<string>
  resolveSnsOriginal: (im: ViewerImage, options?: { retry?: boolean }) => Promise<string>
  copyCurrentLink: () => void
  viewRotate: number
  setViewRotate: React.Dispatch<React.SetStateAction<number>>
  videoSrcs: Record<string, string>
  videoFailed: Set<string>
  videoErr: Map<string, string>
  loadVideo: (vk: string, v: SnsVideoRef) => void
  closeVideo: (vk: string) => void
  onLiveVideoSaved?: (path: string, bytes?: number) => void
  onImageSaved?: (path: string, bytes?: number) => void
}

export function MomentsImageViewer({
  viewer, setViewer, setViewerIndex, curImg, snsImgs, snsOriginals, resolveSnsOriginal, copyCurrentLink,
  viewRotate, setViewRotate, videoSrcs, videoFailed, videoErr, loadVideo, closeVideo,
  onLiveVideoSaved, onImageSaved,
}: MomentsImageViewerProps): React.JSX.Element | null {
  const [activeLiveKey, setActiveLiveKey] = useState('')
  const activeLiveKeyRef = useRef('')
  const snsImgsRef = useRef(snsImgs)
  snsImgsRef.current = snsImgs
  const snsOriginalsRef = useRef(snsOriginals)
  snsOriginalsRef.current = snsOriginals
  const imageSave = useMediaSaveTask()
  const liveSave = useMediaSaveTask()

  useEffect(() => { activeLiveKeyRef.current = activeLiveKey }, [activeLiveKey])

  // 查看器换图时退出实况播放，避免上一张的动态画面挂到下一张静态图上。
  useEffect(() => {
    const key = activeLiveKeyRef.current
    if (key === '') return
    closeVideo(key)
    activeLiveKeyRef.current = ''
    setActiveLiveKey('')
  }, [viewer?.index, closeVideo])

  // 关闭灯箱/组件卸载时一并释放视频 blob 与诊断状态。
  useEffect(() => () => {
    const key = activeLiveKeyRef.current
    if (key !== '') closeVideo(key)
  }, [closeVideo])

  const currentImage = viewer?.images[viewer.index]
  const currentLive = momentLivePhoto(currentImage)
  const currentLiveKey = currentLive === null || currentImage === undefined ? '' : momentLiveKey(currentImage, viewer?.index ?? 0)
  const liveActive = currentLiveKey !== '' && activeLiveKey === currentLiveKey
  const liveSrc = liveActive ? (videoSrcs[activeLiveKey] ?? '') : ''
  const liveFailed = liveActive && videoFailed.has(activeLiveKey)
  const liveLoading = liveActive && liveSrc === '' && !liveFailed
  const liveError = liveActive ? (videoErr.get(activeLiveKey) ?? '') : ''
  const viewerImages = viewer?.images ?? EMPTY_VIEWER_IMAGES
  const sources: ViewerSource[] = useMemo(() => viewerImages.map((im, i) => {
    const imageKey = imgKey(im)
    const imageLive = momentLivePhoto(im)
    // 只喂后端解出的 data URL；`im.thumb` 是 CDN 密文地址，画不出来也不能当占位。
    const thumb = snsImgsRef.current[imageKey]
    if (i === viewer?.index && liveActive && liveSrc !== '') {
      const onDownload = imageLive === null ? undefined : async (): Promise<void> => {
        if (desktopAction()) throw new Error('实况原视频仅支持电脑端保存')
        const outcome = await liveSave.save<{ path?: string; bytes?: number }>({
          idPrefix: 'moment-live-video',
          label: '保存朋友圈实况原视频',
          successMessage: (r) => `已保存实况原视频 → ${r.path ?? ''}`,
          run: async (jobId) => {
            const saved = await saveMomentsLiveVideo(imageLive, jobId)
            return saved.canceled ? null : saved
          },
        })
        if (outcome.ok) onLiveVideoSaved?.(outcome.result.path ?? '', outcome.result.bytes)
      }
      return {
        key: activeLiveKey,
        thumb,
        title: viewer.author,
        subtitle: '实况照片',
        kind: 'video' as const,
        downloadName: '朋友圈实况-' + (imageLive?.md5 || 'video').slice(0, 8) + '.mp4',
        downloadDisabled: desktopAction(),
        downloadDisabledReason: '实况原视频保存仅支持电脑端',
        ...(imageLive?.stillTimeMs !== undefined ? { startAtMs: imageLive.stillTimeMs } : {}),
        ...(onDownload ? { onDownload } : {}),
        load: async (): Promise<string> => liveSrc,
      }
    }
    return {
      key: imageKey || `${String(i)}-${String(im.md5 ?? im.id ?? '')}`,
      thumb,
      title: viewer?.author ?? '',
      subtitle: imageLive === null ? undefined : '实况照片',
      onDownload: async (src: string): Promise<void> => {
        if (!snsOriginalsRef.current.has(imageKey)) {
          throw new Error('原图尚未就绪，请稍后重试')
        }
        const outcome = await imageSave.save<{ path?: string; bytes?: number }>({
          idPrefix: 'moment-image',
          label: '保存朋友圈原图',
          successMessage: (r) => `已保存朋友圈原图 → ${r.path ?? ''}`,
          run: (jobId) => saveMomentImageOriginal(im, src, jobId, i),
        })
        if (outcome.ok) onImageSaved?.(outcome.result.path ?? '', outcome.result.bytes)
      },
      downloadDisabled: desktopAction(),
      downloadDisabledReason: '朋友圈原图保存仅支持电脑端',
      // 本地有缩略图也继续回源；是否已确认原图由媒体层判断。
      load: async (options): Promise<string> => resolveSnsOriginal(im, options),
    }
  }), [viewerImages, viewer?.index, viewer?.author, liveActive, liveSrc, activeLiveKey, liveSave.save, imageSave.save, onLiveVideoSaved, onImageSaved, resolveSnsOriginal])

  if (!viewer) return null

  const stopLive = (): void => {
    const key = activeLiveKeyRef.current
    if (key !== '') closeVideo(key)
    activeLiveKeyRef.current = ''
    setActiveLiveKey('')
  }

  const changeIndex = (next: number): void => {
    stopLive()
    setViewerIndex(next)
  }

  const toggleLive = (): void => {
    if (currentLive === null || currentLiveKey === '') return
    if (liveActive) {
      stopLive()
      if (!liveFailed) return
    }
    if (activeLiveKeyRef.current !== '') stopLive()
    activeLiveKeyRef.current = currentLiveKey
    setActiveLiveKey(currentLiveKey)
    loadVideo(currentLiveKey, currentLive)
  }

  const canCopy = Boolean(curImg?.url || (curImg ? snsImgs[imgKey(curImg)] : '') || curImg?.thumb)
  const canSave = Boolean(curImg && snsOriginals.has(imgKey(curImg)) && snsImgs[imgKey(curImg)])
  const saveCurrentImage = async (): Promise<void> => {
    if (!curImg || !canSave) return
    const src = snsImgsRef.current[imgKey(curImg)] ?? ''
    if (!src) return
    const outcome = await imageSave.save<{ path?: string; bytes?: number }>({
      idPrefix: 'moment-image',
      label: '保存朋友圈原图',
      successMessage: (r) => `已保存朋友圈原图 → ${r.path ?? ''}`,
      run: (jobId) => saveMomentImageOriginal(curImg, src, jobId, viewer.index),
    })
    if (outcome.ok) onImageSaved?.(outcome.result.path ?? '', outcome.result.bytes)
  }
  return (
    <MediaViewer
      sources={sources}
      index={viewer.index}
      onIndexChange={changeIndex}
      onClose={() => { stopLive(); setViewer(null) }}
      dialogName="moments-viewer"
      showThumbnails={viewer.images.length > 1}
      minZoom={1}
      maxZoom={5}
      rotate={viewRotate}
      headerActions={(
        <>
          <button type="button" className={css.btn} onClick={copyCurrentLink} disabled={!canCopy} title="复制链接">复制</button>
          <button type="button" className={css.btn} onClick={() => { void saveCurrentImage() }} disabled={!canSave || imageSave.running} title="保存到本地" {...desktopActionProps()}>保存</button>
        </>
      )}
      extraToolbar={(
        <>
          <button type="button" className={css.btn} onClick={() => { setViewRotate(r => (r + 90) % 360) }} title="旋转90°">↻</button>
          {currentLive !== null && currentLiveKey !== '' && (
            <MomentLiveAction
              active={liveActive}
              loading={liveLoading}
              failed={liveFailed}
              error={liveError}
              onToggle={toggleLive}
            />
          )}
        </>
      )}
      statusOverlay={(
        <>
          <ExportProgressStatus
            compact
            state={imageSave.state}
            onCancel={() => { void imageSave.cancel() }}
          />
          <ExportProgressStatus
            compact
            state={liveSave.state}
            onCancel={() => { void liveSave.cancel() }}
          />
        </>
      )}
    />
  )
}

/**
 * 单条动态详情弹层。
 *
 * 原先是面板 return 里的 `{detail && createPortal(…)}` —— 早返回，DOM 一字未改。
 * 与查看器同理：只搬 JSX，涉及的状态/副作用仍由面板持有（只有面板同时给卡片用）。
 */
export interface MomentsDetailProps {
  detail: { m: MomentItem } | null
  setDetail: React.Dispatch<React.SetStateAction<{ m: MomentItem } | null>>
  setViewer: (v: ViewerState | null) => void
  setAuthorFilter: React.Dispatch<React.SetStateAction<string | null>>
  snsImgs: Record<string, string>
  articleCovers: Record<string, string>
  videoSrcs: Record<string, string>
  videoLoading: Set<string>
  videoMeta: Record<string, { w: number; h: number }>
  setVideoMeta: React.Dispatch<React.SetStateAction<Record<string, { w: number; h: number }>>>
  videoFailed: Set<string>
  videoErr: Map<string, string>
  loadVideo: (vk: string, v: SnsVideoRef) => void
  reportVideoError: (vk: string, message: string) => void
  saveVideo: (v: SnsVideoRef) => void
  fullscreenVideo: (tile: Element | null) => void
  closeVideo: (vk: string) => void
  /**
   * 取图接线登记表（与卡片共用同一个 ref）。
   *
   * 详情浮层里的评论图原来**既没登记 spec 也没挂 `data-sns-key`** ⇒ 就算后端解出来了
   * 也没人触发取图，恒显示 [图]。这里补上登记；节点挂在 `<div>` 上而不是 `RemoteImg` 上，
   * 因为 RemoteImg 在拿到 data URL 之前画的是占位而不是 `<img>`（`remote-image-wiring.spec.ts` 盯这条）。
   */
  mediaKeySpec: React.MutableRefObject<Map<string, MediaKeySpec>>
}

export function MomentsDetail({
  detail, setDetail, setViewer, setAuthorFilter, snsImgs, articleCovers, mediaKeySpec,
  videoSrcs, videoLoading, videoMeta, setVideoMeta, videoFailed, videoErr,
  loadVideo, reportVideoError, saveVideo, fullscreenVideo, closeVideo,
}: MomentsDetailProps): React.JSX.Element | null {
  if (!detail) return null
  const gridImages = momentGridImages(detail.m)
  const cover = gridImages[0]
  const coverKey = cover ? imgKey(cover) : ''
  const coverSpec = cover ? momentImageSpec(cover) : null
  const linkView = momentLinkCardView(detail.m, snsImgs, articleCovers)
  if (coverKey && coverSpec) mediaKeySpec.current.set(coverKey, coverSpec)
  return createPortal(
      <div className={css.overlay} data-st-dialog="moments-detail" onClick={() => { setDetail(null) }} role="dialog" aria-modal="true">
        <div className={css.detailCard} onClick={(e) => { e.stopPropagation() }}>
          <div className={css.lightboxHead}>
            <span className={css.detailAuthor}>
              <MomentsMiniAvatar username={detail.m.username} name={detail.m.author || detail.m.username} />
              <span className={css.detailAuthorText}>{withEnterprise(detail.m.author || '未知', detail.m.enterpriseName)} · {detail.m.time}</span>
            </span>
            <button type="button" className={css.btn} onClick={() => { setDetail(null) }} aria-label="关闭">×</button>
          </div>
          <div className={css.detailBody}>
            {detail.m.text && <div className={css.content}>{detail.m.text}</div>}
            {gridImages.length > 0 && linkView.showImages && (
              <div className={[css.images, gridImages.length === 1 ? css.imagesSingle : ''].filter(Boolean).join(' ')}>
                {gridImages.map((im, ii) => {
                  const key = imgKey(im)
                  const dataSrc = key ? snsImgs[key] : undefined
                  const live = momentLivePhoto(im)
                  const spec = momentImageSpec(im)
                  if (key && spec) mediaKeySpec.current.set(key, spec)
                  // 详情弹层里的图片同样是**固定纵横比的框**（.imgWrap 有 aspect-ratio），
                  // 失败时隐藏图片会留下一个空方块 —— 与卡片视图同一套口径：给占位，不留空。
                  return (
                    <div key={ii} className={css.imgWrap} data-sns-key={key || undefined} title={live ? '点击查看大图（实况）' : '点击查看大图'} {...clickableKey(() => {
                      // 详情浮层与查看器都是 body portal；先收起层级更高的详情，查看器才能可见、可操作。
                      setDetail(null)
                      setViewer({ images: gridImages, index: ii, author: withEnterprise(detail.m.author || '未知', detail.m.enterpriseName) })
                    })}>
                      <RemoteImg
                        src={dataSrc || ''}
                        alt=""
                        loading="lazy"
                        className={css.img}
                        empty={<div className={css.imgFallback}>正在取原图…</div>}
                        pending={<div className={css.imgFallback}>加载中</div>}
                        failed={<div className={css.imgFallback}>图片加载失败</div>}
                      />
                      {live && <MomentLiveBadge />}
                    </div>
                  )
                })}
              </div>
            )}
            {detail.m.videos.length > 0 && (
              <div className={css.videos}>
                {detail.m.videos.map((v, vi) => {
                  const vk = videoCoverKey(v)
                  const vCover = vk ? snsImgs[vk] : undefined
                  return (
                    <MomentsVideoTile
                      key={vi}
                      v={v}
                      vk={vk}
                      cover={vCover}
                      src={vk ? videoSrcs[vk] : undefined}
                      meta={vk ? videoMeta[vk] : undefined}
                      loading={videoLoading.has(vk)}
                      failed={videoFailed.has(vk)}
                      error={videoErr.get(vk)}
                      detail
                      setVideoMeta={setVideoMeta}
                      loadVideo={loadVideo}
                      reportVideoError={reportVideoError}
                      saveVideo={saveVideo}
                      fullscreenVideo={fullscreenVideo}
                      closeVideo={closeVideo}
                    />
                  )
                })}
              </div>
            )}
            {detail.m.link_title && (
              <div className={css.linkCard}>
                {(cover || detail.m.link_thumb || detail.m.contentType === 3) && (
                  <div className={css.linkCover} data-sns-key={coverKey || undefined}>
                    <RemoteImg
                      src={linkView.coverSrc}
                      alt=""
                      empty={<span className={css.linkCoverFallback} title="正在读取公众号封面">🔗</span>}
                      pending={<span className={css.linkCoverFallback}>…</span>}
                      failed={<span className={css.linkCoverFallback} title="封面来自微信 CDN，原链接已失效">🔗</span>}
                    />
                  </div>
                )}
                <div className={css.linkBody}>
                  {detail.m.link_url
                    ? <SafeExternalLink className={css.linkTitle} href={detail.m.link_url} title={linkView.title}>{linkView.title}</SafeExternalLink>
                    : <span className={css.linkTitle} title={linkView.title}>{linkView.title}</span>}
                  <div className={kitCss.textMeta}>{linkView.label}</div>
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
                      <span className={css.clickableName} title={'只看 ' + withEnterprise(l.nickname || l.username || '未知', l.enterpriseName)} {...clickableKey(() => { setAuthorFilter(l.nickname || l.username || null) }, { stopPropagation: true })}>{withEnterprise(l.nickname || l.username || '未知', l.enterpriseName)}</span>
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
                  // 登记取图接线：url/token/seed 缺一不可（实测裸 <url> 5/5 返 HTTP 400）。
                  if (img?.md5) mediaKeySpec.current.set(img.md5, {
                    md5: img.md5,
                    kind: 'comment',
                    ...(img.url ? { url: img.url } : {}),
                    ...(img.token ? { token: img.token } : {}),
                    ...(img.seed ? { seed: img.seed } : {}),
                    ...(img.thumb ? { thumb: img.thumb } : {}),
                  })
                  return (
                    /* data-sns-* 必须挂在这个**永远在 DOM 里**的 div 上：RemoteImg 在拿到
                       data URL 之前画的是占位而不是 <img>，挂它身上这一格就永远不会被观察到。 */
                    <div key={ci} className={css.comment} data-sns-key={img?.md5 || undefined} data-sns-md5={img?.md5 || undefined}>
                      <MomentsMiniAvatar username={c.username} name={c.nickname || c.username} />
                      <span className={css.commentName} title={'只看 ' + withEnterprise(c.nickname || c.username || '未知', c.enterpriseName)} {...clickableKey(() => { setAuthorFilter(c.nickname || c.username || null) }, { stopPropagation: true })}>{withEnterprise(c.nickname || c.username || '未知', c.enterpriseName)}</span>
                      {c.to_username && c.to_username !== detail.m.username && (
                        <span className={css.commentReply}>
                          回复
                          <MomentsMiniAvatar username={c.to_username} name={c.to_nickname || c.to_username} />
                          <span className={css.commentReplyName}>{withEnterprise(c.to_nickname || c.to_username, c.toEnterpriseName)}{target ? '：' : ''}</span>
                        </span>
                      )}
                      {target && <span className={kitCss.textCaption}>“{target.content.slice(0, 40)}”</span>}
                      <span className={css.commentText}>{c.content || ''}</span>
                      {img && cdata && (
                        <RemoteImg key={'img' + String(ci)} src={cdata} alt="" loading="lazy" className={css.commentImg} failed={<span className={css.commentImgFallback}>[图]</span>} {...clickableKey(() => {
                          setDetail(null)
                          setViewer({
                            images: [{
                              thumb: img.thumb,
                              url: img.url,
                              md5: img.md5,
                              mediaId: img.mediaId,
                              token: img.token,
                              seed: img.seed,
                            }],
                            index: 0,
                            author: withEnterprise(c.nickname || c.username || '', c.enterpriseName),
                          })
                        }, { label: '查看大图' })} />
                      )}
                      {c.ts > 0 && <span className={css.commentTime}>{fmtCommentTimeSec(c.ts)}</span>}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>,
      document.body,
  )
}
