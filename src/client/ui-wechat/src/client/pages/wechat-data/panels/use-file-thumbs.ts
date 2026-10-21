/**
 * 文件面板的缩略图队列（2026-10-21：可视区优先 + 视区外预取，宽度自适应）。
 *
 * 从 `Files.tsx` 抽成 hook 的三个理由：
 *  1. `FilesPanel` 受单函数行数棘轮约束（登记 354，只能变小）；
 *  2. 两条通道的时序（可视 24ms / 预取 180ms、各自一个 timer）比内联清楚；
 *  3. 状态机（LRU + fetched/queued 去重）能单独解释，避免"滚回来永远占位"那类错。
 *
 * 关键不变量：
 *  - **可视请求永远不排在预取后面**：两个 lane 各自计时器，可视 24ms 先发；
 *  - 预取只填空闲，不抢可视：180ms 才合批，用户真滚到那里时通常已经缓存好；
 *  - 同一个 key 只会发一次 RPC（`fetched` 命中或 `queued` 已排队都跳过）；
 *  - LRU 上界按列数放大（见 `thumbCacheLimitFor`），预取不会把屏上的图挤掉。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { emptyThumbCache, rememberThumb, type ThumbCache } from '../utils/thumb-cache.ts'
import { fetchFileThumbUrls, thumbCacheLimitFor } from './files-thumbs.ts'

/** 可视格的合批延迟：只为削掉同一帧的 N 次调用，不引入可感知的等待。 */
const VISIBLE_FLUSH_MS = 24
/** 预取合的批延迟：放进空闲时间窗，不跟可视请求抢后端队列。 */
const PREFETCH_FLUSH_MS = 180

/** hook 的选项（宽度来自实测格宽，列数用于放大 LRU 上界）。 */
export interface FileThumbnailsOptions {
  /** 缩略图目标宽度（由 `thumbWidthFor` 按格宽×DPR 取档）。 */
  width: number
  /** 当前列数（`useGridColumns().cols`）。 */
  cols: number
}

/** hook 的返回值。 */
export interface FileThumbnails {
  /** key → 协议 URL（渲染 `<img src>` 用）。 */
  thumbs: Record<string, string>
  /** 可视格挂载时调用（key = `fileKey()`）。 */
  request: (key: string) => void
  /** 视区外预取（key 列表可含可视格的 key，内部会去重）。 */
  prefetch: (keys: readonly string[]) => void
}

/** 只接受 32 位十六进制 key（微信附件名/解码槽位约定）。 */
function normalizeKey(raw: string): string {
  const key = String(raw ?? '').trim().toLowerCase()
  return /^[0-9a-f]{32}$/.test(key) ? key : ''
}

/**
 * 文件面板缩略图队列。
 * @param options - 宽度与列数（每次渲染都用最新值，内部用 ref 承接）。
 * @returns {@link FileThumbnails}。
 */
export function useFileThumbnails(options: FileThumbnailsOptions): FileThumbnails {
  const widthRef = useRef(options.width)
  widthRef.current = options.width
  const limitRef = useRef(thumbCacheLimitFor(options.cols))
  limitRef.current = thumbCacheLimitFor(options.cols)
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  const cache = useRef<ThumbCache>(emptyThumbCache())
  const queued = useRef(new Set<string>())
  const visibleQueue = useRef<string[]>([])
  const prefetchQueue = useRef<string[]>([])
  const visibleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prefetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  /** 发一批并写回 LRU（失败留图标兜底；这些 key 已记 fetched，不重试）。 */
  const flush = useCallback((keys: string[]): void => {
    if (keys.length === 0) return
    for (const key of keys) queued.current.delete(key)
    void fetchFileThumbUrls(keys, widthRef.current).then((urls) => {
      const entries = Object.entries(urls)
      if (entries.length === 0) return
      let next = cache.current
      for (const [key, url] of entries) next = rememberThumb(next, key, url, limitRef.current)
      cache.current = next
      setThumbs(next.thumbs)
    })
  }, [])

  /** 入队；`lane` 决定用哪个合批延迟。返回是否真的新增了 key。 */
  const enqueue = useCallback((keys: readonly string[], delayMs: number): boolean => {
    let added = false
    for (const raw of keys) {
      const key = normalizeKey(raw)
      if (key === '' || cache.current.fetched.has(key) || queued.current.has(key)) continue
      queued.current.add(key)
      if (delayMs >= PREFETCH_FLUSH_MS) prefetchQueue.current.push(key)
      else visibleQueue.current.push(key)
      added = true
    }
    return added
  }, [])

  /** 可视格请求：24ms 内合批（优先级高于预取）。 */
  const request = useCallback((key: string): void => {
    if (!enqueue([key], VISIBLE_FLUSH_MS)) return
    if (visibleTimer.current !== null) return
    visibleTimer.current = setTimeout(() => {
      visibleTimer.current = null
      const keys = visibleQueue.current
      visibleQueue.current = []
      flush(keys)
    }, VISIBLE_FLUSH_MS)
  }, [enqueue, flush])

  /** 视区外预取：180ms 合批，独立 timer（不会延后可视格的 24ms 合批）。 */
  const prefetch = useCallback((keys: readonly string[]): void => {
    if (!enqueue(keys, PREFETCH_FLUSH_MS)) return
    if (prefetchTimer.current !== null) return
    prefetchTimer.current = setTimeout(() => {
      prefetchTimer.current = null
      const pending = prefetchQueue.current
      prefetchQueue.current = []
      flush(pending)
    }, PREFETCH_FLUSH_MS)
  }, [enqueue, flush])

  // 卸载时清 timer（发出去的请求由 promise 自行结束，不会写回已卸载组件以外的东西）。
  useEffect(() => () => {
    if (visibleTimer.current !== null) clearTimeout(visibleTimer.current)
    if (prefetchTimer.current !== null) clearTimeout(prefetchTimer.current)
  }, [])

  return { thumbs, request, prefetch }
}
