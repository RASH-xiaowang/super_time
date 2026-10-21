/**
 * 查看器的按需加载缓存（2026-10-21 自 `MediaViewer.tsx` 抽出）。
 *
 * 职责只有一条：**当前图 + 左右相邻各一张**进 LRU，翻页不闪白；其余按需。
 * 抽出来的原因：组件本体受「单函数 ≤250 行」棘轮约束，而这段状态机可独立解释与测试。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { neighborIndexes } from './viewer-model.ts'
import type { ViewerSource } from './viewer-types.ts'

/** 单条资源的加载状态。 */
export interface ViewerEntry {
  src?: string
  error?: string
}

/** LRU 上限：只留最近几张，避免多张原图把内存吃穿。 */
const MAX_CACHED = 4

/** 把异常翻成可读文案。 */
function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.trim() === '' ? '资源加载失败' : raw
}

/**
 * 当前图与相邻图的按需加载。
 * @param sources - 查看器条目。
 * @param index - 当前索引。
 * @param reloadTick - 自增即重试当前图（错误卡片用）。
 * @returns `getEntry`（读缓存）与 `retry`（删缓存并触发重试）。
 */
export function useViewerCache(
  sources: readonly ViewerSource[],
  index: number,
  reloadTick = 0,
): { getEntry: (key: string) => ViewerEntry | undefined; retry: (key: string) => void } {
  const [cache, setCache] = useState<Record<string, ViewerEntry>>({})
  const cacheRef = useRef(cache)
  cacheRef.current = cache
  const inflight = useRef(new Map<string, Promise<void>>())
  const order = useRef<string[]>([])
  const current = sources[index]

  const ensure = useCallback((source: ViewerSource): void => {
    const key = source.key
    if (cacheRef.current[key]?.src !== undefined || inflight.current.has(key)) return
    const task = (async (): Promise<void> => {
      try {
        const url = await source.load()
        if (typeof url !== 'string' || url === '') throw new Error('资源暂不可用')
        order.current = [...order.current.filter((k) => k !== key), key]
        while (order.current.length > MAX_CACHED) {
          const evict = order.current.shift()
          if (evict && evict !== key) {
            setCache((prev) => {
              const next = { ...prev }
              delete next[evict]
              return next
            })
          }
        }
        setCache((prev) => ({ ...prev, [key]: { src: url } }))
      } catch (err) {
        setCache((prev) => ({ ...prev, [key]: { error: errorText(err) } }))
      } finally {
        inflight.current.delete(key)
      }
    })()
    inflight.current.set(key, task)
  }, [])

  // 当前图 + 相邻预取；换图/重试都会重新跑（缓存命中时是空转）。
  useEffect(() => {
    if (!current) return
    ensure(current)
    for (const n of neighborIndexes(sources.length, index, 1)) {
      const s = sources[n]
      if (s) ensure(s)
    }
  }, [sources, index, current, ensure, reloadTick])

  const getEntry = useCallback((key: string): ViewerEntry | undefined => cacheRef.current[key], [])

  const retry = useCallback((key: string): void => {
    setCache((prev) => {
      const next = { ...prev }
      delete next[key]
      return next
    })
    setCache((prev) => ({ ...prev }))
  }, [])

  return { getEntry, retry }
}
