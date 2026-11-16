/** Verified original-image save for the moments lightbox. */
import type { MediaOriginalExportResult } from '@deepseek-ai/dsh-wechat-data/types'
import { apiExportSnsImage, apiSaveFileDialog } from '../api.ts'
import { desktopAction } from '../ui/desktop-only.tsx'
import { imageDownloadName } from './moments-actions.ts'
import { imageExtOf, type ViewerImageLike } from './moments-viewer.ts'

export async function saveMomentImageOriginal(
  image: ViewerImageLike,
  src: string,
  jobId: string,
  index: number,
): Promise<MediaOriginalExportResult | null> {
  if (desktopAction()) throw new Error('原图保存仅支持电脑端')
  if (!image.md5) throw new Error('这张图片缺少原图标识，无法按原图导出')
  const ext = imageExtOf(src)
  const picked = await apiSaveFileDialog({
    defaultName: imageDownloadName(index, ext),
    title: '保存朋友圈原图',
    filters: [{ name: '图片', extensions: [ext] }],
  })
  if (picked.canceled || !picked.path) return null
  const result = await apiExportSnsImage({
    md5: image.md5,
    ...(image.timelineId ? { timelineId: image.timelineId } : {}),
    ...((image.id ?? image.mediaId) ? { mediaId: image.id ?? image.mediaId } : {}),
    ...(image.url ? { url: image.url } : {}),
    ...(image.token ? { token: image.token } : {}),
    ...((image.seed ?? image.key) ? { seed: image.seed ?? image.key } : {}),
    ...(image.key ? { key: image.key } : {}),
    ...(image.originalWidth !== undefined ? { originalWidth: image.originalWidth } : {}),
    ...(image.originalHeight !== undefined ? { originalHeight: image.originalHeight } : {}),
    ...(image.originalBytes !== undefined ? { originalBytes: image.originalBytes } : {}),
    ...(image.uhdUrl ? { uhdUrl: image.uhdUrl } : {}),
    ...(image.uhdToken ? { uhdToken: image.uhdToken } : {}),
    ...(image.uhdSeed ? { uhdSeed: image.uhdSeed } : {}),
    dest: picked.path,
    jobId,
  })
  if (!result.ok) throw new Error(result.error || '朋友圈原图写入失败')
  return {
    ok: true,
    path: result.path ?? picked.path,
    ...(result.bytes !== undefined ? { bytes: result.bytes } : {}),
    ...(result.format ? { format: result.format } : {}),
  }
}
