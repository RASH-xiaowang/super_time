/**
 * ClawBot 附件的图片放大（2026-10-21 从 `clawbot-chat.tsx` 抽出，接共享 `MediaViewer`）。
 *
 * 抽出的原因：`ClawbotChatView` 受单函数 ≤250 行棘轮约束，而「把已拿到的 data URL
 * 交给统一查看器」只是一段与 ClawBot 业务无关的适配。
 */
import { MediaViewer } from '../media-viewer/MediaViewer.tsx'

/** ClawBot 已解析出的附件图片。 */
export interface ClawbotZoomMedia { src: string; name: string | null }

/**
 * ClawBot 图片预览。
 * @param props.media - 已加载的图片（data URL）与文件名。
 * @param props.onClose - 关闭回调。
 * @returns 共享查看器的单张实例。
 */
export function ClawbotMediaViewer({ media, onClose }: { media: ClawbotZoomMedia; onClose: () => void }): React.JSX.Element {
  return (
    <MediaViewer
      sources={[{
        key: 'clawbot-media',
        thumb: media.src,
        title: media.name ?? '图片预览',
        load: async () => media.src,
        downloadName: media.name ?? 'image.jpg',
      }]}
      index={0}
      onIndexChange={() => { /* 单张 */ }}
      onClose={onClose}
      dialogName="clawbot-media"
    />
  )
}
