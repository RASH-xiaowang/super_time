/**
 * 朋友圈的三个浮层：导出对话框 / 图片查看器 / 单条动态详情（M21 第二十三刀自 moments-panel.tsx 拆出）。
 *
 * 拆法：这些块原本长在面板的 return 里，**道具名与面板作用域里的名字完全相同** ⇒ JSX 可以逐行搬过来。
 * 只有两处结构性改动，都写在各组件上方：
 *   · `{cond && (…)}` 换成组件内的「早返回」（否则要包一层 fragment、多一层 DOM 语义）；
 *   · 原来读模块作用域的 `css` / `MEDIA_LABELS` 等改成从 support 模块 import（值一样）。
 * @module moments-portals
 */
import { Fragment } from 'react'
import { createPortal } from 'react-dom'
import type { MomentItem } from '@deepseek-ai/dsh-wechat-data/types'
import { clickableKey, DateRangeField } from '../ui/kit.tsx'
import { imgKey, MEDIA_LABELS, type MediaFilter, MomentsMiniAvatar, replyTarget } from './moments-support.tsx'
import { fmtCommentTimeSec } from '../utils/format.ts'
import { videoCoverKey, type MediaKeySpec } from './moments-media.ts'
import { RemoteImg, localImageSrc } from './remote-img.tsx'
import { MediaViewer } from '../media-viewer/MediaViewer.tsx'
import { apiGetSnsImageDataUrl } from '../api.ts'
import css from './moments.module.css'
import kitCss from '../ui/kit.module.css'

/** 查看器里的一张图（与面板里 `useState` 的内联类型同构）。 */
export interface ViewerImage { thumb?: string; url?: string; md5?: string; timelineId?: string; id?: string }

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
  doExport: () => unknown
  exporting: boolean
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
  expImages, setExpImages, expZip, setExpZip, doExport, exporting,
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
  copyCurrentLink: () => void
  saveCurrentImage: () => void
  viewRotate: number
  setViewRotate: React.Dispatch<React.SetStateAction<number>>
}

export function MomentsImageViewer({
  viewer, setViewer, setViewerIndex, curImg, snsImgs, copyCurrentLink, saveCurrentImage,
  viewRotate, setViewRotate,
}: MomentsImageViewerProps): React.JSX.Element | null {
  if (!viewer) return null
  const sources = viewer.images.map((im) => ({
    key: imgKey(im) || `${String(viewer.index)}-${String(im.md5 ?? im.id ?? '')}`,
    thumb: snsImgs[imgKey(im)] ?? im.thumb ?? undefined,
    title: viewer.author,
    load: async (): Promise<string> => {
      const local = snsImgs[imgKey(im)]
      if (local) return local
      const r = await apiGetSnsImageDataUrl({
        md5: im.md5 ?? '',
        ...(im.timelineId ? { timelineId: im.timelineId } : {}),
        ...(im.id ? { mediaId: im.id } : {}),
      })
      if (r.url) return r.url
      throw new Error(r.error ?? '图片暂不可用')
    },
  }))
  const canCopy = Boolean(curImg?.url || (curImg ? snsImgs[imgKey(curImg)] : '') || curImg?.thumb)
  const canSave = canCopy
  return (
    <MediaViewer
      sources={sources}
      index={viewer.index}
      onIndexChange={setViewerIndex}
      onClose={() => { setViewer(null) }}
      dialogName="moments-viewer"
      showThumbnails={viewer.images.length > 1}
      minZoom={1}
      maxZoom={5}
      rotate={viewRotate}
      headerActions={(
        <>
          <button type="button" className={css.btn} onClick={copyCurrentLink} disabled={!canCopy} title="复制链接">复制</button>
          <button type="button" className={css.btn} onClick={saveCurrentImage} disabled={!canSave} title="保存到本地">保存</button>
        </>
      )}
      extraToolbar={(
        <button type="button" className={css.btn} onClick={() => { setViewRotate(r => (r + 90) % 360) }} title="旋转90°">↻</button>
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
  videoSrcs: Record<string, string>
  videoMeta: Record<string, { w: number; h: number }>
  setVideoMeta: React.Dispatch<React.SetStateAction<Record<string, { w: number; h: number }>>>
  videoFailed: Set<string>
  videoErr: Map<string, string>
  loadVideo: (vk: string, v: SnsVideoRef) => void
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
  detail, setDetail, setViewer, setAuthorFilter, snsImgs, mediaKeySpec,
  videoSrcs, videoMeta, setVideoMeta, videoFailed, videoErr,
  loadVideo, saveVideo, fullscreenVideo, closeVideo,
}: MomentsDetailProps): React.JSX.Element | null {
  if (!detail) return null
  return createPortal(
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
                  // 详情弹层里的图片同样是**固定纵横比的框**（.imgWrap 有 aspect-ratio），
                  // 失败时隐藏图片会留下一个空方块 —— 与卡片视图同一套口径：给占位，不留空。
                  return (
                    <div key={ii} className={css.imgWrap} title="点击查看大图" {...clickableKey(() => { setViewer({ images: detail.m.images, index: ii, author: detail.m.author }) })}>
                      <RemoteImg
                        src={dataSrc || ''}
                        alt=""
                        loading="lazy"
                        className={css.img}
                        pending={<div className={css.imgFallback}>加载中</div>}
                        failed={<div className={css.imgFallback}>图片加载失败</div>}
                      />
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
                  const src = vk ? videoSrcs[vk] : undefined
                  const playing = !!src
                  const meta = vk ? videoMeta[vk] : undefined
                  return (
                    <div key={vi} className={[css.videoTile, playing ? css.videoTilePlaying : '', playing ? css.videoTileDetail : ''].filter(Boolean).join(' ')} title={v.url || v.md5 || ''}
                      style={playing && meta ? { ['--video-ar' as string]: `${meta.w} / ${meta.h}` } : undefined}
                      {...(playing ? {} : clickableKey(() => { loadVideo(vk, v) }, { label: '播放视频' }))}>
                      {playing
                        ? <>
                          <video
                            className={css.videoPlayer}
                            src={src}
                            controls
                            autoPlay
                            poster={localImageSrc(vCover)}
                            onLoadedMetadata={(e) => {
                              const el = e.currentTarget
                              if (!vk || !el.videoWidth || !el.videoHeight) return
                              setVideoMeta((prev) => (prev[vk]?.w === el.videoWidth ? prev : { ...prev, [vk]: { w: el.videoWidth, h: el.videoHeight } }))
                            }}
                          />
                          <div className={css.videoActions}>
                            <button type="button" className={css.videoActBtn} title="保存视频" onClick={(e) => { e.stopPropagation(); saveVideo(v) }}>⭳</button>
                            <button type="button" className={css.videoActBtn} title="全屏" onClick={(e) => { e.stopPropagation(); fullscreenVideo(e.currentTarget.parentElement?.parentElement ?? null) }}>⛶</button>
                            <button type="button" className={css.videoActBtn} title="收起" onClick={(e) => { e.stopPropagation(); if (vk) closeVideo(vk) }}>✕</button>
                          </div>
                        </>
                        : vCover
                          ? <><RemoteImg className={css.videoCover} src={vCover} alt="" loading="lazy" /><span className={css.videoPlayBadge}>▶</span>{v.duration > 0 && (
                            <span className={css.videoDur}>{Math.round(v.duration)}s</span>
                          )}</>
                          : <>{videoFailed.has(vk)
                            ? <span className={css.videoMissing} title={videoErr.get(vk) || '朋友圈视频要在微信里播放过才会缓存到本机'}>本机未缓存<em>微信里播一次后可看</em></span>
                            : <span className={css.videoBadge}>▶</span>}{v.duration > 0 && (
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
                      <span className={css.commentName} title={'只看 ' + (c.nickname || c.username)} {...clickableKey(() => { setAuthorFilter(c.nickname || c.username || null) }, { stopPropagation: true })}>{c.nickname || c.username || '未知'}</span>
                      {c.to_username && c.to_username !== detail.m.username && <span className={css.commentReply}>回复 {c.to_nickname || c.to_username}{target ? '：' : ''}</span>}
                      {target && <span className={kitCss.textCaption}>“{target.content.slice(0, 40)}”</span>}
                      <span className={css.commentText}>{c.content || ''}</span>
                      {img && cdata && (
                        <RemoteImg key={'img' + String(ci)} src={cdata} alt="" loading="lazy" className={css.commentImg} failed={<span className={css.commentImgFallback}>[图]</span>} {...clickableKey(() => { setViewer({ images: [{ thumb: img.thumb, url: img.url, md5: img.md5 }], index: 0, author: (c.nickname || c.username || '') }) }, { label: '查看大图' })} />
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
