/**
 * 全应用统一的资源大图查看器（2026-10-21）。
 *
 * 原来聊天图片查看器（`chats-media.tsx ImageViewer`）和文件面板灯箱（`Files.tsx`）各写一套：
 * 一套是白底工具条 + 居中「加载中…」，另一套是卡片式 + 底部缩放；都没有「先显示缩略图占位、
 * 原图到了再淡入」，也没有一致的手感。这里收成一份：
 *
 *  - **效率**：当前图按需 `load()`；同时**预取左右相邻各一张**（缓存 hook 里 LRU 只留几张）；
 *    原图未到时先铺缩略图（blur 占位）→ 到位后淡入；视频/图片共用一份壳；
 *  - **审美**：深色玻璃遮罩 + 顶部信息条 + 底部浮动词条 + 左右切图 + 缩放百分比；
 *    加载骨架、错误卡片（可重试）、缩略图条（可选）；
 *  - **无障碍**：焦点陷阱 + Esc 入栈（kit 的 `useDialogFocus`/`useEscapeToClose`），
 *    方向键/加减号/0 键快捷键，按钮都有 aria-label。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useDialogFocus, useEscapeToClose } from '../ui/kit.tsx'
import {
  IconChevronLeftOutline14,
  IconChevronRightOutline14,
  IconCloseOutline16,
  IconFullscreenOutline16,
  IconPlusOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { clampZoom, counterText, DEFAULT_MAX_ZOOM, DEFAULT_MIN_ZOOM, percentOf, wrapIndex, zoomStep } from './viewer-model.ts'
import { useViewerCache } from './use-viewer-cache.ts'
import type { ViewerSource } from './viewer-types.ts'
import css from './media-viewer.module.css'

export type { ViewerSource } from './viewer-types.ts'

/** 查看器道具。 */
export interface MediaViewerProps {
  sources: readonly ViewerSource[]
  index: number
  onIndexChange: (index: number) => void
  onClose: () => void
  /** `data-st-dialog` 名字（a11y 守卫按它登记）。 */
  dialogName: string
  /** 顶部右侧额外动作（复制链接/保存原图等）。 */
  headerActions?: ReactNode
  /** 是否显示底部缩略图条（默认关；朋友圈这类多图场景可开）。 */
  showThumbnails?: boolean
  /** 缩放区间（默认 0.5–6；朋友圈可给 1–5）。 */
  minZoom?: number
  maxZoom?: number
  /** 底部额外工具（旋转等）。 */
  extraToolbar?: ReactNode
  /** 旋转角度（度）；由调用方控制（朋友圈的旋转按钮）。 */
  rotate?: number
}

/**
 * 统一资源查看器。
 * @param props - 见 {@link MediaViewerProps}。
 * @returns 全屏预览覆盖层。
 */
export function MediaViewer({
  sources, index, onIndexChange, onClose, dialogName, headerActions, showThumbnails = false,
  minZoom = DEFAULT_MIN_ZOOM, maxZoom = DEFAULT_MAX_ZOOM, extraToolbar, rotate = 0,
}: MediaViewerProps): React.JSX.Element {
  const current = sources[wrapIndex(sources.length, index, 0)]
  const [reloadTick, setReloadTick] = useState(0)
  const { getEntry, retry: clearEntry } = useViewerCache(sources, index, reloadTick)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)
  const pinchRef = useRef<{ dist: number; zoom: number } | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)

  useDialogFocus(true, `[data-st-dialog="${dialogName}"]`)
  useEscapeToClose(true, onClose)

  // 换图重置视图。
  useEffect(() => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
    setDragging(false)
    dragRef.current = null
  }, [current?.key])

  const reset = useCallback((): void => { setZoom(1); setPan({ x: 0, y: 0 }) }, [])
  const zoomBy = useCallback((dir: number): void => {
    setZoom((z) => zoomStep(z, dir, minZoom, maxZoom))
  }, [minZoom, maxZoom])

  // 键盘：方向键翻页、+/− 缩放、0 重置（Esc 走 kit 的共享栈）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowLeft') onIndexChange(wrapIndex(sources.length, index, -1))
      else if (e.key === 'ArrowRight') onIndexChange(wrapIndex(sources.length, index, 1))
      else if (e.key === '+' || e.key === '=') zoomBy(1)
      else if (e.key === '-' || e.key === '_') zoomBy(-1)
      else if (e.key === '0') reset()
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [index, onIndexChange, reset, sources.length, zoomBy])

  // 滚轮缩放：原生监听（passive:false）才能可靠阻止底层滚动。
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      setZoom((z) => clampZoom(z * (e.deltaY < 0 ? 1.15 : 1 / 1.15), minZoom, maxZoom))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => { el.removeEventListener('wheel', onWheel) }
  }, [minZoom, maxZoom])

  // 打开期间锁住背景滚动。
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])

  const entry = current ? getEntry(current.key) : undefined
  const src = entry?.src ?? ''
  const error = entry?.error ?? ''
  const thumb = current?.thumb && current.thumb !== src ? current.thumb : ''
  const loading = !src && !error

  const retry = (): void => {
    if (!current) return
    clearEntry(current.key)
    setReloadTick((t) => t + 1)
  }

  const download = (): void => {
    if (!current || !src) return
    if (current.onDownload) { current.onDownload(src); return }
    const a = document.createElement('a')
    a.href = src
    a.download = current.downloadName ?? (current.kind === 'video' ? 'video.mp4' : 'image.jpg')
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  const hasMany = sources.length > 1
  const transform = `translate(${String(pan.x)}px, ${String(pan.y)}px) scale(${String(zoom)}) rotate(${String(rotate)}deg)`
  const thumbStrip = showThumbnails
    ? sources.map((source, i) => ({ source, i })).filter(({ source }) => Boolean(source.thumb))
    : []

  return createPortal(
    <div className={css.overlay} data-st-dialog={dialogName} role="dialog" aria-modal="true" aria-label={current?.title ?? '资源预览'}>
      <div className={css.backdrop} onClick={onClose} />
      <header className={css.header}>
        <div className={css.headText}>
          <span className={css.title}>{current?.title ?? '资源预览'}</span>
          {current?.subtitle ? <span className={css.subtitle}>{current.subtitle}</span> : null}
        </div>
        <div className={css.headCenter}>{hasMany ? <span className={css.counter}>{counterText(index, sources.length)}</span> : null}</div>
        <div className={css.headActions}>
          {headerActions}
          <button type="button" className={css.iconBtn} title="下载" aria-label="下载" onClick={download} disabled={!src}>
            <span aria-hidden="true" className={css.downloadGlyph}>↓</span>
          </button>
          <button type="button" className={css.iconBtn} title="关闭" aria-label="关闭" onClick={onClose}>
            <IconCloseOutline16 size={16} />
          </button>
        </div>
      </header>

      <div
        ref={stageRef}
        className={css.stage}
        data-dragging={dragging || undefined}
        onPointerDown={(e) => {
          if (zoom <= minZoom) return
          e.preventDefault()
          dragRef.current = { x: e.clientX, y: e.clientY, ox: pan.x, oy: pan.y }
          setDragging(true)
          ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
        }}
        onPointerMove={(e) => {
          const d = dragRef.current
          if (d) setPan({ x: d.ox + (e.clientX - d.x), y: d.oy + (e.clientY - d.y) })
        }}
        onPointerUp={(e) => {
          dragRef.current = null
          setDragging(false)
          ;(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId)
        }}
        onPointerCancel={() => { dragRef.current = null; setDragging(false) }}
        onDoubleClick={() => { setZoom((z) => (z === 1 ? 2.5 : 1)); setPan({ x: 0, y: 0 }) }}
        onTouchStart={(e) => {
          const a = e.touches[0]
          const b = e.touches[1]
          if (e.touches.length === 2 && a && b) pinchRef.current = { dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), zoom }
        }}
        onTouchMove={(e) => {
          const p = pinchRef.current
          const a = e.touches[0]
          const b = e.touches[1]
          if (!p || e.touches.length !== 2 || !a || !b) return
          const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
          setZoom(clampZoom(p.zoom * (dist / p.dist), minZoom, maxZoom))
        }}
        onTouchEnd={() => { pinchRef.current = null }}
      >
        {thumb ? (
          <img className={css.placeholder} src={thumb} alt="" aria-hidden="true" draggable={false} />
        ) : loading ? (
          <div className={css.skeleton} aria-hidden="true" />
        ) : null}
        {loading ? <div className={css.loading} role="status"><span className={css.spinner} />正在加载原图…</div> : null}
        {error ? (
          <div className={css.errorBox} role="alert">
            <span className={css.errorTitle}>这张资源打不开</span>
            <span className={css.errorNote}>{error}</span>
            <button type="button" className={css.retryBtn} onClick={retry}>重试</button>
          </div>
        ) : null}
        {src && current?.kind === 'video' ? (
          <video className={css.media} src={src} controls autoPlay playsInline />
        ) : src ? (
          <img className={css.media} src={src} alt={current?.title ?? '资源预览'} draggable={false}
            decoding="async" style={{ transform }} onLoad={() => { setDragging(false) }} />
        ) : null}

        {hasMany ? (
          <>
            <button type="button" className={`${css.nav} ${css.navLeft}`} title="上一张" aria-label="上一张"
              onClick={(e) => { e.stopPropagation(); onIndexChange(wrapIndex(sources.length, index, -1)) }}><IconChevronLeftOutline14 /></button>
            <button type="button" className={`${css.nav} ${css.navRight}`} title="下一张" aria-label="下一张"
              onClick={(e) => { e.stopPropagation(); onIndexChange(wrapIndex(sources.length, index, 1)) }}><IconChevronRightOutline14 /></button>
          </>
        ) : null}
      </div>

      {thumbStrip.length > 1 ? (
        <div className={css.thumbStrip}>
          {thumbStrip.map(({ source, i }) => (
            <button key={source.key} type="button" className={i === wrapIndex(sources.length, index, 0) ? `${css.thumb} ${css.thumbActive}` : css.thumb}
              title={source.title ?? `第 ${String(i + 1)} 张`} aria-label={source.title ?? `第 ${String(i + 1)} 张`}
              onClick={() => { onIndexChange(i) }}>
              <img src={source.thumb ?? ''} alt="" loading="lazy" decoding="async" />
            </button>
          ))}
        </div>
      ) : null}

      <footer className={css.footer}>
        <div className={css.toolbar}>
          <button type="button" className={css.toolBtn} title="缩小" aria-label="缩小" onClick={() => { zoomBy(-1) }}><span aria-hidden="true">−</span></button>
          <button type="button" className={css.zoomText} title="重置缩放" aria-label="重置缩放" onClick={reset}>{percentOf(zoom)}</button>
          <button type="button" className={css.toolBtn} title="放大" aria-label="放大" onClick={() => { zoomBy(1) }}><IconPlusOutline16 size={15} /></button>
          <span className={css.divider} aria-hidden="true" />
          <button type="button" className={css.toolBtn} title="适应窗口 / 1:1" aria-label="重置视图" onClick={reset}><IconFullscreenOutline16 size={15} /></button>
          {extraToolbar}
        </div>
        <span className={css.hint}>← → 切换 · 滚轮缩放 · 双击还原 · Esc 关闭</span>
      </footer>
    </div>,
    document.body,
  )
}
