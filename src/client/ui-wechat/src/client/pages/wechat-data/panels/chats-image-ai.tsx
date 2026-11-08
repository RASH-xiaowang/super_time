/**
 * 图片文字 AI 识别入口与 JSON 结果弹窗。
 *
 * 与微信原生 OCR 完全分开：点击 `AI` 才会把图片交给当前配置的多模态模型。
 * 结果只用文本节点渲染 JSON，不把模型输出当 HTML。
 */
import { createPortal } from 'react-dom'
import { useEffect, useRef, useState } from 'react'
import { IconCloseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ImageAiJsonResult } from '../../../contracts.ts'
import { apiImageAiJson, runtimeCapabilities } from '../api.ts'
import { copyTextToClipboard } from '../utils/misc.ts'
import { RecognitionImagePreview } from './chats-recognition-preview.tsx'
import { useDialogFocus, useEscapeToClose } from '../ui/kit.tsx'
import cssrows from './chats-rows.module.css'
import cssshell from './chats-shell.module.css'

type AiPhase =
  | { kind: 'loading' }
  | { kind: 'success'; result: ImageAiJsonResult }
  | { kind: 'error'; message: string }

const AI_CACHE_MAX = 30
const AI_CACHE_TTL_MS = 2 * 60_000
const aiResultCache = new Map<string, { result: ImageAiJsonResult; at: number }>()
const aiInflight = new Map<string, Promise<ImageAiJsonResult>>()

function sourceHash(source: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

function cacheKeyOf(username: string, localId: number, source: string): string {
  return `${username}\u0000${String(localId)}\u0000${String(source.length)}\u0000${sourceHash(source)}`
}

function readCached(key: string): ImageAiJsonResult | undefined {
  const entry = aiResultCache.get(key)
  if (entry === undefined) return undefined
  if (Date.now() - entry.at > AI_CACHE_TTL_MS) {
    aiResultCache.delete(key)
    return undefined
  }
  aiResultCache.delete(key)
  aiResultCache.set(key, entry)
  return entry.result
}

function writeCached(key: string, result: ImageAiJsonResult): void {
  aiResultCache.delete(key)
  while (aiResultCache.size >= AI_CACHE_MAX) {
    const oldest = aiResultCache.keys().next()
    if (oldest.done) break
    aiResultCache.delete(oldest.value)
  }
  aiResultCache.set(key, { result, at: Date.now() })
}

function recognizeShared(key: string, source: string): Promise<ImageAiJsonResult> {
  const existing = aiInflight.get(key)
  if (existing !== undefined) return existing
  const pending = apiImageAiJson(source)
    .then((result) => {
      writeCached(key, result)
      return result
    })
    .finally(() => {
      if (aiInflight.get(key) === pending) aiInflight.delete(key)
    })
  aiInflight.set(key, pending)
  return pending
}

export function ImageAiAction({ source, username, localId, layout }: {
  source: string
  username: string
  localId: number
  layout: 'side' | 'overlay'
}): React.JSX.Element | null {
  const desktop = runtimeCapabilities().isDesktop
  const [open, setOpen] = useState(false)
  const [phase, setPhase] = useState<AiPhase>({ kind: 'loading' })
  const [copyNotice, setCopyNotice] = useState<string | null>(null)
  const [loadingStartedAt, setLoadingStartedAt] = useState<number | null>(null)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const aliveRef = useRef(true)
  const attemptRef = useRef(0)
  const cacheKeyRef = useRef<string | null>(null)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      attemptRef.current += 1
    }
  }, [])

  useEffect(() => {
    attemptRef.current += 1
    cacheKeyRef.current = null
    setOpen(false)
    setPhase({ kind: 'loading' })
    setCopyNotice(null)
    setLoadingStartedAt(null)
    setElapsedSeconds(0)
  }, [username, localId, source])

  useEffect(() => {
    if (phase.kind !== 'loading' || loadingStartedAt === null) return
    const tick = (): void => {
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - loadingStartedAt) / 1000)))
    }
    tick()
    const timer = window.setInterval(tick, 1000)
    return () => { window.clearInterval(timer) }
  }, [phase.kind, loadingStartedAt])

  useEffect(() => {
    if (copyNotice === null) return
    const timer = window.setTimeout(() => { setCopyNotice(null) }, 1800)
    return () => { window.clearTimeout(timer) }
  }, [copyNotice])

  const close = (): void => {
    attemptRef.current += 1
    setOpen(false)
    setCopyNotice(null)
    setLoadingStartedAt(null)
  }
  useEscapeToClose(open, close)
  useDialogFocus(open, '[data-st-dialog="chats-image-ai"]')

  const recognize = async (): Promise<void> => {
    const attempt = ++attemptRef.current
    setOpen(true)
    setCopyNotice(null)
    const startedAt = Date.now()
    setLoadingStartedAt(startedAt)
    setElapsedSeconds(0)
    setPhase({ kind: 'loading' })
    const key = cacheKeyRef.current ?? cacheKeyOf(username, localId, source)
    cacheKeyRef.current = key
    const cached = readCached(key)
    if (cached !== undefined) {
      if (!aliveRef.current || attempt !== attemptRef.current) return
      setLoadingStartedAt(null)
      setPhase({ kind: 'success', result: cached })
      return
    }
    try {
      const result = await recognizeShared(key, source)
      if (!aliveRef.current || attempt !== attemptRef.current) return
      setLoadingStartedAt(null)
      setPhase({ kind: 'success', result })
    } catch (error) {
      if (!aliveRef.current || attempt !== attemptRef.current) return
      setLoadingStartedAt(null)
      const message = error instanceof Error ? error.message.trim() : String(error).trim()
      setPhase({ kind: 'error', message: message || '大模型图片识别失败，请重试' })
    }
  }

  const copy = async (text: string): Promise<void> => {
    const ok = await copyTextToClipboard(text)
    if (aliveRef.current) setCopyNotice(ok ? '已复制 JSON' : '复制失败，请手动选中 JSON')
  }

  if (!desktop) return null

  const jsonText = phase.kind === 'success'
    ? JSON.stringify(phase.result.json, null, 2)
    : ''
  const dialog = open ? createPortal(
    <div
      className={cssshell.calOverlay}
      data-st-dialog="chats-image-ai"
      role="dialog"
      aria-modal="true"
      aria-label="AI 图片文字 JSON 结果"
      onClick={(event) => { if (event.target === event.currentTarget) close() }}
    >
      <div className={`${cssshell.calDialog} ${cssrows.msgRecognitionDialog}`}>
        <div className={cssshell.calHeader}>
          <span className={cssshell.calTitle}>AI 图片文字</span>
          <div className={cssrows.msgOcrHeaderActions}>
            {phase.kind === 'success' && (
              <button
                type="button"
                className={cssrows.msgOcrCopy}
                onClick={() => { void copy(jsonText) }}
              >复制 JSON</button>
            )}
            <button type="button" className={cssshell.calClose} onClick={close} aria-label="关闭 AI 图片文字">
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
                <strong>正在由当前配置的大模型识别图片</strong>
                <span>图片会发送给当前配置的多模态模型处理。</span>
                {elapsedSeconds > 0 && (
                  <span className={cssrows.msgAiElapsed} data-ai-elapsed="1" aria-live="polite">
                    {`已等待 ${String(elapsedSeconds)} 秒，模型正在生成结构化结果…`}
                  </span>
                )}
              </div>
            )}
            {phase.kind === 'success' && (
              <>
                <div className={cssrows.msgOcrMeta}>
                  {`已配置大模型 · ${phase.result.model || '当前模型'} · JSON`}
                </div>
                <pre className={cssrows.msgOcrText} data-format="json">{jsonText}</pre>
              </>
            )}
            {phase.kind === 'error' && (
              <div className={cssrows.msgOcrState} role="alert">
                <strong>AI 识别失败</strong>
                <span>{phase.message}</span>
                <button type="button" className={cssrows.msgOcrRetry} onClick={() => { void recognize() }}>
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
        className={cssrows.msgAiAction}
        data-layout={layout}
        data-ai-action="1"
        title="用当前配置的大模型识别图片文字（输出 JSON）"
        aria-label="用 AI 识别图片文字并输出 JSON"
        aria-haspopup="dialog"
        onPointerDown={(event) => { event.stopPropagation() }}
        onPointerUp={(event) => { event.stopPropagation() }}
        onPointerCancel={(event) => { event.stopPropagation() }}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          void recognize()
        }}
      >AI</button>
      {dialog}
    </>
  )
}
