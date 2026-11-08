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

/** 全局记录 load 函数身份；只有真正换了加载器才算同一 key 的新资源。 */
const loadIdentity = new WeakMap<ViewerSource['load'], number>()
let nextLoadIdentity = 1

/** 生成「资源键 + 加载器身份」签名，数组重建但内容不变时保持稳定。 */
function sourcesSignatureOf(sources: readonly ViewerSource[]): string {
  return sources.map((source) => {
    let id = loadIdentity.get(source.load)
    if (id === undefined) {
      id = nextLoadIdentity
      nextLoadIdentity += 1
      loadIdentity.set(source.load, id)
    }
    return [source.key, String(id), source.kind ?? 'image', String(source.startAtMs ?? '')].join('\u001e')
  }).join('\u001f')
}

/** 把异常翻成可读文案。 */
function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  if (raw.trim() !== '') console.warn('[media-viewer] 资源加载失败：', raw)
  return '资源暂不可用，请稍后重试'
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
): {
  getEntry: (key: string) => ViewerEntry | undefined
  retry: (key: string) => void
  reportError: (key: string, message: string) => void
} {
  const [cache, setCache] = useState<Record<string, ViewerEntry>>({})
  const cacheRef = useRef(cache)
  cacheRef.current = cache
  /**
   * 键 → 发起请求时的 generation。
   *
   * 只存 Promise 无法判断「回包时查看器是不是已经换了一批源」；旧请求还会把新请求
   * 的同名键从在做集合里删掉。存 generation 后，旧任务只能清理自己那一轮。
   */
  const inflight = useRef(new Map<string, number>())
  const order = useRef<string[]>([])
  /** 每次资源键序列变化或卸载都 +1，让上一批源的迟到回包失效。 */
  const generation = useRef(0)
  const mountedSignature = useRef<string | null>(null)
  const current = sources[index]
  /**
   * 按「键 + 加载器身份」判断源是否变化。
   *
   * 朋友圈查看器会在每次父组件渲染时重新 map 出 sources 数组；如果按数组引用清缓存，
   * 实况状态或失败提示的一次 setState 就会把已加载原图与正在预取的请求全部作废。
   * 同一键换了加载器仍视为新资源，保留「同名源切换必须重载」的旧契约。
   */
  const sourcesSignature = sourcesSignatureOf(sources)

  useEffect(() => {
    const changed = mountedSignature.current !== null && mountedSignature.current !== sourcesSignature
    mountedSignature.current = sourcesSignature
    generation.current += 1
    if (changed) {
      cacheRef.current = {}
      order.current = []
      setCache({})
    }
    const myGeneration = generation.current
    return () => {
      if (generation.current === myGeneration) generation.current += 1
      inflight.current.clear()
      order.current = []
    }
  }, [sourcesSignature])

  /**
   * 成功和失败都必须进入同一条 LRU。
   *
   * 此前失败项只写 cache、不写 order，于是永远不会被淘汰；长期反复打开坏图会把
   * 错误文本和 URL 留在内存里直到整个 renderer 退出。
   */
  const commit = useCallback((key: string, entry: ViewerEntry, myGeneration: number): void => {
    if (myGeneration !== generation.current) return
    order.current = [...order.current.filter((k) => k !== key), key]
    const evicted: string[] = []
    while (order.current.length > MAX_CACHED) {
      const oldest = order.current.shift()
      if (oldest !== undefined) evicted.push(oldest)
    }
    setCache((prev) => {
      const next = { ...prev }
      for (const oldKey of evicted) delete next[oldKey]
      next[key] = entry
      return next
    })
  }, [])

  /** 当前图再次被定位时提升到 MRU，避免预取的环绕邻居把正在看的失败/成功项挤掉。 */
  const touch = useCallback((key: string): void => {
    if (cacheRef.current[key] === undefined) return
    order.current = [...order.current.filter((k) => k !== key), key]
  }, [])

  const ensure = useCallback((source: ViewerSource): void => {
    const key = source.key
    const cached = cacheRef.current[key]
    if (cached?.src !== undefined || cached?.error !== undefined) {
      // 失败项只允许用户点「重试」或 reloadTick 清掉，不能被普通重渲染自动重拉；
      // 但正在看的那一项必须提升到 MRU，否则环绕预取会把当前错误项直接挤出缓存。
      touch(key)
      return
    }
    if (inflight.current.has(key)) return
    const myGeneration = generation.current
    inflight.current.set(key, myGeneration)
    const task = (async (): Promise<void> => {
      try {
        const url = await source.load()
        if (typeof url !== 'string' || url === '') throw new Error('资源暂不可用')
        commit(key, { src: url }, myGeneration)
      } catch (err) {
        commit(key, { error: errorText(err) }, myGeneration)
      } finally {
        if (inflight.current.get(key) === myGeneration) inflight.current.delete(key)
      }
    })()
    void task
  }, [commit, touch])

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

  const reportError = useCallback((key: string, message: string): void => {
    commit(key, { error: message }, generation.current)
  }, [commit])

  const retry = useCallback((key: string): void => {
    setCache((prev) => {
      const next = { ...prev }
      delete next[key]
      return next
    })
  }, [])

  return { getEntry, retry, reportError }
}
