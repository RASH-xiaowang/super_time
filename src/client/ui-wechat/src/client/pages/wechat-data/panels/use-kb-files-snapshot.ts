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
import { useCallback, useEffect, useState } from 'react'
import { apiGetKbFiles, writeRenderCache } from '../api.ts'
import type { KbFileMeta } from '../types.ts'
import { kbCacheKey } from './kb-scope.ts'
import { cachedFiles } from './kb-files-support.tsx'

/** 文件列表快照状态。 */
export interface KbFilesSnapshotState {
  snapshot: { items: readonly KbFileMeta[]; total: number }
  setSnapshot: (next: { items: readonly KbFileMeta[]; total: number }) => void
  readError: string | null
  loading: boolean
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
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const load = useCallback(async (opts?: { silent?: boolean }): Promise<void> => {
    const silent = opts?.silent === true
    if (!silent) setLoading(true)
    try {
      const r = await apiGetKbFiles(kbId)
      setSnapshot({ items: r.items, total: r.total })
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

  useEffect(() => { void load() }, [load])

  // 切库：先按新库的首帧缓存顶上去，再把不属于新库的读错误清掉。
  useEffect(() => {
    setSnapshot(cachedFiles(kbId) ?? { items: [], total: 0 })
    setReadError(null)
    setError(null)
    setLoading(true)
  }, [kbId])

  return { snapshot, setSnapshot, readError, loading, error, setError, now, load }
}
