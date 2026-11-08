/**
 * 图片消息的微信原生 OCR 入口与结果弹窗。
 *
 * 这里只负责界面与有界内存缓存；真正的 OCR 由主进程调用本机微信
 * `WeChatOcr` 插件完成。入口在桌面端才渲染，手机浏览器和网页交接态不出现
 * 一个点了没反应的按钮。
 */
import { createPortal } from 'react-dom'
import { useEffect, useRef, useState } from 'react'
import { IconCloseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ImageOcrResult } from '../../../contracts.ts'
import { apiOcrImage, runtimeCapabilities } from '../api.ts'
import { ImageAiAction } from './chats-image-ai.tsx'
import { RecognitionImagePreview } from './chats-recognition-preview.tsx'
import { copyTextToClipboard } from '../utils/misc.ts'
import { useDialogFocus, useEscapeToClose } from '../ui/kit.tsx'
import cssrows from './chats-rows.module.css'
import cssshell from './chats-shell.module.css'

const OCR_CACHE_MAX = 120
const ocrCache = new Map<string, ImageOcrResult>()

type OcrPhase =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'success'; result: ImageOcrResult }
  | { kind: 'empty' }
  | { kind: 'error'; message: string }

function cacheKey(username: string, localId: number): string {
  return `${username}\u0000${String(localId)}`
}

function readCached(username: string, localId: number): ImageOcrResult | undefined {
  const key = cacheKey(username, localId)
  const hit = ocrCache.get(key)
  if (hit === undefined) return undefined
  // Map 的插入顺序就是 LRU 顺序：命中后刷新它，淘汰的总是最久未用的结果。
  ocrCache.delete(key)
  ocrCache.set(key, hit)
  return hit
}

function writeCached(username: string, localId: number, result: ImageOcrResult): void {
  const key = cacheKey(username, localId)
  if (ocrCache.has(key)) ocrCache.delete(key)
  while (ocrCache.size >= OCR_CACHE_MAX) {
    const oldest = ocrCache.keys().next()
    if (oldest.done) break
    ocrCache.delete(oldest.value)
  }
  ocrCache.set(key, result)
}

/**
 * 图片旁/图片格内的 `?` 按钮：点击后打开识别结果。
 *
 * `side` 用在单图气泡外侧，`overlay` 用在连拍网格每一格的上角；
 * 对方消息在右侧，自己发送的消息由外层 CSS 镜像到左侧。
 * 两种形态都必须是图片可点击区域的**兄弟节点**，避免点 OCR 时同时打开大图。
 */
export function ImageOcrAction({ source, username, localId, layout }: {
  source: string
  username: string
  localId: number
  layout: 'side' | 'overlay'
}): React.JSX.Element | null {
  const desktop = runtimeCapabilities().isDesktop
  const [open, setOpen] = useState(false)
  const [phase, setPhase] = useState<OcrPhase>({ kind: 'idle' })
  const [copyNotice, setCopyNotice] = useState<string | null>(null)
  const aliveRef = useRef(true)
  const attemptRef = useRef(0)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      attemptRef.current += 1
    }
  }, [])

  // 虚拟列表会复用行节点：换到另一条图片时必须关掉上一条的结果。
  useEffect(() => {
    attemptRef.current += 1
    setOpen(false)
    setPhase({ kind: 'idle' })
    setCopyNotice(null)
  }, [username, localId, source])

  useEffect(() => {
    if (copyNotice === null) return
    const timer = window.setTimeout(() => { setCopyNotice(null) }, 1800)
    return () => { window.clearTimeout(timer) }
  }, [copyNotice])

  const close = (): void => {
    attemptRef.current += 1
    setOpen(false)
    setCopyNotice(null)
  }
  useEscapeToClose(open, close)
  useDialogFocus(open, '[data-st-dialog="chats-ocr"]')

  const recognize = async (force = false): Promise<void> => {
    const cached = force ? undefined : readCached(username, localId)
    setOpen(true)
    setCopyNotice(null)
    if (cached) {
      setPhase(cached.text.trim() ? { kind: 'success', result: cached } : { kind: 'empty' })
      return
    }
    const attempt = ++attemptRef.current
    setPhase({ kind: 'loading' })
    try {
      const result = await apiOcrImage(source)
      if (!aliveRef.current || attempt !== attemptRef.current) return
      if (result.text.trim()) {
        writeCached(username, localId, result)
        setPhase({ kind: 'success', result })
      } else {
        setPhase({ kind: 'empty' })
      }
    } catch (error) {
      if (!aliveRef.current || attempt !== attemptRef.current) return
      const message = error instanceof Error ? error.message.trim() : String(error).trim()
      setPhase({ kind: 'error', message: message || '微信原生 OCR 识别失败，请重试' })
    }
  }

  const copy = async (text: string): Promise<void> => {
    const ok = await copyTextToClipboard(text)
    if (aliveRef.current) setCopyNotice(ok ? '已复制' : '复制失败，请手动选中文字')
  }

  if (!desktop) return null

  const dialog = open ? createPortal(
    <div
      className={cssshell.calOverlay}
      data-st-dialog="chats-ocr"
      role="dialog"
      aria-modal="true"
      aria-label="图片文字识别结果"
      onClick={(event) => { if (event.target === event.currentTarget) close() }}
    >
      <div className={`${cssshell.calDialog} ${cssrows.msgRecognitionDialog}`}>
        <div className={cssshell.calHeader}>
          <span className={cssshell.calTitle}>图片文字</span>
          <div className={cssrows.msgOcrHeaderActions}>
            {phase.kind === 'success' && (
              <button
                type="button"
                className={cssrows.msgOcrCopy}
                onClick={() => { void copy(phase.result.text) }}
              >复制文字</button>
            )}
            <button type="button" className={cssshell.calClose} onClick={close} aria-label="关闭">
              <IconCloseOutline16 size={15} />
            </button>
          </div>
        </div>
        <div className={`${cssshell.calBody} ${cssrows.msgRecognitionBody}`} data-state={phase.kind}>
          <RecognitionImagePreview source={source} />
          <div className={cssrows.msgRecognitionResult} data-recognition-result="1">
            {phase.kind === 'loading' && (
              <div className={cssrows.msgOcrState} role="status" aria-live="polite">
                <span className={cssrows.msgOcrSpinner} aria-hidden="true" />
                <span>正在用微信原生 OCR 识别图片…</span>
              </div>
            )}
            {phase.kind === 'success' && (
              <>
                <div className={cssrows.msgOcrMeta}>
                  微信原生 OCR · {phase.result.lines.length > 0 ? `${String(phase.result.lines.length)} 行文字` : '文字'}
                </div>
                <pre className={cssrows.msgOcrText}>{phase.result.text}</pre>
              </>
            )}
            {phase.kind === 'empty' && (
              <div className={cssrows.msgOcrState}>
                <strong>没有识别到文字</strong>
                <span>图片可能不含清晰文字，或文字区域过小。</span>
                <button type="button" className={cssrows.msgOcrRetry} onClick={() => { void recognize(true) }}>
                  重新识别
                </button>
              </div>
            )}
            {phase.kind === 'error' && (
              <div className={cssrows.msgOcrState} role="alert">
                <strong>识别失败</strong>
                <span>{phase.message}</span>
                <button type="button" className={cssrows.msgOcrRetry} onClick={() => { void recognize(true) }}>
                  重试
                </button>
              </div>
            )}
            {copyNotice !== null && <div className={cssrows.msgOcrNotice} aria-live="polite">{copyNotice}</div>}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  ) : null

  return (
    <>
      <button
        type="button"
        className={cssrows.msgOcrAction}
        data-layout={layout}
        title="识别图片文字（微信原生 OCR）"
        aria-label="识别图片文字"
        aria-haspopup="dialog"
        onPointerDown={(event) => { event.stopPropagation() }}
        onPointerUp={(event) => { event.stopPropagation() }}
        onPointerCancel={(event) => { event.stopPropagation() }}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          void recognize()
        }}
      >?</button>
      {dialog}
    </>
  )
}

/**
 * 图片外侧的文本动作栈：微信原生 OCR `?` 在上，已配置大模型 `AI` 在下。
 *
 * 两个按钮都必须是图片可点击区域的兄弟节点；动作栈再统一负责左右镜像，
 * 避免自己发送的图片把按钮挤到右侧。
 */
export function ImageTextActions({ source, username, localId, layout }: {
  source: string
  username: string
  localId: number
  layout: 'side' | 'overlay'
}): React.JSX.Element {
  return (
    <span className={cssrows.msgImageActionStack} data-layout={layout}>
      <ImageOcrAction source={source} username={username} localId={localId} layout={layout} />
      <ImageAiAction source={source} username={username} localId={localId} layout={layout} />
    </span>
  )
}
