/**
 * Single-file media export RPCs.
 *
 * Kept separate from `api-media.ts` so the media cache/queue implementation does
 * not keep growing past the M21 file-size limit.
 *
 * @module api-media-original-export
 */

import type { MediaOriginalExportResult } from '@deepseek-ai/dsh-wechat-data/types'
import { remote, unwrap } from './api-core.ts'

/** 把一条朋友圈视频写到用户选定路径（本机缓存优先，否则 CDN 取回+解密）。 */
export async function apiExportSnsVideo(options: {
  md5?: string
  timelineId?: string
  mediaId?: string
  url?: string
  key?: string
  dest: string
  jobId?: string
}): Promise<{ ok: boolean; path?: string; bytes?: number; format?: string; source?: 'local' | 'cdn'; error?: string }> {
  return unwrap(await remote().exportSnsVideo(options))
}

/** 把朋友圈单张原图写到用户选定路径。 */
export async function apiExportSnsImage(options: {
  md5: string
  timelineId?: string
  mediaId?: string
  url?: string
  token?: string
  seed?: string
  key?: string
  dest: string
  jobId?: string
}): Promise<{ ok: boolean; path?: string; bytes?: number; format?: string; source?: 'local' | 'cdn'; error?: string }> {
  return unwrap(await remote().exportSnsImage(options))
}

/** 把单张聊天图片按原图写到用户选定路径；仅有缩略图时失败且不落盘。 */
export async function apiExportChatImage(options: {
  username: string
  localId: number
  dest: string
  jobId?: string
}): Promise<{ ok: boolean; path?: string; bytes?: number; format?: string; source?: string; error?: string }> {
  return unwrap(await remote().exportChatImage(options))
}

/** 保存聊天视频原文件；后端返回的 path 可能已按真实容器格式校正扩展名。 */
export async function apiExportChatVideo(options: {
  username: string
  localId: number
  dest: string
  jobId?: string
}): Promise<MediaOriginalExportResult> {
  return unwrap(await remote().exportChatVideo(options))
}

/** 保存聊天文件原文件；文件归属和大小/MD5 均由后端消息库确认。 */
export async function apiExportChatFile(options: {
  username: string
  localId: number
  dest: string
  jobId?: string
}): Promise<MediaOriginalExportResult> {
  return unwrap(await remote().exportChatFile(options))
}

/** 保存文件库图片原图；只有缩略图或 MD5 不匹配时拒绝落盘。 */
export async function apiExportFileImage(options: {
  md5: string
  dest: string
  jobId?: string
}): Promise<MediaOriginalExportResult> {
  return unwrap(await remote().exportFileImage(options))
}

/** 保存文件库视频原文件。 */
export async function apiExportFileVideo(options: {
  md5: string
  dest: string
  jobId?: string
}): Promise<MediaOriginalExportResult> {
  return unwrap(await remote().exportFileVideo(options))
}

/** 保存文件库普通附件原文件。 */
export async function apiExportFileAttachment(options: {
  fileName: string
  size?: number
  createTime?: number
  md5?: string
  dest: string
  jobId?: string
}): Promise<MediaOriginalExportResult> {
  return unwrap(await remote().exportFileAttachment(options))
}

/** 保存收藏图片原图；缺少 fullMd5 时后端拒绝。 */
export async function apiExportFavoriteImage(options: {
  fullMd5?: string
  md5?: string
  thumbMd5?: string
  kind?: 'image'
  dest: string
  jobId?: string
}): Promise<MediaOriginalExportResult> {
  return unwrap(await remote().exportFavoriteImage(options))
}

/** 保存收藏视频原片；缺少 fullMd5 或内容不是视频容器时后端拒绝。 */
export async function apiExportFavoriteVideo(options: {
  fullMd5?: string
  md5?: string
  thumbMd5?: string
  kind?: 'video'
  dest: string
  jobId?: string
}): Promise<MediaOriginalExportResult> {
  return unwrap(await remote().exportFavoriteVideo(options))
}

/** 保存收藏普通附件原文件；只从完整内容 MD5 命中的条目写盘。 */
export async function apiExportFavoriteFile(options: {
  fullMd5?: string
  md5?: string
  thumbMd5?: string
  kind?: 'file'
  dest: string
  jobId?: string
}): Promise<MediaOriginalExportResult> {
  return unwrap(await remote().exportFavoriteFile(options))
}
