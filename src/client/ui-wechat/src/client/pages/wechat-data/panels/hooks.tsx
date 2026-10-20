/**
 * 渐进式列表渲染 hook:大数据量列表先渲染前 `step` 项,滚动到底部哨兵
 * 出现时再增量增加,避免一次性渲染上千 DOM 节点导致卡顿。
 * 数据长度变化时自动钳制回合法范围。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import kitCss from '../ui/kit.module.css'
import { LoadingState } from '../ui/kit-fields.tsx'
import { REFRESH_MIN_INTERVAL_MS, computeHasMore, refreshGate, refreshPagesFor } from './paged-list.ts'
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
 *
 * `watch` 是这一族**停滞**问题的补丁：IntersectionObserver 只在"状态变了"的那一刻给回调。
 * 哨兵一直待在视口里（内容比视口矮，或上一次回调正好撞上"这一页还在加载中"被丢掉）时，
 * 不会有第二次回调，于是翻页永远停在当前页 —— 实测在 600 条附件、格子墙视口 625px 高的机器上，
 * 翻到第 2 页就再也不动，界面上看不到任何错误，也只有把列表滚到底才发现"下面还有几百条没出来"。
 * 数据每追加一批就用 `watch` 重新问一次"哨兵还在里面吗"，把"该加载但没被通知"这条路补上。
 * @param onVisible - 哨兵进入视口时调用一次（调用方自己带 `hasMore && !loadingMore` 的闸）。
 * @param rootMargin - 提前量，默认 600px。
 * @param root - 滚动容器（不传就是视口）。
 * @param watch - 变了就重查一次的值，通常传**已加载条数**。
 * @returns 给哨兵元素用的 ref 回调。
 */
export function useLazySentinel(onVisible: () => void, rootMargin = '600px 0px', root?: () => Element | null, watch?: unknown): (el: HTMLDivElement | null) => void {
  const cbRef = useRef(onVisible)
  cbRef.current = onVisible
  const rootRef = useRef(root)
  rootRef.current = root
  const ioRef = useRef<IntersectionObserver | null>(null)
  /** 哨兵此刻在不在视口里（IO 只在变化时报，所以自己记住最后一次的状态）。 */
  const hitRef = useRef(false)
  /** 第一次跑 `watch` 那个 effect 要跳过（挂载时 IO 已经报过一遍了）。 */
  const firstWatchRef = useRef(true)
  const attach = useCallback((el: HTMLDivElement | null) => {
    if (ioRef.current) { ioRef.current.disconnect(); ioRef.current = null }
    if (!el || typeof IntersectionObserver === 'undefined') return
    const rootEl = rootRef.current?.() ?? null
    const ob = new IntersectionObserver((entries) => {
      const hit = !!entries[0]?.isIntersecting
      hitRef.current = hit
      if (hit) cbRef.current()
    }, { root: rootEl, rootMargin })
    ob.observe(el)
    ioRef.current = ob
  }, [rootMargin])
  useEffect(() => {
    // 挂载那一轮不补查：IO 在 `observe()` 时本来就会报一次初始状态，再 call 一遍就是白敲。
    if (firstWatchRef.current) { firstWatchRef.current = false; return }
    if (hitRef.current) cbRef.current()
  }, [watch])
  return attach
}

/**
 * 列表/网格加载态：统一为「旋转指示 + 加载中…」（2026-10-18）。
 *
 * 历史：原来是「头像方块 + 占位线 + 右侧元信息」的骨架条（`.nm-skel` / `.skelRow`），
 * 用户要求「请检查看看哪里还有这样的加载条，请全部修复，用一个正常的加载样式」——
 * 骨架条观感像一排坏掉的卡片，浅色主题下更像异常块。
 *
 * 现在所有调用点（聊天、文件、收藏、通讯录、朋友圈、资金、记录、知识库…）渲染同一个
 * 旋转指示 + 文案；`rows / grid / minCol` 仅为兼容既有调用保留，不再影响视觉。
 * @param props - 旧骨架参数（已无视觉效果，仅为兼容保留）。
 * @returns 统一加载态。
 */
export function ListSkeleton(_props: { rows?: number; grid?: boolean; minCol?: number } = {}): React.JSX.Element {
  return <LoadingState variant="compact" label="加载中…" />
}

/**
 * 订阅宿主「微信数据已更新」事件（真实同步把新数据解密进快照后由宿主派发）。
 * 用 ref 保存最新 handler，避免每次渲染重复订阅；事件触发时调用 ref.current()，
 * 始终拿到最新闭包。相比固定轮询，能按需、即时刷新。
 * @param handler - 数据落地后的刷新回调。
 */
export function useWechatDataUpdated(handler: () => void, eventName = 'dsh-wechat-data-updated', debounceMs = 300): void {
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => {
    let timer: number | undefined
    const on = (): void => {
      // 高频同步事件合并为一次刷新，避免连续重载导致界面卡顿。
      // 合并窗可调（2026-10-13）：后端推送已自带 1.5s 限频，会话列表这类「第一眼就要变」
      // 的界面用更小的窗换更快的响应。
      if (timer !== undefined) window.clearTimeout(timer)
      timer = window.setTimeout(() => { timer = undefined; ref.current() }, debounceMs)
    }
    window.addEventListener(eventName, on)
    return () => {
      if (timer !== undefined) window.clearTimeout(timer)
      window.removeEventListener(eventName, on)
    }
  }, [eventName, debounceMs])
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
/**
 * 慢查询的「走了几秒」计时器。
 *
 * ── 为什么每个慢面板都需要它 ──────────────────────────────────────────────
 * 后端是**同步 SQLite**，单次查询会排在别的重查询后面 —— 资金账本在「数据总览」的
 * 全量统计（扫 21 万条消息）跑完前可能要等十几秒。只给一行「正在统计…」，
 * 用户无从区分"在跑"还是"卡死"（R3 实测：802px 的内容区里留了 608px 连续空白）。
 * 有了秒数，等待就有了可读的进度感，而且不需要后端配合。
 *
 * ── 语义 ─────────────────────────────────────────────────────────────────
 * `active` 转 true 时清零并开始每秒 +1；转 false 时停表并**保留**最后一次读数
 * （面板紧接着就渲染数据了，"闪回 0s"没有意义）；再次转 true 会重新清零。
 *
 * ⚠️ 传进来的 `active` 应当是**首屏加载**（`loading && data === null`），
 * 不要直接传 `loading` —— 有渲染缓存时的后台静默刷新会白闪一次走秒。
 * @param active - 是否处于首屏加载。
 * @returns 已用整秒数。
 */
export function useElapsedSeconds(active: boolean): number {
  const [elapsed, setElapsed] = useState(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  useEffect(() => {
    if (!active) return
    const t0 = Date.now()
    setElapsed(0)
    timerRef.current = setInterval(() => { setElapsed(Math.round((Date.now() - t0) / 1000)) }, 1000)
    return () => {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
    }
  }, [active])
  return elapsed
}

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
 *
 * ## ⚠️ `root` 必须指向**滚动容器**，不能留 `null`（2026-10-16 修「手机端看不到地图」）
 *
 * 原先写的是 `{ root: null, rootMargin }` —— `root: null` 表示「以视口为根」。
 * 但本应用的内容区是 `.content`（`overflow-y: auto`）这个**滚动容器**，
 * 元素在它内部滚动。Chromium 对「元素在滚动容器内、且滚动容器在视口内」的情形
 * 会**额外按滚动容器的裁剪框判定**：实测元素在 `top: 874`（视口 812）、
 * `rootMargin: 1200px` 把 rootBounds 扩到 `-1200 ~ 2012`，元素明明落在里面，
 * `isIntersecting` 仍是 **false** —— 于是地图永远停在「地图进入可视区后加载…」，
 * 用户滚到那里才加载（体感就是「看不到地图」）。
 *
 * 修法：向上找最近的滚动祖先当 `root`。找不到（或它不可滚动）时退回 `null`，
 * 行为与原先一致。
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
    // 最近的**滚动容器**祖先：`overflow-y` 为 auto/scroll。
    //
    // ⚠️ 这里**不能**再要求 `scrollHeight > clientHeight`（2026-10-16 第二次修正）：
    // 本 effect 在首次渲染后立刻运行，而那时面板数据往往还在加载 —— 内容还没撑开，
    // 滚动容器的 `scrollHeight === clientHeight`，于是「可滚」判断为假、一路退到
    // `document.body`，最终退回 `root: null` ⇒ 又踩回「Chromium 按滚动容器裁剪框判定、
    // 元素在容器可视区外就永远不触发」那个坑（实测地图停在占位符）。
    // 只要 `overflow-y` 是 auto/scroll，它就是 IO 该用的 root —— 裁剪框由它决定，
    // 与「此刻能不能滚」无关。
    let root: Element | null = ref.current.parentElement
    while (root && root !== document.body) {
      const oy = getComputedStyle(root).overflowY
      if (oy === 'auto' || oy === 'scroll') break
      root = root.parentElement
    }
    const ob = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) {
        reveal()
        ob.disconnect()
      }
    }, { root: root && root !== document.body ? root : null, rootMargin })
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
 * `refresh()` 的上界与节流口径都在 `paged-list.ts`（纯逻辑才可测）：
 *   · {@link refreshPagesFor} —— 一轮最多 `REFRESH_MAX_PAGES` 页；**装不下就整轮跳过**，
 *     绝不发前 N 页然后把列表截短（截短会塌高度、把用户弹回顶部 —— 那正是 `refresh`
 *     存在的理由被推翻）；
 *   · {@link refreshGate} —— 两轮之间至少隔 `REFRESH_MIN_INTERVAL_MS`，期间到达的
 *     事件合并成一次尾部刷新（合并 ≠ 丢弃），页面不可见时一个请求都不发。
 * 旧写法是「每约 10 秒、最多 16 个重读请求全部压进后端那一条队列」。
 */

export function usePagedList<T>(options: {
  pageSize: number
  fetchPage: (offset: number, limit: number) => Promise<{ items: readonly T[]; total: number }>
  /** 数据事件驱动的后台刷新最小间隔（缺省 30s）。需要更实时的小列表（如会话列表）传更小值。 */
  refreshMinIntervalMs?: number
  /** 推送合并窗（缺省 300ms）。后端推送已自带限频，需要最快响应的小列表传更小值。 */
  refreshDebounceMs?: number
  /**
   * 已加载条数的**硬上限**（缺省 0 = 不限制）。
   *
   * 为什么需要：`useLazySentinel` 的 `watch` 机制会在哨兵**一直待在视口里**时反复
   * 触发 `loadMore`（见 `useLazySentinel` 的注释），而 `loadMore` 是**无上限追加**的。
   * 真机实测：操作日志在连续滚动下累积到 **91,028 个节点 / scrollHeight 260,017px**，
   * 此时滚动 p50 85ms、p90 837ms、单帧最长 941ms（CDP 滚动探针）——
   * 界面基本卡死。这不是「滚动优化」能救的，是 DOM 本身没有上界。
   *
   * 达到上限后 `hasMore` 变 false，哨兵不再触发加载；**已加载的内容一条不丢**，
   * 滚动位置也不动（与「丢弃头部」相比，那种做法会让 scrollTop 跳）。
   * 调用方应当在上限处给出提示，引导用户用筛选缩小范围。
   */
  maxItems?: number
}): {
  items: readonly T[]
  total: number
  loading: boolean
  loadingMore: boolean
  error: string | null
  hasMore: boolean
  /** 是否因为触到 {@link maxItems} 而停止加载（调用方据此提示用户）。 */
  capped: boolean
  loadMore: () => void
  reset: () => void
  refresh: () => void
} {
  const { pageSize, refreshDebounceMs, refreshMinIntervalMs, maxItems = 0 } = options
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
      setItems(prev => {
        if (!append) return list
        const merged = [...prev, ...list]
        // 触到上限就**截断尾部**（保留已加载的前 N 条），而不是丢弃头部 ——
        // 丢头部会让 scrollTop 跳，用户正在看的那一行会跑掉。
        return maxItems > 0 && merged.length > maxItems ? merged.slice(0, maxItems) : merged
      })
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
  }, [pageSize, maxItems])

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
    const plan = refreshPagesFor(want, pageSize)
    if (!plan.feasible) {
      // 已加载的条数超出一轮的上界：这一轮**不刷**。发前 N 页会把列表缩到 N 页，
      // 用户看到的不是「数据旧了一点」而是「列表被截断 + 被弹回顶部」。
      return
    }
    lastRefreshAtRef.current = Date.now()
    const seq = ++seqRef.current
    busyRef.current = true
    void (async () => {
      try {
        const r = await collectPageRange<T>({
          want,
          pageSize,
          maxPages: plan.pages,
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
  /** 上一轮真正开始的时刻 / 已排队的尾部刷新。 */
  const lastRefreshAtRef = useRef(0)
  const trailingRef = useRef<number | undefined>(undefined)

  /**
   * 事件驱动的后台刷新：先过节流门，不可见就不发，被合并掉的那一次排成**尾部刷新**。
   *
   * 「丢弃」与「合并」的差别是要害：只丢掉事件的话，面板会一直停在旧数据上
   * （再也没有人触发刷新）—— 那不是省请求，那是把省请求换成了看不见的过期。
   */
  const maybeBackgroundRefresh = useCallback((): void => {
    const gate = refreshGate({
      now: Date.now(),
      lastStartedAt: lastRefreshAtRef.current,
      hidden: typeof document !== 'undefined' && document.hidden === true,
      minIntervalMs: refreshMinIntervalMs ?? REFRESH_MIN_INTERVAL_MS,
    })
    if (gate.go) { refresh(); return }
    if (gate.waitMs <= 0 || trailingRef.current !== undefined) return
    trailingRef.current = window.setTimeout(() => {
      trailingRef.current = undefined
      refresh()
    }, gate.waitMs)
  }, [refresh, refreshMinIntervalMs])

  // 窗口从后台切回前台时补一次：期间攒下的变更在这里落地（而不是每 10 秒打一轮）。
  useEffect(() => {
    if (typeof document === 'undefined') return undefined
    const onVisible = (): void => { if (document.hidden !== true) refresh() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { document.removeEventListener('visibilitychange', onVisible) }
  }, [refresh])

  useEffect(() => () => {
    if (trailingRef.current !== undefined) window.clearTimeout(trailingRef.current)
  }, [])

  useWechatDataUpdated(() => {
    maybeBackgroundRefresh()
  }, 'dsh-wechat-data-updated', refreshDebounceMs ?? 300)

  /** 是否已触到 {@link maxItems} 上界（`maxItems` 为 0 时恒 false）。 */
  const capped = maxItems > 0 && items.length >= maxItems

  return {
    items,
    total,
    loading,
    loadingMore,
    error,
    // 判定逻辑抽到 paged-list.ts：纯逻辑才能测（本仓库没有 hook/DOM 测试环境），
    // 而且旧判据（`items.length < total && lastCount === pageSize`）会在 total 不可信
    // 或整页末页时静默截断数据 —— 详见该模块头部注释（L7）。
    //
    // 触到 `maxItems` 时**强制 false**：这是 DOM 上界，不是数据到底。
    // 不这么做的话哨兵会一直触发 `loadMore`，而每次追加都被 `slice` 截掉 ——
    // 白跑请求、白重渲，界面还是卡（真机实测过 91,028 节点那一版）。
    hasMore: !capped && computeHasMore({ loaded: items.length, total, lastPageCount: lastCount, pageSize }),
    capped,
    loadMore,
    reset,
    refresh,
  }
}
