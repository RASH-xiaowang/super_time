/**
 * `kit.tsx` 的「可折叠区域 FoldableBar（含命令式句柄）」部分（M21 拆分）。
 *
 * 从原模块原样搬出，**行为逐字节不变**；原文件继续以 `export *` 转发
 * ⇒ 所有既有 import 一行都不用改。
 *
 * @module kit-foldable
 */

import * as React from 'react'
import { forwardRef, useEffect, useId, useImperativeHandle, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { DEFAULT_FOLD_IDLE_MS, FOLD_ANIM_MS, createFoldController, type FoldController, type FoldEvent } from './fold-idle.ts'
import css from './kit.module.css'

/** `FoldableBar` 的命令式句柄：给外部「必须展开」的场景用（例如全局搜索的 Ctrl+K）。 */
export interface FoldableBarHandle {
  /** 立刻展开（并取消待折叠的计时）。 */
  expand: () => void
  /** 立刻收起。 */
  collapse: () => void
  /** 当前是否展开。 */
  isOpen: () => boolean
}

/**
 * 「向上折叠」条：默认收起只留一条居中把手，点开展示内容；指针离开区域
 * 且 `idleMs`（默认 10 秒）内无任何活动时自动收起。
 *
 * 三个非显然的实现点：
 * ① **高度动画用 `grid-template-rows: 0fr ↔ 1fr`** 而不是 `max-height`：后者必须写死一个
 *    「够大的」上限，过渡在内容比上限矮时前半段是空跑的（观感上「先快后慢」）；
 *    `0fr/1fr` 由浏览器按真实内容高度插值，多高都是一次到位。
 * ② **收起时给内容加 `inert`**（React 18 不支持该 prop，用 ref 直接设属性）：否则折叠后
 *    里面的输入框仍能被 Tab 聚焦，键盘用户会「掉进」一块看不见的区域。
 * ③ **展开后要解除裁剪**：容器为了做高度动画必须 `overflow: hidden`，而顶栏里的搜索下拉
 *    是 `position: absolute` 溢出到容器外的 —— 展开态若继续裁剪，下拉会被切掉。
 *    所以裁剪状态由 JS 在过渡结束后关掉（`prefers-reduced-motion` 下时长为 0，立即关）。
 * @param props - 内容、空闲时长、可访问性标签与变化回调。
 * @param ref - 命令式句柄（供外部展开，例如全局搜索的 Ctrl+K）。
 * @returns 折叠条元素。
 */
export const FoldableBar = forwardRef(function FoldableBar({ children, idleMs, label = '可折叠区域', className, onOpenChange }: {
  children: React.ReactNode
  /** 指针离开后多久自动收起（毫秒）。 */
  idleMs?: number
  /** 区域的可访问性名称（读屏用）。 */
  label?: string
  className?: string
  /** 展开态变化时回调。 */
  onOpenChange?: (open: boolean) => void
}, ref: React.ForwardedRef<FoldableBarHandle>): React.JSX.Element {
  const [open, setOpen] = useState(false)
  /** 是否仍在裁剪内容（展开过渡期间为 true，结束后关掉以放行绝对定位的下拉）。 */
  const [clipped, setClipped] = useState(true)
  const ctrlRef = useRef<FoldController | null>(null)
  const innerRef = useRef<HTMLDivElement | null>(null)
  const clipTimerRef = useRef<number | null>(null)
  const reducedRef = useRef(false)
  const bodyId = useId()
  // onOpenChange 走 ref：调用方每次渲染都是新函数，不该成为重建控制器的依赖
  const onOpenChangeRef = useRef(onOpenChange)
  onOpenChangeRef.current = onOpenChange

  // 控制器只建一次：状态机与计时器都在里面，React 侧只做「变化时 setState」
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    reducedRef.current = mq.matches
    const onMq = (): void => { reducedRef.current = mq.matches }
    mq.addEventListener('change', onMq)
    const ctrl = createFoldController({
      idleMs: idleMs ?? DEFAULT_FOLD_IDLE_MS,
      onChange: (next) => {
        setOpen(next)
        onOpenChangeRef.current?.(next)
        // inert 在这里**同步**摘掉，不放进 useEffect：调用方（如全局搜索的 Ctrl+K）几乎总是
        // 「expand() 之后立刻 focus()」，而 React 的 setState 要到本轮事件结束才提交 ——
        // 若 inert 留到 effect 里才摘，那次 focus 会落在仍被标记 inert 的元素上**静默失败**，
        // 表现为「快捷键把顶栏展开了，但光标没进搜索框」。
        if (next) innerRef.current?.removeAttribute('inert')
        else innerRef.current?.setAttribute('inert', '')
        // 收起：立刻恢复裁剪；展开：先裁着，过渡结束后再放开（放行绝对定位的搜索下拉）
        if (clipTimerRef.current !== null) { window.clearTimeout(clipTimerRef.current); clipTimerRef.current = null }
        if (!next) {
          setClipped(true)
        } else {
          const dur = reducedRef.current ? 0 : FOLD_ANIM_MS
          clipTimerRef.current = window.setTimeout(() => {
            clipTimerRef.current = null
            setClipped(false)
          }, dur)
        }
      },
    })
    ctrlRef.current = ctrl
    return () => {
      if (clipTimerRef.current !== null) { window.clearTimeout(clipTimerRef.current); clipTimerRef.current = null }
      ctrl.dispose()
      ctrlRef.current = null
    }
    // idleMs 变化不重建：它只在「开始计时」那一刻被读取，重建会让进行中的计时被丢掉
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 挂载时补上 inert（初始即折叠）。之后的摘除/恢复由 onChange 同步做，见上。
  // React 18 没有 inert prop，只能直接设属性。
  useEffect(() => {
    innerRef.current?.setAttribute('inert', '')
  }, [])

  useImperativeHandle(ref, () => ({
    expand: () => { ctrlRef.current?.dispatch({ type: 'open' }) },
    collapse: () => { ctrlRef.current?.dispatch({ type: 'collapse' }) },
    isOpen: () => ctrlRef.current?.isOpen() ?? false,
  }), [])

  const dispatch = (ev: FoldEvent): void => { ctrlRef.current?.dispatch(ev) }

  return (
    <div
      className={clsx(css.foldable, className)}
      data-open={open || undefined}
      onPointerEnter={() => { dispatch({ type: 'pointer-enter' }) }}
      onPointerLeave={() => { dispatch({ type: 'pointer-leave' }) }}
      onPointerDown={() => { dispatch({ type: 'interact' }) }}
      onKeyDown={() => { dispatch({ type: 'interact' }) }}
      onFocusCapture={() => { dispatch({ type: 'interact' }) }}
    >
      <div className={css.foldableBody} data-clipped={clipped || undefined}>
        <div className={css.foldableInner} ref={innerRef} id={bodyId}>
          {children}
        </div>
      </div>
      <div className={css.foldableHandle}>
        <button
          type="button"
          className={css.foldableToggle}
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => { dispatch({ type: open ? 'collapse' : 'open' }) }}
        >
          <svg
            className={css.foldableChevron}
            viewBox="0 0 24 24"
            width="12"
            height="12"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            data-open={open || undefined}
          >
            {open ? <path d="m6 15 6-6 6 6" /> : <path d="m6 9 6 6 6-6" />}
          </svg>
          <span>{open ? '收起' : `展开${label}`}</span>
        </button>
      </div>
    </div>
  )
})

/** 单调单元格样式（md5/路径等）。 */
export function Mono({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <span className={css.cellMono}>{children}</span>
}
/** 主文本单元格样式。 */
export function CellPrimary({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <span className={css.cellPrimary}>{children}</span>
}

/** 防抖值 hook：输入频繁变化时仅在停顿后提交（搜索框配套）。 */
export function useDebouncedValue(value: string, delayMs = 300): string {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = window.setTimeout(() => { setDebounced(value) }, delayMs)
    return () => { window.clearTimeout(t) }
  }, [value, delayMs])
  return debounced
}
