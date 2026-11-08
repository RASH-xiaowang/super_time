/**
 * Multi-message chat poster.
 *
 * Selection lives by localId instead of DOM node: the message stream is
 * virtualized, so selected rows may be unmounted while the user scrolls.
 * The final poster is rendered into a dedicated, scaled preview and captured
 * with the existing Electron capture-panel bridge.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { WechatMessage, WechatSession } from '@deepseek-ai/dsh-wechat-data/types'
import type { MessageRenderItem } from '../utils/message-items.ts'
import { fmtDateTimeSec } from '../utils/format.ts'
import { apiCapturePanel, runtimeCapabilities } from '../api.ts'
import { useEscapeToClose } from '../ui/kit.tsx'
import type { MsgRowRenderOptions } from './chats-msg-row.tsx'
import { withEnterprise } from './enterprise-identity.ts'
import { IdentityName } from './identity.tsx'
import css from './chats-poster.module.css'

const POSTER_WIDTH = 720
const POSTER_CAPTURE_PADDING = 10

interface RectLike {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

export interface ChatsPosterController {
  active: boolean
  selectedIds: ReadonlySet<number>
  busy: boolean
  previewItems: readonly MessageRenderItem[] | null
  toggle: (localId: number) => void
  cancel: () => void
  generate: (items: readonly MessageRenderItem[]) => Promise<void>
}

export interface ChatsPosterTools {
  controller: ChatsPosterController
  begin: (m: WechatMessage) => void
}

/** Union only the avatar + message column, not the full-width virtual row. */
export function posterCaptureRect(parts: readonly RectLike[], padding = 14): RectLike | null {
  const valid = parts.filter(r => r.width > 0 && r.height > 0)
  if (valid.length === 0) return null
  const left = Math.min(...valid.map(r => r.left)) - padding
  const top = Math.min(...valid.map(r => r.top)) - padding
  const right = Math.max(...valid.map(r => r.right)) + padding
  const bottom = Math.max(...valid.map(r => r.bottom)) + padding
  return { left, top, right, bottom, width: right - left, height: bottom - top }
}

/** Stable, filesystem-safe default name for the save dialog. */
export function posterFilename(sessionName: string, localId: number, now = Date.now()): string {
  const safe = (sessionName.trim() || '聊天')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .slice(0, 48)
  const stamp = new Date(now).toISOString().slice(0, 19).replace(/[:T]/g, '-')
  return `聊天海报-${safe}-${localId}-${stamp}.png`
}

/** Return the stable localId represented by a virtual message item. */
export function posterItemLocalId(item: MessageRenderItem): number {
  if (item.kind === 'day') return -1
  const head = item.kind === 'group' ? item.items[0] : item.m
  return head?.localId ?? -1
}

/** Return the first real message represented by a virtual item. */
export function posterItemHead(item: MessageRenderItem): WechatMessage | null {
  if (item.kind === 'day') return null
  return item.kind === 'group' ? (item.items[0] ?? null) : item.m
}

/** Immutable add/remove used by click selection and tests. */
export function togglePosterSelection(selected: ReadonlySet<number>, localId: number): Set<number> {
  const next = new Set(selected)
  if (next.has(localId)) next.delete(localId)
  else if (localId > 0) next.add(localId)
  return next
}

/** Keep the message stream's chronological order, independent of click order. */
export function posterItemsForSelection(
  items: readonly MessageRenderItem[],
  selected: ReadonlySet<number>,
): MessageRenderItem[] {
  return items.filter((item) => {
    const id = posterItemLocalId(item)
    return id > 0 && selected.has(id)
  })
}

/** Count the underlying messages; an image group contributes all its images. */
export function posterMessageCount(items: readonly MessageRenderItem[]): number {
  let count = 0
  for (const item of items) {
    if (item.kind === 'day') continue
    count += item.kind === 'group' ? item.items.length : 1
  }
  return count
}

function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame !== 'function') {
      setTimeout(resolve, 0)
      return
    }
    requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) })
  })
}

/** Give avatar/photo requests a short chance to settle before capture. */
async function waitForPosterReady(el: HTMLElement): Promise<void> {
  const deadline = Date.now() + 1600
  let quietChecks = 0
  while (Date.now() < deadline) {
    const images = [...el.querySelectorAll('img')]
    if (images.every(img => img.complete)) {
      quietChecks += 1
      if (quietChecks >= 3) return
    } else {
      quietChecks = 0
    }
    await new Promise(resolve => setTimeout(resolve, 60))
  }
}

/**
 * Selection and capture state shared by the message tools hook and ChatsView.
 * The preview itself is rendered by ChatsPosterPreview so capture runs only
 * after React has committed and laid out the dedicated poster DOM.
 */
export function useChatsPoster(curSession: WechatSession | null, flash: (message: string) => void): ChatsPosterTools {
  const [active, setActive] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set())
  const [previewItems, setPreviewItems] = useState<readonly MessageRenderItem[] | null>(null)
  const [busy, setBusy] = useState(false)
  const activeRef = useRef(active)
  const busyRef = useRef(busy)
  activeRef.current = active
  busyRef.current = busy

  const reset = useCallback((): void => {
    activeRef.current = false
    setActive(false)
    setSelectedIds(new Set())
    setPreviewItems(null)
  }, [])

  const cancel = useCallback((): void => {
    if (busyRef.current) return
    reset()
  }, [reset])

  useEffect(() => {
    reset()
  }, [curSession?.username, reset])

  const begin = useCallback((m: WechatMessage): void => {
    if (!curSession) return
    if (!runtimeCapabilities().capturePanel) {
      flash('当前环境不支持生成聊天海报，请在桌面端使用')
      return
    }
    const id = m.localId
    setSelectedIds(prev => {
      if (!activeRef.current) return new Set([id])
      if (prev.has(id)) return prev
      const next = new Set(prev)
      next.add(id)
      return next
    })
    activeRef.current = true
    setActive(true)
  }, [curSession, flash])

  const toggle = useCallback((localId: number): void => {
    if (!activeRef.current || localId <= 0) return
    setSelectedIds(prev => togglePosterSelection(prev, localId))
  }, [])

  const generate = useCallback(async (items: readonly MessageRenderItem[]): Promise<void> => {
    if (!curSession || busyRef.current) return
    if (!runtimeCapabilities().capturePanel) {
      flash('当前环境不支持生成聊天海报，请在桌面端使用')
      return
    }
    const selected = posterItemsForSelection(items, selectedIds)
    if (selected.length === 0) {
      flash('请至少选择一条聊天记录')
      return
    }
    const firstId = posterItemLocalId(selected[0]!)
    busyRef.current = true
    setBusy(true)
    setPreviewItems(selected)
    try {
      // Two paint rounds allow the preview to mount, measure, and apply its fit scale.
      await nextPaint()
      await nextPaint()
      const el = document.querySelector<HTMLElement>('[data-st-poster-preview]')
      if (!el) {
        flash('生成聊天海报失败：预览层尚未就绪')
        setPreviewItems(null)
        return
      }
      await waitForPosterReady(el)
      const crop = posterCaptureRect([el.getBoundingClientRect()], POSTER_CAPTURE_PADDING)
      if (!crop) {
        flash('生成聊天海报失败：无法测量海报区域')
        setPreviewItems(null)
        return
      }
      const x = Math.max(0, crop.left)
      const y = Math.max(0, crop.top)
      const right = Math.min(window.innerWidth, crop.right)
      const bottom = Math.min(window.innerHeight, crop.bottom)
      if (right <= x || bottom <= y) {
        flash('生成聊天海报失败：海报已超出可视区域')
        setPreviewItems(null)
        return
      }
      const res = await apiCapturePanel({
        x,
        y,
        width: right - x,
        height: bottom - y,
        filename: posterFilename(curSession.displayName || curSession.username, firstId),
      })
      if (!res.ok) {
        flash('生成聊天海报失败：' + (res.message || '未知错误'))
        setPreviewItems(null)
        return
      }
      if (res.canceled) {
        flash('已取消生成聊天海报')
        setPreviewItems(null)
        return
      }
      reset()
      flash(`聊天海报已保存：${res.path ?? ''}`)
    } catch (e) {
      flash('生成聊天海报失败：' + (e as Error).message)
      setPreviewItems(null)
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }, [curSession, flash, reset, selectedIds])

  return {
    controller: {
      active,
      selectedIds,
      busy,
      previewItems,
      toggle,
      cancel,
      generate,
    },
    begin,
  }
}

export interface ChatsPosterSelectionBarProps {
  count: number
  busy: boolean
  onCancel: () => void
  onGenerate: () => void
}

/** Non-overlapping selection toolbar shown between the header and message stream. */
export function ChatsPosterSelectionBar({
  count,
  busy,
  onCancel,
  onGenerate,
}: ChatsPosterSelectionBarProps): React.JSX.Element {
  return (
    <div className={css.selectionBar} data-st-poster-selection-bar>
      <span className={css.selectionMark} aria-hidden="true">图</span>
      <div className={css.selectionCopy}>
        <strong>海报多选</strong>
        <span>{count > 0 ? `已选 ${count} 条消息` : '点击消息开始选择'}</span>
        <span className={css.selectionHint}>可上下滚动继续勾选，生成时按发送时间排序</span>
      </div>
      <div className={css.selectionActions}>
        <button type="button" className={css.selectionCancel} onClick={onCancel} disabled={busy}>取消</button>
        <button type="button" className={css.selectionPrimary} onClick={onGenerate} disabled={busy || count === 0}>
          {busy ? '生成中…' : '生成海报'}
        </button>
      </div>
    </div>
  )
}

type PosterRowRenderer = (item: MessageRenderItem, options?: MsgRowRenderOptions) => React.JSX.Element | null

export interface ChatsPosterPreviewProps {
  session: WechatSession
  items: readonly MessageRenderItem[]
  busy: boolean
  renderItem: PosterRowRenderer
  onCancel: () => void
}

/** A single, scaled poster surface so every selected message is captured at once. */
export function ChatsPosterPreview({
  session,
  items,
  busy,
  renderItem,
  onCancel,
}: ChatsPosterPreviewProps): React.JSX.Element {
  const contentRef = useRef<HTMLElement | null>(null)
  const generatedAt = useRef(new Date())
  const [scale, setScale] = useState(1)
  const [naturalHeight, setNaturalHeight] = useState(0)
  useEscapeToClose(true, onCancel)

  useLayoutEffect(() => {
    let alive = true
    const measure = (): void => {
      const el = contentRef.current
      if (!alive || !el) return
      const height = Math.max(1, el.scrollHeight)
      const maxWidth = Math.max(280, Math.min(760, window.innerWidth - 96))
      const maxHeight = Math.max(280, window.innerHeight - 132)
      const next = Math.min(1, maxWidth / POSTER_WIDTH, maxHeight / height)
      setScale(Number(next.toFixed(4)))
      setNaturalHeight(height)
    }
    measure()
    const raf = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(measure)
      : undefined
    window.addEventListener('resize', measure)
    let observer: ResizeObserver | null = null
    if (typeof ResizeObserver === 'function' && contentRef.current) {
      observer = new ResizeObserver(measure)
      observer.observe(contentRef.current)
    }
    return () => {
      alive = false
      if (raf !== undefined) cancelAnimationFrame(raf)
      window.removeEventListener('resize', measure)
      observer?.disconnect()
    }
  }, [items])

  const heads = items.map(posterItemHead).filter((m): m is WechatMessage => m !== null)
  const first = heads[0]
  const last = heads.at(-1)
  const count = posterMessageCount(items)
  const range = first && last
    ? first.createTime === last.createTime
      ? fmtDateTimeSec(first.createTime)
      : `${fmtDateTimeSec(first.createTime)} — ${fmtDateTimeSec(last.createTime)}`
    : ''
  const width = POSTER_WIDTH * scale
  const height = naturalHeight * scale

  return (
    <div className={css.posterOverlay} role="dialog" aria-modal="true" aria-label="聊天海报预览" data-st-poster-overlay>
      <div className={css.posterToolbar}>
        <span className={css.posterToolbarTitle}>{busy ? '正在生成聊天海报…' : '聊天海报预览'}</span>
        <span className={css.posterToolbarHint}>{count} 条消息 · 自动缩放以完整导出</span>
        <button type="button" className={css.posterClose} onClick={onCancel} disabled={busy}>取消</button>
      </div>
      <div className={css.posterViewport} style={{ width, height }}>
        <article
          ref={contentRef}
          className={css.posterArticle}
          data-st-poster-preview
          style={{ width: POSTER_WIDTH, transform: `scale(${scale})` }}
        >
          <header className={css.posterHeader}>
            <div className={css.posterEyebrow}>
              <span className={css.posterAccent} aria-hidden="true" />
              <span>CHAT MEMORY</span>
              <span className={css.posterBrand}>SUPER TIME</span>
            </div>
            <IdentityName
              className={css.posterSession}
              textClassName={css.posterSessionName}
              name={session.displayName || session.username}
              username={session.username}
              size={46}
            >
              {withEnterprise(session.displayName || session.username, session.enterpriseName)}
            </IdentityName>
            <div className={css.posterMeta}>
              <span>{count} 条精选聊天记录</span>
              {range && <span>{range}</span>}
            </div>
          </header>
          <main className={css.posterMessages}>
            {items.map((item, index) => {
              const head = posterItemHead(item)
              const messageTime = head?.createTime
              return (
                <section className={css.posterExcerpt} key={`${posterItemLocalId(item)}-${index}`}>
                  {messageTime ? (
                    <time className={css.posterTime} dateTime={new Date(messageTime * 1000).toISOString()}>
                      {fmtDateTimeSec(messageTime)}
                    </time>
                  ) : null}
                  {renderItem(item, { idPrefix: 'poster-msg-', interactive: false })}
                </section>
              )
            })}
          </main>
          <footer className={css.posterFooter}>
            <span>由 Super Time 生成</span>
            <span>{generatedAt.current.toLocaleString('zh-CN', { hour12: false })}</span>
          </footer>
        </article>
      </div>
    </div>
  )
}

export interface ChatsPosterOverlayProps {
  controller: ChatsPosterController
  session: WechatSession | null
  renderItem: PosterRowRenderer
}

/** Mount the capture surface only while a poster generation is in flight. */
export function ChatsPosterOverlay({
  controller,
  session,
  renderItem,
}: ChatsPosterOverlayProps): React.JSX.Element | React.ReactPortal | null {
  if (!controller.previewItems || !session || typeof document === 'undefined') return null
  return createPortal(
    <ChatsPosterPreview
      session={session}
      items={controller.previewItems}
      busy={controller.busy}
      renderItem={renderItem}
      onCancel={controller.cancel}
    />,
    document.body,
  )
}
