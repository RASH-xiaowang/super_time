/** Save a file-library item through the backend original-file RPCs. */
import type { FileItem, MediaOriginalExportResult } from '@deepseek-ai/dsh-wechat-data/types'
import { apiExportFileAttachment, apiExportFileImage, apiExportFileVideo, apiSaveFileDialog } from '../api.ts'
import { DESKTOP_ACTION_WHY, desktopAction } from '../ui/desktop-only.tsx'
import { fileKey } from './files-naming.ts'

function safeName(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, '_').trim()
}

const IMAGE_EXT = /\.(?:jpe?g|png|gif|webp|bmp|avif|heic|heif)$/i
const VIDEO_EXT = /\.(?:mp4|mov|m4v)$/i

/** Prefer a real source extension; otherwise leave it off and let the backend append the sniffed format. */
function defaultNameOf(item: FileItem): string {
  const key = fileKey(item)
  const original = safeName(item.fileName || '')
  if (item.category === 'image') {
    if (IMAGE_EXT.test(original)) return original
    const stem = safeName(original.replace(/\.dat$/i, '').replace(/_(?:t|h|b|thumb.*)$/i, ''))
    return stem && !/^[0-9a-f]{16,64}$/i.test(stem) ? stem : `图片-${(item.md5 || key).slice(0, 8)}`
  }
  if (item.category === 'video') {
    if (VIDEO_EXT.test(original)) return original
    const stem = safeName(original.replace(/\.dat$/i, ''))
    return stem && !/^[0-9a-f]{16,64}$/i.test(stem) ? stem : `视频-${(item.md5 || key).slice(0, 8)}`
  }
  return original || safeName(key || item.md5 || 'file')
}

/**
 * Ask for a destination, then let the backend copy and verify exact bytes.
 * The returned path may differ in extension when the real media format is not
 * what the display source implied.
 */
export async function saveFileOriginal(
  item: FileItem,
  options: { jobId?: string } = {},
): Promise<MediaOriginalExportResult | null> {
  if (!desktopAction()) {
    const category = item.category
    const picked = await apiSaveFileDialog({
      defaultName: defaultNameOf(item),
      title: category === 'image' ? '保存文件库原图'
        : category === 'video' ? '保存文件库原视频'
          : '保存文件库原文件',
      filters: category === 'image'
        ? [{ name: '图片', extensions: ['jpg', 'png', 'gif', 'webp', 'bmp', 'avif', 'heic', 'heif'] }]
        : category === 'video'
          ? [{ name: '视频', extensions: ['mp4', 'mov', 'm4v'] }]
          : [{ name: '全部文件', extensions: ['*'] }],
    })
    if (picked.canceled || !picked.path) return null

    const jobId = options.jobId
    const result = category === 'image'
      ? await apiExportFileImage({ md5: fileKey(item), dest: picked.path, ...(jobId ? { jobId } : {}) })
      : category === 'video'
        ? await apiExportFileVideo({ md5: item.md5 || fileKey(item), dest: picked.path, ...(jobId ? { jobId } : {}) })
        : await apiExportFileAttachment({
          fileName: item.fileName,
          ...(item.fileSize > 0 ? { size: item.fileSize } : {}),
          ...(item.md5 ? { md5: item.md5 } : {}),
          dest: picked.path,
          ...(jobId ? { jobId } : {}),
        })
    if (!result.ok) throw new Error(result.error || '原文件写入失败')
    return result
  }
  throw new Error(DESKTOP_ACTION_WHY)
}
