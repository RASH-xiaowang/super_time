/**
 * 朋友圈**视频本体**的取用层：本机缓存优先、CDN 兜底、全屏、保存、按宽高比定尺寸。
 *
 * ## 为什么单独成模块（第三批 #18 第三步）
 *
 * 四份互相跟着走的状态（`videoSrcs` / `videoFailed` / `videoErr` / `videoMeta`）加上
 * 「正在取」的集合原先散在 `moments-panel.tsx` 的五个位置，收起一块的同时把一条**不能被顺手
 * 简化**的事实写在这儿：CDN 返回的是微信客户端加密流，所以**不能把 XML 里的原始 URL 直接当
 * `src`**（CSP 会拦，而且那是密文）—— 只有后端确认取回的字节真的是 MP4 之后才用。
 *
 * @module moments-videos
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { apiExportSnsVideo, apiGetSnsVideoDataUrl, apiSaveFileDialog } from '../api.ts'
import { capRecord } from '../utils/misc.ts'
import { VIDEO_SRC_CACHE_MAX } from './moments-support.tsx'
import type { MomentsNoticeSink } from './moments-support.tsx'
import type { SnsVideoRef } from './moments-portals.tsx'
import { useMediaSaveTask } from './media-save-task.ts'
import type { ExportTaskState } from './export-task.ts'

/** 失败状态与宽高比元数据只服务当前可见播放器，长时间滚动不应无限累积。 */
export const VIDEO_DIAG_CACHE_MAX = 200

/** 播放器尺寸信息（按视频真实宽高比定框，消除竖屏视频的左右黑边）。 */
export type VideoMeta = Record<string, { w: number; h: number }>

/** 写入失败集合，并淘汰最早的一条。 */
function addBoundedVideoKey(previous: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(previous)
  next.delete(key)
  next.add(key)
  while (next.size > VIDEO_DIAG_CACHE_MAX) {
    const oldest = next.values().next().value
    if (oldest === undefined) break
    next.delete(oldest)
  }
  return next
}

/** 从有界集合移除一个键；不存在时保持原引用，避免无意义重渲染。 */
function removeVideoKey(previous: ReadonlySet<string>, key: string): Set<string> {
  if (!previous.has(key)) return previous as Set<string>
  const next = new Set(previous)
  next.delete(key)
  return next
}

/** 写入失败原因，并淘汰最早的一条。 */
function setBoundedVideoError(previous: ReadonlyMap<string, string>, key: string, message: string): Map<string, string> {
  const next = new Map(previous)
  next.delete(key)
  next.set(key, message)
  while (next.size > VIDEO_DIAG_CACHE_MAX) {
    const oldest = next.keys().next().value
    if (oldest === undefined) break
    next.delete(oldest)
  }
  return next
}

/** 删除失败原因；不存在时保持原引用。 */
function removeVideoError(previous: ReadonlyMap<string, string>, key: string): Map<string, string> {
  if (!previous.has(key)) return previous as Map<string, string>
  const next = new Map(previous)
  next.delete(key)
  return next
}

/** 从视频源表移除一个键。 */
function removeVideoSrc(previous: Record<string, string>, key: string): Record<string, string> {
  if (!(key in previous)) return previous
  const next = { ...previous }
  delete next[key]
  return next
}

/** `useMomentsVideos` 的输入。 */
export interface MomentsVideosInput {
  notify: MomentsNoticeSink
  /**
   * 保存成功后把落盘路径交回面板（面板用它显示「打开这个文件」那一行）。
   * 不给就是没人记账 —— 这条不是可选的装饰：`saveVideo` 唯一的一次状态副作用。
   */
  onSavedPath?: (path: string) => void
}

/**
 * 视频状态与四个动作。
 * @param input - 见 {@link MomentsVideosInput}。
 * @returns 四份状态、`setVideoMeta`（`onLoadedMetadata` 要写它）与 `loadVideo` / `closeVideo` /
 *   `fullscreenVideo` / `saveVideo`。
 */
export function useMomentsVideos(input: MomentsVideosInput): {
  videoSrcs: Record<string, string>
  videoLoading: Set<string>
  videoFailed: Set<string>
  videoErr: Map<string, string>
  videoMeta: VideoMeta
  setVideoMeta: React.Dispatch<React.SetStateAction<VideoMeta>>
  loadVideo: (vk: string, v: SnsVideoRef) => void
  reportVideoError: (vk: string, message: string) => void
  closeVideo: (vk: string) => void
  fullscreenVideo: (tile: Element | null) => void
  saveVideo: (v: SnsVideoRef) => void
  exportState: ExportTaskState
  cancelExport: () => Promise<void>
} {
  const { notify, onSavedPath } = input
  const mediaSave = useMediaSaveTask()
  const [videoSrcs, setVideoSrcs] = useState<Record<string, string>>({})
  const [videoLoading, setVideoLoading] = useState<Set<string>>(new Set())
  const [videoFailed, setVideoFailed] = useState<Set<string>>(new Set())
  /** 每个取视频失败的原因（悬停提示用），来自后端：未缓存 / CDN 加密流 / 出站被拦等。 */
  const [videoErr, setVideoErr] = useState<Map<string, string>>(new Map())
  /** 已播放视频的真实宽高比（`onLoadedMetadata` 填），播放器按它定尺寸以消除黑边。 */
  const [videoMeta, setVideoMeta] = useState<VideoMeta>({})
  const videoFetching = useRef<Set<string>>(new Set())

  const recordErr = useCallback((vk: string, msg: string): void => {
    setVideoErr(prev => setBoundedVideoError(prev, vk, msg))
  }, [])

  const clearErr = useCallback((vk: string): void => {
    setVideoErr(prev => removeVideoError(prev, vk))
  }, [])

  /** 元数据来自多个播放器，写入口也必须有界；否则播过的视频越多，表只会越长。 */
  const setVideoMetaBounded = useCallback<React.Dispatch<React.SetStateAction<VideoMeta>>>((action) => {
    setVideoMeta((previous) => {
      const next = typeof action === 'function' ? action(previous) : action
      return capRecord(next, VIDEO_DIAG_CACHE_MAX)
    })
  }, [])

  // 视频本体：本地缓存优先（离线、最快）；没有缓存时后端会按朋友圈 XML 里的
  // <url> 从微信 CDN 按需取回，并校验取回的字节真的是 MP4 —— 实测 CDN 返回的是
  // 微信客户端加密流，所以不能把原始 URL 直接当 src（CSP 会拦，且那是密文）。
  const loadVideo = useCallback((vk: string, v: SnsVideoRef): void => {
    if (!vk || (videoSrcs[vk] && !videoFailed.has(vk)) || videoFetching.current.has(vk)) return
    videoFetching.current.add(vk)
    if (videoFailed.has(vk)) setVideoSrcs(prev => removeVideoSrc(prev, vk))
    setVideoLoading(prev => addBoundedVideoKey(prev, vk))
    setVideoFailed(prev => removeVideoKey(prev, vk))
    clearErr(vk)
    void (async () => {
      try {
        const r = await apiGetSnsVideoDataUrl({ md5: v.md5, timelineId: v.timelineId, mediaId: v.id, url: v.url, key: v.key })
        if (r.url) {
          setVideoSrcs(prev => capRecord({ ...prev, [vk]: r.url as string }, VIDEO_SRC_CACHE_MAX))
          setVideoFailed(prev => removeVideoKey(prev, vk))
          clearErr(vk)
        } else {
          setVideoFailed(prev => addBoundedVideoKey(prev, vk))
          if (r.error) recordErr(vk, r.error as string)
        }
      } catch (e) {
        setVideoFailed(prev => addBoundedVideoKey(prev, vk))
        recordErr(vk, (e as Error).message)
      } finally {
        videoFetching.current.delete(vk)
        setVideoLoading(prev => removeVideoKey(prev, vk))
      }
    })()
  }, [videoSrcs, videoFailed, recordErr, clearErr])

  /**
   * 媒体元素解码/网络错误：清掉不可用的 src，并让格子回到「失败 + 重试」态。
   * 不能只留 videoErr，因为 src 还在时播放器分支会继续渲染黑屏。
   */
  const reportVideoError = useCallback((vk: string, message: string): void => {
    if (!vk) return
    setVideoSrcs(prev => removeVideoSrc(prev, vk))
    setVideoFailed(prev => addBoundedVideoKey(prev, vk))
    setVideoLoading(prev => removeVideoKey(prev, vk))
    recordErr(vk, message)
  }, [recordErr])

  // 播放器按视频真实宽高比定尺寸：容器与画面同比例，`object-fit: contain` 就没有黑边
  // （早先是固定 280×180 的横框，竖屏视频左右两条黑边）。
  const fullscreenVideo = useCallback((tile: Element | null): void => {
    const v = tile?.querySelector('video')
    if (!v) return
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => { /* 忽略 */ })
    else if (typeof v.requestFullscreen === 'function') void v.requestFullscreen().catch(() => { /* 被拒则保持内联 */ })
  }, [])

  /** 收起播放器，回到封面（清掉已解析的 src 与失败标记）。 */
  const closeVideo = useCallback((vk: string): void => {
    setVideoSrcs((prev) => { const n = { ...prev }; delete n[vk]; return n })
    setVideoLoading((prev) => removeVideoKey(prev, vk))
    setVideoFailed((prev) => { const n = new Set(prev); n.delete(vk); return n })
    setVideoErr((prev) => { const n = new Map(prev); n.delete(vk); return n })
    setVideoMeta((prev) => { const n = { ...prev }; delete n[vk]; return n })
  }, [])

  // 保存视频：先在主进程弹保存对话框选路径，再由**后端**取字节写盘。
  // 渲染端的 `<a download>` 在这个 Electron 里落不了盘（实测点了没反应）；
  // 把几十 MB 的 base64 经 IPC 传回主进程也不合适，所以写盘放在后端做。
  const saveVideo = useCallback((v: SnsVideoRef): void => {
    void (async () => {
      let pickedPath = ''
      try {
        // 选路径这一步原来在 try 之外：主进程对话框起不来时（IPC 断了、窗口不在前台）
        // 既没有任何提示，也会在渲染进程里留一条没人接的 rejection。
        const picked = await apiSaveFileDialog({
          defaultName: `朋友圈视频-${(v.md5 || 'export').slice(0, 8)}.mp4`,
          title: '保存视频',
          filters: [{ name: 'MP4 视频', extensions: ['mp4'] }],
        })
        if (picked.canceled || !picked.path) return
        pickedPath = picked.path
        const outcome = await mediaSave.save<{ path?: string; bytes?: number }>({
          idPrefix: 'moment-video',
          label: '保存朋友圈原视频',
          successMessage: (r) => `已保存视频（${Math.round((r.bytes ?? 0) / 1048576)} MB）`,
          run: async (jobId) => {
            const r = await apiExportSnsVideo({
              md5: v.md5,
              timelineId: v.timelineId,
              mediaId: v.id,
              url: v.url,
              key: v.key,
              dest: pickedPath,
              jobId,
            })
            if (!r.ok) throw new Error(r.error || '未知错误')
            return { path: r.path ?? pickedPath, ...(r.bytes !== undefined ? { bytes: r.bytes } : {}) }
          },
        })
        if (outcome.ok) {
          notify.flash(outcome.message)
          onSavedPath?.(outcome.result.path ?? pickedPath)
        } else if (!outcome.canceled) {
          notify.hold('保存失败: ' + outcome.error)
        }
      } catch (e) {
        notify.hold('保存失败: ' + (e as Error).message)
      }
    })()
  }, [mediaSave.save, notify, onSavedPath])

  // Esc 退出全屏：Chromium 对「元素全屏」的默认 Esc 处理在本应用里不生效（实测按了没反应），
  // 页面层自己接一次，避免用户点进全屏后出不来。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || !document.fullscreenElement) return
      e.preventDefault()
      void document.exitFullscreen().catch(() => { /* 忽略 */ })
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [])

  return {
    videoSrcs,
    videoLoading,
    videoFailed,
    videoErr,
    videoMeta,
    setVideoMeta: setVideoMetaBounded,
    loadVideo,
    reportVideoError,
    closeVideo,
    fullscreenVideo,
    saveVideo,
    exportState: mediaSave.state,
    cancelExport: mediaSave.cancel,
  }
}
