/** 保存朋友圈实况照片里的原始视频。 */
import { apiExportSnsVideo, apiSaveFileDialog } from '../api.ts'
import type { MomentLivePhotoRef } from './moments-live.tsx'

export interface LiveVideoSaveResult {
  canceled: boolean
  path?: string
  bytes?: number
}

/**
 * 实况视频不经渲染进程转存：先选保存路径，再由后端从本机缓存或 CDN
 * 取原始字节并写盘。`livePhoto.id` 对应视频接口的 `mediaId`。
 * @param video - 规范化后的实况视频引用。
 * @returns 是否取消及成功时的路径/字节数。
 */
export async function saveMomentsLiveVideo(
  video: MomentLivePhotoRef,
  jobId?: string,
): Promise<LiveVideoSaveResult> {
  const picked = await apiSaveFileDialog({
    defaultName: `朋友圈实况-${(video.md5 || video.id || 'video').slice(0, 12)}.mp4`,
    title: '保存实况原视频',
    filters: [{ name: 'MP4 视频', extensions: ['mp4'] }],
  })
  if (picked.canceled || !picked.path) return { canceled: true }

  const r = await apiExportSnsVideo({
    ...(video.md5 ? { md5: video.md5 } : {}),
    ...(video.timelineId ? { timelineId: video.timelineId } : {}),
    ...(video.id ? { mediaId: video.id } : {}),
    ...(video.url ? { url: video.url } : {}),
    ...(video.key ? { key: video.key } : {}),
    dest: picked.path,
    ...(jobId ? { jobId } : {}),
  })
  if (!r.ok) throw new Error(r.error || '原始实况视频写入失败')
  return { canceled: false, path: r.path ?? picked.path, bytes: r.bytes }
}
