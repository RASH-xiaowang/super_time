/**
 * 朋友圈视频格子的共享实现。
 *
 * 卡片与详情浮层以前各抄一份 `<video>` 分支，导致媒体错误、加载反馈和失败重试
 * 很容易只修到其中一处。这里统一：封面/播放/加载/失败四种状态，以及媒体错误上报。
 */
import type { MomentItem } from '@deepseek-ai/dsh-wechat-data/types'
import { clickableKey } from '../ui/kit.tsx'
import { desktopActionProps } from '../ui/desktop-only.tsx'
import { videoPlaybackErrorText } from '../media-viewer/video-errors.ts'
import { RemoteImg, localImageSrc } from './remote-img.tsx'
import css from './moments.module.css'

export interface MomentsVideoTileProps {
  v: MomentItem['videos'][number]
  vk: string
  cover?: string
  src?: string
  meta?: { w: number; h: number }
  loading: boolean
  failed: boolean
  error?: string
  detail?: boolean
  desktopSave?: boolean
  dataKey?: string
  dataMd5?: string
  dataTid?: string
  dataMid?: string
  setVideoMeta: React.Dispatch<React.SetStateAction<Record<string, { w: number; h: number }>>>
  loadVideo: (vk: string, v: MomentItem['videos'][number]) => void
  reportVideoError: (vk: string, message: string) => void
  saveVideo: (v: MomentItem['videos'][number]) => void
  fullscreenVideo: (tile: Element | null) => void
  closeVideo: (vk: string) => void
}

export function MomentsVideoTile({
  v, vk, cover, src, meta, loading, failed, error, detail = false, desktopSave = false,
  dataKey, dataMd5, dataTid, dataMid,
  setVideoMeta, loadVideo, reportVideoError, saveVideo, fullscreenVideo, closeVideo,
}: MomentsVideoTileProps): React.JSX.Element {
  const playing = src !== undefined && src !== '' && !failed
  const retryTitle = error || '视频暂不可用，点击重试'
  const className = [
    css.videoTile,
    playing ? css.videoTilePlaying : '',
    playing && detail ? css.videoTileDetail : '',
  ].filter(Boolean).join(' ')

  return (
    <div
      className={className}
      title={failed ? retryTitle : (v.url || v.md5 || '')}
      data-moments-video-tile=""
      data-sns-key={dataKey || undefined}
      data-sns-md5={dataMd5 || undefined}
      data-sns-tid={dataTid || undefined}
      data-sns-mid={dataMid || undefined}
      style={playing && meta ? { ['--video-ar' as string]: `${meta.w} / ${meta.h}` } : undefined}
      {...(playing ? {} : clickableKey(() => { loadVideo(vk, v) }, { label: failed ? '重试视频' : '播放视频' }))}
    >
      {playing ? (
        <>
          <video
            className={css.videoPlayer}
            src={src}
            controls
            autoPlay
            poster={localImageSrc(cover)}
            onLoadedMetadata={(e) => {
              const el = e.currentTarget
              if (!vk || !el.videoWidth || !el.videoHeight) return
              setVideoMeta((prev) => (
                prev[vk]?.w === el.videoWidth && prev[vk]?.h === el.videoHeight
                  ? prev
                  : { ...prev, [vk]: { w: el.videoWidth, h: el.videoHeight } }
              ))
            }}
            onError={(e) => { reportVideoError(vk, videoPlaybackErrorText(e.currentTarget.error)) }}
          />
          <div className={css.videoActions}>
            <button
              type="button"
              className={css.videoActBtn}
              title="保存视频"
              onClick={(e) => { e.stopPropagation(); saveVideo(v) }}
              {...(desktopSave ? desktopActionProps() : {})}
            >⭳</button>
            <button
              type="button"
              className={css.videoActBtn}
              title="全屏"
              onClick={(e) => {
                e.stopPropagation()
                fullscreenVideo(e.currentTarget.closest('[data-moments-video-tile]'))
              }}
            >⛶</button>
            <button
              type="button"
              className={css.videoActBtn}
              title="收起"
              onClick={(e) => { e.stopPropagation(); if (vk) closeVideo(vk) }}
            >✕</button>
          </div>
        </>
      ) : cover ? (
        <RemoteImg className={css.videoCover} src={cover} alt="" loading="lazy" decoding="async" />
      ) : (
        <span className={css.videoBadge}>▶</span>
      )}

      {!playing && failed && (
        <span className={css.videoMissing} title={retryTitle}>
          视频加载失败<em>点击重试</em>
        </span>
      )}
      {!playing && loading && (
        <span className={css.videoLoading} role="status">加载中…</span>
      )}
      {!playing && !failed && !loading && cover && <span className={css.videoPlayBadge}>▶</span>}
      {v.duration > 0 && <span className={css.videoDur}>{Math.round(v.duration)}s</span>}
    </div>
  )
}
