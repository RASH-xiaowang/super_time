/**
 * 渐进式列表窗口：首屏只挂载一小段，靠近底部时继续追加；超过窗口上限后
 * 从头部回收 DOM，并用实测高度补位，避免长列表只增不减。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import kitCss from '../ui/kit.module.css'
import { LoadingState } from '../ui/kit-fields.tsx'
import { REFRESH_MIN_INTERVAL_MS, computeHasMore, refreshGate, refreshPagesFor } from './paged-list.ts'
import { collectPageRange } from './load-page-range.ts'
import { DEFAULT_NOTICE_MS, createNoticeController, type NoticeController } from './timers.ts'
import { useKeepAliveActive } from './keep-alive.tsx'

interface ProgressiveWindow {
  /** 当前窗口第一个条目的原始索引。 */
  start: number
  /** 当前窗口结束位置（不含），沿用旧 API 的 `count` 语义。 */
  end: number
  /** 已卸载头部条目的实测总高度。 */
  beforeHeight: number
  /**
   * 每次向下回收的头部区间及实测高度。
   *
   * 向上滚回时必须按相反顺序恢复这些区间；只存总高度无法知道下一段该恢复多少。
   */
  headRuns: ProgressiveHeadRun[]
}

interface ProgressiveHeadRun {
  start: number
  end: number
  height: number
}

export interface ProgressiveListOptions {
  /**
   * 同时挂载的最大条目数。默认 `step * 3`。
   *
   * 这不是「最多加载多少数据」，而是 DOM 窗口上限：滚过上限后从头部回收，
   * 用等高占位保持滚动位置，后面的数据仍可继续加载。
   */
  maxCount?: number
  /** 筛选、搜索或业务页签变化时重置到第一段（内容变了，旧索引不再有意义）。 */
  resetKey?: unknown
  /** 与外部共用滚动容器（例如会话列表还要给键盘导航用）时传入。 */
  listRef?: RefObject<HTMLElement | null>
}

function initialProgressiveWindow(len: number, step: number): ProgressiveWindow {
  return { start: 0, end: Math.min(Math.max(0, len), step), beforeHeight: 0, headRuns: [] }
}

function normalizeProgressiveWindow(
  window: ProgressiveWindow,
  len: number,
  step: number,
  maxCount: number,
): ProgressiveWindow {
  const total = Math.max(0, len)
  if (total === 0) return initialProgressiveWindow(0, step)
  if (window.end <= 0 || window.start >= total) return initialProgressiveWindow(total, step)
  const end = Math.min(window.end, total)
  // 数据缩短时只裁尾部。把 start 往回拉会让已回收条目重新出现、却保留不了
  // 对应的占位高度，滚动位置会突然跳动；只要 start 仍在范围内就原样保留。
  let start = window.start
  if (end - start > maxCount) {
    // 只有窗口上限本身变小时才会走到这里。此时无法反推旧占位对应的高度，
    // 清空头部状态比保留一份错位的高度更安全。
    start = Math.max(0, end - maxCount)
  }
  return start === window.start && end === window.end
    ? window
    : start !== window.start
      ? { start, end, beforeHeight: 0, headRuns: [] }
    : { ...window, start, end }
}

/**
 * 渐进式列表窗口。
 *
 * 旧实现只增不减：`count` 每次靠近底部就加 `step`，用户一路滚下去后前面所有条目
 * 都留在 DOM 里。现在窗口有硬上限，越过上限时从头部回收；被回收条目的实际高度
 * 写入顶部占位，使剩余内容在屏幕上的坐标不变。
 *
 * 为什么不用固定行高虚拟化：这些列表混有图片、多行正文、展开卡片，行高不固定。
 * 这里只要求条目根节点带 `data-progressive-item={原始索引}`，回收时用相邻条目的
 * 实际 `getBoundingClientRect().top` 差测高度，不假设行高。
 *
 * @param len - 当前数据总条数。
 * @param step - 每次追加的条数。
 * @param options - 窗口上限、重置键、外部列表 ref。
 * @returns 当前窗口、顶部占位高度、哨兵 ref 与列表 ref。
 */
export function useProgressiveList(
  len: number,
  step = 120,
  options: ProgressiveListOptions = {},
): {
  start: number
  end: number
  count: number
  beforeHeight: number
  grow: () => void
  reveal: (n: number) => void
  sentinelRef: (el: HTMLDivElement | null) => void
  topSentinelRef: (el: HTMLDivElement | null) => void
  listRef: RefObject<HTMLElement | null>
} {
  const safeStep = Math.max(1, Math.floor(step) || 1)
  const maxCount = Math.max(safeStep, Math.floor(options.maxCount ?? safeStep * 3) || safeStep)
  const [window, setWindow] = useState<ProgressiveWindow>(() => initialProgressiveWindow(len, safeStep))
  const windowRef = useRef(window)
  windowRef.current = window
  const active = useKeepAliveActive()
  const activeRef = useRef(active)
  activeRef.current = active
  const fallbackListRef = useRef<HTMLElement | null>(null)
  const listRef = options.listRef ?? fallbackListRef
  const [bottomEl, setBottomEl] = useState<HTMLDivElement | null>(null)
  const bottomIo = useRef<IntersectionObserver | null>(null)
  const [topEl, setTopEl] = useState<HTMLDivElement | null>(null)
  const topIo = useRef<IntersectionObserver | null>(null)
  const lenRef = useRef(len)
  lenRef.current = len
  const resetKeyRef = useRef(options.resetKey)
  const pendingResetRef = useRef(false)

  const reset = useCallback((): void => {
    if (!activeRef.current) {
      pendingResetRef.current = true
      return
    }
    pendingResetRef.current = false
    setWindow(initialProgressiveWindow(lenRef.current, safeStep))
  }, [safeStep])

  // 数据晚到 / 缩短 / 过滤后，把已有窗口钳回合法范围；不会把正常滚动进度重置。
  useEffect(() => {
    // 隐藏分段不写状态；active 重新为 true 时本 effect 会带着最新 len 再跑一次。
    if (!active) return
    setWindow(prev => normalizeProgressiveWindow(prev, len, safeStep, maxCount))
  }, [active, len, safeStep, maxCount])

  // 只在 resetKey 真正变化时重置。隐藏期间发生变化就记一笔，重新显示后再应用。
  useEffect(() => {
    if (options.resetKey === resetKeyRef.current) return
    resetKeyRef.current = options.resetKey
    if (options.resetKey === undefined) return
    reset()
  }, [active, options.resetKey, reset])

  useEffect(() => {
    if (active && pendingResetRef.current) reset()
  }, [active, reset])

  const grow = useCallback((): void => {
    if (!activeRef.current) return
    const current = windowRef.current
    const total = Math.max(0, lenRef.current)
    if (current.end >= total) return
    const end = Math.min(total, current.end + safeStep)
    const start = Math.max(0, end - maxCount)
    let removedHeight = 0
    if (start > current.start) {
      const root = listRef.current
      const first = root?.querySelector<HTMLElement>(`[data-progressive-item="${current.start}"]`)
      const next = root?.querySelector<HTMLElement>(`[data-progressive-item="${start}"]`)
      if (first && next) {
        removedHeight = Math.max(0, next.getBoundingClientRect().top - first.getBoundingClientRect().top)
      } else {
        // 测量不到真实高度时宁可不回收：否则占位高度为 0，用户会看到滚动位置跳动。
        // 所有使用窗口上限的列表都传了 listRef；留这条兜底是为了让误配置表现为
        // “窗口不再增长”，而不是更难定位的视觉错位。
        return
      }
    }
    setWindow(prev => {
      if (prev.start !== current.start || prev.end !== current.end) return prev
      return {
        start,
        end,
        beforeHeight: Math.round(prev.beforeHeight + removedHeight),
        headRuns: [
          ...prev.headRuns,
          { start: current.start, end: start, height: Math.round(removedHeight) },
        ],
      }
    })
  }, [listRef, maxCount, safeStep])

  // ref 回调只登记元素；观察器由 effect 重挂。元素本身是依赖，因此搜索/页签条件
  // 让哨兵在窗口范围不变时重新挂载，也能重新接上。
  const growRef = useRef(grow)
  growRef.current = grow
  const sentinelRef = useCallback((el: HTMLDivElement | null) => { setBottomEl(el) }, [])

  /** 从头部恢复最近一次回收的区间，并裁掉等量尾部条目，保持窗口上界不变。 */
  const shiftBack = useCallback((): void => {
    if (!activeRef.current) return
    const current = windowRef.current
    const last = current.headRuns.at(-1)
    if (!last || last.start >= current.start) return
    const count = current.start - last.start
    const end = Math.max(last.start, current.end - count)
    setWindow(prev => {
      if (prev.start !== current.start || prev.end !== current.end) return prev
      const tail = prev.headRuns.at(-1)
      if (!tail || tail.start !== last.start) return prev
      return {
        start: last.start,
        end,
        beforeHeight: Math.max(0, Math.round(prev.beforeHeight - last.height)),
        headRuns: prev.headRuns.slice(0, -1),
      }
    })
  }, [])

  const topSentinelRef = useCallback((el: HTMLDivElement | null): void => { setTopEl(el) }, [])

  /*
   * 顶部哨兵和底部哨兵都随窗口变化重挂观察器。
   *
   * IntersectionObserver 只报“相交状态变化”：如果向上恢复一段后哨兵仍留在
   * rootMargin 内，不重挂就收不到第二次回调，用户会停在半空占位里。窗口变化后
   * 重挂一次，可在同一帧里继续恢复，直到哨兵离开预加载区或已回到第 0 条。
   */
  const shiftBackRef = useRef(shiftBack)
  shiftBackRef.current = shiftBack

  useEffect(() => {
    if (bottomIo.current) {
      bottomIo.current.disconnect()
      bottomIo.current = null
    }
    const el = bottomEl
    if (!active || !el) return undefined
    if (typeof IntersectionObserver === 'undefined') {
      // 无 IO 支持时也保持窗口硬上界。Electron 运行时始终有 IO；这里不能为了
      // 降级可见性把 1 万条重新塞回 DOM。
      const total = Math.max(0, lenRef.current)
      setWindow({ start: 0, end: Math.min(total, maxCount), beforeHeight: 0, headRuns: [] })
      return undefined
    }
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && activeRef.current) growRef.current()
      },
      { root: null, rootMargin: '600px 0px' },
    )
    obs.observe(el)
    bottomIo.current = obs
    return () => {
      obs.disconnect()
      if (bottomIo.current === obs) bottomIo.current = null
    }
  }, [active, bottomEl, maxCount, window.end])

  useEffect(() => {
    if (topIo.current) {
      topIo.current.disconnect()
      topIo.current = null
    }
    const el = topEl
    if (!active || !el || typeof IntersectionObserver === 'undefined') return undefined
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && activeRef.current) shiftBackRef.current()
      },
      { root: null, rootMargin: '600px 0px' },
    )
    obs.observe(el)
    topIo.current = obs
    return () => {
      obs.disconnect()
      if (topIo.current === obs) topIo.current = null
    }
  }, [active, topEl, window.start])

  /** 至少渲染到第 n 项（定位跳转等场景需要目标项立刻在 DOM 里）。 */
  const reveal = useCallback((n: number): void => {
    if (!activeRef.current) return
    setWindow(prev => {
      const total = Math.max(0, lenRef.current)
      const end = Math.min(total, Math.max(prev.end, Math.floor(n) || 0))
      const start = Math.max(0, end - maxCount)
      return end === prev.end && start === prev.start
        ? prev
        : start !== prev.start
          // 跳转后的头部不再是原来的连续区间；保留旧占位会把同一条目
          // 既算进 spacer 又挂进 DOM。清空头部状态，至少不发生重复占位。
          ? { start, end, beforeHeight: 0, headRuns: [] }
          : { ...prev, end }
    })
  }, [maxCount])

  return {
    start: window.start,
    end: window.end,
    count: window.end,
    beforeHeight: window.beforeHeight,
    grow,
    reveal,
    sentinelRef,
    topSentinelRef,
    listRef,
  }
}

/** 哨兵容器:占位两个像素,IntersectionObserver 观察它即可触发渐进加载。 */
export function ListSentinel({ refFn }: { refFn: (el: HTMLDivElement | null) => void }): React.JSX.Element {
  return <div ref={refFn} className={kitCss.sentinel} aria-hidden="true" />
}

/**
 * 已回收头部条目的等高占位；高度来自真实 DOM 测量，不参与点击与读屏。
 *
 * 顶部哨兵与占位一起渲染：用户向上滚回预加载区时，按记录的回收区间把条目
 * 放回占位位置，而不是让用户穿过一整段不可见空白。
 */
export function ProgressiveListSpacer({ height, topSentinelRef }: {
  height: number
  topSentinelRef?: (el: HTMLDivElement | null) => void
}): React.JSX.Element | null {
  if (height <= 0) return null
  return (
    <>
      {topSentinelRef && (
        <div
          ref={topSentinelRef}
          className={kitCss.windowTopSentinel}
          data-progressive-top-sentinel=""
          aria-hidden="true"
        />
      )}
      <div className={kitCss.windowSpacer} data-progressive-spacer={height} style={{ height }} aria-hidden="true" />
    </>
  )
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
  const active = useKeepAliveActive()
  const activeRef = useRef(active)
  activeRef.current = active
  const elRef = useRef<HTMLDivElement | null>(null)
  const ioRef = useRef<IntersectionObserver | null>(null)
  /** 哨兵此刻在不在视口里（IO 只在变化时报，所以自己记住最后一次的状态）。 */
  const hitRef = useRef(false)
  /** 第一次跑 `watch` 那个 effect 要跳过（挂载时 IO 已经报过一遍了）。 */
  const firstWatchRef = useRef(true)
  /** 首次挂载的 ref 回调已经建过观察器；active effect 不能在挂载时再建第二只。 */
  const firstActiveEffectRef = useRef(true)
  const attach = useCallback((el: HTMLDivElement | null) => {
    elRef.current = el
    if (ioRef.current) { ioRef.current.disconnect(); ioRef.current = null }
    // 新观察器要重新等一次相交首报；保留上一轮 true 会让同一次提交里的
    // watch 补查与 observe 首报各 call 一次。
    hitRef.current = false
    if (!activeRef.current || !el || typeof IntersectionObserver === 'undefined') return
    const rootEl = rootRef.current?.() ?? null
    const ob = new IntersectionObserver((entries) => {
      const hit = !!entries[0]?.isIntersecting
      hitRef.current = hit
      if (hit && activeRef.current) cbRef.current()
    }, { root: rootEl, rootMargin })
    ob.observe(el)
    ioRef.current = ob
  }, [rootMargin])
  // display:none 期间 IO 可能只报一次 false；恢复显示后主动重挂，
  // 避免哨兵仍在视口里却收不到第二次相交回调。
  useEffect(() => {
    if (firstActiveEffectRef.current) {
      firstActiveEffectRef.current = false
      return
    }
    const el = elRef.current
    if (el) attach(el)
  }, [active, attach])
  useEffect(() => {
    // 挂载那一轮不补查：IO 在 `observe()` 时本来就会报一次初始状态，再 call 一遍就是白敲。
    if (firstWatchRef.current) { firstWatchRef.current = false; return }
    // 恢复显示由上面的 active effect 重挂观察器；这里只补「数据追加」这一路，
    // 否则 active 与 watch 同时变化时 observe 首报和补查会各 call 一次。
    if (activeRef.current && hitRef.current) cbRef.current()
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
export interface WechatDataUpdatedOptions {
  /**
   * 隐藏期间收到的事件是否在重新显示时补跑一次。
   *
   * `usePagedList` / `useFreshData` 自己已有恢复钩子；它们传 false，避免恢复时双查。
   * 其余直接订阅的面板默认 true：隐藏期间不查，但恢复后不能让数据永久停在旧快照。
   */
  replayOnResume?: boolean
}

export function useWechatDataUpdated(
  handler: () => void,
  eventName = 'dsh-wechat-data-updated',
  debounceMs = 300,
  options: WechatDataUpdatedOptions = {},
): void {
  const ref = useRef(handler)
  ref.current = handler
  const active = useKeepAliveActive()
  const activeRef = useRef(active)
  activeRef.current = active
  const wasActiveRef = useRef(active)
  const dirtyRef = useRef(false)
  const scheduleRef = useRef<(() => void) | null>(null)
  const replayOnResume = options.replayOnResume !== false
  useEffect(() => {
    let timer: number | undefined
    const schedule = (): void => {
      if (timer !== undefined) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        timer = undefined
        // 合并窗内面板被隐藏：不后台查询，留到恢复时补跑（或交给面板自己的恢复钩子）。
        if (!activeRef.current) {
          dirtyRef.current = true
          return
        }
        ref.current()
      }, debounceMs)
    }
    scheduleRef.current = schedule
    const on = (): void => {
      if (!activeRef.current) {
        dirtyRef.current = true
        return
      }
      // 高频同步事件合并为一次刷新，避免连续重载导致界面卡顿。
      // 合并窗可调（2026-10-13）：后端推送已自带限频；会话列表这类「第一眼就要变」
      // 的界面把窗归零，直接刷新。
      schedule()
    }
    window.addEventListener(eventName, on)
    return () => {
      if (timer !== undefined) window.clearTimeout(timer)
      if (scheduleRef.current === schedule) scheduleRef.current = null
      window.removeEventListener(eventName, on)
    }
  }, [eventName, debounceMs])

  useEffect(() => {
    const resumed = active && !wasActiveRef.current
    wasActiveRef.current = active
    if (!resumed) return
    if (!replayOnResume) {
      dirtyRef.current = false
      return
    }
    if (!dirtyRef.current) return
    dirtyRef.current = false
    scheduleRef.current?.()
  }, [active, replayOnResume])
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

function usePagedListLoader<T>(
  fetchPage: (offset: number, limit: number) => Promise<{ items: readonly T[]; total: number }>,
  pageSize: number,
  maxItems: number,
  refreshPageLimit = 0,
  mergeItems?: (current: readonly T[], incoming: readonly T[]) => readonly T[],
) {
  const fetchPageRef = useRef(fetchPage)
  fetchPageRef.current = fetchPage
  const [items, setItems] = useState<readonly T[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastCount, setLastCount] = useState(0)
  const offsetRef = useRef(0)
  const seqRef = useRef(0)
  const busyRef = useRef(false)
  const active = useKeepAliveActive()
  const activeRef = useRef(active)
  activeRef.current = active
  const lastRefreshAtRef = useRef(0)

  const load = useCallback(async (append: boolean, force = false, keepItems = false): Promise<void> => {
    if (!activeRef.current) return
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
      if (seq !== seqRef.current || !activeRef.current) return
      const list = r.items
      setItems(prev => {
        if (!append) return list
        const merged = mergeItems ? mergeItems(prev, list) : [...prev, ...list]
        // 触到上限就**截断尾部**（保留已加载的前 N 条），而不是丢弃头部 ——
        // 丢头部会让 scrollTop 跳，用户正在看的那一行会跑掉。
        return maxItems > 0 && merged.length > maxItems ? merged.slice(0, maxItems) : merged
      })
      setTotal(r.total)
      setLastCount(list.length)
      offsetRef.current = offset + list.length
    } catch (e) {
      if (seq === seqRef.current && activeRef.current) setError((e as Error).message)
    } finally {
      if (seq === seqRef.current) {
        busyRef.current = false
        if (activeRef.current) {
          setLoading(false)
          setLoadingMore(false)
        }
      }
    }
  }, [pageSize, maxItems, mergeItems])

  const loadMore = useCallback((): void => { void load(true) }, [load])
  const reset = useCallback((): void => {
    seqRef.current += 1
    offsetRef.current = 0
    busyRef.current = false
    if (!activeRef.current) return
    void load(false, true)
  }, [load])

  const refresh = useCallback((): void => {
    if (!activeRef.current) return
    const want = offsetRef.current
    if (want <= 0) {
      lastRefreshAtRef.current = Date.now()
      void load(false, true, true)
      return
    }
    // 会话列表这类「已加载 N 页但只需要最新头部」的列表：一轮刷新收成**一个**
    // `offset=0, limit=want` 请求，避免 600 条时连续打 5 次 getSessions。
    // 其它分页列表保持原逻辑（逐页取，保证页参数与页面语义一致）。
    const singleLimit = refreshPageLimit > 0 ? Math.min(want, Math.floor(refreshPageLimit)) : 0
    if (singleLimit > 0) {
      const seq = ++seqRef.current
      busyRef.current = true
      lastRefreshAtRef.current = Date.now()
      void (async () => {
        try {
          const r = await fetchPageRef.current(0, singleLimit)
          if (seq !== seqRef.current || !activeRef.current) return
          setItems((prev) => {
            const merged = mergeItems ? mergeItems(prev, r.items) : r.items
            return maxItems > 0 && merged.length > maxItems ? merged.slice(0, maxItems) : merged
          })
          setTotal(r.total)
          setLastCount(r.items.length)
          // 首页刷新只合并头部，不推进分页 offset：旧页仍在列表里，
          // 下一次 loadMore 从原 offset 继续，重复项由 mergeItems 去重。
          setError(null)
        } catch (e) {
          if (seq === seqRef.current && activeRef.current) setError((e as Error).message)
        } finally {
          if (seq === seqRef.current) {
            busyRef.current = false
            if (activeRef.current) {
              setLoading(false)
              setLoadingMore(false)
            }
          }
        }
      })()
      return
    }
    const plan = refreshPagesFor(want, pageSize)
    if (!plan.feasible) return
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
          onPage: (info) => {
            if (seq !== seqRef.current || !activeRef.current) return false
            setTotal(info.total)
            return true
          },
        })
        if (seq !== seqRef.current || !activeRef.current) return
        setItems(r.items)
        setLastCount(r.items.length)
        offsetRef.current = r.items.length
        setError(null)
      } catch (e) {
        if (seq === seqRef.current && activeRef.current) setError((e as Error).message)
      } finally {
        if (seq === seqRef.current) {
          busyRef.current = false
          if (activeRef.current) {
            setLoading(false)
            setLoadingMore(false)
          }
        }
      }
    })()
  }, [load, maxItems, mergeItems, pageSize, refreshPageLimit])

  return {
    items,
    total,
    loading,
    loadingMore,
    error,
    lastCount,
    active,
    activeRef,
    seqRef,
    busyRef,
    lastRefreshAtRef,
    loadMore,
    reset,
    refresh,
  }
}

function usePagedListAutoRefresh(args: {
  active: boolean
  activeRef: { current: boolean }
  seqRef: { current: number }
  busyRef: { current: boolean }
  lastRefreshAtRef: { current: number }
  refresh: () => void
  refreshMinIntervalMs?: number
  refreshDebounceMs?: number
}): void {
  const {
    active,
    activeRef,
    seqRef,
    busyRef,
    lastRefreshAtRef,
    refresh,
    refreshMinIntervalMs,
    refreshDebounceMs,
  } = args
  const wasActiveRef = useRef(active)
  const trailingRef = useRef<number | undefined>(undefined)

  const maybeBackgroundRefresh = useCallback((): void => {
    if (!activeRef.current) return
    const gate = refreshGate({
      now: Date.now(),
      lastStartedAt: lastRefreshAtRef.current,
      hidden: typeof document !== 'undefined' && document.hidden === true,
      minIntervalMs: refreshMinIntervalMs ?? REFRESH_MIN_INTERVAL_MS,
    })
    if (gate.go) {
      refresh()
      return
    }
    if (gate.waitMs <= 0 || trailingRef.current !== undefined) return
    trailingRef.current = window.setTimeout(() => {
      trailingRef.current = undefined
      if (activeRef.current) refresh()
    }, gate.waitMs)
  }, [activeRef, lastRefreshAtRef, refresh, refreshMinIntervalMs])

  useEffect(() => {
    if (typeof document === 'undefined') return undefined
    const onVisible = (): void => {
      if (document.hidden !== true && activeRef.current) refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => { document.removeEventListener('visibilitychange', onVisible) }
  }, [activeRef, refresh])

  useEffect(() => {
    if (active) return
    seqRef.current += 1
    busyRef.current = false
    if (trailingRef.current !== undefined) {
      window.clearTimeout(trailingRef.current)
      trailingRef.current = undefined
    }
  }, [active, busyRef, seqRef])

  useEffect(() => {
    const resumed = active && !wasActiveRef.current
    wasActiveRef.current = active
    if (resumed) refresh()
  }, [active, refresh])

  useEffect(() => () => {
    if (trailingRef.current !== undefined) window.clearTimeout(trailingRef.current)
  }, [])

  useWechatDataUpdated(() => {
    maybeBackgroundRefresh()
  }, 'dsh-wechat-data-updated', refreshDebounceMs ?? 300, { replayOnResume: false })
}

export function usePagedList<T>(options: {
  pageSize: number
  fetchPage: (offset: number, limit: number) => Promise<{ items: readonly T[]; total: number }>
  /** 数据事件驱动的后台刷新最小间隔（缺省 30s）。需要更实时的小列表（如会话列表）传更小值。 */
  refreshMinIntervalMs?: number
  /** 推送合并窗（缺省 300ms）。后端推送已自带限频，需要最快响应的小列表传更小值。 */
  refreshDebounceMs?: number
  /**
   * 一轮后台刷新是否合并成「一个最多 N 条的首部请求」。
   *
   * 仅用于会话列表这类刷新时只关心最新排序头部的列表：600 条时避免按 120 条
   * 分页连打 5 个请求。缺省 0 = 保持原「按已加载页数逐页重取」语义。
   */
  refreshPageLimit?: number
  /**
   * 分页与实时头部刷新时的合并函数。
   *
   * 传了它就必须按业务键去重并保持期望排序；当前只有会话列表使用。
   * 不传则保持原有「追加拼接 / 首页替换」语义。
   */
  mergeItems?: (current: readonly T[], incoming: readonly T[]) => readonly T[]
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
  const {
    pageSize,
    refreshDebounceMs,
    refreshMinIntervalMs,
    maxItems = 0,
    refreshPageLimit = 0,
    mergeItems,
  } = options
  const {
    items,
    total,
    loading,
    loadingMore,
    error,
    lastCount,
    active,
    activeRef,
    seqRef,
    busyRef,
    lastRefreshAtRef,
    loadMore,
    reset,
    refresh,
  } = usePagedListLoader(options.fetchPage, pageSize, maxItems, refreshPageLimit, mergeItems)

  usePagedListAutoRefresh({
    active,
    activeRef,
    seqRef,
    busyRef,
    lastRefreshAtRef,
    refresh,
    refreshMinIntervalMs,
    refreshDebounceMs,
  })

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
