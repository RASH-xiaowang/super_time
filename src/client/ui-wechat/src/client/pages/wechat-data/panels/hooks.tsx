/**
 * 渐进式列表渲染 hook:大数据量列表先渲染前 `step` 项,滚动到底部哨兵
 * 出现时再增量增加,避免一次性渲染上千 DOM 节点导致卡顿。
 * 数据长度变化时自动钳制回合法范围。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import kitCss from '../ui/kit.module.css'
import { computeHasMore } from './paged-list.ts'
import { collectPageRange } from './load-page-range.ts'
import { DEFAULT_NOTICE_MS, createNoticeController, type NoticeController } from './timers.ts'

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
export function ListSkeleton({ rows = 8, grid = false, minCol = 120 }: { rows?: number; grid?: boolean; minCol?: number }): React.JSX.Element {
  return (
    <div className={kitCss.skelGrid} style={{ gridTemplateColumns: grid ? `repeat(auto-fill, minmax(${minCol}px, 1fr))` : '1fr' }} aria-hidden="true">
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
 * 提示语「显示 N 秒后自动消失」的公共实现（L20）。
 *
 * 为什么要有它：这段模式在各面板里被手写抄了十余处，每份都是
 *   `setNotice('…'); window.setTimeout(() => { setNotice(null) }, 3000)`
 * 手写版有两个真实缺陷（`timers.spec.ts` 用假时钟把两条都覆盖了）：
 *   ① 定时器句柄丢了 —— 组件卸载后回调仍会写 state；更常见的是**连出两条提示时，
 *      第一条的定时器把第二条提前清掉**（第二条只停留了「剩余时间」）；
 *   ② 时长散成十余份魔数（同仓实测 2500 / 3000 / 4000 / 6000 共存），改口径要改十处。
 * 计时语义在 `timers.ts` 的 `createNoticeController`（不 import react，可被单测），
 * 这里只是把它接到 `useState` / 卸载清理上的薄壳。
 *
 * **迁移状态（L20 已完成）**：`Contacts / Emoticons / Favorites / Health / Ledger /
 *   Moments / Overview / PeriodSummary / Records / Tasks` 共 10 个面板、13 处已迁到本 hook
 *   （时长按各处原值：3000 / 4000 / 6000，Overview 的图片导出仍是 `flash(x, 2500)`）；
 *   接线由 `transient-notice.wiring.spec.ts` 逐文件钉住（源码级，因为仓库没有组件测试环境）。
 *   仍在原位、**形态不同、未迁移**的两处（都不是「一句提示 N 秒后消失」）：
 *   `DailySummary.tsx` 是 toast 队列（多条并存、各自计时）；`Settings.tsx` 的 `notify` 是带
 *   `kind`/`details`/关闭按钮的富提示（按有无 details 分 5000 / 12000 两档），且该文件不在
 *   本次写集内。
 * 迁移方式：`const [notice, setNotice] = useState<string | null>(null)` →
 * `const { notice, flash, hold, clear } = useTransientNotice(<默认时长>)`，删掉那行 setTimeout，
 * `setNotice(x)` 换成 `flash(x)`（本处时长不一致时显式 `flash(x, ms)`）；
 * **改前不带定时器的常驻提示（失败/错误类）用 `hold(x)`**，`setNotice(null)` 用 `clear()`。
 * @param durationMs - 默认存活时长；只在挂载时取一次，逐次微调请用 `flash(value, ms)`。
 * @returns `notice` 当前提示；`flash` 写入并自动消失；`hold` 写入且常驻；`clear` 立即清空。
 */
export function useTransientNotice<T = string>(durationMs: number = DEFAULT_NOTICE_MS): {
  notice: T | null
  flash: (value: T, ms?: number) => void
  hold: (value: T) => void
  clear: () => void
} {
  const [notice, setNotice] = useState<T | null>(null)
  const ref = useRef<NoticeController<T> | null>(null)
  // 惰性建一次：控制器持有定时器句柄，重建会丢掉待执行的那次（也就丢了自动消失）。
  const controller = ref.current ?? (ref.current = createNoticeController<T>({ apply: setNotice, durationMs }))
  useEffect(() => () => { ref.current?.dispose() }, [])
  // flash/hold/clear 直接用控制器上的方法：它们不依赖 this，引用恒定 —— 传进子组件或
  // 放进依赖数组都不会引起重复渲染。
  return { notice, flash: controller.flash, hold: controller.hold, clear: controller.clear }
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
/**
 * `refresh()` 单轮最多发多少个请求（每个上限 `pageSize`）。
 * 16 × 200 = 3200 条，足够覆盖真实账号的通讯录量级（实测全量约 2150）；
 * 设上界是为了让「后台刷新」绝不退化成无界拉取。
 */
const MAX_REFRESH_PAGES = 16

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
  refresh: () => void
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

  const load = useCallback(async (append: boolean, force = false, keepItems = false): Promise<void> => {
    if (busyRef.current && !force) return
    busyRef.current = true
    const seq = ++seqRef.current
    const offset = append ? offsetRef.current : 0
    if (append) setLoadingMore(true)
    else if (keepItems) {
      // 非破坏性刷新：**不动 items**，列表与滚动位置都保持原样，等新数据到达再替换。
      setError(null)
    } else {
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

  /**
   * **非破坏性**地重新取数：保留当前已加载的列表（不置空、不显示骨架屏），
   * 数据到达后再原位替换。
   *
   * 为什么必须与 `reset` 分开（本方法存在的唯一理由）：
   * `reset()` 会**同步** `setItems([])`，列表瞬间被换成骨架屏 —— 内容高度从「已加载
   * 的 N 条」塌到 12 行时，浏览器会把 `scrollTop` 钳到 0。于是任何走 `reset` 的
   * 后台刷新都会把用户**弹回列表顶部**。实测触发路径：实时同步每约 10 秒派发一次
   * `dsh-wechat-data-updated`，本钩子订阅它并 `reset()`，用户往下翻之后会不断被顶回顶部。
   *
   * 取数范围要**覆盖已加载条数**：只重取第一页会让列表从 N 条缩回一页，高度骤降
   * 同样会把滚动位置钳掉。所以按「已加载条数」重取，并保持 `offsetRef` 停在末尾，
   * 后续 `loadMore()` 接着往下翻。单次请求仍以 `pageSize` 为上限（不放大 IPC 负载），
   * 因此最多发 `MAX_REFRESH_PAGES` 个请求；超过就退回「重建第一页」，不做无界刷新。
   *
   * `refresh()` 只用于「筛选条件没变、只是要拿最新数据」的场景；筛选条件真的变了
   * 仍用 `reset()` —— 那种情况本来就应该回到顶部。
   */
  const refresh = useCallback((): void => {
    const want = offsetRef.current
    if (want <= 0) { void load(false, true, true); return }
    const seq = ++seqRef.current
    busyRef.current = true
    void (async () => {
      try {
        const r = await collectPageRange<T>({
          want,
          pageSize,
          maxPages: MAX_REFRESH_PAGES,
          fetchPage: (offset, limit) => fetchPageRef.current(offset, limit),
          // 返回 false = 这一轮已作废（期间发生了切换分类/搜索），丢弃已收集内容。
          onPage: (info) => {
            if (seq !== seqRef.current) return false
            setTotal(info.total)
            return true
          },
        })
        if (seq !== seqRef.current) return
        setItems(r.items)
        setLastCount(r.items.length)
        offsetRef.current = r.items.length
        setError(null)
      } catch (e) {
        if (seq === seqRef.current) setError((e as Error).message)
      } finally {
        if (seq === seqRef.current) {
          setLoading(false)
          setLoadingMore(false)
          busyRef.current = false
        }
      }
    })()
  }, [load, pageSize])

  // 数据落地后安静刷新，使新数据及时可见。
  //
  // 实测（冷启动 + 连续切换页签）：后端启动同步要跑 2–3 分钟，期间请求可能返回
  // 空快照，面板就停在「共 0 项 / 暂无数据」；约 45–60 秒后才自行恢复 —— 但那份
  // 恢复是偶然的：用本钩子的面板里只有 Files 订阅了更新事件，其余并没有任何刷新
  // 通路。这里把它变成确定行为。
  //
  // 用 `refresh()`（非破坏性）而不是 `reset()`：同步活跃期该事件约每 10 秒一次，
  // 而 `reset()` 会**同步清空 items** ⇒ 列表被骨架屏替换 ⇒ 容器高度塌陷 ⇒
  // 浏览器把 scrollTop 钳到 0 —— 用户往下翻之后会被反复**弹回顶部**。
  // `refresh()` 保留当前列表并按已加载条数重取，滚动位置不受影响。
  useWechatDataUpdated(() => {
    refresh()
  })

  return {
    items,
    total,
    loading,
    loadingMore,
    error,
    // 判定逻辑抽到 paged-list.ts：纯逻辑才能测（本仓库没有 hook/DOM 测试环境），
    // 而且旧判据（`items.length < total && lastCount === pageSize`）会在 total 不可信
    // 或整页末页时静默截断数据 —— 详见该模块头部注释（L7）。
    hasMore: computeHasMore({ loaded: items.length, total, lastPageCount: lastCount, pageSize }),
    loadMore,
    reset,
    refresh,
  }
}
