/**
 * 朋友圈实况照片的展示与播放控制。
 *
 * 微信 XML 把实况视频嵌在静态图片的 `<media>` 内，后端把它挂在图片的
 * `livePhoto`（兼容 `live`）字段上；这里只负责把该元数据规范化成查看器能用的形状。
 */
import { imgKey } from './moments-support.tsx'
import css from './moments.module.css'

/** 后端可能返回的实况视频字段（两种命名都兼容）。 */
export interface MomentLiveMedia {
  url?: string
  key?: string
  md5?: string
  duration?: number
  stillImageTimeMs?: number
  stillTime?: number
  thumb?: string
  id?: string
  timelineId?: string
}

/** 朋友圈图片在渲染层的最小形状（MomentMedia 的结构子集）。 */
export interface MomentImageWithLive {
  thumb?: string
  url?: string
  md5?: string
  id?: string
  timelineId?: string
  livePhoto?: MomentLiveMedia
  live?: MomentLiveMedia
}

/** 规范化后的实况视频引用，可直接交给 `loadVideo`。 */
export interface MomentLivePhotoRef {
  url: string
  key: string
  md5: string
  duration?: number
  stillTimeMs?: number
  thumb?: string
  id?: string
  timelineId?: string
}

function nonEmptyString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function finiteNonNegative(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''))
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

/**
 * 从图片媒体里取实况视频。
 *
 * `livePhoto` 是当前后端字段；`live` 保留给代理层重命名/扁平化时的兼容输入。
 */
export function momentLivePhoto(image: unknown): MomentLivePhotoRef | null {
  if (image === null || typeof image !== 'object') return null
  const record = image as MomentImageWithLive
  const media = record.livePhoto ?? record.live
  if (media === null || typeof media !== 'object') return null
  const url = nonEmptyString(media.url)
  const md5 = nonEmptyString(media.md5)
  if (url === '' && md5 === '') return null
  const live: MomentLivePhotoRef = {
    url,
    md5,
    key: nonEmptyString(media.key),
  }
  const duration = finiteNonNegative(media.duration)
  const stillTimeMs = finiteNonNegative(media.stillImageTimeMs ?? media.stillTime)
  const thumb = nonEmptyString(media.thumb)
  const id = nonEmptyString(media.id)
  const timelineId = nonEmptyString(media.timelineId) || nonEmptyString(record.timelineId)
  if (duration !== undefined) live.duration = duration
  if (stillTimeMs !== undefined) live.stillTimeMs = stillTimeMs
  if (thumb !== '') live.thumb = thumb
  if (id !== '') live.id = id
  if (timelineId !== '') live.timelineId = timelineId
  return live
}

/**
 * 实况视频在现有视频状态表中的键。
 *
 * 必须与普通视频的 `v:` 键空间分开，否则同一动态里图片视频和独立视频的 md5
 * 碰巧相同时会互相覆盖状态。
 */
export function momentLiveKey(image: unknown, index: number): string {
  const live = momentLivePhoto(image)
  if (live === null) return ''
  const record = image as MomentImageWithLive
  const identity = live.md5 || live.url || imgKey(record) || 'index-' + String(index)
  const timeline = live.timelineId ?? ''
  return 'live:' + (timeline === '' ? '' : timeline + ':') + identity
}

/** 图片角标：让用户在打开查看器之前就能发现这张是实况。 */
export function MomentLiveBadge(): React.JSX.Element {
  return (
    <span className={css.liveBadge} title="实况照片" aria-label="实况照片">
      <span className={css.liveBadgeDot} aria-hidden="true" />
      实况
    </span>
  )
}

/** 查看器工具条里的实况按钮与失败提示。 */
export function MomentLiveAction(props: {
  active: boolean
  loading: boolean
  failed: boolean
  error: string
  onToggle: () => void
}): React.JSX.Element {
  const { active, loading, failed, error, onToggle } = props
  const label = active ? (loading ? '实况加载中…' : failed ? '重试实况' : '退出实况') : '播放实况'
  return (
    <>
      <button
        type="button"
        className={css.liveTool}
        data-on={active || undefined}
        data-live-action={active ? 'stop' : 'play'}
        aria-pressed={active}
        disabled={loading}
        title={failed && error ? error : '播放实况照片中的视频'}
        onClick={onToggle}
      >
        <span className={css.liveBadgeDot} aria-hidden="true" />
        {label}
      </button>
      {failed && <span className={css.liveError} title={error || '实况视频暂不可用'}>视频不可用</span>}
    </>
  )
}
