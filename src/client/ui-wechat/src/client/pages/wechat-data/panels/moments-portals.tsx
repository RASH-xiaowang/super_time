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
import { fmtCommentTime, imgKey, MEDIA_LABELS, type MediaFilter, MomentsMiniAvatar, replyTarget } from './moments-support.tsx'
import { proxyableSrc } from '../utils/url.ts'
import { RemoteImg, localImageSrc } from './remote-img.tsx'
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
export interface MomentsImageViewerProps {
  viewer: ViewerState | null
  setViewer: (v: ViewerState | null) => void
  setViewerIndex: (index: number) => void
  curImg: ViewerImage | undefined
  snsImgs: Record<string, string>
  copyCurrentLink: () => void
  saveCurrentImage: () => void
  viewOriginal: boolean
  setViewOriginal: React.Dispatch<React.SetStateAction<boolean>>
  viewRotate: number
  setViewRotate: React.Dispatch<React.SetStateAction<number>>
  viewZoom: number
  setViewZoom: React.Dispatch<React.SetStateAction<number>>
  viewPan: { x: number; y: number }
  setViewPan: React.Dispatch<React.SetStateAction<{ x: number; y: number }>>
  lightboxWrapRef: React.MutableRefObject<HTMLDivElement | null>
  pinchRef: React.MutableRefObject<{ dist: number; zoom: number } | null>
  viewZoomRef: React.MutableRefObject<number>
  dragRef: React.MutableRefObject<{ sx: number; sy: number; ox: number; oy: number } | null>
}

export function MomentsImageViewer({
  viewer, setViewer, setViewerIndex, curImg, snsImgs, copyCurrentLink, saveCurrentImage,
  viewOriginal, setViewOriginal, viewRotate, setViewRotate, viewZoom, setViewZoom,
  viewPan, setViewPan, lightboxWrapRef, pinchRef, viewZoomRef, dragRef,
}: MomentsImageViewerProps): React.JSX.Element | null {
  if (!viewer) return null
  return createPortal(
      <div className={[css.overlay, css.overlayTop].join(' ')} data-st-dialog="moments-viewer" onClick={() => { setViewer(null) }} role="dialog" aria-modal="true">
        <div className={css.lightbox} onClick={(e) => { e.stopPropagation() }}>
          <div className={css.lightboxHead}>
            <span>{viewer.author} · {String(viewer.index + 1)}/{String(viewer.images.length)}</span>
            <div className={css.lightboxHeadActions}>
              <button type="button" className={css.btn} onClick={copyCurrentLink} disabled={!((curImg?.url) || (curImg && snsImgs[imgKey(curImg)]) || curImg?.thumb)} title="复制链接">复制</button>
              <button type="button" className={css.btn} onClick={saveCurrentImage} disabled={!((curImg && snsImgs[imgKey(curImg)]) || curImg?.url || curImg?.thumb)} title="保存到本地">保存</button>
              <button type="button" className={css.btn} data-on={viewOriginal || undefined} onClick={() => { setViewOriginal(v => !v) }} disabled={!proxyableSrc(curImg?.url)} title={viewOriginal ? '当前为原始链接，点按回离线解码图' : '切换为原始链接'}>原图</button>
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
            {/* 「原图」开关决定优先要哪一个地址；两个都可能是 CDN 地址，那就交给后端代理（M23）。
                取不到才说「加载失败」—— 在这一步之前谁也不知道是网络问题还是本机没有。 */}
            <RemoteImg
              src={viewOriginal ? (proxyableSrc(curImg?.url) || (curImg && snsImgs[imgKey(curImg)]) || proxyableSrc(curImg?.thumb) || '') : ((curImg && snsImgs[imgKey(curImg)]) || proxyableSrc(curImg?.url, curImg?.thumb) || '')}
              alt=""
              draggable={false}
              className={css.lightboxImg}
              style={{ transform: 'rotate(' + String(viewRotate) + 'deg) scale(' + String(viewZoom) + ') translate(' + String(viewPan.x) + 'px,' + String(viewPan.y) + 'px)' }}
              failed={<div className={css.lightboxFail}>图片加载失败</div>}
            />
          </div>
          <div className={css.lightboxNav}>
            <button type="button" className={css.btn} disabled={viewer.index <= 0} onClick={() => { setViewerIndex(viewer.index - 1) }}>‹ 上一张</button>
            <button type="button" className={css.btn} disabled={viewer.index >= viewer.images.length - 1} onClick={() => { setViewerIndex(viewer.index + 1) }}>下一张 ›</button>
          </div>
          {viewer.images.length > 1 && (
            <div className={css.lightboxThumbs}>
              {viewer.images.map((im, i) => {
                const t = (snsImgs[imgKey(im)] || proxyableSrc(im.thumb, im.url))
                return (
                  <RemoteImg
                    key={i}
                    src={t || ''}
                    alt=""
                    className={[css.lightboxThumb, i === viewer.index ? css.lightboxThumbActive : ''].filter(Boolean).join(' ')}
                    {...clickableKey(() => { setViewerIndex(i) }, { label: `查看第 ${i + 1} 张图` })}
                  />
                )
              })}
            </div>
          )}
        </div>
      </div>,
      document.body,
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
}

export function MomentsDetail({
  detail, setDetail, setViewer, setAuthorFilter, snsImgs,
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
                        src={dataSrc || proxyableSrc(im.thumb, im.url)}
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
                  const vk = v.md5 ? 'v:' + v.md5 : (v.timelineId && v.id ? 'v:' + v.timelineId + ':' + v.id : '')
                  const vCover = (vk ? snsImgs[vk] : undefined) || proxyableSrc(v.thumb)
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
                  return (
                    <div key={ci} className={css.comment}>
                      <MomentsMiniAvatar username={c.username} name={c.nickname || c.username} />
                      <span className={css.commentName} title={'只看 ' + (c.nickname || c.username)} {...clickableKey(() => { setAuthorFilter(c.nickname || c.username || null) }, { stopPropagation: true })}>{c.nickname || c.username || '未知'}</span>
                      {c.to_username && c.to_username !== detail.m.username && <span className={css.commentReply}>回复 {c.to_nickname || c.to_username}{target ? '：' : ''}</span>}
                      {target && <span className={kitCss.textCaption}>“{target.content.slice(0, 40)}”</span>}
                      <span className={css.commentText}>{c.content || ''}</span>
                      {img && (cdata || proxyableSrc(img.thumb, img.url)) && (
                        <RemoteImg key={'img' + String(ci)} src={cdata || proxyableSrc(img.thumb, img.url)} alt="" loading="lazy" className={css.commentImg} failed={<span className={css.commentImgFallback}>[图]</span>} {...clickableKey(() => { setViewer({ images: [{ thumb: img.thumb, url: img.url, md5: img.md5 }], index: 0, author: (c.nickname || c.username || '') }) }, { label: '查看大图' })} />
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
  )
}
