/**
 * 「打开即查最新、失败才回退缓存」的**共用取数 hook**（2026-10-03）。
 *
 * ## 为什么要有它
 *
 * 用户要求："数据改为每次打开都会直接请求获取，不需要本地缓存了，只有在（后端不可用的）时候才使用本地缓存"。
 *
 * 但这条规则在面板里被复制粘贴成了同一个模式 —— `const [x, setX] = useState(() => readRenderCache(…))`
 * 出现在 **17 个文件**里。逐个手改等于把同一条语义写 17 遍，任何一处跑偏都没有判据能发现。
 * 所以抽成这一个 hook：**语义只有一处**，面板侧改成一行。
 *
 * ## 三条硬规则（本文件即契约）
 *
 * 1. **不预填**：`data` 初值恒为 `null` —— 打开时绝不先画旧缓存（否则"看到的旧数据会被当成最新"）；
 * 2. **成功写回**：`fetcher` 成功 ⇒ `writeRenderCache(key, fresh)` + `stale = false`（把最新资源保存好）；
 * 3. **失败回退**：`fetcher` 失败 ⇒ 读缓存兜底，命中则 `stale = true` 且 `error` 里**写明**"本地缓存、可能不是最新"；
 *    未命中则只留 `error`（不假装有数据）。
 *
 * @module use-fresh-data
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { readRenderCache, writeRenderCache } from '../api.ts'

/** 取数状态。`stale === true` 时 UI **必须**标注"这是缓存数据"。 */
export interface FreshDataState<T> {
  /** 最新查询结果；查询失败且缓存命中时是缓存值；都没有则为 null。 */
  data: T | null
  /** 首次查询 / 重新查询进行中。 */
  loading: boolean
  /** 失败原因（回退缓存时前缀写明"以下为本地缓存（可能不是最新）"）。 */
  error: string | null
  /** 当前 `data` 是否来自缓存兜底。 */
  stale: boolean
  /**
   * **外部覆写**：本地动作改写了这份数据（切换隐私开关、清空审计记录…）时用它。
   * `data` 本身是只读的（由 hook 拥有），没有这个出口，混合面板就只能把整份数据搬回组件里管。
   * 覆写会把 `stale` / `error` 复位（此后显示的就是本地写入的新值，不再是缓存兜底）。
   */
  override: (next: T) => void

  /** 重新查询（走同一条"先查后缓存"的路径）。 */
  reload: () => Promise<void>
}

/**
 * 取最新数据：打开即查，失败才回退缓存。
 *
 * @param key - 渲染缓存键（同一面板不同上下文请用不同 key，例如 `'moments:' + author`）。
 * @param fetcher - 真实查询（`useCallback` 包一层，避免每次渲染都重查）。
 * @param opts - 可选策略。`shouldCache` 返回 false 时**本次结果不写缓存** ——
 *   `Tasks` 需要它：后端在"读不到待办库"时会返回空列表 + `readError`，
 *   把这份空列表写进缓存，下次打开就会先渲染「暂无待办」，而缓存本身看不出
 *   「是读失败」还是「确实没有」（源码里记着这就是 N1 要消除的假象）。
 * @returns 取数状态与 `reload`。
 */
export function useFreshData<T>(
  key: string,
  fetcher: () => Promise<T>,
  opts?: { shouldCache?: (data: T) => boolean },
): FreshDataState<T> {
  /** ① 不预填：初值恒为 null（旧实现是 `useState(() => readRenderCache(key))`）。 */
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  const alive = useRef(true)

  const run = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const fresh = await fetcher()
      if (!alive.current) return
      setData(fresh)
      setStale(false)
      // ② 成功写回（除非调用方声明"这次结果不该缓存"）
      if (opts?.shouldCache === undefined || opts.shouldCache(fresh)) writeRenderCache(key, fresh)
    } catch (e) {
      if (!alive.current) return
      const msg = (e as Error).message
      const cached = readRenderCache<T>(key)
      if (cached !== null) {
        // ③ 失败回退：数据照给，但**必须**让调用方知道这不是最新的
        setData(cached)
        setStale(true)
        setError('查询失败，以下为本地缓存（可能不是最新）：' + msg)
      } else {
        setError(msg)
      }
    } finally {
      if (alive.current) setLoading(false)
    }
  }, [key, fetcher, opts])

  useEffect(() => {
    alive.current = true
    void run()
    return () => { alive.current = false }
  }, [run])

  /**
   * **键变化即清空 `data`**（2026-10-03 补）。
   *
   * 为什么需要：`run` 只按 `[key, fetcher]` 重跑取数，而 `data` 会保留上一次的值直到新结果回来。
   * 对固定键的面板无害；但**动态键**的组件（`WordCloudCard` 的 cacheKey 随 scope/username/year 变）
   * 会在切 scope 时**闪出上一个键的词云**。
   *
   * 这条 effect 声明在取数 effect **之前** ⇒ 先清空再取数，中间态是"没有数据 + loading"。
   */
  const lastKey = useRef(key)
  useEffect(() => {
    if (lastKey.current === key) return
    lastKey.current = key
    setData(null)
    setStale(false)
    setError(null)
  }, [key])

  /** 外部覆写实现（见接口上的说明）。 */
  const override = useCallback((next: T): void => {
    setData(next)
    setStale(false)
    setError(null)
  }, [])

  return { data, loading, error, stale, reload: run, override }
}
