/** 统一查看器里的视频元素：负责实况定位点与媒体错误上报。 */
import type { ViewerSource } from './viewer-types.ts'
import { videoPlaybackErrorText } from './video-errors.ts'
import css from './media-viewer.module.css'

export interface ViewerVideoProps {
  src: string
  source: ViewerSource
  onError: (message: string) => void
}

export function ViewerVideo({ src, source, onError }: ViewerVideoProps): React.JSX.Element {
  return (
    <video
      className={css.media}
      src={src}
      controls
      autoPlay
      playsInline
      onLoadedMetadata={(e) => {
        const video = e.currentTarget
        const startAt = (source.startAtMs ?? 0) / 1000
        if (startAt <= 0 || !Number.isFinite(video.duration)) return
        video.currentTime = Math.min(startAt, Math.max(0, video.duration - 0.05))
      }}
      onError={(e) => { onError(videoPlaybackErrorText(e.currentTarget.error)) }}
    />
  )
}
