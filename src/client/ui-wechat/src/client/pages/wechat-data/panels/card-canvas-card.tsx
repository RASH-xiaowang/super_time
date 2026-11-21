/**
 * 画布卡片的**位置通道**（2026-11-19）。
 *
 * 卡片怎么知道自己的 x/y/宽？两条路：
 *   · 容器把布局结果塞进 `<style>` —— 会被 CSP 拦、导出截图时也可能丢；
 *   · 容器把「查位置」的函数放进 Context，卡片自己取 —— 纯 React，可测、可导出。
 *
 * 这里选后者。Context 的值只有**两个查表函数**（不是整份布局对象），
 * 这样布局变化时卡片会重渲染，但不会因为"对象字面量每次都是新的"而白白全量重画。
 *
 * @module panels/card-canvas-card
 */
import { createContext, useContext } from 'react'
import type { CanvasSlot } from './card-canvas-layout.ts'
import css from './card-canvas.module.css'
/** 内容类（zoneTag 这类被多处共用的）仍在 annual.module.css。 */
import contentCss from './annual.module.css'

/** 拖拽位移（px）。 */
export interface CanvasDragOffset {
  dx: number
  dy: number
}

/** 画布提供给卡片的查询接口。 */
export interface CanvasContextValue {
  /** 这张卡当前的槽位（未布局完成时 undefined）。 */
  slotOf: (id: string) => CanvasSlot | undefined
  /** 这张卡是否正在被拖动。 */
  dragOf: (id: string) => CanvasDragOffset | null
}

export const CanvasContext = createContext<CanvasContextValue | null>(null)

/**
 * 一张卡在画布上的外壳（标题 + 分区 + 拖拽手柄 + 内容）。
 *
 * **不设宽度也不设高度**：宽度由容器统一给（等宽瀑布流，见 layout 模块），
 * 高度由内容决定，容器用 ResizeObserver 量回来再参与排版。
 * @param props - 标识、标题与内容。
 * @returns 绝对定位的卡片元素。
 */
export function CanvasCard({ id, cols = 1, title, zone, extra, tone, children }: {
  /** 稳定 id（位置按它存取，改名等于换了一张卡）。 */
  id: string
  /**
   * 跨几列（默认 1）。
   *
   * 绝大多数卡等宽是对的（扫视基线统一）。只有**世界地图**这种内容天然横长的卡
   * 值得占 2 列 —— 塞进一列只会得到一个又高又空的地图框。
   */
  cols?: number
  /** 标题。允许 ReactNode —— 总览的卡标题带图标（`<span>` + 文字）。 */
  title: React.ReactNode
  zone?: string
  extra?: React.ReactNode
  tone?: string
  children: React.ReactNode
}): React.JSX.Element {
  const ctx = useContext(CanvasContext)
  const slot = ctx?.slotOf(id)
  const drag = ctx?.dragOf(id) ?? null

  const style: React.CSSProperties = {
    /*
     * 布局还没算出来时**藏起来**，不要让它待在 0,0。
     *
     * 为什么是 `visibility` 而不是不渲染：卡必须先出现在 DOM 里，`CardCanvas` 才能
     * 量到它的高度、把布局算出来；不渲染就永远量不到（死锁）。
     *
     * 为什么不给个兜底 left/top：那样它会**压在第一张卡上**（用户报的"相互遮挡"）。
     * 这在一帧内看不出差别，但面板挂在 `display:none` 的弹窗里时 `clientWidth` 是 0、
     * 布局迟迟算不出来，就会一直保持「所有卡静止叠在左上角」的可见错误状态。
     * 藏起来在那种情况下是唯一正确的表现。
     *
     * 一帧的隐藏不可见：`CardCanvas` 的测量在 `useLayoutEffect` 里跑，早于浏览器绘制。
     */
    ...(slot === undefined
      ? { visibility: 'hidden' as const, left: 0, top: 0 }
      : { left: slot.x, top: slot.y, width: slot.w }),
    ...(drag === null ? {} : { transform: `translate(${String(drag.dx)}px, ${String(drag.dy)}px)`, zIndex: 30 }),
  }

  return (
    <section
      className={css.canvasCard}
      data-canvas-id={id}
      {...(cols > 1 ? { 'data-canvas-cols': String(cols) } : {})}
      {...(tone === undefined ? {} : { 'data-tone': tone })}
      {...(drag === null ? {} : { 'data-dragging': '' })}
      style={style}
    >
      {/*
        拖拽手柄是**卡片的直接子元素 + 绝对定位**，不在 `canvasHead` 的 flex 流里。
        原因：卡头是 `flex-wrap: wrap` —— 标题长、或右侧有分区药丸/操作按钮时，
        放在流里的手柄会被挤到第二行甚至左下角，"右上角"就不成立了。
        绝对定位之后它的位置只由 `top/right` 决定，与内容多少无关。
      */}
      <span
        className={css.canvasHandle}
        data-canvas-handle=""
        title="拖动摆放"
        role="button"
        tabIndex={-1}
        aria-label="拖动这张卡"
      >
        <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
          <circle cx="5" cy="4" r="1.2" fill="currentColor" /><circle cx="11" cy="4" r="1.2" fill="currentColor" />
          <circle cx="5" cy="8" r="1.2" fill="currentColor" /><circle cx="11" cy="8" r="1.2" fill="currentColor" />
          <circle cx="5" cy="12" r="1.2" fill="currentColor" /><circle cx="11" cy="12" r="1.2" fill="currentColor" />
        </svg>
      </span>
      <div className={css.canvasHead}>
        <span className={css.canvasTitle}>{title}</span>
        <span className={css.canvasRight}>
          {zone !== undefined && <span className={contentCss.zoneTag}>{zone}</span>}
          {extra !== undefined && <span className={css.canvasExtra}>{extra}</span>}
        </span>
      </div>
      <div className={css.canvasBody}>{children}</div>
    </section>
  )
}
