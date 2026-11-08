/** DataTable 的可选列宽拖拽：拖动中直接改 DOM，松手时只提交一次 React 状态。 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'

export const COLUMN_MIN_WIDTH = 64
export const COLUMN_MAX_WIDTH = 1200
export const COLUMN_RESIZE_STEP = 16

interface ResizableColumn {
  id: string
  width?: number
}

interface ResizeSession {
  columns: readonly ResizableColumn[]
  columnId: string
  columnIndex: number
  colElements: HTMLTableColElement[]
  handle: HTMLElement
  table: HTMLTableElement
  pointerId: number
  startX: number
  startWidth: number
  startWidths: Record<string, number>
  previousWidths: Record<string, number> | null
  latestClientX: number | null
  frame: number
  applied: boolean
}

export function clampColumnWidth(width: number): number {
  return Math.min(COLUMN_MAX_WIDTH, Math.max(COLUMN_MIN_WIDTH, Math.round(width)))
}

export function adjustColumnWidths(
  widths: Readonly<Record<string, number>>,
  columnId: string,
  nextWidth: number,
): Record<string, number> {
  return { ...widths, [columnId]: clampColumnWidth(nextWidth) }
}

/**
 * 维护列宽拖拽状态。
 *
 * 表格尚未拖动时保持原来的自适应列宽；第一次按下手柄才把实际像素宽度固化，
 * 因而不会改变其他未开启拖拽的表格。拖动期间监听 window，避免快速移动时丢指针。
 */
export function useTableColumnResize(
  columns: readonly ResizableColumn[],
  enabled: boolean,
  minTableWidth: number,
): {
  tableRef: React.RefObject<HTMLTableElement>
  widths: Readonly<Record<string, number>> | null
  tableStyle: CSSProperties | undefined
  startResize: (event: ReactPointerEvent<HTMLElement>, columnId: string) => void
  resetWidths: () => void
  adjustWidth: (columnId: string, delta: number) => void
} {
  const tableRef = useRef<HTMLTableElement>(null)
  const [widths, setWidths] = useState<Record<string, number> | null>(null)
  const widthsRef = useRef<Record<string, number> | null>(null)
  const cleanupRef = useRef<(() => void) | null>(null)
  const idsKey = columns.map(column => column.id).join('\u0000')

  const commitWidths = useCallback((next: Record<string, number>): void => {
    widthsRef.current = next
    setWidths(next)
  }, [])

  const measureWidths = useCallback((): Record<string, number> | null => {
    if (!enabled) return null
    if (widthsRef.current) return { ...widthsRef.current }
    const headers = tableRef.current?.querySelectorAll<HTMLTableCellElement>('thead th')
    if (!headers || headers.length !== columns.length) return null

    const next: Record<string, number> = {}
    columns.forEach((column, index) => {
      const measured = headers[index]?.getBoundingClientRect().width ?? 0
      next[column.id] = clampColumnWidth(measured || column.width || COLUMN_MIN_WIDTH)
    })
    return next
  }, [columns, enabled])

  const applyDomWidths = useCallback((
    session: ResizeSession,
    next: Readonly<Record<string, number>>,
    onlyColumnId?: string,
  ): void => {
    let totalWidth = 0
    session.columns.forEach((column, index) => {
      const width = next[column.id] ?? column.width ?? COLUMN_MIN_WIDTH
      totalWidth += width
      if (onlyColumnId !== undefined && column.id !== onlyColumnId) return
      const col = session.colElements[index]
      if (col) col.style.width = `${width}px`
    })
    session.table.style.width = `max(100%, ${Math.max(minTableWidth, totalWidth)}px)`
  }, [minTableWidth])

  const restoreDomWidths = useCallback((session: ResizeSession): void => {
    session.columns.forEach((column, index) => {
      const col = session.colElements[index]
      if (!col) return
      if (column.width === undefined) col.style.removeProperty('width')
      else col.style.width = `${column.width}px`
    })
    session.table.style.removeProperty('width')
  }, [])

  // 列定义变化（例如表格被另一套列复用）时丢弃旧宽度。
  useEffect(() => {
    cleanupRef.current?.()
    widthsRef.current = null
    setWidths(null)
  }, [idsKey])

  useEffect(() => () => { cleanupRef.current?.() }, [])

  const startResize = useCallback((event: ReactPointerEvent<HTMLElement>, columnId: string): void => {
    if (!enabled || event.button !== 0) return
    const startWidths = measureWidths()
    const startWidth = startWidths?.[columnId]
    const table = tableRef.current
    const columnIndex = columns.findIndex(column => column.id === columnId)
    if (!startWidths || startWidth === undefined || !table || columnIndex < 0) return
    const colElements = [...table.querySelectorAll<HTMLTableColElement>('colgroup > col')]
    if (colElements.length !== columns.length) return

    event.preventDefault()
    event.stopPropagation()
    cleanupRef.current?.()
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId)
    } catch {
      // 某些自动化环境没有活动指针，窗口监听仍然可用。
    }

    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    const session: ResizeSession = {
      columns,
      columnId,
      columnIndex,
      colElements,
      handle: event.currentTarget,
      table,
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth,
      startWidths,
      previousWidths: widthsRef.current ? { ...widthsRef.current } : null,
      latestClientX: null,
      frame: 0,
      applied: false,
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    session.handle.dataset.resizing = 'true'
    session.table.dataset.columnResizing = 'true'

    const cancelFrame = (): void => {
      if (!session.frame) return
      if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(session.frame)
      else window.clearTimeout(session.frame)
      session.frame = 0
    }

    const applyAt = (clientX: number): void => {
      const width = clampColumnWidth(session.startWidth + clientX - session.startX)
      const current = widthsRef.current ?? session.startWidths
      const next = { ...current, [session.columnId]: width }
      widthsRef.current = next
      const firstFrame = !session.applied
      session.applied = true
      // 第一帧锁住所有列，之后只改目标列，避免每帧无谓地触碰另外五列样式。
      applyDomWidths(session, next, firstFrame ? undefined : session.columnId)
      session.handle.setAttribute('aria-valuenow', String(width))
      session.handle.setAttribute('aria-valuetext', `${width} 像素`)
    }

    const runFrame = (): void => {
      session.frame = 0
      if (session.latestClientX !== null) applyAt(session.latestClientX)
    }

    const scheduleFrame = (clientX: number): void => {
      session.latestClientX = clientX
      if (session.frame) return
      session.frame = typeof window.requestAnimationFrame === 'function'
        ? window.requestAnimationFrame(runFrame)
        : window.setTimeout(runFrame, 16)
    }

    const finish = (commit: boolean): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerCancel)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('blur', onBlur)
      cancelFrame()
      if (commit && session.latestClientX !== null) applyAt(session.latestClientX)

      if (commit && session.applied && widthsRef.current) {
        commitWidths(widthsRef.current)
      } else if (!commit) {
        widthsRef.current = session.previousWidths
        if (session.previousWidths) applyDomWidths(session, session.previousWidths)
        else restoreDomWidths(session)
      }

      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
      try {
        if (session.handle.hasPointerCapture?.(session.pointerId)) {
          session.handle.releasePointerCapture(session.pointerId)
        }
      } catch {
        // 指针已释放时浏览器会抛错，不影响最终列宽。
      }
      delete session.handle.dataset.resizing
      delete session.table.dataset.columnResizing
      cleanupRef.current = null
    }

    const onMove = (move: PointerEvent): void => {
      if (move.pointerId !== session.pointerId) return
      scheduleFrame(move.clientX)
    }
    const onPointerUp = (up: PointerEvent): void => {
      if (up.pointerId !== session.pointerId) return
      finish(true)
    }
    const onPointerCancel = (cancel: PointerEvent): void => {
      if (cancel.pointerId !== session.pointerId) return
      finish(true)
    }
    const onKeyDown = (key: KeyboardEvent): void => {
      if (key.key !== 'Escape') return
      key.preventDefault()
      finish(false)
    }
    const onBlur = (): void => { finish(true) }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerCancel)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('blur', onBlur)
    cleanupRef.current = () => { finish(false) }
  }, [applyDomWidths, columns, commitWidths, enabled, measureWidths, restoreDomWidths])

  const resetWidths = useCallback((): void => {
    cleanupRef.current?.()
    widthsRef.current = null
    setWidths(null)
    const table = tableRef.current
    if (!table) return
    const colElements = [...table.querySelectorAll<HTMLTableColElement>('colgroup > col')]
    columns.forEach((column, index) => {
      const col = colElements[index]
      if (!col) return
      if (column.width === undefined) col.style.removeProperty('width')
      else col.style.width = `${column.width}px`
    })
    table.style.removeProperty('width')
  }, [columns])

  const adjustWidth = useCallback((columnId: string, delta: number): void => {
    const current = measureWidths()
    if (!current) return
    const width = current?.[columnId]
    if (width === undefined) return
    commitWidths(adjustColumnWidths(current, columnId, width + delta))
  }, [commitWidths, measureWidths])

  const tableStyle = useMemo<CSSProperties | undefined>(() => {
    if (!widths) return undefined
    const totalWidth = columns.reduce((total, column) => total + (widths[column.id] ?? column.width ?? 0), 0)
    return { width: `max(100%, ${Math.max(minTableWidth, totalWidth)}px)` }
  }, [columns, minTableWidth, widths])

  return { tableRef, widths, tableStyle, startResize, resetWidths, adjustWidth }
}
