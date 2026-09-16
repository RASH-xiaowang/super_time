/**
 * 让悬浮面板可以用鼠标/键盘拖动，并记住位置。
 *
 * 为什么要有它：这类卡片原本是固定死在某个角上的（首次配置向导卡在左下、提醒卡在右下），
 * 挡住内容时用户只能关掉它 —— 结果是把提醒本身一起关掉了。可拖动之后，位置由用户决定。
 *
 * 分工：位置的夹取/解析/持久化在 `float-pos.ts`（纯函数 + 单测）；这里只把它接到
 * 指针与键盘事件上。用 Pointer Events + `setPointerCapture`（而不是 mousemove/touchmove 两套），
 * 指针拖出把手范围也能继续跟手，鼠标与触屏同一套代码。
 *
 * 可访问性：把手可聚焦，方向键微调（Shift 加速）；拖动中给卡片加 `data-dragging`，由样式改光标。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'

import { clampFloatPos, floatPosKey, parseFloatPos, type FloatPos } from './float-pos.ts'

/** 键盘微调步长（px）。 */
const KEY_STEP = 16
/** 拿不到元素尺寸时的兜底（只为夹取用，取不到就按卡片大致尺寸算）。 */
const FALLBACK_SIZE = { w: 392, h: 320 }

export interface DraggableFloat {
  /** 展开到「把手」元素上（本卡片用标题栏）。 */
  handleProps: {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void
    onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void
    onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => void
    tabIndex: number
    role: string
    'aria-label': string
    'aria-roledescription': string
  }
  /** 卡片自身的样式：未拖动过时为空对象，交给 CSS 里的默认位置。 */
  cardStyle: { left?: number; top?: number; bottom?: string }
  dragging: boolean
  /** 是否已拖动过（用于在 UI 上提示「可复位」）。 */
  moved: boolean
  /** 复位回 CSS 默认位置。 */
  reset: () => void
}

/**
 * 让某个悬浮面板可拖动。
 * @param id - 面板标识（位置按它分开存）。
 * @param cardRef - 指向卡片根元素的 ref（拖拽时要读它的当前矩形与尺寸）。
 * @returns 把手 props、卡片样式与拖拽状态。
 */
export function useDraggableFloat(
  id: string,
  cardRef: { current: HTMLElement | null },
): DraggableFloat {
  const [pos, setPos] = useState<FloatPos | null>(() => {
    try {
      return parseFloatPos(localStorage.getItem(floatPosKey(id)))
    } catch {
      return null
    }
  })
  const [dragging, setDragging] = useState(false)
  /** 指针相对卡片左上角的偏移，拖动期间保持不变。 */
  const grab = useRef<{ dx: number; dy: number } | null>(null)
  /** 当前位置的镜像：事件回调里读它，避免把 pos 塞进依赖导致反复重建回调。 */
  const posRef = useRef<FloatPos | null>(pos)

  const clampTo = useCallback((p: FloatPos): FloatPos => {
    const el = cardRef.current
    return clampFloatPos(
      p,
      { w: el?.offsetWidth ?? FALLBACK_SIZE.w, h: el?.offsetHeight ?? FALLBACK_SIZE.h },
      { w: window.innerWidth, h: window.innerHeight },
    )
  }, [cardRef])

  const commit = useCallback((p: FloatPos): void => {
    posRef.current = clampTo(p)
    setPos(posRef.current)
  }, [clampTo])

  const persist = useCallback((): void => {
    try {
      if (posRef.current) localStorage.setItem(floatPosKey(id), JSON.stringify(posRef.current))
    } catch {
      /* 存不下就只在本次会话有效 */
    }
  }, [id])

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLElement>): void => {
    const el = cardRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    grab.current = { dx: e.clientX - r.left, dy: e.clientY - r.top }
    // 从 CSS 默认位置切到绝对坐标：首帧就落在当前位置，避免按下的瞬间跳一下
    commit({ x: r.left, y: r.top })
    setDragging(true)
    e.currentTarget.setPointerCapture?.(e.pointerId)
    // 拖动时不要选中标题文字
    e.preventDefault()
  }, [cardRef, commit])

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLElement>): void => {
    const g = grab.current
    if (!g) return
    commit({ x: e.clientX - g.dx, y: e.clientY - g.dy })
  }, [commit])

  const finish = useCallback((e: ReactPointerEvent<HTMLElement>): void => {
    if (!grab.current) return
    grab.current = null
    setDragging(false)
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    persist()
  }, [persist])

  const onKeyDown = useCallback((e: ReactKeyboardEvent<HTMLElement>): void => {
    const step = e.shiftKey ? KEY_STEP * 4 : KEY_STEP
    const el = cardRef.current
    const cur = posRef.current ?? (el
      ? { x: el.getBoundingClientRect().left, y: el.getBoundingClientRect().top }
      : { x: 0, y: 0 })
    const next = e.key === 'ArrowLeft' ? { x: cur.x - step, y: cur.y }
      : e.key === 'ArrowRight' ? { x: cur.x + step, y: cur.y }
        : e.key === 'ArrowUp' ? { x: cur.x, y: cur.y - step }
          : e.key === 'ArrowDown' ? { x: cur.x, y: cur.y + step }
            : null
    if (!next) return
    e.preventDefault()
    commit(next)
    persist()
  }, [cardRef, commit, persist])

  // 窗口变小：把卡片夹回可视范围，否则它会落在视口外，再也拖不回来
  useEffect(() => {
    if (!pos) return
    const onResize = (): void => { commit(posRef.current ?? pos) }
    window.addEventListener('resize', onResize)
    return () => { window.removeEventListener('resize', onResize) }
  }, [pos, commit])

  const reset = useCallback((): void => {
    posRef.current = null
    setPos(null)
    try {
      localStorage.removeItem(floatPosKey(id))
    } catch {
      /* ignore */
    }
  }, [id])

  return {
    handleProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: finish,
      onPointerCancel: finish,
      onKeyDown,
      tabIndex: 0,
      role: 'button',
      'aria-label': '拖动以移动面板（也可用方向键，按住 Shift 加速）',
      'aria-roledescription': '可拖动面板',
    },
    cardStyle: pos ? { left: pos.x, top: pos.y, bottom: 'auto' } : {},
    dragging,
    moved: pos !== null,
    reset,
  }
}
