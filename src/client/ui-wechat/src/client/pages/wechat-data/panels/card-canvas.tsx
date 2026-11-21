/**
 * 年度报告的**自由画布**（2026-11-19）。
 *
 * ## 与「网格」的区别
 *
 * 改前是 `display: grid` + 12 列 + `span`：卡片宽度只能是 1/12 的整数倍，
 * 同一行必须等高（矮卡下方留白），顺序还被 `dense` 的补空打乱。
 *
 * 现在每张卡是**绝对定位的一块**：
 *   · 宽度由自己的档位（narrow/medium/wide/full）决定，不再吸附到 12 列；
 *   · 高度完全由内容决定（`height: auto`），相邻卡不共享任何行基线；
 *   · 初始位置由 `packCanvas` 算（最短落点，矮卡下方立刻被后续卡填上）；
 *   · 用户可**直接拖动卡片**摆放，位置按年份记住；「自动排列」一键回到初始版面。
 *
 * ## 高度怎么来的
 *
 * 宽度确定后高度由内容决定，而布局需要高度才知道「下面能放哪」。所以用
 * `ResizeObserver` 观察每张卡：内容变了（字体加载、图片解码、折叠区展开）就重新量、
 * 重新排。这是画布的必需成本 —— 改前的网格靠 `span` 天然不需要测高，也就做不到
 * 「高度随内容 + 自由摆放」。
 *
 * 收敛性：宽度只由档位和容器宽决定，**不依赖高度**；高度只由宽度和内容决定。
 * 所以「宽度 → 高度 → 布局」是一次性收敛的，不会来回抖。
 *
 * @module panels/annual-canvas
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { readRenderCache, writeRenderCache } from '../api.ts'
import {
  CANVAS_GAP,
  canvasHeight,
  clampCanvasX,
  packCanvas,
  settleCanvas,
  type CanvasSlot,
} from './card-canvas-layout.ts'
import { CanvasContext, type CanvasContextValue, type CanvasDragOffset } from './card-canvas-card.tsx'
import { readCanvasPositions, writeCanvasPositions, type CanvasPositions } from './card-canvas-positions.ts'
import css from './card-canvas.module.css'

/** 位置存储走年报自己那套渲染缓存（换账号/换数据目录时一起失效）。 */
const POSITION_STORE = { read: readRenderCache, write: writeRenderCache }

/**
 * 是否开发构建。
 *
 * 用 `import.meta.env.PROD` 而不是读 `process.env`：这是渲染进程的浏览器代码，
 * `process` 未必存在；Vite 会把 `import.meta.env.PROD` 静态替换成字面量，
 * 生产包里整个 `warnCanvasMisuse` 调用会被摇掉。
 * 取不到时按「开发」处理 —— 宁可多打一条日志，也不要静默漏掉重叠。
 */
const IS_DEV = (import.meta as { env?: { PROD?: boolean } }).env?.PROD !== true

/** 拖拽中的卡片状态：起始指针 + 卡片原始位置。 */
interface DragState {
  id: string
  pointerX: number
  pointerY: number
  originX: number
  originY: number
  dx: number
  dy: number
}

/**
 * 渲染画布。
 *
 * 子元素必须是 `CanvasCard`（靠 `data-canvas-id` / `data-canvas-width` 被识别）。
 * @param props.year - 年份（位置按年隔离）。
 * @param props.children - 卡片。
 * @returns 画布元素。
 */
export function CardCanvas({ year, scope = 'main', children }: {
  year: number
  /** 画布作用域：首屏与「更多年度数据」是两个独立画布，位置各存各的。 */
  scope?: string
  children: React.ReactNode
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const observedRef = useRef<WeakSet<Element>>(new WeakSet())
  const [containerWidth, setContainerWidth] = useState(0)
  /** 实测高度（id → px）。 */
  const [heights, setHeights] = useState<Record<string, number>>({})
  /** 卡片顺序与跨列数（从 DOM 读，保证与 JSX 顺序一致）。 */
  const [cards, setCards] = useState<Array<{ id: string; cols: number }>>([])
  /** 手动位置（空 = 自动排列）。 */
  const [manual, setManual] = useState<CanvasPositions>(() => readCanvasPositions(POSITION_STORE, year, scope))
  const [drag, setDrag] = useState<DragState | null>(null)

  // 换年份：换成那一年的位置表。
  useEffect(() => { setManual(readCanvasPositions(POSITION_STORE, year, scope)) }, [year, scope])

  /**
   * 观察容器宽度与每张卡的高度。
   *
   * 一次 ResizeObserver 同时观察容器与卡片：卡片高度变化（内容变了）和容器宽度变化
   * （窗口缩放）都走同一段回调，不需要两套逻辑。
   *
   * ## 为什么要两个 effect（2026-11-19 修）
   *
   * 只建一次 observer 是不够的：卡片数量会变（数据刷新、年份切换、页面从 8 张变 25 张）。
   * 新建的 DOM 节点不会自动被观察，而 ResizeObserver 只在**已有**节点尺寸变化时回调 ——
   * 于是新增的卡片永远量不到高度，布局里它们是 0 高，全部堆在左上角。
   *
   * 所以拆成：① observer 只建一次；② `children` 变化后主动 measure 一次
   * （measure 里会给新节点补 observe）。这样"节点集合变了"和"节点尺寸变了"两条路都覆盖。
   */
  const measureRef = useRef<() => void>(() => { /* 挂载后由下面的 effect 填入 */ })

  useLayoutEffect(() => {
    const host = hostRef.current
    if (host === null) return undefined
    let observer: ResizeObserver | null = null
    const measure = (): void => {
      setContainerWidth(host.clientWidth)
      const nodes = Array.from(host.querySelectorAll<HTMLElement>('[data-canvas-id]'))
      const nextCards = nodes
        .map((el) => {
          const id = el.getAttribute('data-canvas-id') ?? ''
          // 跨列数从 DOM 读（卡自己声明 `data-canvas-cols`），布局只认数字。
          const colsRaw = Number(el.getAttribute('data-canvas-cols') ?? '1')
          const cols = Number.isFinite(colsRaw) && colsRaw >= 1 ? Math.floor(colsRaw) : 1
          return { id, cols }
        })
        .filter(c => c.id !== '')
      setCards(prev => (sameCards(prev, nextCards) ? prev : nextCards))
      const nextHeights: Record<string, number> = {}
      for (const el of nodes) {
        const id = el.getAttribute('data-canvas-id')
        if (id === null || id === '') continue
        // `offsetHeight` 不含 transform（拖拽时那张卡被偏移，量原高才对）。
        nextHeights[id] = el.offsetHeight
        if (observer !== null && !observedRef.current.has(el)) {
          observer.observe(el)
          observedRef.current.add(el)
        }
      }
      setHeights(prev => (sameHeights(prev, nextHeights) ? prev : nextHeights))
      if (IS_DEV) warnCanvasMisuse(host, nodes)
    }
    measureRef.current = measure
    observer = new ResizeObserver(measure)
    observer.observe(host)
    measure()
    return () => { observer?.disconnect() }
  }, [])

  /**
   * 卡片集合变了就重新量一次。
   *
   * 依赖 `children` 而不是 `cards`：`cards` 是**量完才知道**的，用它在逻辑上成了循环。
   * `children` 变说明 JSX 变了，此时 DOM 已经提交（layout effect 阶段），量得到新节点。
   */
  useLayoutEffect(() => { measureRef.current() }, [children])

  /** 自动布局（宽度/高度/卡片集合变化都重算）。 */
  const autoLayout = useMemo((): CanvasSlot[] => {
    if (containerWidth <= 0 || cards.length === 0) return []
    return packCanvas(
      cards.map(c => ({
        id: c.id,
        cols: c.cols,
        ...(heights[c.id] === undefined ? {} : { height: heights[c.id] }),
      })),
      { containerWidth, gap: CANVAS_GAP },
    )
  }, [cards, containerWidth, heights])

  /**
   * 实际位置：自动排版打底，手动版式只覆盖 x/y，**最后统一过一遍压实**。
   *
   * ## 为什么压实放在这里，而不是拖拽时做（2026-11-19）
   *
   * 遮挡不止「拖到别人身上」一个入口。手动版式一旦建立，自动排版就不再重排，
   * 于是**内容变高**（数据刷新 / 图片解码 / 字体加载）、**新卡出现**（条件渲染）、
   * **窗口改列**都会让卡片压在一起。把压实放在「渲染前最后一次计算位置」这个唯一出口，
   * 这些路径就一次性全覆盖了 —— 不管 y 从哪来，输出一定无重叠。
   *
   * 手动 x 还先过一道 `clampCanvasX`：位置表存的是像素 x，表达的却是"第几列"。
   * 列数变化后旧值会错位甚至溢出右边界（跨列卡尤其），必须按**当前**列宽重新收进来。
   *
   * 幂等性：压实只向下让位、结果稳定，所以同一份输入反复计算得到同一个版面，
   * 不会每次渲染都往下漂。
   */
  const placed = useMemo((): Map<string, CanvasSlot> => {
    if (autoLayout.length === 0) return new Map<string, CanvasSlot>()
    const colsById = new Map(cards.map(c => [c.id, c.cols]))
    const desired = autoLayout.map((slot) => {
      const m = manual[slot.id]
      if (m === undefined) return slot
      const span = colsById.get(slot.id) ?? 1
      return { ...slot, x: clampCanvasX(m.x, span, { containerWidth, gap: CANVAS_GAP }), y: m.y }
    })
    const settled = settleCanvas(desired, CANVAS_GAP)
    return new Map(settled.map(slot => [slot.id, slot]))
  }, [autoLayout, manual, cards, containerWidth])

  /** 内容高度：自动布局的下沿，或手动版式里最靠下的那张（取大者，避免被裁）。 */
  const totalHeight = useMemo(() => {
    const slots = [...placed.values()]
    if (drag !== null) {
      const cur = placed.get(drag.id)
      // 拖动中那张卡的下沿可能已经移出原画布底边，要跟着撑高，否则被裁。
      if (cur !== undefined) slots.push({ ...cur, y: cur.y + drag.dy })
    }
    return canvasHeight(slots, CANVAS_GAP)
  }, [drag, placed])

  const slotOf = useCallback((id: string): CanvasSlot | undefined => placed.get(id), [placed])
  const dragOf = useCallback((id: string): CanvasDragOffset | null => (
    drag !== null && drag.id === id ? { dx: drag.dx, dy: drag.dy } : null
  ), [drag])
  const ctx = useMemo<CanvasContextValue>(() => ({ slotOf, dragOf }), [slotOf, dragOf])

  /**
   * 开始拖动。只在**拖拽手柄**上生效（`data-canvas-handle`）：
   * 卡片正文里有可点击的东西（身份名、链接），整块可拖会把这些交互吃掉。
   */
  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement
    if (target.closest('[data-canvas-handle]') === null) return
    const card = target.closest<HTMLElement>('[data-canvas-id]')
    const id = card?.getAttribute('data-canvas-id') ?? ''
    const cur = placed.get(id)
    if (cur === undefined) return
    event.preventDefault()
    setDrag({ id, pointerX: event.clientX, pointerY: event.clientY, originX: cur.x, originY: cur.y, dx: 0, dy: 0 })
  }, [placed])

  useEffect(() => {
    if (drag === null) return undefined
    const move = (event: PointerEvent): void => {
      setDrag(d => d === null ? d : { ...d, dx: event.clientX - d.pointerX, dy: event.clientY - d.pointerY })
    }
    const up = (): void => {
      setDrag((d) => {
        if (d === null) return null
        const dragSpan = cards.find(c => c.id === d.id)?.cols ?? 1
        /*
         * 落点：x 收进合法列（**考虑自身跨列数**，否则 `cols=2` 的卡拖到最后一列会溢出），
         * y 由用户决定，但不能为负。x 的避让不在这里做 —— 交给下面的压实。
         */
        const snapped = {
          x: clampCanvasX(d.originX + d.dx, dragSpan, { containerWidth, gap: CANVAS_GAP }),
          y: Math.max(0, Math.round(d.originY + d.dy)),
        }
        /**
         * 把**当前整份版面**固化成手动位置，只改被抓的这张。
         *
         * 为什么不是只记这一张：其余卡的位置是 `packCanvas` 算的；只记一张的话，
         * 下次重排时别的卡会按自动算法移动、被抓的那张却停在原地 —— 版面立刻散掉。
         * 固化整份之后，「拖一张」=「把当前版面定住」，可预期。
         *
         * 固化前先跑一遍压实：落点可能正压在别的卡上（用户想插进去），
         * 压实会把它自己和下方受影响的卡依次下移，保证**存进位置表的版面无重叠**。
         * 这样即使下次渲染前崩溃/重启，读回来的版面也是干净的。
         */
        const desired = [...placed.values()].map(slot => (
          slot.id === d.id ? { ...slot, x: snapped.x, y: snapped.y } : slot
        ))
        const next: CanvasPositions = {}
        for (const slot of settleCanvas(desired, CANVAS_GAP)) next[slot.id] = { x: slot.x, y: slot.y }
        setManual(next)
        writeCanvasPositions(POSITION_STORE, year, next, scope)
        return null
      })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }, [drag, placed, cards, containerWidth, year, scope])

  /** 一键回到自动排列。 */
  const resetLayout = useCallback((): void => {
    setManual({})
    writeCanvasPositions(POSITION_STORE, year, {}, scope)
  }, [year, scope])

  const isManual = Object.keys(manual).length > 0

  return (
    <div className={css.canvasWrap}>
      <div className={css.canvasBar} data-export-exclude="">
        <span className={css.canvasHint}>拖动卡片右上角的手柄可自由摆放</span>
        {isManual && <button type="button" className={css.canvasReset} onClick={resetLayout}>自动排列</button>}
      </div>
      <div
        className={css.canvas}
        ref={hostRef}
        style={{ height: totalHeight === 0 ? undefined : totalHeight }}
        onPointerDown={onPointerDown}
        {...(drag === null ? {} : { 'data-dragging': '' })}
      >
        <CanvasContext.Provider value={ctx}>{children}</CanvasContext.Provider>
      </div>
    </div>
  )
}

/**
 * 开发期自检：画布的两个「结构性错误」不能静默。
 *
 * 两者的后果都是**卡片完全重叠**，而运行时看起来只是"某张卡不见了"：
 *   · 重复 `canvasId` ⇒ 两张卡拿同一个槽位，完全盖住；
 *   · 画布里夹了不走 `CanvasCard` 的元素 ⇒ 它留在文档流、被绝对定位的邻卡压住。
 *
 * 生产构建不跑（`IS_DEV` 为 false），零开销。故意用 `console.error` 而不是抛错：
 * 画布是渲染路径，抛错会让整页白屏，比版面错更糟。
 * @param host - 画布容器。
 * @param nodes - 本次测量到的卡节点。
 */
function warnCanvasMisuse(host: HTMLElement, nodes: readonly HTMLElement[]): void {
  const ids = nodes.map(el => el.getAttribute('data-canvas-id') ?? '')
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) {
      console.error(`[canvas] 重复的 canvasId "${id}"：两张卡会占用同一个槽位、完全重叠。`)
      break
    }
    seen.add(id)
  }
  // 子元素里有既不是卡、也不是画布工具行的节点 ⇒ 它没有 data-canvas-id，会被压住。
  for (const child of Array.from(host.children)) {
    if (child.hasAttribute('data-canvas-id')) continue
    if (child.getAttribute('data-canvas-toolbar') !== null) continue
    console.error('[canvas] 画布里有不走 CanvasCard 的元素，它会被绝对定位的卡片压住。', child)
  }
}

/** 卡片集合是否没变（id 顺序与跨列数都要一致）。 */
function sameCards(
  a: readonly { id: string; cols: number }[],
  b: readonly { id: string; cols: number }[],
): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]?.id !== b[i]?.id || a[i]?.cols !== b[i]?.cols) return false
  }
  return true
}

function sameHeights(a: Record<string, number>, b: Record<string, number>): boolean {
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  for (const k of ka) if (a[k] !== b[k]) return false
  return true
}
