/** Original image/video export for favorites, backed by the full-content MD5 tier. */
import type { FavItemPart, MediaOriginalExportResult } from '@deepseek-ai/dsh-wechat-data/types'
import { apiExportFavoriteFile, apiExportFavoriteImage, apiExportFavoriteVideo, apiSaveFileDialog } from '../api.ts'
import { DESKTOP_ACTION_WHY, desktopAction } from '../ui/desktop-only.tsx'
import { imageExtOf } from './moments-viewer.ts'

function hasFullMd5(part: FavItemPart): part is FavItemPart & { fullMd5: string } {
  return typeof part.fullMd5 === 'string' && /^[0-9a-f]{32}$/i.test(part.fullMd5)
}

function videoExt(part: FavItemPart): string {
  const ext = part.format?.toLowerCase() ?? ''
  return /^(mp4|mov|m4v)$/.test(ext) ? ext : 'mp4'
}

/**
 * Save a favorite image only when XML exposes its full-content MD5. The visible
 * image can be a `thumbMd5`; using that here would silently save a thumbnail.
 */
export async function saveFavoriteImageOriginal(
  part: FavItemPart,
  sourceHint = '',
  jobId?: string,
): Promise<MediaOriginalExportResult | null> {
  if (!desktopAction()) {
    if (!hasFullMd5(part)) throw new Error('该收藏项缺少原图 MD5，无法确认原图；已拒绝保存缩略图')
    const ext = imageExtOf(sourceHint)
    const picked = await apiSaveFileDialog({
      defaultName: `收藏图片-${part.fullMd5.slice(0, 8)}.${ext}`,
      title: '保存收藏原图',
      filters: [{ name: '图片', extensions: [ext] }],
    })
    if (picked.canceled || !picked.path) return null
    const result = await apiExportFavoriteImage({
      fullMd5: part.fullMd5,
      ...(part.md5 ? { md5: part.md5 } : {}),
      ...(part.thumbMd5 ? { thumbMd5: part.thumbMd5 } : {}),
      kind: 'image',
      dest: picked.path,
      ...(jobId ? { jobId } : {}),
    })
    if (!result.ok) throw new Error(result.error || '收藏原图写入失败')
    return result
  }
  throw new Error(DESKTOP_ACTION_WHY)
}

/** Save a favorite video through the backend, never through a browser download. */
export async function saveFavoriteVideoOriginal(
  part: FavItemPart,
  jobId?: string,
): Promise<MediaOriginalExportResult | null> {
  if (!desktopAction()) {
    if (!hasFullMd5(part)) throw new Error('该收藏项缺少原视频 MD5，无法确认原片；已拒绝保存封面或预览')
    const ext = videoExt(part)
    const picked = await apiSaveFileDialog({
      defaultName: `收藏视频-${part.fullMd5.slice(0, 8)}.${ext}`,
      title: '保存收藏原视频',
      filters: [{ name: '视频', extensions: [ext] }],
    })
    if (picked.canceled || !picked.path) return null
    const result = await apiExportFavoriteVideo({
      fullMd5: part.fullMd5,
      ...(part.md5 ? { md5: part.md5 } : {}),
      ...(part.thumbMd5 ? { thumbMd5: part.thumbMd5 } : {}),
      kind: 'video',
      dest: picked.path,
      ...(jobId ? { jobId } : {}),
    })
    if (!result.ok) throw new Error(result.error || '收藏原视频写入失败')
    return result
  }
  throw new Error(DESKTOP_ACTION_WHY)
}

/** Save a favorite attachment from `business/favorite`, never from `msg/file`. */
export async function saveFavoriteFileOriginal(
  part: FavItemPart,
  jobId?: string,
): Promise<MediaOriginalExportResult | null> {
  if (!desktopAction()) {
    if (!hasFullMd5(part)) throw new Error('该收藏项缺少原文件 MD5，无法确认原文件')
    const ext = (part.ext ?? '').replace(/^\./, '').trim().toLowerCase()
    const rawName = (part.name || part.title || `收藏文件-${part.fullMd5.slice(0, 8)}`).trim()
    const safeName = rawName.replace(/[\\/:*?"<>|]/g, '_') || `收藏文件-${part.fullMd5.slice(0, 8)}`
    const defaultName = ext && !safeName.toLowerCase().endsWith('.' + ext) ? safeName + '.' + ext : safeName
    const picked = await apiSaveFileDialog({
      defaultName,
      title: '保存收藏原文件',
      filters: [
        ...(ext ? [{ name: ext.toUpperCase() + ' 文件', extensions: [ext] }] : []),
        { name: '全部文件', extensions: ['*'] },
      ],
    })
    if (picked.canceled || !picked.path) return null
    const result = await apiExportFavoriteFile({
      fullMd5: part.fullMd5,
      kind: 'file',
      dest: picked.path,
      ...(jobId ? { jobId } : {}),
    })
    if (!result.ok) throw new Error(result.error || '收藏原文件写入失败')
    return result
  }
  throw new Error(DESKTOP_ACTION_WHY)
}
