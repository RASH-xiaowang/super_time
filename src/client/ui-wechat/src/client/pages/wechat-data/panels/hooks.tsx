/**
 * 渐进式列表渲染 hook:大数据量列表先渲染前 `step` 项,滚动到底部哨兵
 * 出现时再增量增加,避免一次性渲染上千 DOM 节点导致卡顿。
 * 数据长度变化时自动钳制回合法范围。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import kitCss from '../ui/kit.module.css'

export function useProgressiveList(
  len: number,
  step = 120,
): { count: number; grow: () => void; reveal: (n: number) => void; sentinelRef: (el: HTMLDivElement | null) => void } {
  const [count, setCount] = useState(() => Math.min(step, len))
  const io = useRef<IntersectionObserver | null>(null)

  const sentinelRef = useCallback((el: HTMLDivElement | null) => {
    if (io.current) { io.current.disconnect(); io.current = null }
    if (!el || typeof IntersectionObserver === 'undefined') {
      // 无 IO 支持时直接全量,保证数据可见
      setCount(c => (c < len ? Math.max(len, c) : c))
      return
    }
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) setCount(c => Math.min(c + step, len))
      },
      { root: null, rootMargin: '600px 0px' },
    )
    obs.observe(el)
    io.current = obs
  }, [step, len])

  const grow = useCallback((): void => {
    setCount(c => Math.min(c + step, len))
  }, [step, len])

  /** 至少渲染到第 n 项（定位跳转等场景需要目标项立刻在 DOM 里）。
   *  不做上限钳制：调用时闭包里的 len 可能已过期，返回的 count 会按最新
   *  len 钳制，超出部分自然被忽略。 */
  const reveal = useCallback((n: number): void => {
    setCount(c => Math.max(c, n))
  }, [])

  /*
   * 数据晚到时的自愈（第 62 轮）。
   *
   * `count` 的初值只在**挂载那一刻**算一次：`useState(() => Math.min(step, len))`。
   * 而这些面板一律是「先渲染骨架、数据后到」——冷启动时后端还在同步，首次请求可能返回空快照，
   * 于是挂载时 `len = 0` ⇒ `count = 0`；数据到了之后 `count` 还是 0，
   * 只能靠 sentinel 的 IntersectionObserver 兜回来，而它只在**交叉状态变化**时回调，
   * 实测会卡住：第 62 轮的 31 页签普查里「文件资产」反复读到 37–50 字符的「只有表头」状态
   * （把它改成不渲染任何条目能复现同一个特征：正文 43 字符）。
   *
   * 这里补一次「len 有值但 count 还是 0」的自愈。它只影响这个坏状态：
   * 正常路径上 count 挂载时就已经 ≥ min(step, len) > 0。
   * 同一 hook 被 9 个面板共用（文件/表情包/收藏/会话/账本/媒体/朋友圈/公众号/撤回），
   * 所以修在这里而不是各个调用点。
   */
  useEffect(() => {
    if (count === 0 && len > 0) setCount(Math.min(step, len))
  }, [count, len, step])

  return { count: Math.min(count, len), grow, reveal, sentinelRef }
}

/** 哨兵容器:占位两个像素,IntersectionObserver 观察它即可触发渐进加载。 */
export function ListSentinel({ refFn }: { refFn: (el: HTMLDivElement | null) => void }): React.JSX.Element {
  return <div ref={refFn} className={kitCss.sentinel} aria-hidden="true" />
}

/**
 * 分页哨兵：滚动到可视区附近时回调一次（用于「加载更多」而非仅渐进 DOM 渲染）。
 * 传入的 onVisible 保存在 ref 中，避免每次渲染重建观察器。
 */
export function useLazySentinel(onVisible: () => void, rootMargin = '600px 0px', root?: () => Element | null): (el: HTMLDivElement | null) => void {
  const cbRef = useRef(onVisible)
  cbRef.current = onVisible
  const rootRef = useRef(root)
  rootRef.current = root
  const ioRef = useRef<IntersectionObserver | null>(null)
  return useCallback((el: HTMLDivElement | null) => {
    if (ioRef.current) { ioRef.current.disconnect(); ioRef.current = null }
    if (!el || typeof IntersectionObserver === 'undefined') return
    const rootEl = rootRef.current?.() ?? null
    const ob = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) cbRef.current()
    }, { root: rootEl, rootMargin })
    ob.observe(el)
    ioRef.current = ob
  }, [rootMargin])
}

/**
 * 骨架屏:数据未到时先渲染框架占位(微光动画),不让整页被"加载中…"卡住。
 * 行模式用于列表,网格模式用于卡片格子。
 */
export function ListSkeleton({ rows = 8, grid = false }: { rows?: number; grid?: boolean }): React.JSX.Element {
  return (
    <div className={kitCss.skelGrid} style={{ gridTemplateColumns: grid ? 'repeat(auto-fill, minmax(120px, 1fr))' : '1fr' }} aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className={`nm-skel ${grid ? kitCss.skelCard : kitCss.skelRow}`}>
          {!grid && (
            <>
              <span className={`nm-skel ${kitCss.skelAvatar}`} />
              <span className={`nm-skel ${kitCss.skelLine}`} />
              <span className={`nm-skel ${kitCss.skelMeta}`} />
            </>
          )}
        </div>
      ))}
    </div>
  )
}

/**
 * 订阅宿主「微信数据已更新」事件（真实同步把新数据解密进快照后由宿主派发）。
 * 用 ref 保存最新 handler，避免每次渲染重复订阅；事件触发时调用 ref.current()，
 * 始终拿到最新闭包。相比固定轮询，能按需、即时刷新。
 * @param handler - 数据落地后的刷新回调。
 */
export function useWechatDataUpdated(handler: () => void, eventName = 'dsh-wechat-data-updated'): void {
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => {
    let timer: number | undefined
    const on = (): void => {
      // 高频同步事件合并为一次刷新，避免连续重载导致界面卡顿。
      if (timer !== undefined) window.clearTimeout(timer)
      timer = window.setTimeout(() => { timer = undefined; ref.current() }, 300)
    }
    window.addEventListener(eventName, on)
    return () => {
      if (timer !== undefined) window.clearTimeout(timer)
      window.removeEventListener(eventName, on)
    }
  }, [eventName])
}

/**
 * 懒挂载容器：子元素进入可视区附近时才渲染。用于地图、重型图表或统计区块，
 * 避免打开页签时把不可见的重资源一次性加载/渲染。
 */
export function LazyMount({ children, rootMargin = '600px 0px', placeholder = null, onShow }: {
  children: React.ReactNode
  rootMargin?: string
  placeholder?: React.ReactNode
  onShow?: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const [show, setShow] = useState(false)
  const shownRef = useRef(false)
  const onShowRef = useRef(onShow)
  onShowRef.current = onShow
  const reveal = (): void => {
    setShow(true)
    if (!shownRef.current) {
      shownRef.current = true
      onShowRef.current?.()
    }
  }
  useEffect(() => {
    if (!ref.current || typeof IntersectionObserver === 'undefined') {
      reveal()
      return
    }
    const ob = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) {
        reveal()
        ob.disconnect()
      }
    }, { root: null, rootMargin })
    ob.observe(ref.current)
    return () => { ob.disconnect() }
  }, [rootMargin])
  return <div ref={ref}>{show ? children : placeholder}</div>
}

/**
 * 通用分页加载器：首次装载拉第一页，`loadMore` 追加下一页（offset 分页），
 * `reset` 在筛选/关键词变化时重新从第一页加载。`fetchPage` 使用 ref 持有，
 * 调用方每次渲染传新函数也不会触发重复加载。
 */
export function usePagedList<T>(options: {
  pageSize: number
  fetchPage: (offset: number, limit: number) => Promise<{ items: readonly T[]; total: number }>
}): {
  items: readonly T[]
  total: number
  loading: boolean
  loadingMore: boolean
  error: string | null
  hasMore: boolean
  loadMore: () => void
  reset: () => void
} {
  const { pageSize } = options
  const fetchPageRef = useRef(options.fetchPage)
  fetchPageRef.current = options.fetchPage
  const [items, setItems] = useState<readonly T[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastCount, setLastCount] = useState(0)
  const offsetRef = useRef(0)
  const seqRef = useRef(0)
  const busyRef = useRef(false)

  const load = useCallback(async (append: boolean, force = false): Promise<void> => {
    if (busyRef.current && !force) return
    busyRef.current = true
    const seq = ++seqRef.current
    const offset = append ? offsetRef.current : 0
    if (append) setLoadingMore(true)
    else {
      setItems([])
      setTotal(0)
      setLastCount(0)
      setLoading(true)
      setError(null)
    }
    try {
      const r = await fetchPageRef.current(offset, pageSize)
      if (seq !== seqRef.current) return
      const list = r.items
      setItems(prev => append ? [...prev, ...list] : list)
      setTotal(r.total)
      setLastCount(list.length)
      offsetRef.current = offset + list.length
    } catch (e) {
      if (seq === seqRef.current) setError((e as Error).message)
    } finally {
      if (seq === seqRef.current) {
        setLoading(false)
        setLoadingMore(false)
        busyRef.current = false
      }
    }
  }, [pageSize])

  const loadMore = useCallback((): void => { void load(true) }, [load])
  const reset = useCallback((): void => {
    seqRef.current += 1
    offsetRef.current = 0
    busyRef.current = false
    void load(false, true)
  }, [load])

  // 数据落地后自动补齐「空列表」。
  //
  // 实测（冷启动 + 连续切换页签）：后端启动同步要跑 2–3 分钟，期间请求可能返回
  // 空快照，面板就停在「共 0 项 / 暂无数据」；约 45–60 秒后才自行恢复 —— 但那份
  // 恢复是偶然的：7 个用本钩子的面板里只有 Files 订阅了更新事件，其余并没有
  // 任何刷新通路。这里把它变成确定行为。
  //
  // 只在**当前列表为空**时重载：同步期间该事件约每 10 秒一次，若无条件 reset()
  // 会让已加载的列表每隔 10 秒清空重取，产生可见闪烁。
  useWechatDataUpdated(() => {
    if (items.length === 0) reset()
  })

  return {
    items,
    total,
    loading,
    loadingMore,
    error,
    hasMore: items.length < total && lastCount === pageSize,
    loadMore,
    reset,
  }
}
