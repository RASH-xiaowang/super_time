/**
 * 识别弹窗左侧/顶部的原图预览。
 *
 * 图片只在容器内做 CSS transform，不触发弹窗重排；倍率与平移状态由本组件
 * 独立维护。滚轮和双击用于放大，放大后可拖拽查看局部，避免为看小字再开一层
 * 全屏查看器。
 */
import { useEffect, useRef, useState } from 'react'
import { clampZoom, percentOf, zoomStep } from '../media-viewer/viewer-model.ts'
import cssrows from './chats-rows.module.css'

const MIN_ZOOM = 1
const MAX_ZOOM = 5
const WHEEL_FACTOR = 1.12

type ViewState = {
  zoom: number
  x: number
  y: number
}

type DragState = {
  pointerId: number
  startX: number
  startY: number
  originX: number
  originY: number
  mode: 'zoom' | 'pan'
}

const INITIAL_VIEW: ViewState = { zoom: 1, x: 0, y: 0 }

function clampPan(x: number, y: number, zoom: number, width: number, height: number): { x: number; y: number } {
  const maxX = Math.max(0, width * (zoom - 1) / 2)
  const maxY = Math.max(0, height * (zoom - 1) / 2)
  return {
    x: Math.min(maxX, Math.max(-maxX, Number.isFinite(x) ? x : 0)),
    y: Math.min(maxY, Math.max(-maxY, Number.isFinite(y) ? y : 0)),
  }
}

/**
 * 可缩放的原图预览，AI 识别和微信原生 OCR 弹窗共用。
 * @param props.source - 图片 data URL 或微信媒体地址。
 * @param props.alt - 图片替代文本。
 */
export function RecognitionImagePreview({ source, alt = '被识别的图片' }: {
  source: string
  alt?: string
}): React.JSX.Element {
  const stageRef = useRef<HTMLElement | null>(null)
  const viewRef = useRef<ViewState>(INITIAL_VIEW)
  const dragRef = useRef<DragState | null>(null)
  const [view, setViewState] = useState<ViewState>(INITIAL_VIEW)
  const [dragging, setDragging] = useState(false)

  const commitView = (next: ViewState): void => {
    viewRef.current = next
    setViewState(next)
  }

  const reset = (): void => {
    dragRef.current = null
    setDragging(false)
    commitView(INITIAL_VIEW)
  }

  const zoomAt = (nextZoom: number, clientX?: number, clientY?: number): void => {
    const current = viewRef.current
    const next = clampZoom(nextZoom, MIN_ZOOM, MAX_ZOOM)
    if (Math.abs(next - current.zoom) < 0.001) return
    const rect = stageRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      commitView({ zoom: next, x: 0, y: 0 })
      return
    }
    const anchorX = clientX === undefined ? 0 : clientX - rect.left - rect.width / 2
    const anchorY = clientY === undefined ? 0 : clientY - rect.top - rect.height / 2
    const ratio = next / current.zoom
    const pan = clampPan(
      anchorX - (anchorX - current.x) * ratio,
      anchorY - (anchorY - current.y) * ratio,
      next,
      rect.width,
      rect.height,
    )
    commitView({ zoom: next, ...pan })
  }

  const zoomBy = (direction: number): void => {
    const current = viewRef.current
    zoomAt(zoomStep(current.zoom, direction, MIN_ZOOM, MAX_ZOOM))
  }

  useEffect(() => {
    viewRef.current = INITIAL_VIEW
    dragRef.current = null
    setViewState(INITIAL_VIEW)
    setDragging(false)
  }, [source])

  // 原生 non-passive 监听才能可靠阻止弹窗内容区跟随滚轮滚动。
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      const current = viewRef.current
      const next = clampZoom(
        current.zoom * (event.deltaY < 0 ? WHEEL_FACTOR : 1 / WHEEL_FACTOR),
        MIN_ZOOM,
        MAX_ZOOM,
      )
      zoomAt(next, event.clientX, event.clientY)
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => { stage.removeEventListener('wheel', onWheel) }
  }, [])

  return (
    <figure
      ref={(node) => { stageRef.current = node }}
      className={cssrows.msgRecognitionPreview}
      data-recognition-preview="1"
      data-zoom={view.zoom}
      data-zoomed={view.zoom > MIN_ZOOM ? 'true' : undefined}
      data-dragging={dragging ? 'true' : undefined}
      tabIndex={0}
      role="group"
      aria-label={`${alt}，可向上拖动或滚轮放大，放大后拖拽查看，双击复位`}
      title="向上拖动或滚轮放大，放大后拖拽查看，双击复位"
      onDoubleClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        if (viewRef.current.zoom > MIN_ZOOM) reset()
        else zoomAt(2)
      }}
      onKeyDown={(event) => {
        if (event.key === '+' || event.key === '=') {
          event.preventDefault()
          zoomBy(1)
        } else if (event.key === '-' || event.key === '_') {
          event.preventDefault()
          zoomBy(-1)
        } else if (event.key === '0') {
          event.preventDefault()
          reset()
        }
      }}
      onPointerDown={(event) => {
        const current = viewRef.current
        if (event.pointerType === 'mouse' && event.button !== 0) return
        event.preventDefault()
        dragRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          originX: current.x,
          originY: current.y,
          mode: current.zoom > MIN_ZOOM ? 'pan' : 'zoom',
        }
        setDragging(true)
        event.currentTarget.setPointerCapture?.(event.pointerId)
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current
        if (!drag || drag.pointerId !== event.pointerId) return
        event.preventDefault()
        const rect = event.currentTarget.getBoundingClientRect()
        const current = viewRef.current
        if (drag.mode === 'zoom') {
          const upward = drag.startY - event.clientY
          const travel = Math.max(120, rect.height * 0.65)
          zoomAt(1 + upward / travel, event.clientX, event.clientY)
          return
        }
        const pan = clampPan(
          drag.originX + event.clientX - drag.startX,
          drag.originY + event.clientY - drag.startY,
          current.zoom,
          rect.width,
          rect.height,
        )
        commitView({ zoom: current.zoom, ...pan })
      }}
      onPointerUp={(event) => {
        if (dragRef.current?.pointerId !== event.pointerId) return
        dragRef.current = null
        setDragging(false)
        event.currentTarget.releasePointerCapture?.(event.pointerId)
      }}
      onPointerCancel={(event) => {
        if (dragRef.current?.pointerId !== event.pointerId) return
        dragRef.current = null
        setDragging(false)
      }}
    >
      <img
        src={source}
        alt={alt}
        draggable={false}
        decoding="async"
        style={{
          transform: `translate3d(${String(view.x)}px, ${String(view.y)}px, 0) scale(${String(view.zoom)})`,
        }}
      />
      <span className={cssrows.msgRecognitionZoomHint} aria-hidden="true">
        {view.zoom > MIN_ZOOM ? '拖拽查看' : '拖动放大 · 滚轮缩放'}
      </span>
      <div
        className={cssrows.msgRecognitionZoomTools}
        data-zoom-controls="1"
        onPointerDown={(event) => { event.stopPropagation() }}
        onClick={(event) => { event.stopPropagation() }}
        onDoubleClick={(event) => { event.stopPropagation() }}
      >
        <button
          type="button"
          aria-label="缩小识别图片"
          title="缩小"
          disabled={view.zoom <= MIN_ZOOM}
          onClick={() => { zoomBy(-1) }}
        >−</button>
        <button
          type="button"
          className={cssrows.msgRecognitionZoomPercent}
          aria-label="重置图片缩放"
          title="重置为 100%"
          onClick={reset}
        >{percentOf(view.zoom)}</button>
        <button
          type="button"
          aria-label="放大识别图片"
          title="放大"
          disabled={view.zoom >= MAX_ZOOM}
          onClick={() => { zoomBy(1) }}
        >+</button>
      </div>
    </figure>
  )
}
