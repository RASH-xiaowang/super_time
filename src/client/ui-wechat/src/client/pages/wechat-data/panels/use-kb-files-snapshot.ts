/**
 * 文件列表快照的读取与首帧缓存。
 *
 * 面板原本在主函数里内联了「请求、setState、写渲染缓存、静默刷新」一整套；
 * 批量队列接入后需要复用同一套刷新口径，因此收到这里。
 *
 * 两个不能退化的点：
 *   · 读失败时绝不写缓存（否则下次打开会先渲染「还没有文件」）；
 *   · `silent` 不驱动骨架屏与「读取中…」，轮询才不会每 1.5 秒闪一次。
 *
 * @module use-kb-files-snapshot
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { apiGetKbFiles, writeRenderCache } from '../api.ts'
import type { KbFileMeta } from '../types.ts'
import { kbCacheKey } from './kb-scope.ts'
import { cachedFiles } from './kb-files-support.tsx'

/** 单次读取的条数（与后端默认页一致；超过时后端会夹到上限）。 */
const KB_FILES_PAGE = 200
/** 后端单库上限（`MAX_FILES_PER_KB`）：翻页不超过它。 */
const KB_FILES_MAX = 5000

/** 文件列表快照状态。 */
export interface KbFilesSnapshotState {
  snapshot: { items: readonly KbFileMeta[]; total: number }
  setSnapshot: (next: { items: readonly KbFileMeta[]; total: number }) => void
  readError: string | null
  loading: boolean
  /** 还有未加载的文件（`total > 已加载`）。 */
  hasMore: boolean
  /** 正在加载下一页。 */
  loadingMore: boolean
  /** 追加下一页。 */
  loadMore: () => Promise<void>
  error: string | null
  setError: (msg: string | null) => void
  now: number
  load: (opts?: { silent?: boolean }) => Promise<void>
}

/**
 * 读取文件列表并维护首帧缓存。
 * @param kbId - 当前知识库。
 * @returns 快照、错误、加载态与刷新函数。
 */
export function useKbFilesSnapshot(kbId: number): KbFilesSnapshotState {
  const [snapshot, setSnapshot] = useState<{ items: readonly KbFileMeta[]; total: number }>(
    () => cachedFiles(kbId) ?? { items: [], total: 0 },
  )
  const [readError, setReadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(() => {
    const cached = cachedFiles(kbId)
    return cached !== null && cached.items.length < cached.total
  })
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  /** 已加载条数（`load` 的 limit 与 `loadMore` 的 offset 都以它为准，不必进依赖）。 */
  const loadedRef = useRef(snapshot.items.length)
  const loadingMoreRef = useRef(false)

  useEffect(() => { loadedRef.current = snapshot.items.length }, [snapshot.items.length])

  const load = useCallback(async (opts?: { silent?: boolean }): Promise<void> => {
    const silent = opts?.silent === true
    if (!silent) setLoading(true)
    try {
      /**
       * 刷新时至少取回「用户已经翻到的条数」：解析轮询/批量任务会周期性调用本函数，
       * 若每次都只取第一页，用户点了两次「加载更多」后，下一次静默刷新会把列表
       * 缩回 200 条 —— 看起来像文件丢了。上限由后端夹住。
       */
      const want = Math.min(KB_FILES_MAX, Math.max(KB_FILES_PAGE, loadedRef.current))
      const r = await apiGetKbFiles(kbId, { limit: want })
      setSnapshot({ items: r.items, total: r.total })
      setHasMore(r.items.length < r.total)
      setReadError(r.readError ?? null)
      setNow(Date.now())
      if (!r.readError) writeRenderCache(kbCacheKey('kb-files', kbId), { items: r.items, total: r.total })
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      if (!silent) setLoading(false)
    }
  }, [kbId])

  /**
   * 追加下一页。
   *
   * 为什么需要它：后端列表默认只回 200 条（单库上限 5,000），而界面此前既不分页、
   * 页头又显示「已登记 visible / total」—— 第 201 条之后的文件永远不可见，正文检索
   * 命中它们时左侧也点不开。这里按 offset 追加，并按 id 去重（翻页期间可能有新文件
   * 插到最前面，导致同一行出现在两页）。
   */
  const loadMore = useCallback(async (): Promise<void> => {
    if (loadingMoreRef.current) return
    loadingMoreRef.current = true
    setLoadingMore(true)
    try {
      const offset = loadedRef.current
      const r = await apiGetKbFiles(kbId, { limit: KB_FILES_PAGE, offset })
      setSnapshot((prev) => {
        const seen = new Set(prev.items.map((f) => f.id))
        const items = [...prev.items, ...r.items.filter((f) => !seen.has(f.id))]
        loadedRef.current = items.length
        return { items, total: r.total }
      })
      setHasMore(r.items.length > 0 && offset + r.items.length < r.total)
      setReadError(r.readError ?? null)
      setNow(Date.now())
    } catch (e) {
      setError((e as Error).message)
    } finally {
      loadingMoreRef.current = false
      setLoadingMore(false)
    }
  }, [kbId])

  useEffect(() => { void load() }, [load])

  // 切库：先按新库的首帧缓存顶上去，再把不属于新库的读错误清掉。
  useEffect(() => {
    const cached = cachedFiles(kbId)
    setSnapshot(cached ?? { items: [], total: 0 })
    loadedRef.current = cached?.items.length ?? 0
    setHasMore(cached !== null && cached.items.length < cached.total)
    setReadError(null)
    setError(null)
    setLoading(true)
  }, [kbId])

  return {
    snapshot, setSnapshot, readError, loading, loadingMore, hasMore, loadMore, error, setError, now, load,
  }
}
