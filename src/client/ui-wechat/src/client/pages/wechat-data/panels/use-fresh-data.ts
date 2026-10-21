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
 * ## WAL 实时刷新（2026-10-13，`liveRefresh: true` 的面板）
 *
 * 订阅 `dsh-wechat-data-updated`（微信 WAL 增量推送）做**静默重查**：已有数据时不翻
 * `loading`（不闪骨架、不闪按钮文案）、失败**保留旧值不报错**（与缓存后台复验同一降级口径）。
 * 缺省为关：已各自订阅推送的面板（如 Graph 有带条件的守卫）不该被这里再触发一次双查。
 *
 * ## opts 稳定性（2026-10-13 修的真 bug）
 *
 * `opts` 经 ref 读取、**不进 `run` 的依赖**：调用方若传内联对象（`Tasks` 的
 * `{ shouldCache: … }` 就是），旧写法会让 `run` 每次渲染都换身份 ⇒ effect 每次渲染都重跑
 * ⇒ 无限重查循环（jsdom 探针实测：8 次 flush 后 fetcher 被调 **3,166,897 次**）。
 * 语义不变：谓词每次执行都读**最新**的 opts。
 *
 * @module use-fresh-data
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { readRenderCache, writeRenderCache } from '../api.ts'
import { useWechatDataUpdated } from './hooks.tsx'

/** 取数状态。`stale === true` 时 UI **必须**标注"这是缓存数据"。 */
export interface FreshDataState<T> {
  /** 最新查询结果；查询失败且缓存命中时是缓存值；都没有则为 null。 */
  data: T | null
  /** 首次查询 / 重新查询进行中（WAL 静默重查**不**翻它）。 */
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

  /**
   * 静默重新查询：已有数据时不翻 `loading`、不清空内容、失败保留旧值。
   * 用于“刷新”按钮与事件驱动的回源，避免列表闪空 / 滚动位置被重置。
   */
  reloadSilent: () => Promise<void>

  /** 静默刷新是否在途；只用于禁用按钮/`aria-busy`，不替换当前内容。 */
  refreshing: boolean
}

export interface FreshDataOpts<T> {
  /** 返回 false 时**本次结果不写缓存**（N1：读失败的空列表不该进缓存，见 Tasks）。 */
  shouldCache?: (data: T) => boolean
  /** 订阅 WAL 增量推送做静默重查（2026-10-13，见模块头）。 */
  liveRefresh?: boolean
}

/**
 * 取最新数据：打开即查，失败才回退缓存。
 *
 * @param key - 渲染缓存键（同一面板不同上下文请用不同 key，例如 `'moments:' + author`）。
 * @param fetcher - 真实查询（`useCallback` 包一层，避免每次渲染都重查）。
 * @param opts - 可选策略（见 {@link FreshDataOpts}；经 ref 读取，内联传也不会引发重查循环）。
 * @returns 取数状态与 `reload`。
 */
export function useFreshData<T>(
  key: string,
  fetcher: () => Promise<T>,
  opts?: FreshDataOpts<T>,
): FreshDataState<T> {
  /** ① 不预填：初值恒为 null（旧实现是 `useState(() => readRenderCache(key))`）。 */
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  const alive = useRef(true)
  const dataRef = useRef<T | null>(null)
  dataRef.current = data
  const optsRef = useRef(opts)
  optsRef.current = opts
  /**
   * 只允许最后一次发起的请求提交结果。
   *
   * 静默刷新与首屏/键变化可能重叠：慢的旧请求后回来时，如果不判序号，它会把
   * 刚上屏的新快照覆盖回去，表现成列表短暂回退。被取代的请求仍会正常写缓存
   * （它拿到的是同一资源的一份真实快照），但**不更新组件状态**。
   */
  const requestSeqRef = useRef(0)

  /**
   * @param silent - WAL 推送触发的静默重查：已有数据时不翻 loading、失败保留旧值不报错。
   */
  /**
   * @param silent - WAL 推送触发的静默重查：已有数据时不翻 loading、失败保留旧值不报错。
   * @param keepContent - 内容仍显示在屏上时只更新 `refreshing`，绝不翻 `loading`。
   */
  const run = useCallback(async (silent = false, keepContent = false): Promise<void> => {
    const requestSeq = requestSeqRef.current + 1
    requestSeqRef.current = requestSeq
    if (!silent && !keepContent) {
      setLoading(true)
      setError(null)
    }
    try {
      const fresh = await fetcher()
      if (!alive.current || requestSeq !== requestSeqRef.current) return
      setData(fresh)
      setStale(false)
      // ② 成功写回（除非调用方声明"这次结果不该缓存"）
      const o = optsRef.current
      if (o?.shouldCache === undefined || o.shouldCache(fresh)) writeRenderCache(key, fresh)
    } catch (e) {
      if (!alive.current || requestSeq !== requestSeqRef.current) return
      if ((silent || keepContent) && dataRef.current !== null) return
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
      if (alive.current && !silent && !keepContent && requestSeq === requestSeqRef.current) setLoading(false)
    }
  }, [key, fetcher])

  useEffect(() => {
    alive.current = true
    void run()
    return () => { alive.current = false }
  }, [run])

  useWechatDataUpdated(() => {
    if (optsRef.current?.liveRefresh !== true) return
    void run(true)
  })

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

  /** 重新查询（非静默）。reload 身份随 `run` 走（`[key, fetcher]`），调用方可以安全放进依赖。 */
  const reload = useCallback((): Promise<void> => run(false), [run])

  /** 静默重新查询（保留当前内容；见接口说明）。 */
  const reloadSilent = useCallback(async (): Promise<void> => {
    const hasContent = dataRef.current !== null
    setRefreshing(true)
    try {
      // 有内容：保留旧快照，只亮 `refreshing`；失败保留旧值、不打断用户。
      // 无内容：这是首次可见加载，照常翻 `loading`（页面还没有任何可保留的内容）。
      // `silent=true` 仅服务 WAL 这类不由用户主动触发的回源。
      await run(false, hasContent)
    } finally {
      if (alive.current) setRefreshing(false)
    }
  }, [run])

  return { data, loading, error, stale, reload, reloadSilent, refreshing, override }
}
