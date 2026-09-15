/**
 * 聊天面板 —— React 版，忠实迁移 WeChatPanel 的 chats 页签核心：左侧会话
 * 列表（搜索/统计/置顶/批量导出），右侧消息流（分页加载 + 多类型消息渲染）。
 * 数据通过 DSH 后端 Remote（sessions + messages）。
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { LazyMount, ListSentinel, ListSkeleton, useLazySentinel, usePagedList, useProgressiveList } from './hooks.tsx'
import { SessionAsk } from './SessionAsk.tsx'
import { clickableKey, Dialog, SearchInput, Segmented, useDialogFocus, useEscapeToClose } from '../ui/kit.tsx'
import { apiBuildSearchIndex, apiClearAllSessionDrafts, apiClearSessionDraft, apiEditChatMessage, apiExportSessionMessages, apiGetAvatar, apiGetAvatarsLocal, apiGetDailyCounts, apiGetEmoticonDataUrl, apiGetGroupInfo, apiGetImageDataUrl, apiGetMessageFile, apiGetMessages, apiGetNewMessages, apiGetPaymentStatus, apiGetSearchIndexStatus, apiGetSessions, apiGetVideoInfo, apiGetVoiceDataUrl, apiGetVoiceInfo, apiGetVoiceTranscript, apiListEditedMessages, apiOpenPath, apiResetEditedMessage, apiResolveChatHistory, apiSearchMessages, apiTranscribeVoiceMessage, pickDirectory, readRenderCache, writeRenderCache } from '../api.ts'
import type { ChatlogRecord, EditedMessageRecord, GroupInfo, GroupMember, MessageRenderKind as RenderKind, MessageRich, PaymentStatus, SearchHit, WechatMessage, WechatSession } from '@deepseek-ai/dsh-wechat-data/types'
import {
  IconChevronLeftOutline14, IconChevronRightOutline14, IconCloseOutline16,
  IconDataOutline16, IconDownloadOutline16, IconEllipsisOutline16,
  IconFullscreenOutline16, IconLinkOutline14, IconListPenOutline16,
  IconPlayOutline16, IconPlusOutline16, IconSearchOutline16, IconTrashOutline16, IconUserOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { RainWindow } from './rain-window.tsx'
import { cacheBounded } from '../utils/misc.ts'
import { MessageText } from '../utils/message-text.tsx'
import { buildMessageItems, renderKindOf } from '../utils/message-items.ts'
import { cspSafeSrc } from '../utils/url.ts'
import kitCss from '../ui/kit.module.css'
import css from './chats.module.css'
import { avatarColors, fmtBytes, fmtDateTimeSec, fmtMsgClockSec, fmtSessionTimeSec } from '../utils/format.ts'

/** 16px calendar glyph (kept local; the primitives set has no calendar). */
/**
 * 未读角标的悬停说明（第 67 轮）。
 * @param n - 未读条数。
 * @param since - 最早一条未读的时间（epoch 秒）；后端解析不到时不传。
 * @returns 「未读 N 条 · 最早 X 前」或只有条数。
 */
function unreadTitle(n: number, since?: number): string {
  const base = `未读 ${n} 条`
  if (!since || since <= 0) return base
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - since)
  const mins = Math.floor(diff / 60)
  const hours = Math.floor(mins / 60)
  const days = Math.floor(hours / 24)
  const ago = days >= 1 ? `${days} 天前` : hours >= 1 ? `${hours} 小时前` : mins >= 1 ? `${mins} 分钟前` : '刚刚'
  return `${base} · 最早一条 ${ago}（${fmtDateTimeSec(since)}）`
}

function IconCalendar(): React.JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="12" rx="2" stroke="currentColor" strokeWidth="1.25" />
      <path d="M1.5 6h13M5 1v3M11 1v3" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  )
}

/** 14px pin glyph for pinned sessions. */
function IconPin(): React.JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M9.2 1.6 14.4 6.8c.4.4.2 1-.3 1.1l-2.4.5-3.1 3.1c-.4.4-1 .4-1.4 0l-.3-.3L4 14.6c-.3.3-.8.3-1.1 0l-.5-.5c-.3-.3-.3-.8 0-1.1l3.4-3.1-.3-.3c-.4-.4-.4-1 0-1.4l3.1-3.1.5-2.4c.1-.5.7-.7 1.1-.3Z" />
    </svg>
  )
}

/** 15px image glyph for media placeholders. */
function IconImage(): React.JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.25" />
      <circle cx="5.5" cy="6" r="1.4" fill="currentColor" />
      <path d="m2.5 12.5 3.5-3.5 2.5 2.5 2.5-2.5 2.5 2.5" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
    </svg>
  )
}

/** 14px minus glyph for the lightbox zoom control. */
function IconMinus(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3 8h10" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  )
}

/** 14px 话筒字形（通话气泡：已接通）。 */
function IconCallOutline(): React.JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4.2 2.3 5.9 5c.2.3.1.7-.1.9l-.9.8c-.2.2-.3.5-.1.8.6 1.1 1.6 2.1 2.7 2.7.3.2.6.1.8-.1l.8-.9c.2-.2.6-.3.9-.1l2.7 1.7c.3.2.4.6.2.9l-.7 1.1c-.5.8-1.5 1.1-2.4.8-2-.7-3.9-2.6-4.6-4.6-.3-.9 0-1.9.8-2.4l1.1-.7c.3-.2.7-.1.9.2Z" fill="currentColor" />
    </svg>
  )
}

/** 15px 话筒+斜线字形（通话气泡：未接通）。 */
function IconCallMissedOutline(): React.JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4.2 2.3 5.9 5c.2.3.1.7-.1.9l-.9.8c-.2.2-.3.5-.1.8.6 1.1 1.6 2.1 2.7 2.7.3.2.6.1.8-.1l.8-.9c.2-.2.6-.3.9-.1l2.7 1.7c.3.2.4.6.2.9l-.7 1.1c-.5.8-1.5 1.1-2.4.8-2-.7-3.9-2.6-4.6-4.6-.3-.9 0-1.9.8-2.4l1.1-.7c.3-.2.7-.1.9.2Z" fill="currentColor" opacity="0.55" />
      <path d="M10.4 5.6 14 9.2M14 5.6 10.4 9.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

/** Open an external http(s) URL in a new tab (protocol-checked). */
function openLink(url: string): void {
  if (/^https?:\/\//i.test(url)) {
    window.open(url, '_blank', 'noopener,noreferrer')
  }
}


/** Wechat transfer state label (mirrors st_control transfer_status_label). */
function transferStatusLabel(self: boolean, paySub: string | undefined): string {
  switch (paySub) {
    case '3': case '8': return self ? '已被接收' : '已收款'
    case '4': case '9': return '已退还'
    case '5': case '10': return '已过期退回'
    case '7': return '待领取'
    case '1': return self ? '等待对方领取' : '待收款'
    default: return ''
  }
}

/** Transfer visual state bucket: pending (arrow) / accepted (check) / refunded (muted). */
function transferStateKey(paySub: string | undefined): 'pending' | 'accepted' | 'refunded' {
  switch (paySub) {
    case '1': case '7': return 'pending'
    case '4': case '5': case '9': case '10': return 'refunded'
    default: return 'accepted'
  }
}

/** White check glyph: transfer received/accepted state. */
function TransferCheckGlyph(): React.JSX.Element {
  return (
    <svg width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="m4 8.4 2.6 2.6L12 5.6" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** White transfer arrow glyph inside the wechat transfer card. */
function TransferArrowGlyph(): React.JSX.Element {
  return (
    <svg width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3.2 5.2h9.4M9.8 2.6 12.6 5.2 9.8 7.8" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12.8 10.8H3.4M6.2 8.2 3.4 10.8l2.8 2.6" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 右键菜单项要触发的动作。 */
type MsgMenuAction = 'copyText' | 'copyJson' | 'openLink' | 'openViewer' | 'openFile' | 'openChatlog' | 'edit'

/**
 * 右键菜单里一项的规格。
 *
 * 做成「声明 + 动作名」而不是直接塞回调，是为了让条目计算保持纯函数：
 * 打开菜单时要先知道条目数才能把菜单夹进视口，塞回调就没法在 setState 之前算。
 */
interface MsgMenuItem {
  label: string
  action: MsgMenuAction
  /** 动作的入参（要复制的文本 / 链接 / 文件名）。 */
  arg?: string
}

/**
 * 一条消息的右键菜单项（微信同款位置与顺序）。
 *
 * 本项目是**只读的本地库查看器**：没有发送链路，所以微信菜单里的
 * 「转发」「撤回」「删除」在这里没有对应动作；能做的按微信顺序排列：
 * 复制文本 → 复制消息 JSON →（打开链接 / 查看大图 / 打开文件 / 查看聊天记录）→ 编辑消息副本。
 * 「语音转文字」仍留在语音气泡下方 —— 微信也是把转写做成气泡下方的按钮，不是菜单项。
 * @param m - the target message.
 * @param kind - its render kind.
 * @returns menu items in display order.
 */
function buildMsgMenu(m: WechatMessage, kind: RenderKind): MsgMenuItem[] {
  const items: MsgMenuItem[] = []
  const text = m.displayText || ''
  if (text) items.push({ label: '复制文本', action: 'copyText', arg: text })
  items.push({ label: '复制消息 JSON', action: 'copyJson' })
  const url = m.rich && typeof m.rich.url === 'string' ? m.rich.url : ''
  if (/^https?:\/\//i.test(url)) items.push({ label: '打开链接', action: 'openLink', arg: url })
  if (kind === 'image') items.push({ label: '查看大图', action: 'openViewer' })
  if (kind === 'file') items.push({ label: '打开文件', action: 'openFile', arg: m.rich?.title || text })
  if (kind === 'chatlog' && m.rich) items.push({ label: '查看聊天记录', action: 'openChatlog' })
  // 只对**纯文本**放开：后端的编辑是整列覆盖 `message_content`，而引用消息（local_type 49）
  // 的该列是本机 100% BLOB 的 appmsg XML（probe-storage 普查：49 型 13213 行全 blob）。
  // 覆盖成纯文本等于把引用卡片拍平成文本、被引用的原文从界面上消失。要做引用编辑，
  // 得改成只改写 XML 里的 <title> 再写回同编码 —— 那是另一件事，先不做。
  if (kind === 'text') items.push({ label: '编辑消息副本', action: 'edit' })
  return items
}

/** 微信语音时长（秒）→ 气泡宽度：官方公式 80px + 秒数×4（1s→84px，60s 封顶 320px）。 */
function voiceWidth(sec: number): string {
  const clamped = Math.min(60, Math.max(1, sec))
  return `${80 + clamped * 4}px`
}

/** Module-level avatar cache (username -> data URL / remote URL / null). */
const avatarCache = new Map<string, string | null>()
/** 头像缓存上限：模块级缓存生命周期等于渲染进程，必须设上限（值为 base64 data URL）。 */
const AVATAR_CACHE_MAX = 300

/**
 * Avatar: lazy-loads the real WeChat avatar via Remote, falls back to a letter tile.
 *
 * 缓存键**只用 `username`**。以前是 `username || name`，而 `name` 是昵称/备注：
 * 群里两个同名成员（或同一个昵称出现在两个会话）会命中同一条缓存、显示同一个头像 ——
 * 属于「用户标识张冠李戴」。调用方必须传真实 username；拿不到时传空串，
 * 此时只渲染首字母占位、不写缓存（宁可没有头像，也不给错的头像）。
 * @param props.name - 展示名（仅用于首字母与配色）。
 * @param props.username - 真实 wxid；为空表示未知身份。
 * @param props.size - 头像边长（px）。
 * @returns the avatar element.
 */
function Avatar({ name, username, size }: { name: string; username: string; size?: number }): React.JSX.Element {
  const key = username
  const cached = key ? avatarCache.get(key) : undefined
  const [, force] = useState(0)
  useEffect(() => {
    let cancelled = false
    if (!key || cached !== undefined) return
    apiGetAvatar({ username: key })
      .then((r) => {
        const value = r.kind === 'data' ? (r.data ?? null) : r.kind === 'url' ? (r.url ?? null) : null
        cacheBounded(avatarCache, key, value, AVATAR_CACHE_MAX)
        if (!cancelled) force(v => v + 1)
      })
      .catch(() => { cacheBounded(avatarCache, key, null, AVATAR_CACHE_MAX); if (!cancelled) force(v => v + 1) })
    return () => { cancelled = true }
  }, [key, cached])
  const letter = (name || username || '?').slice(0, 1).toUpperCase()
  // 第 88 轮：统一由 avatarColors 给底色 + 文字色（对比度 ≥4.5；四个面板同一套哈希，同一个人同色）
  const av = avatarColors(username || name || '?')
  const src = cached ?? null
  if (src) {
    return (
      <div className={css.avatar} style={{ width: size ?? 34, height: size ?? 34, overflow: 'hidden' }}>
        <img src={src} alt={letter} className={css.avatarImg} width={size ?? 34} height={size ?? 34} />
      </div>
    )
  }
  return (
    <div className={css.avatar} style={{ width: size ?? 34, height: size ?? 34, background: av.background, color: av.color }}>
      {letter}
    </div>
  )
}

/** One image entry in the viewer strip. */
export interface ViewerImage {
  username: string
  localId: number
}

/**
 * Lightbox image viewer: zoom (wheel/buttons), drag pan, prev/next, ESC/backdrop close.
 * Resolves each image to a data URL through the Remote on demand.
 */
function ImageViewer({ images, index, onClose, onIndexChange }: {
  images: readonly ViewerImage[]
  index: number
  onClose: () => void
  onIndexChange: (i: number) => void
}): React.JSX.Element {
  const item = images[index]
  const [src, setSrc] = useState<string | null>(null)
  const [vErr, setVErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [off, setOff] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const dragStart = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)

  useEffect(() => {
    if (!item) return
    let cancelled = false
    setSrc(null)
    setVErr(null)
    setZoom(1)
    setOff({ x: 0, y: 0 })
    setLoading(true)
    apiGetImageDataUrl({ username: item.username, localId: item.localId })
      .then((r) => {
        if (cancelled) return
        if (r.url) setSrc(r.url)
        else setVErr(r.error ?? '图片不可用')
      })
      .catch((e: unknown) => { if (!cancelled) setVErr((e as Error).message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [item?.username, item?.localId])

  // 媒体查看器是 createPortal 出去的覆盖层，同样需要把焦点收进来并锁在里面。
  useDialogFocus(!!item, '[data-st-dialog="chats-viewer"]')

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowLeft') onIndexChange((index - 1 + images.length) % images.length)
      else if (e.key === 'ArrowRight') onIndexChange((index + 1) % images.length)
    }
    window.addEventListener('keydown', onKey)
    return () =>{  window.removeEventListener('keydown', onKey) }
  }, [onClose, onIndexChange, index, images.length])

  const zoomBy = (f: number): void =>{  setZoom(z => Math.min(Math.max(z * f, 0.25), 8)) }
  const reset = (): void => { setZoom(1); setOff({ x: 0, y: 0 }) }

  return createPortal(
    <div className={css.viewerOverlay} role="dialog" data-st-dialog="chats-viewer" aria-modal="true"
      onWheel={(e) => { e.preventDefault(); zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15) }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
      onMouseMove={(e) => {
        if (dragging && dragStart.current) {
          setOff({
            x: dragStart.current.ox + (e.clientX - dragStart.current.x),
            y: dragStart.current.oy + (e.clientY - dragStart.current.y),
          })
        }
      }}
      onMouseUp={() => { setDragging(false); dragStart.current = null }}
      onMouseLeave={() => { setDragging(false); dragStart.current = null }}
    >

      <div className={css.viewerBar}>
        <span className={css.viewerCount}>{index + 1} / {images.length}</span>
        <button type="button" className={css.viewerBtn} title="放大" aria-label="放大" onClick={() =>{  zoomBy(1.3) }}><IconPlusOutline16 size={15} /></button>
        <button type="button" className={css.viewerBtn} title="缩小" aria-label="缩小" onClick={() =>{  zoomBy(1 / 1.3) }}><IconMinus /></button>
        <button type="button" className={css.viewerBtn} title="1:1" aria-label="1:1" onClick={reset}><IconFullscreenOutline16 size={15} /></button>
        <button type="button" className={css.viewerBtn} title="上一张" aria-label="上一张" onClick={() => { onIndexChange((index - 1 + images.length) % images.length) }}><IconChevronLeftOutline14 /></button>
        <button type="button" className={css.viewerBtn} title="下一张" aria-label="下一张" onClick={() => { onIndexChange((index + 1) % images.length) }}><IconChevronRightOutline14 /></button>
        <button type="button" className={clsx(css.viewerBtn, css.viewerBtnClose)} title="关闭" aria-label="关闭" onClick={(e) => { e.stopPropagation(); onClose() }}><IconCloseOutline16 size={16} /></button>
      </div>
      <div className={css.viewerStage}>
        {loading && !src && !vErr && <div className={css.viewerMsg}>加载中…</div>}
        {vErr && <div className={css.viewerMsg}>{vErr === 'hevc-unsupported' ? '🖼️ wxgf 原图（需系统 HEVC 解码）' : vErr}</div>}
        {src && (
          <img
            src={src}
            alt="图片"
            className={css.viewerImg}
            style={{ transform: `translate(${off.x}px, ${off.y}px) scale(${zoom})` }}
            draggable={false}
            onMouseDown={(e) => {
              e.preventDefault()
              setDragging(true)
              dragStart.current = { x: e.clientX, y: e.clientY, ox: off.x, oy: off.y }
            }}
          />
        )}
      </div>
    </div>,
    document.body,
  )
}

/** Authoritative transfer/redpacket status line from general.db. */
function PayStatusLine({ serverId }: { serverId: string }): React.JSX.Element | null {
  const [pay, setPay] = useState<PaymentStatus | null>(null)
  useEffect(() => {
    let cancelled = false
    apiGetPaymentStatus(serverId)
      .then((r) => { if (!cancelled && r.found) setPay(r) })
      .catch(() => { /* keep XML-derived status */ })
    return () => { cancelled = true }
  }, [serverId])
  if (!pay || pay.kind === 'transfer' || !pay.redpacket) return null
  const rp = pay.redpacket
  const state = rp.hbStatus === 4 || rp.receiveStatus === 4 ? '已退还'
    : rp.receiveStatus === 3 ? '已被领取'
      : rp.receiveStatus === 2 ? '已领取'
        : '待领取'
  return (
    <div className={css.msgPayStatus} data-kind={pay.kind}>
      {rp.sender ? '来自 ' + rp.sender + ' · ' : ''}{state}
      {rp.hbType === 1 ? ' · 群红包' : ''}
    </div>
  )
}

/** 不同扩展名的图标风格（kind + emoji），便于按类型区分样式。 */
const FILE_STYLE: Record<string, { kind: string; emoji: string }> = {
  pdf: { kind: 'pdf', emoji: '📄' },
  doc: { kind: 'word', emoji: '📝' }, docx: { kind: 'word', emoji: '📝' },
  xls: { kind: 'excel', emoji: '📊' }, xlsx: { kind: 'excel', emoji: '📊' }, csv: { kind: 'excel', emoji: '📊' },
  ppt: { kind: 'ppt', emoji: '📽️' }, pptx: { kind: 'ppt', emoji: '📽️' },
  png: { kind: 'image', emoji: '🖼️' }, jpg: { kind: 'image', emoji: '🖼️' }, jpeg: { kind: 'image', emoji: '🖼️' }, gif: { kind: 'image', emoji: '🖼️' }, webp: { kind: 'image', emoji: '🖼️' }, bmp: { kind: 'image', emoji: '🖼️' },
  mp4: { kind: 'video', emoji: '🎬' }, mov: { kind: 'video', emoji: '🎬' }, avi: { kind: 'video', emoji: '🎬' },
  mp3: { kind: 'audio', emoji: '🎵' }, wav: { kind: 'audio', emoji: '🎵' }, m4a: { kind: 'audio', emoji: '🎵' },
  zip: { kind: 'archive', emoji: '🗜️' }, rar: { kind: 'archive', emoji: '🗜️' }, '7z': { kind: 'archive', emoji: '🗜️' }, tar: { kind: 'archive', emoji: '🗜️' }, gz: { kind: 'archive', emoji: '🗜️' },
  js: { kind: 'code', emoji: '💻' }, ts: { kind: 'code', emoji: '💻' }, py: { kind: 'code', emoji: '💻' }, sql: { kind: 'code', emoji: '💻' }, html: { kind: 'code', emoji: '💻' }, css: { kind: 'code', emoji: '💻' }, json: { kind: 'code', emoji: '💻' }, yaml: { kind: 'code', emoji: '💻' }, yml: { kind: 'code', emoji: '💻' }, ini: { kind: 'code', emoji: '💻' }, xml: { kind: 'code', emoji: '💻' }, bat: { kind: 'code', emoji: '💻' }, ps1: { kind: 'code', emoji: '💻' }, sh: { kind: 'code', emoji: '💻' }, java: { kind: 'code', emoji: '💻' },
  txt: { kind: 'text', emoji: '📃' }, md: { kind: 'text', emoji: '📃' }, log: { kind: 'text', emoji: '📃' }, rtf: { kind: 'text', emoji: '📃' },
}

function fileStyle(fileName: string): { kind: string; emoji: string } {
  const ext = (fileName.split('.').pop() || '').toLowerCase()
  return FILE_STYLE[ext] || { kind: 'file', emoji: '📁' }
}
/**
 * 从 `msg/file` 本地缓存取回收到的文件并触发下载。
 *
 * 抽成模块级函数的唯一原因：文件卡的点击区与右键菜单的「打开文件」
 * 都要走同一条链路，不能各写一份（两份实现迟早会在错误文案上分叉）。
 * @param fileName - 消息里的文件名。
 * @param opts - 归属线索：消息里的文件字节数与接收时间。`msg/file` 只按月份
 *   分目录，同名文件可能属于别的会话，必须把这两条线索透传给后端。
 * @returns 成功返回空串，失败返回可展示的错误文案。
 */
async function downloadMessageFile(fileName: string, opts: { size?: number; createTime?: number } = {}): Promise<string> {
  try {
    const r = await apiGetMessageFile({
      fileName,
      ...(opts.size !== undefined ? { size: opts.size } : {}),
      ...(opts.createTime !== undefined ? { createTime: opts.createTime } : {}),
    })
    if (!r.url) return r.error ?? '文件不可用'
    const a = document.createElement('a')
    a.href = r.url
    a.download = fileName
    document.body.appendChild(a)
    a.click()
    a.remove()
    return ''
  } catch (e) {
    return (e as Error).message
  }
}

/** 点击打开/下载收到的文件（走 msg/file 本地缓存读取）。 */
function OpenFileCard({ title, size, createTime }: { title: string; size: string; createTime?: number }): React.JSX.Element {
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [message, setMessage] = useState('')
  const openFile = async (): Promise<void> => {
    setStatus('loading')
    setMessage('')
    const bytes = Number(size)
    const err = await downloadMessageFile(title, {
      ...(Number.isFinite(bytes) && bytes > 0 ? { size: bytes } : {}),
      ...(createTime !== undefined ? { createTime } : {}),
    })
    if (err) {
      setStatus('error')
      setMessage(err)
      return
    }
    setStatus('idle')
  }
  const ext = (title.split('.').pop() || '').toLowerCase()
  const style = fileStyle(title)
  const sized = size ? fmtBytes(Number(size)) : ''
  const foot = status === 'loading' ? '打开中…' : status === 'error' ? message : '点击打开 / 下载'
  return (
    <div className={css.msgFileCard} {...clickableKey(() => { void openFile() })} title={status === 'error' ? message : '点击打开/下载文件'}>
      <span className={css.msgFileIcon} data-kind={style.kind}>{style.emoji}</span>
      <span className={css.msgFileBody}>
        <span className={css.msgFileTitle}>{title}</span>
        <span className={css.msgFileMeta}>{[ext ? ext.toUpperCase() : '文件', sized].filter(Boolean).join(' · ')}</span>
        <span className={css.msgFileHint}>{foot}</span>
      </span>
      <span className={css.msgFileExt}>{ext ? ext.toUpperCase() : '文件'}</span>
      <CardFoot label="微信电脑版" />
    </div>
  )
}

/**
 * 引用消息里被引用类型 → 中文短标签（后端已写好 `rich.referType`）。
 *
 * 微信 refermsg 的 type 与消息 local_type 同一编码族：媒体用本类型号，
 * 应用消息多在 49 族。没有映射时返回空串，界面不硬造标签。
 * @param t - refermsg <type>.
 * @returns 中文标签（''）。
 */
function quoteTypeLabel(t: number | undefined): string {
  if (!t || typeof t !== 'number') return ''
  if (t === 1) return '文本'
  if (t === 3) return '图片'
  if (t === 34) return '语音'
  if (t === 43) return '视频'
  if (t === 47) return '表情'
  if (t === 48) return '位置'
  if (t === 42 || t === 66) return '名片'
  if (t === 49 || t === 5 || t === 68) return '链接'
  if (t === 53) return '接龙'
  if (t === 50) return '通话'
  return ''
}

/**
 * 卡片底部的**类型条**（微信原生卡片底部那一行「微信转账 / 微信红包 / 聊天记录」）。
 *
 * 有了它，同一张卡片在不同位置（气泡内 / 合并转发弹窗内）都能被一眼认出来源；
 * 也因此**不再**把类型名塞进标题 —— 那会让标题被截断。
 * @param props.label - 类型名。
 * @returns the footer element.
 */
function CardFoot({ label }: { label: string }): React.JSX.Element {
  return <span className={css.msgCardFoot}>{label}</span>
}

/**
 * 通用「带标签的小卡」：群公告 / 笔记 / 卡片 / 商品 / 表情 / 版本不支持。
 *
 * 这些 appmsg 子类型在 `RichCard` 里曾经一律落到 `default` 分支，
 * 于是被画成**链接卡**（标题 + 描述 + 假链接区）—— 实际它们没有可跳转的 URL。
 * 这里给一个统一外形：图标 + 类型标签 + 标题 + 描述（+ 来源 + 可选的跳转）。
 * @param props - icon/label plus the parsed title/desc/source/url.
 * @returns the card element.
 */
function LabeledCard({ icon, label, title, desc, source, url, foot, thumb }: {
  icon: string
  label: string
  title?: string
  desc?: string
  source?: string
  url?: string
  foot?: string
  thumb?: string
}): React.JSX.Element {
  const link = /^https?:\/\//i.test(url ?? '')
  const safeThumb = cspSafeSrc(thumb)
  return (
    <div
      className={link ? `${css.msgAppmsgCard} ${css.msgAppmsgCardOpen}` : css.msgAppmsgCard}
      title={link ? '点击打开链接' : undefined}
      {...(link ? clickableKey(() => { openLink(url ?? '') }, { role: 'link', label: '打开链接' }) : {})}
    >
      {safeThumb
        ? <img className={css.msgAppmsgThumb} src={safeThumb} alt="" loading="lazy" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
        : <span className={css.msgAppmsgIcon} aria-hidden="true">{icon}</span>}
      <span className={css.msgAppmsgBody}>
        <span className={css.msgAppmsgLabel}>{label}</span>
        {title && <span className={css.msgAppmsgTitle} title={title}>{title}</span>}
        {desc && <span className={css.msgAppmsgDesc} title={desc}>{desc}</span>}
        {source && <span className={css.msgAppmsgSource}>{source}</span>}
      </span>
      {foot && <CardFoot label={foot} />}
    </div>
  )
}

/**
 * 视频号 / 直播卡片：封面 + 作者 + 标题 + 可选角标。
 *
 * 视频号分享在本机 appmsg 里是 type 51（标题常被微信替换成
 * 「当前微信版本不支持展示该内容」），真正的标题来自 `<finderFeed><desc>` ——
 * 后端已解析到 `rich.title`，界面只需别再退化成通用链接卡。
 * @param props - the channels/live rich descriptor.
 * @returns the card element.
 */
function MediaCoverCard({ cover, badge, title, from, desc, onOpen, variant }: {
  cover?: string
  badge?: string
  title: string
  from?: string
  desc?: string
  onOpen?: () => void
  variant: 'channels' | 'live'
}): React.JSX.Element {
  const safe = cspSafeSrc(cover)
  const [broken, setBroken] = useState(false)
  const open = onOpen
  return (
    <div
      className={css.msgMediaCard}
      data-variant={variant}
      {...(open ? clickableKey(open, { role: 'link', label: '打开' }) : {})}
    >
      <div className={css.msgMediaCover} data-empty={!safe || broken || undefined}>
        {safe && !broken
          ? <img src={safe} alt="" loading="lazy" onError={() => { setBroken(true) }} />
          : <span className={css.msgMediaCoverFallback} aria-hidden="true">{variant === 'live' ? '📡' : '▶'}</span>}
        {badge && <span className={css.msgMediaBadge}>{badge}</span>}
        {variant === 'live' && <span className={css.msgMediaDot} aria-hidden="true" />}
      </div>
      <div className={css.msgMediaBody}>
        <div className={css.msgMediaTitle} title={title}>{title}</div>
        {from && <div className={css.msgMediaFrom}>{from}</div>}
        {desc && desc !== title && <div className={css.msgMediaDesc} title={desc}>{desc}</div>}
      </div>
      <CardFoot label={variant === 'live' ? '视频号直播' : '视频号'} />
    </div>
  )
}

/** 直播状态文案：`<livestatus>` 各版本取值不同，做一次归一。 */
function liveStatusText(raw?: string): string {
  const v = String(raw ?? '').trim().toLowerCase()
  if (!v) return ''
  if (['1', 'live', 'living', 'ongoing', 'started'].includes(v)) return '直播中'
  if (['2', 'end', 'ended', 'finished', 'over', 'closed'].includes(v)) return '已结束'
  if (['0', 'preview', 'notstarted', 'not_started'].includes(v)) return '预告'
  return ''
}

/**
 * 公众号多图文推送的一篇（后端 `rich.mpArticles`）。
 *
 * 客户端这份类型是**本地声明**：`node_modules` 里那份类型副本落后于后端，
 * 它的 `MessageRich` 索引签名还没有 `MpArticle[]`，直接读会过不了 `tsc`。
 * 所以这里只做「从 unknown 里安全取数组」这一件事，字段逐个校验。
 */
interface MpArticle {
  title?: string
  url?: string
  cover?: string
  summary?: string
}

/** 安全读后端写的次条数组（字段缺失/类型不对时返回空数组，界面退化成普通链接卡）。 */
function mpArticlesOf(rich: MessageRich): MpArticle[] {
  const raw: unknown = rich.mpArticles
  if (!Array.isArray(raw)) return []
  return raw.filter((a): a is MpArticle => !!a && typeof a === 'object')
}

/**
 * 公众号推送卡（官方形态，用户参考图）：**大图封面**在卡片顶部，
 * 单篇推送在封面下方给标题；多篇推送则把次条排成一行一篇（标题 + 右小方图），
 * 头条只由那张大图代表（参考图里 2 篇的推送就是「大图 + 1 行次条」）。
 *
 * 判据来自 `biz_message_0.db` 的真实结构（见后端 `applyMpNews`）：
 * `<mmreader><topnew><cover>` 是头条封面，`<item>` 列表第 2 篇起是次条。
 * 卡片宽度按微信的 384px 封顶 —— 本项目普通气泡是 100%（见 `--wx-bubble-maxw`），
 * 但 16:9 的封面在宽窗口下会被拉成一条横带，所以这里单独封顶。
 * @param props.rich - the parsed link fields (`mpNews` / `mpArticles` / `thumb`).
 * @param props.title - the top article's title.
 * @param props.url - the top article's url.
 * @returns the card element.
 */
function MpNewsCard({ rich, title, url }: { rich: MessageRich; title: string; url: string }): React.JSX.Element {
  const cover = cspSafeSrc(rich.thumb)
  const [broken, setBroken] = useState(false)
  const secondaries = mpArticlesOf(rich)
  const openUrl = (u: string) => { if (/^https?:\/\//i.test(u)) openLink(u) }
  const mainClickable = /^https?:\/\//i.test(url)
  const showCover = !!cover && !broken
  return (
    <div className={css.msgMpCard} data-mp-count={secondaries.length + 1}>
      {showCover && (
        <span
          className={`${css.msgMpCover} ${mainClickable ? css.msgMpClickable : ''}`}
          title={mainClickable ? '点击打开文章' : undefined}
          {...(mainClickable ? clickableKey(() => { openUrl(url) }, { role: 'link', label: '打开文章' }) : {})}
        >
          <img className={css.msgMpCoverImg} src={cover} alt="" loading="lazy" onError={() => { setBroken(true) }} />
        </span>
      )}
      {secondaries.length === 0 ? (
        <span
          className={`${css.msgMpTitle} ${mainClickable ? css.msgMpClickable : ''}`}
          title={mainClickable ? '点击打开文章' : undefined}
          {...(mainClickable ? clickableKey(() => { openUrl(url) }, { role: 'link', label: '打开文章' }) : {})}
        >
          {title}
        </span>
      ) : (
        secondaries.map((a, i) => {
          const t = a.title || ''
          const u = a.url || ''
          const thumb = cspSafeSrc(a.cover)
          const clickable = /^https?:\/\//i.test(u)
          return (
            <span
              key={`${u || t}-${String(i)}`}
              className={`${css.msgMpRow} ${clickable ? css.msgMpClickable : ''}`}
              title={clickable ? '点击打开文章' : undefined}
              {...(clickable ? clickableKey(() => { openUrl(u) }, { role: 'link', label: '打开次条文章' }) : {})}
            >
              <span className={css.msgMpRowTitle}>{t || '[无标题]'}</span>
              {thumb && <img className={css.msgMpRowThumb} src={thumb} alt="" loading="lazy" />}
            </span>
          )
        })
      )}
    </div>
  )
}

/**
 * 链接卡：`default`（左文右图）与 `cover`（公众号大图式）两种外形。
 *
 * 微信把公众号文章渲染成「封面大图 + 底部标题」，普通网页是「标题 + 摘要 + 域名」。
 * 后端用 `rich.linkStyle` 已经判好了（摘要以话题标签开头 / 含 `#话题#` /
 * PC 信息流链接近 cover），界面按它切换即可，不必每个面板自己猜。
 * @param props - the parsed link fields.
 * @returns the card element.
 */
function LinkCard({ rich, title, desc, url }: {
  rich: MessageRich
  title: string
  desc: string
  url: string
}): React.JSX.Element {
  const safeThumb = cspSafeSrc(rich.thumb)
  const [broken, setBroken] = useState(false)
  const clickable = /^https?:\/\//i.test(url)
  const cover = rich.linkStyle === 'cover' && safeThumb && !broken
  const source = rich.source || ''
  let host = ''
  try { host = clickable ? new URL(url).hostname : '' } catch { host = '' }
  return (
    <div
      className={[css.msgLinkCard, clickable ? css.msgLinkCardOpen : '', cover ? css.msgLinkCover : ''].filter(Boolean).join(' ')}
      title={clickable ? '点击打开链接' : undefined}
      // 可打开时是链接语义（读屏播报「链接」），不可打开时完全不挂交互属性
      {...(clickable ? clickableKey(() => { openLink(url) }, { role: 'link', label: '打开链接' }) : {})}
    >
      {cover && (
        <span className={css.msgLinkCoverWrap}>
          <img className={css.msgLinkCoverImg} src={safeThumb} alt="" loading="lazy" onError={() => { setBroken(true) }} />
          {clickable && <span className={css.msgLinkOpen}><IconLinkOutline14 size={12} /></span>}
          <span className={css.msgLinkCoverTitle} title={title}>{title}</span>
        </span>
      )}
      {!cover && (
        <span className={css.msgLinkThumbWrap}>
          <span className={css.msgLinkText}>
            {source && <span className={css.msgLinkSource}>{source}</span>}
            <span className={css.msgLinkTitle}>{title}</span>
            {desc && <span className={css.msgLinkDesc} title={desc}>{desc}</span>}
            {!safeThumb && clickable && <span className={css.msgLinkUrl} title={url}>{host || url}</span>}
          </span>
          {safeThumb && (
            <img className={css.msgLinkThumb} src={safeThumb} alt="" loading="lazy" onError={() => { setBroken(true) }} />
          )}
        </span>
      )}
      {clickable && !cover && <span className={css.msgLinkOpen}><IconLinkOutline14 size={12} /></span>}
    </div>
  )
}

/** 单张消息图片（可点击进大图）。图片组网格也复用它。 */
function MessageThumb({ username, localId, onOpen, alt = '图片' }: {
  username: string
  localId: number
  onOpen?: () => void
  alt?: string
}): React.JSX.Element {
  const [src, setSrc] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    setSrc(null)
    setErr(null)
    apiGetImageDataUrl({ username, localId })
      .then((r) => { if (!cancelled) { if (r.url) setSrc(r.url); else setErr(r.error ?? '图片不可用') } })
      .catch((e: unknown) => { if (!cancelled) setErr((e as Error).message) })
    return () => { cancelled = true }
  }, [username, localId])
  if (err) {
    return <span className={css.msgImageGridEmpty} title={err}><IconImage /></span>
  }
  if (!src) return <span className={css.msgImageGridEmpty} data-loading="true" />
  return (
    <span
      className={css.msgImageGridItem}
      {...(onOpen ? clickableKey(onOpen, { label: '查看大图' }) : {})}
    >
      <img src={src} alt={alt} loading="lazy" decoding="async" />
    </span>
  )
}

/**
 * 图片组（微信「连拍合并」）。
 *
 * 微信把一次连拍的 N 张图拆成 N 条消息，每条都带同一个 `<groupinfo><id>` 与
 * `<count>`。逐条平铺会让一屏只有图片、失去「这是一组」的信息；这里按 id 合成
 * 网格（最多 9 格，多出的用 `+N` 角标），点击任意格进大图。
 * @param props.items - the group's messages (in order).
 * @returns the grid element.
 */
function MessageImageGroup({ items, username, onOpenAt }: {
  items: readonly WechatMessage[]
  username: string
  onOpenAt: (m: WechatMessage) => void
}): React.JSX.Element {
  const shown = items.slice(0, 9)
  const rest = items.length - shown.length
  return (
    <div className={css.msgImageGrid} data-count={Math.min(shown.length, 9)}>
      {shown.map((m, i) => (
        <span key={m.localId} className={css.msgImageGridCell}>
          <MessageThumb username={username} localId={m.localId} onOpen={() => { onOpenAt(m) }} />
          {rest > 0 && i === shown.length - 1 && <span className={css.msgImageGridMore}>+{rest}</span>}
        </span>
      ))}
    </div>
  )
}

/**
 * 系统提示行（type 10000 / 10002）。
 *
 * 撤回单独成类（后端 `renderType === 'revoke'`）：它是**动作**不是通知——
 * 微信也用不同的灰底样式表示。其余系统消息按是否有图标区分：
 * @returns the centered system line.
 */
function MessageSystem({ m }: { m: WechatMessage }): React.JSX.Element {
  const text = m.displayText || (m.renderType === 'revoke' ? '撤回了一条消息' : '[系统消息]')
  const kind = m.renderType === 'revoke' ? 'revoke' : (m.sysKind === 'chatroomtopmsg' || m.sysKind === 'top' ? 'top' : 'notice')
  const icon = kind === 'revoke' ? '↩' : kind === 'top' ? '📌' : ''
  return (
    <div className={css.msgSystem} data-kind={kind}>
      {icon && <span className={css.msgSystemIcon} aria-hidden="true">{icon}</span>}
      <span className={css.msgSystemText}>{text}</span>
    </div>
  )
}

/**
 * 位置卡片：标题 + 详细地址 + 经纬度（可复制核对）。
 *
 * 后端 `rich.lat/lng` 来自 `<location x y>`（x=纬度、y=经度，微信沿用 mapkit 命名）。
 * 没有可用的离线地图瓦片，所以**不画假地图** —— 只给一个坐标芯片，
 * 让「这条位置到底是哪」可核对，而不是一个只有地名的空卡。
 * @param props.m - the location message.
 * @returns the location card element.
 */
function MessageLocation({ m }: { m: WechatMessage }): React.JSX.Element {
  const rich = m.rich
  const name = rich?.title || m.displayText || '位置'
  const addr = rich?.desc || ''
  const lat = typeof rich?.lat === 'number' ? rich.lat : null
  const lng = typeof rich?.lng === 'number' ? rich.lng : null
  const coord = lat !== null && lng !== null ? `${lat.toFixed(5)}, ${lng.toFixed(5)}` : ''
  return (
    <div className={css.msgLocationCard}>
      <span className={css.msgLocationMap} aria-hidden="true">
        <span className={css.msgLocationGrid} />
        <span className={css.msgLocationPin}>📍</span>
      </span>
      <span className={css.msgLocationBody}>
        <span className={css.msgLocationTitle} title={name}>{name}</span>
        {addr && addr !== name && <span className={css.msgLocationDesc} title={addr}>{addr}</span>}
        {coord && <span className={css.msgLocationCoord} title="纬度, 经度">{coord}</span>}
      </span>
      <CardFoot label="位置" />
    </div>
  )
}

/**
 * 名片卡片：头像（CDN 地址，可能不可达则退回首字）+ 昵称 + 别名/微信号。
 * @param props.m - the contact-card message.
 * @returns the card element.
 */
function MessageContact({ m }: { m: WechatMessage }): React.JSX.Element {
  const rich = m.rich
  const nick = rich?.nickname || rich?.title || m.displayText || '联系人'
  const uname = rich?.username || ''
  const alias = typeof rich?.alias === 'string' ? rich.alias : ''
  const avatar = cspSafeSrc(typeof rich?.avatar === 'string' ? rich.avatar : '')
  const [broken, setBroken] = useState(false)
  const initial = (nick || uname || '?').slice(0, 1).toUpperCase()
  const isEnterprise = m.type === 66 || uname.endsWith('@openim')
  return (
    <div className={css.msgContactCard}>
      <span className={css.msgContactAvatar}>
        {avatar && !broken
          ? <img src={avatar} alt="" loading="lazy" onError={() => { setBroken(true) }} />
          : initial}
      </span>
      <span className={css.msgContactBody}>
        <span className={css.msgContactNick} title={nick}>{nick}</span>
        {alias && <span className={kitCss.textCaption}>别名：{alias}</span>}
        {uname && <span className={kitCss.textCaptionTrunc} title={uname}>{uname}</span>}
      </span>
      <CardFoot label={isEnterprise ? '企业微信名片' : '个人名片'} />
    </div>
  )
}

/** 微信语音波纹字形（三层声波，参考 WeChatDataAnalysis MessageContent.vue）。 */
function IconVoiceWaves({ mirror, size = 18 }: { mirror?: boolean; size?: number }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="currentColor"
      aria-hidden="true"
      style={mirror ? { transform: 'scaleX(-1)' } : undefined}
    >
      <path d="M10.24 11.616l-4.224 4.192 4.224 4.192c1.088-1.056 1.76-2.56 1.76-4.192s-0.672-3.136-1.76-4.192z" />
      <path d="M15.199 6.721l-1.791 1.76c1.856 1.888 3.008 4.48 3.008 7.328s-1.152 5.44-3.008 7.328l1.791 1.76c2.336-2.304 3.809-5.536 3.809-9.088s-1.473-6.784-3.809-9.088z" opacity="0.85" />
      <path d="M20.129 1.793l-1.762 1.76c3.104 3.168 5.025 7.488 5.025 12.256s-1.921 9.088-5.025 12.256l1.762 1.76c3.648-3.616 5.887-8.544 5.887-14.016s-2.239-10.4-5.887-14.016z" opacity="0.55" />
    </svg>
  )
}

/**
 * 引用行里「卡片类 appmsg」的类型图标（转账 2000）。
 *
 * 形状按官方参考图**逐像素描**：外径 13-14px 的描边圆（笔画约 1.5px）+ 圆内
 * 居中一块约 8×5.5 的实心圆角矩形（把参考图放大到 1px 一个字符量出来的）。
 * 图标语义（是「转账」专用还是卡片消息通用）本机无法验证，所以只挂到
 * appmsg 2000，其余类型保持原样 —— 若日后证明是通用形，把条件放宽即可。
 * @returns the glyph element.
 */
function IconQuoteCard(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <circle cx="7" cy="6.7" r="5.8" stroke="currentColor" strokeWidth="1.4" />
      <rect x="4.2" y="4.2" width="6.9" height="5.4" rx="2.6" fill="currentColor" />
    </svg>
  )
}

/**
 * 引用行里的类型图标：官方在摘要前放一个类型小图标；没有合适图标时返回 null（只显示名字与摘要）。
 * @param t - 被引用消息的 refermsg `<type>`。
 * @param appType - 被引用内容是 appmsg 时的子类型（后端 `rich.referAppType`）；0 表示不是 appmsg。
 * @returns the icon element or null.
 */
function quoteKindIcon(t: number | undefined, appType = 0): React.JSX.Element | null {
  if (appType === 2000) return <IconQuoteCard />
  switch (t) {
    case 3: return <IconImage />
    case 34: return <IconVoiceWaves size={13} />
    case 43: return <IconPlayOutline16 size={13} />
    case 42: case 66: return <IconUserOutline16 size={13} />
    case 49: case 5: case 68: return <IconLinkOutline14 size={13} />
    default: return null
  }
}

/**
 * 当前正在播放的语音（模块级）：消息流里同时只允许一条在放（微信行为）。
 * 用模块级而不是 state，是因为「点新的一条要停掉上一条」需要跨组件实例访问。
 */
let currentVoiceAudio: HTMLAudioElement | null = null

/**
 * 语音消息：时长来自消息 XML（`<voicemsg voicelength>`，毫秒）。
 *
 * 旧实现拿 `VoiceInfo.length(voice_data)`（**压缩后的字节数**）除以 2000 当秒用，
 * 短语音普遍显示 0″、长语音偏差一倍以上。XML 里的 voicelength 才是微信自己
 * 展示的那个值；只有它缺失时才退回「已知可解码但没有时长」的形态。
 * @param props.m - the voice message.
 * @returns the voice bubble.
 */
function MessageVoice({ m, selfName }: { m: WechatMessage; selfName: string }): React.JSX.Element {
  const [transcript, setTranscript] = useState<string | null>(null)
  const [transcribing, setTranscribing] = useState(false)
  const [tErr, setTErr] = useState<string | null>(null)
  const [audioOk, setAudioOk] = useState<boolean | null>(null)
  const [playing, setPlaying] = useState(false)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  useEffect(() => {
    let cancelled = false
    apiGetVoiceInfo({ username: selfName, localId: m.localId })
      .then((r) => { if (!cancelled) setAudioOk(r.available === true) })
      .catch(() => { if (!cancelled) setAudioOk(false) })
    apiGetVoiceTranscript({ username: selfName, localId: m.localId })
      .then((r) => { if (!cancelled && r.text) setTranscript(r.text) })
      .catch(() => { /* 尚未转写,跳过 */ })
    return () => { cancelled = true }
  }, [selfName, m.localId])
  const doTranscribe = async (): Promise<void> => {
    setTranscribing(true)
    setTErr(null)
    try {
      const r = await apiTranscribeVoiceMessage({ username: selfName, localId: m.localId })
      if (r.ok && r.text) setTranscript(r.text)
      else setTErr(r.error ?? '转写失败')
    } catch (e) {
      setTErr((e as Error).message)
    } finally {
      setTranscribing(false)
    }
  }
  const ms = typeof m.rich?.durationMs === 'number' ? m.rich.durationMs : 0
  const sec = ms > 0 ? Math.max(1, Math.round(ms / 1000)) : 0
  const width = sec > 0 ? voiceWidth(sec) : undefined
  const isSelf = m.isSender === 1
  // 卸载（切会话/滚动出窗口）时停掉本条，避免声音在后台继续放
  useEffect(() => () => {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null }
  }, [])
  /**
   * 点气泡就地播放/暂停。
   * 音频是后端解码好的 16kHz wav（data URL）——CSP 的 `media-src` 允许 `data:`，
   * 不允许 `file:`，所以只能走 data URL；同一条消息流里只允许一条在放（微信行为）。
   */
  const togglePlay = async (): Promise<void> => {
    setLoadErr(null)
    const cur = audioRef.current
    if (cur && playing) { cur.pause(); setPlaying(false); return }
    try {
      let url = cur ? cur.src : ''
      if (!url) {
        const r = await apiGetVoiceDataUrl({ username: selfName, localId: m.localId })
        if (!r.url) { setLoadErr(r.error ?? '语音不可播放'); return }
        url = r.url
      }
      if (currentVoiceAudio && currentVoiceAudio !== cur) currentVoiceAudio.pause()
      const a = cur ?? new Audio(url)
      audioRef.current = a
      currentVoiceAudio = a
      a.onended = () => { setPlaying(false) }
      a.onerror = () => { setPlaying(false); setLoadErr('播放失败') }
      await a.play()
      setPlaying(true)
    } catch (e) {
      setPlaying(false)
      setLoadErr((e as Error).message)
    }
  }
  return (
    <div className={css.msgVoice}>
      <div
        className={css.msgVoiceBubble}
        style={width ? { width } : undefined}
        title={loadErr ?? (playing ? '点击暂停' : '点击播放')}
        data-self={isSelf || undefined}
        data-playing={playing || undefined}
        {...clickableKey(() => { void togglePlay() }, { role: 'button', label: playing ? '暂停语音' : '播放语音' })}
      >
        {/* 方向：微信只把**我方**图标镜像（参考实现 chat.css `.voice-icon-sent { transform: scaleX(-1) }`），
            对方用基础方向 —— 基础图形是「锥体朝左 + 波纹朝右」，所以对方应是 `◀))) 5″`。
            此前写成 mirror={!isSelf} 把两侧都镜像反了（用户报「对方语音图标方向错」）。 */}
        <span className={css.msgVoiceIcon}><IconVoiceWaves mirror={isSelf} /></span>
        {sec > 0 && <span className={css.msgVoiceDur}>{sec}″</span>}
      </div>
      {sec === 0 && audioOk === false && <span className={kitCss.textMeta}>语音数据不在本地</span>}
      {loadErr && <span className={css.msgVoiceErr} title={loadErr}>{loadErr.length > 28 ? loadErr.slice(0, 28) + '…' : loadErr}</span>}
      {!transcript && !transcribing && !tErr && (
        <button type="button" className={css.msgVoiceBtn} onClick={() => { void doTranscribe() }}>语音转文字</button>
      )}
      {transcribing && <span className={kitCss.textMeta}>转写中…</span>}
      {tErr && !transcript && (
        <span className={css.msgVoiceErr} title={tErr}>{tErr.length > 28 ? tErr.slice(0, 28) + '…' : tErr}</span>
      )}
      {transcript && <span className={css.msgVoiceText}>【{transcript}】</span>}
    </div>
  )
}

/**
 * 视频消息气泡：有封面就画封面 + 播放钮 + 时长角标；没有封面但有实体时给可点开的一行。
 *
 * 「打开」交给系统播放器（`apiOpenPath`）：渲染进程的 CSP 是 `media-src 'self' data: blob:`，
 * 不含 `file:`，站内 `<video src="file://…">` 会被直接拦掉，所以链接文件才是真能用的路径。
 */
function MessageVideo({ m, selfName }: { m: WechatMessage; selfName: string }): React.JSX.Element {
  const [cover, setCover] = useState<string | null>(null)
  const [vErr, setVErr] = useState<string | null>(null)
  const [videoPath, setVideoPath] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    apiGetVideoInfo({ username: selfName, localId: m.localId })
      .then((r) => {
        if (cancelled) return
        // videoPath 是后端新增字段；types 包在 node_modules 里是旧副本（既有的 48 条类型错误同源），
        // 这里按运行时读，不为了一个字段去动那份副本。
        const path = (r as { videoPath?: string }).videoPath
        if (path) setVideoPath(path)
        if (r.coverUrl) setCover(r.coverUrl)
        else setVErr(r.error === 'hevc-unsupported' ? 'wxgf/HEVC 封面（需系统解码）' : (r.error ?? '视频不可用'))
      })
      .catch((e: unknown) => { if (!cancelled) setVErr((e as Error).message) })
    return () => { cancelled = true }
  }, [selfName, m.localId])
  const durSec = typeof m.rich?.durationSec === 'number' ? m.rich.durationSec : 0
  const durText = durSec > 0 ? `${Math.floor(durSec / 60)}:${String(durSec % 60).padStart(2, '0')}` : ''
  const openVideo = (): void => {
    if (!videoPath) return
    void apiOpenPath(videoPath).catch(() => { /* 打不开就保持原样，用户可用右键菜单里的「显示所在位置」 */ })
  }
  // 没有封面但有实体：给一行可点的入口，而不是报「不在本地」
  if (vErr && videoPath) {
    return (
      <div className={css.msgBubble}>
        <span className={css.msgVoicelike} title={videoPath} {...clickableKey(openVideo, { role: 'button', label: '用系统播放器打开视频' })}>
          <IconPlayOutline16 size={13} /> 视频{durText ? ` ${durText}` : ''}
        </span>
        <span className={kitCss.textMeta}>封面不在本地，点上方用系统播放器打开</span>
      </div>
    )
  }
  if (vErr) {
    return (
      <div className={css.msgBubble}>
        <span className={css.msgVoicelike}><IconPlayOutline16 size={13} /> 视频{durText ? ` ${durText}` : ''}</span>
        <span className={kitCss.textMeta}>（{vErr}）</span>
      </div>
    )
  }
  if (!cover) {
    return (
      <div className={css.msgBubble}>
        <span className={css.msgVoicelike}><IconPlayOutline16 size={13} /> 视频{durText ? ` ${durText}` : ''}</span>
        <span className={kitCss.textMeta}>加载中…</span>
      </div>
    )
  }
  return (
    <div className={`${css.msgBubble} ${css.msgBubbleTight}`}>
      <span
        className={css.msgVideoWrap}
        title={videoPath ? `${videoPath}\n（点击用系统播放器打开）` : '视频封面'}
        {...(videoPath ? clickableKey(openVideo, { role: 'button', label: '用系统播放器打开视频' }) : {})}
      >
        <img src={cover} alt="视频封面" className={css.msgImage} loading="lazy" />
        <span className={css.msgVideoPlay}><IconPlayOutline16 size={18} /></span>
        {durText && <span className={css.msgVideoDur}>{durText}</span>}
      </span>
    </div>
  )
}

/**
 * Format a call duration in seconds as MM:SS (or H:MM:SS past an hour).
 * @param sec - duration in seconds.
 * @returns the clock-style duration text.
 */
function fmtCallDuration(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/** 16px 摄像机字形（视频通话结局）。 */
function IconVideoCallOutline(): React.JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="4" width="9" height="8" rx="2" stroke="currentColor" strokeWidth="1.25" />
      <path d="M10.5 8.4 14.5 6v4.8L10.5 8.4Z" fill="currentColor" />
    </svg>
  )
}

/**
 * Call bubble (type 50) —— 通话结局与时长都来自 voip XML 的 `<msg>` 文本。
 *
 * 后端 `parseMessageContent(50, …)` 解出 `rich = { type:'call', status,
 * connected, callStatus, durationSec?, voipType? }`：`status` 是微信自己写的结局
 * （通话时长 00:21 / 对方已取消 / 已拒绝 / 未应答 / 已在其它设备接听 …）。
 * `durationSec` 由它解析而来（XML 的 `<duration>` 实测恒为 0，不可用）。
 * `voipType` 来自 `<room_type>`（1=视频、2=语音），未知时只画话筒图标。
 * @param props.m - the call message.
 * @returns the call bubble element.
 */
function MessageCall({ m }: { m: WechatMessage }): React.JSX.Element {
  const rich = m.rich
  const status = String(rich?.status ?? rich?.title ?? '').trim() || (m.displayText || '').replace(/^\[通话\]\s*/, '')
  const durSec = typeof rich?.durationSec === 'number' ? rich.durationSec : null
  const connected = rich?.connected === true || durSec !== null
  const kind = String(rich?.callStatus ?? (connected ? 'connected' : 'missed'))
  const isVideo = rich?.voipType === 'video'
  // 「通话时长 00:21」里的时长已单独渲染，状态行去掉尾部时间避免重复。
  const label = status.replace(/\s*\d{1,2}:\d{2}(?::\d{2})?\s*$/, '').trim()
  return (
    <div className={css.msgCall} data-state={connected ? 'done' : 'missed'} data-kind={kind} data-media={isVideo ? 'video' : 'audio'}>
      <span className={css.msgCallIcon} aria-hidden="true">
        {isVideo ? <IconVideoCallOutline /> : connected ? <IconCallOutline /> : <IconCallMissedOutline />}
      </span>
      <span className={css.msgCallBody}>
        {/*
          微信的通话气泡只有「图标 + 结局」两段：语音/视频由**图标**表达
          （话筒 / 摄像机），气泡里**不写**「语音通话 / 视频通话」这行标签。
          此前多画了一行，实测气泡比官方的宽 50px（215×38 vs 参考 165×36）。
        */}
        <span className={css.msgCallStatus}>{label || (connected ? '通话' : '未接通')}</span>
        {durSec !== null && <span className={css.msgCallDur}>{fmtCallDuration(durSec)}</span>}
      </span>
    </div>
  )
}

/** Lazy message image: resolve + decode via Remote, render as data URL. */
function MessageImage({ m, selfName, onOpen }: {
  m: WechatMessage
  selfName: string
  onOpen?: (m: WechatMessage) => void
}): React.JSX.Element {
  const [src, setSrc] = useState<string | null>(null)
  const [imgErr, setImgErr] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    setSrc(null)
    setImgErr(null)
    apiGetImageDataUrl({ username: selfName, localId: m.localId })
      .then((r) => {
        if (cancelled) return
        if (r.url) setSrc(r.url)
        else setImgErr(r.error ?? '图片不可用')
      })
      .catch((e: unknown) => { if (!cancelled) setImgErr((e as Error).message) })
    return () => { cancelled = true }
  }, [selfName, m.localId])
  if (imgErr) {
    const isHevc = imgErr === 'hevc-unsupported'
    const isNoDat = imgErr.startsWith('找不到 .dat')
    const short = isHevc ? 'wxgf 原图' : isNoDat ? '图片（未解码）' : imgErr
    return (
      <div className={css.msgBubble} title={imgErr}><span className={kitCss.textMeta}><IconImage /> {short}</span></div>
    )
  }
  if (!src) {
    return <div className={`${css.msgBubble} ${css.msgBubbleTight}`}><span className={kitCss.textMeta}><IconImage /> 图片加载中…</span></div>
  }
  return (
    <div className={`${css.msgBubble} ${css.msgBubbleZoom}`} {...clickableKey(() => { if (onOpen) onOpen(m) }, { label: '查看大图' })}>
      <img src={src} alt="图片" className={css.msgImage} loading="lazy" />
    </div>
  )
}


/**
 * 自定义表情真图：按 md5 走 Remote 解码（decoded 缓存优先，否则扫本地表情缓存），
 * 本地解不开时后端会用消息带来的 `cdnurl` 下载一次并落缓存（见后端 fetchEmoticonRemote）。
 * 失败时退回占位芯片，保证会话里永远有一行可读内容。
 */
function MessageEmoticon({ md5, label, emojiUrl }: { md5: string; label?: string; emojiUrl?: string }): React.JSX.Element {
  const [src, setSrc] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    if (!md5 || !/^[0-9a-f]{32}$/i.test(md5)) {
      setSrc(null)
      setErr('缺少表情 MD5')
      return () => { cancelled = true }
    }
    setSrc(null)
    setErr(null)
    apiGetEmoticonDataUrl({ md5: md5.toLowerCase(), ...(emojiUrl ? { emojiUrl } : {}) })
      .then((r) => {
        if (cancelled) return
        if (r.url) setSrc(r.url)
        else setErr(r.error ?? '表情不可用')
      })
      .catch((e: unknown) => { if (!cancelled) setErr((e as Error).message) })
    return () => { cancelled = true }
  }, [md5])
  if (src) {
    return (
      <div className={css.msgSticker} title={label || '表情'}>
        <img className={css.msgStickerImg} src={src} alt={label || '表情'} loading="lazy" decoding="async" />
      </div>
    )
  }
  return (
    <div className={css.msgBubble}>
      <span className={css.msgEmojiChip} title={err || (md5 ? `自定义表情 · MD5 ${md5}` : '自定义表情')}>
        {err ? '😊 [表情]' : '😊 表情加载中…'}
      </span>
    </div>
  )
}

/** 需要走 `RichCard` 的卡片型种类（其余种类有专用渲染器）。 */
const CARD_KINDS = new Set<RenderKind>([
  'file', 'link', 'quote', 'miniapp', 'channels', 'live', 'music', 'product',
  'card', 'note', 'sticker', 'announcement', 'solitaire', 'chatlog',
  'transfer', 'redpacket', 'unsupported', 'unknown',
])

/**
 * 兜底解码 XML 实体（卡片标题/描述用）。
 *
 * 后端 `parseAppmsg` 已经解码，这里只是**渲染缓存里的旧数据**——
 * `readRenderCache` 存的是上一版写入的消息对象，它们的 `rich.title` 里还带着
 * `&#x20;`（公众号标题常把连续空格写成实体）。升级后不清洗会直接显示字面量。
 * @param s - raw text.
 * @returns text with XML entities decoded.
 */
function decodeEntities(s: string): string {
  if (!s || s.indexOf('&') < 0) return s
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
}

/**
 * Render a rich media card (file/link/quote/miniapp/...) inside a bubble.
 *
 * 与旧实现的区别：**种类判断只在 `MessageBody` 里做一次**（按后端 `renderType`），
 * 这里只按 `rich.type` 分派外形，不再维护第二张白名单。
 * @param props - the parsed rich descriptor + render context.
 * @returns the card element.
 */
function RichCard({ rich, fallback, self = false, onOpenChatlog, serverId, createTime }: {
  rich: MessageRich
  fallback: string
  self?: boolean
  onOpenChatlog?: (rich: MessageRich) => void
  serverId?: string
  /** 本条消息的接收时间（秒）—— 文件卡按它缩小到月份目录。 */
  createTime?: number
}): React.JSX.Element {
  const title = decodeEntities(rich.title || fallback || '')
  const desc = decodeEntities(rich.desc || '')
  const url = rich.url || ''
  switch (rich.type) {
    case 'transfer': {
      const amount = (rich.title || '').replace(/^\s*[Y￥]/, '¥')
      const state = transferStatusLabel(self, rich.paysubtype)
      const key = transferStateKey(rich.paysubtype)
      return (
        <div className={css.msgTransferCard} data-state={key}>
          <span className={css.msgTransferArrow} aria-hidden="true">{key === 'pending' ? <TransferArrowGlyph /> : <TransferCheckGlyph />}</span>
          <span className={css.msgTransferMain}>
            <span className={css.msgTransferAmount}>{amount || '¥0.00'}</span>
            <span className={css.msgTransferStatus}>{state || (key === 'pending' ? (self ? '等待对方领取' : '待收款') : '已收款')}</span>
          </span>
          <CardFoot label="微信转账" />
        </div>
      )
    }
    case 'redpacket': {
      const amount = typeof rich.amount === 'string' ? rich.amount.replace(/^\s*[Y￥]/, '¥') : ''
      const greet = rich.desc || '恭喜发财，大吉大利'
      return (
        <div className={css.msgRedpacketCard}>
          <div className={css.msgRedpacketIcon} aria-hidden="true">🧧</div>
          <div className={css.msgRedpacketBody}>
            <div className={css.msgRedpacketTitle}>{greet}</div>
            {amount && <div className={css.msgRedpacketAmount}>{amount}</div>}
            {serverId && <PayStatusLine serverId={serverId} />}
          </div>
          <CardFoot label="微信红包" />
        </div>
      )
    }
    case 'solitaire': {
      // 群接龙：title 只是摘要（`#接龙\n明晚球\n\n1. 云端"），参与者名单在 rich.members。
      // 本机 316 条接龙里 268 条带名单 —— 旧实现把它们渲染成通用链接卡，名单全看不见。
      const members = Array.isArray(rich.members) ? rich.members : []
      const declared = typeof rich.declared === 'number' ? rich.declared : 0
      const lines = String(rich.title || '').replace(/^#?接龙\s*/, '').split('\n').map(l => l.trim()).filter(Boolean)
      // 有名单时只留事由（第一行）；没名单时 title 里的 "1. xxx" 就是全部信息，照原样显示
      const subject = members.length > 0 ? (lines[0] ?? '') : lines.join(' · ')
      const shown = members.slice(0, 8)
      return (
        <div className={css.msgSolitaireCard}>
          <div className={css.msgSolitaireHd}>
            <span className={css.msgSolitaireIcon} aria-hidden="true">🧾</span>
            <span className={css.msgSolitaireSubject} title={subject || '群接龙'}>{subject || '群接龙'}</span>
            {members.length > 0 && <span className={css.msgSolitaireCount}>{declared > members.length ? `${members.length}/${declared} 人` : `${members.length} 人`}</span>}
          </div>
          {shown.length > 0 && (
            <ol className={css.msgSolitaireList}>
              {shown.map(m => (
                <li key={m.idx} className={css.msgSolitaireItem} title={m.username ? `${m.username}` : undefined}>
                  <span className={css.msgSolitaireIdx}>{m.idx}</span>
                  <span className={css.msgSolitaireText}>{m.content || '（未填）'}</span>
                </li>
              ))}
            </ol>
          )}
          {members.length > shown.length && (
            <div className={kitCss.textCaption}>还有 {members.length - shown.length} 人…</div>
          )}
          {declared > members.length && (
            <div className={kitCss.textCaption}>名单声明 {declared} 人，当前列出 {members.length} 人（有人退出后未同步）</div>
          )}
          <CardFoot label="群接龙" />
        </div>
      )
    }
    case 'announcement':
      return <LabeledCard icon="📢" label="群公告" title={title || '群公告'} desc={desc} source={rich.source || ''} foot="群公告" />
    case 'note':
      return <LabeledCard icon="📝" label="笔记" title={title || desc} desc={title ? desc : ''} source={rich.source || ''} foot="笔记" />
    case 'card': {
      // 36 类卡片（本机实测是第三方 H5/团购卡）：有 url 就能跳，别画成死卡。
      return <LabeledCard icon="🏷️" label="卡片" title={title} desc={desc} source={rich.source || ''} thumb={rich.thumb || ''} url={url} foot="卡片" />
    }
    case 'product':
      return <LabeledCard icon="🛍️" label="商品" title={title} desc={desc} source={rich.source || ''} thumb={rich.thumb || ''} url={url} foot="商品" />
    case 'sticker': {
      // 自定义表情：按 md5 解码真图；有 CDN thumb 时优先用 thumb（免扫盘）。
      const md5 = rich.md5 || title || ''
      const safeThumb = cspSafeSrc(rich.thumb)
      if (safeThumb) {
        return (
          <div className={css.msgSticker} title={title || '表情'}>
            <img className={css.msgStickerImg} src={safeThumb} alt={title || '表情'} loading="lazy"
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
          </div>
        )
      }
      if (md5) return <MessageEmoticon md5={md5} label={title || undefined} emojiUrl={typeof rich.emojiUrl === 'string' ? rich.emojiUrl : undefined} />
      return (
        <div className={css.msgBubble}>
          <span className={css.msgEmojiChip} title="自定义表情">😊 [表情]</span>
        </div>
      )
    }
    case 'pat':
      return <div className={css.msgSystem} data-kind="pat">{title || '[拍一拍]'}</div>
    case 'unsupported':
      return (
        <LabeledCard icon="⚠️" label="版本不支持" title={title || '当前微信版本不支持展示该内容，请升级至最新版本。'} foot="暂不支持" />
      )
    case 'quote': {
      // 引用：desc = 被引用的原文（媒体/卡片已折成 `[图片]`/`[转账]`），referName = 被引用方昵称。
      //
      // 官方形态（用户参考图 + 几何核对）：**被引用内容不套在气泡里**，而是气泡下方
      // 独立的一行灰字 `发送者: <类型图标> 摘要`，无底色、单行省略。
      // 判据：参考图里那条引用行宽 138px，而同一条绿色气泡只有 40px ——
      // 引用行比气泡还宽，它不可能是气泡的子元素。
      const quoted = desc || ''
      const refName = rich.referName || ''
      const thumb = cspSafeSrc(rich.thumb)
      const qType = quoteTypeLabel(rich.referType)
      const appType = typeof rich.referAppType === 'number' ? rich.referAppType : 0
      const kindIcon = quoteKindIcon(rich.referType, appType)
      // 引用行已经画了类型图标，摘要就不再重复一遍类型词
      // （官方参考图是「⊙微信转账」，不是「⊙ [转账] 微信转账」）。
      const summary = appType === 2000 ? quoted.replace(/^\[转账\]\s*/, '') : quoted
      const thumbOpen = /^https?:\/\//i.test(thumb)
      return (
        <>
          <div className={css.msgBubble}>{title}</div>
          {(quoted || refName || qType) && (
            <div className={css.msgQuoteStrip} title={refName ? `${refName}：${summary}` : summary}>
              {refName && <span className={css.msgQuoteWho}>{refName}:</span>}
              {kindIcon && <span className={css.msgQuoteKind} aria-hidden="true">{kindIcon}</span>}
              <span className={css.msgQuoteWhat}>{summary || `[${qType}]`}</span>
              {thumb && (
                <span
                  className={`${css.msgQuoteThumbWrap} ${thumbOpen ? css.msgQuoteThumbOpen : ''}`}
                  {...(thumbOpen ? clickableKey(() => { openLink(thumb) }, { role: 'link', label: '查看引用缩略图' }) : {})}
                >
                  <img className={css.msgQuoteThumb} src={thumb} alt="" loading="lazy" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
                </span>
              )}
            </div>
          )}
        </>
      )
    }
    case 'file':
      return <OpenFileCard title={title} size={rich.fileSize ?? ''} {...(createTime !== undefined ? { createTime } : {})} />
    case 'chatlog': {
      const records = Array.isArray(rich.records) ? rich.records : []
      const preview = records.slice(0, 4).map(r => `${r.name || ''}${r.name ? '：' : ''}${r.text || ''}`.trim()).filter(Boolean)
      return (
        <button type="button" className={css.msgChatlogCard}
          onClick={onOpenChatlog ? () => { onOpenChatlog(rich) } : undefined}
          title={onOpenChatlog ? '点击查看聊天记录' : undefined}>
          <span className={css.msgChatlogMain}>
            <span className={css.msgChatlogIcon}><IconDataOutline16 size={15} /></span>
            <span className={css.msgChatlogBody}>
              <span className={css.msgChatlogTitle}>{title || '群聊的聊天记录'}</span>
              {preview.length > 0 && (
                <span className={css.msgChatlogPreview}>
                  {preview.map((line, i) => <span key={i} className={css.msgChatlogLine} title={line}>{line}</span>)}
                </span>
              )}
            </span>
          </span>
          <CardFoot label={records.length > 0 ? `聊天记录 · 共 ${records.length} 条` : '聊天记录'} />
        </button>
      )
    }
    case 'miniapp': {
      // 微信原生小程序卡：顶栏应用名 → 标题 → 页面封面大图 → 底栏「小程序」。
      const cover = cspSafeSrc(rich.thumb)
      const appIcon = cspSafeSrc(typeof rich.avatar === 'string' ? rich.avatar : '')
      const appName = rich.source || ''
      const bodyDesc = desc && !/[<>]/.test(desc) && desc !== title ? desc : ''
      return (
        <div className={css.msgMiniappCard}>
          {(appName || appIcon) && (
            <div className={css.msgMiniappApp}>
              {appIcon
                ? <img className={css.msgMiniappAppIcon} src={appIcon} alt="" loading="lazy" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
                : <span className={css.msgMiniappAppDot} aria-hidden="true" />}
              <span className={css.msgMiniappName}>{appName || '小程序'}</span>
            </div>
          )}
          <div className={css.msgMiniappTitle}>{title || '[小程序]'}</div>
          {bodyDesc && <div className={css.msgMiniappDesc}>{bodyDesc}</div>}
          <div className={css.msgMiniappCover} data-empty={!cover || undefined}>
            {cover
              ? (
                <img
                  className={css.msgMiniappCoverImg}
                  src={cover}
                  alt=""
                  loading="lazy"
                  onError={(e) => {
                    const el = e.target as HTMLImageElement
                    el.style.display = 'none'
                    el.parentElement?.setAttribute('data-empty', '')
                  }}
                />
              )
              : (
                <span className={css.msgMiniappCoverFallback} aria-hidden="true">
                  <IconDataOutline16 size={22} />
                </span>
              )}
          </div>
          <CardFoot label="小程序" />
        </div>
      )
    }
    case 'channels':
      return (
        <MediaCoverCard
          variant="channels"
          cover={rich.thumb}
          title={title || '[视频号]'}
          {...(rich.source ? { from: rich.source } : {})}
          {...(desc ? { desc } : {})}
          {...(/^https?:\/\//i.test(url) ? { onOpen: () => { openLink(url) } } : {})}
        />
      )
    case 'live':
      return (
        <MediaCoverCard
          variant="live"
          cover={rich.thumb}
          {...(liveStatusText(typeof rich.status === 'string' ? rich.status : '') ? { badge: liveStatusText(typeof rich.status === 'string' ? rich.status : '') } : {})}
          title={title || '[直播]'}
          {...(rich.source ? { from: rich.source } : {})}
          {...(desc ? { desc } : {})}
          {...(/^https?:\/\//i.test(url) ? { onOpen: () => { openLink(url) } } : {})}
        />
      )
    case 'music': {
      const safeThumb = cspSafeSrc(rich.thumb)
      const link = /^https?:\/\//i.test(url)
      return (
        <div className={css.msgMusicCard}
          title={link ? '点击打开' : undefined}
          {...(link ? clickableKey(() => { openLink(url) }, { role: 'link', label: '打开音乐' }) : {})}>
          <span className={css.msgMusicCover} data-empty={!safeThumb || undefined}>
            {safeThumb
              ? <img src={safeThumb} alt="" loading="lazy" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
              : <span aria-hidden="true">🎵</span>}
          </span>
          <span className={css.msgMusicBody}>
            <span className={css.msgMusicTitle} title={title}>{title || '音乐'}</span>
            {desc && <span className={css.msgMusicArtist} title={desc}>{desc}</span>}
            {rich.source && <span className={css.msgMusicFrom}>{rich.source}</span>}
          </span>
          <CardFoot label="音乐" />
        </div>
      )
    }
    case 'link': {
      const cardUrl = url || (title.match(/https?:\/\/[^\s<>"']+/) ?? [])[0]?.replace(/[。，；、！？）)】…]+$/, '') || ''
      // 公众号推送（后端识别出 `<mmreader>`）走大图卡 + 次条，其余链接仍是紧凑链接卡
      if (rich.mpNews === true) return <MpNewsCard rich={rich} title={title} url={cardUrl} />
      return <LinkCard rich={rich} title={title || '链接'} desc={desc} url={cardUrl} />
    }
    default: {
      // appmsg 兜底：有 url 走链接卡，没 url 就只显示标题文本，绝不画带假链接的卡片。
      const cardUrl = url
        || (title.match(/https?:\/\/[^\s<>"']+/) ?? [])[0]?.replace(/[。，；、！？）)】…]+$/, '')
        || ''
      if (/^https?:\/\//i.test(cardUrl)) return <LinkCard rich={rich} title={title || '链接'} desc={desc} url={cardUrl} />
      return (
        <div className={css.msgAppmsgCard}>
          <span className={css.msgAppmsgIcon} aria-hidden="true">💬</span>
          <span className={css.msgAppmsgBody}>
            <span className={css.msgAppmsgTitle} title={title}>{title || fallback || '[应用消息]'}</span>
            {desc && <span className={css.msgAppmsgDesc} title={desc}>{desc}</span>}
          </span>
        </div>
      )
    }
  }
}

/**
 * Render one message body by its canonical `renderType`.
 *
 * **只按 `renderType` 分派**（后端 `classifyRender` 的单一答案），不再
 * 「先看 local_type、再看 rich.type、再看白名单」三段判断 —— 后者每漏一个
 * 子类型就退化成通用链接卡（接龙/笔记/卡片/表情都掉过）。
 * `renderKindOf(m)`（`utils/message-items.ts`）只为渲染缓存里的旧消息兜底。
 * @param props - the message + render callbacks.
 * @returns the message body element.
 */
function MessageBody({ m, selfName, onOpenImage, onOpenChatlog }: {
  m: WechatMessage
  selfName: string
  onOpenImage?: (m: WechatMessage) => void
  onOpenChatlog?: (rich: MessageRich) => void
}): React.JSX.Element {
  const kind = renderKindOf(m)
  const text = m.displayText || ''
  const rich = m.rich

  // 系统/撤回：居中系统行（带子类型样式），不是气泡。
  if (kind === 'system' || kind === 'revoke') return <MessageSystem m={m} />
  if (kind === 'pat') return <div className={css.msgSystem} data-kind="pat">{text || '[拍一拍]'}</div>
  // 11000：内容为空、status=2 的占位行（本机 13 条）。画空气泡或空白都很难看，
  // 给一行极淡的说明，让「这里有一条记录但没内容」这件事可见。
  if (kind === 'empty') {
    return <div className={css.msgSystem} data-kind="empty"><span className={css.msgSystemText}>（无内容的消息记录）</span></div>
  }

  if (kind === 'text') {
    return (
      <div className={css.msgBubble}>
        <MessageText text={text} atUsers={m.atUsers} onOpenLink={openLink} />
      </div>
    )
  }
  if (kind === 'image') {
    return <MessageImage m={m} selfName={selfName} {...(onOpenImage ? { onOpen: onOpenImage } : {})} />
  }
  if (kind === 'voice') return <MessageVoice m={m} selfName={selfName} />
  if (kind === 'video') return <MessageVideo m={m} selfName={selfName} />
  if (kind === 'location') {
    // 位置消息可能没有 rich（老的 render cache），此时退回纯文本展示。
    if (!rich || rich.type !== 'location') return <div className={css.msgBubble}><MessageText text={text || '[位置]'} onOpenLink={openLink} /></div>
    return <MessageLocation m={m} />
  }
  if (kind === 'contactCard') return <MessageContact m={m} />
  if (kind === 'voip') return <MessageCall m={m} />
  if (kind === 'emoji') {
    const md5 = rich?.md5 || rich?.title || ''
    if (md5) return <MessageEmoticon md5={md5} label={text || undefined} emojiUrl={typeof rich?.emojiUrl === 'string' ? rich.emojiUrl : undefined} />
    return (
      <div className={css.msgBubble}>
        <span className={css.msgEmojiChip} title="自定义表情">😊 [表情]</span>
      </div>
    )
  }

  // 卡片型：rich 存在时走 RichCard；rich 缺失（旧缓存 / 极端兜底）时给可读文本。
  if (rich && (CARD_KINDS.has(kind) || rich.type !== undefined)) {
    return (
      <RichCard rich={rich} fallback={text} self={m.isSender === 1}
        createTime={m.createTime}
        {...(onOpenChatlog ? { onOpenChatlog } : {})}
        {...(m.serverId ? { serverId: m.serverId } : {})} />
    )
  }
  if (kind === 'link') {
    const urlMatch = text.match(/https?:\/\/[^\s<>"']+/)
    const url = urlMatch ? urlMatch[0].replace(/[。，；、！？）)】…]+$/, '') : ''
    return <LinkCard rich={{ type: 'link', title: text }} title={text || '链接'} desc="" url={url} />
  }
  return <div className={css.msgBubble}><span className={kitCss.textMeta}>{text || `[类型 ${m.type}]`}</span></div>
}
/**
 * Render the chats panel.
 * @returns the chats element tree.
 */
/** Which session view to show: all chats, official accounts, service accounts, or kefu. */
export type ChatView = 'chats' | 'bizchats' | 'servicechats' | 'kefu'

/** External navigation target: open a session and (optionally) locate a message. */
export interface ChatTarget {
  username: string
  localId?: number
  /** Monotonic nonce so the same session can be re-targeted. */
  nonce: number
}

/** Enterprise-WeChat conversation detection (@openim / @weclaw / kefu). */
export function isEnterpriseChat(u: string): boolean {
  const s = (u || '').toLowerCase()
  return s.endsWith('@openim') || s.endsWith('@weclaw')
    || s.includes('@kefu') || s.includes('openim') && (s.includes('chatroom') || s.includes('@'))
}

/** Kefu session detection：真实企业微信/品牌客服会话（不含占位 holder 与 @openim 企业微信用户）。 */
function isKefuSession(u: string): boolean {
  const s = (u || '').toLowerCase()
  return s.includes('@weclaw') || s.includes('@kefu.openim') || s.includes('opencustomerservicemsg')
}

/**
 * 会话是否属于某个分类视图。
 *
 * **列表过滤与「打开中的会话是否仍属当前类目」必须共用本判据** ——
 * 否则列表已经换成「客服」类目、右侧却还留着某个公众号的聊天，
 * 就是「别人的信息出现在这个界面」。三个公众号类目互斥且都排除客服。
 * @param s - the session.
 * @param view - current category view.
 * @returns whether the session belongs to the view.
 */
function sessionInView(s: WechatSession, view: ChatView): boolean {
  if (view === 'bizchats') {
    return s.username.startsWith('gh_') && s.accountKind !== 'service' && !isKefuSession(s.username)
  }
  if (view === 'servicechats') {
    return s.username.startsWith('gh_') && s.accountKind === 'service' && !isKefuSession(s.username)
  }
  if (view === 'kefu') return isKefuSession(s.username)
  return true
}

const POLL_VISIBLE_MS = 1000
const POLL_HIDDEN_MS = 5000

/**
 * Render the chats panel.
 * @param props - optional view filter for subscription tabs and an external
 *   navigation target (records/privacy/ask jump into a session + message).
 * @returns the chats element tree.
 */
export function ChatsPanel({ initialView = 'chats', initialTarget }: { initialView?: ChatView; initialTarget?: ChatTarget | null }): React.JSX.Element {
  const [view, setView] = useState<ChatView>(() => initialView)

  const [sessions, setSessions] = useState<readonly WechatSession[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [curSession, setCurSession] = useState<WechatSession | null>(null)
  const [messages, setMessages] = useState<readonly WechatMessage[]>([])
  const [msgLoading, setMsgLoading] = useState(false)
  const [msgError, setMsgError] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [cursor, setCursor] = useState(0)
  /**
   * 复合游标的第二段（上一页最后一行的 local_id）。
   * 只回传 cursor（sort_seq）会在 sort_seq 重复的分页边界上丢消息，
   * 两个值必须成对传回后端。
   */
  const [cursorLocalId, setCursorLocalId] = useState<number | undefined>(undefined)
  /** Real-time polling toggle (persisted). */
  const [realtime, setRealtime] = useState<boolean>(() => {
    try { return localStorage.getItem('wc_realtime') !== '0' } catch { return true }
  })
  /** 头部「更多」溢出菜单（导出/已编辑/清空草稿）。 */
  const [moreOpen, setMoreOpen] = useState(false)
  /** Highest sort_seq already loaded; the incremental-poll watermark. */
  const watermarkRef = useRef(0)
  const inFlightRef = useRef(false)
  /**
   * 会话归属令牌 —— 用于挡住「上一个会话的在途取数」写进当前会话。
   *
   * `curSession` 与 `messages` 是两份独立 state，切会话时必然有一段
   * 「curSession 已换、messages 还是上一个人」的窗口。首次/翻页/轮询/对账
   * 都是异步的：如果回来时不校验归属就 setMessages，上一个人的消息就会
   * 出现在当前会话里，并且会被写进**上一个会话的渲染缓存**（`chat-msgs:<talker>`），
   * 于是重开那个会话也还是错的 —— 这是「别人的消息出现在这个聊天界面」的根因。
   *
   * 约定：任何异步取数在**提交 state 之前**必须调用 `sessionAlive(epoch, talker)`；
   * 追加/替换型更新还要在 updater 内部再判一次（updater 可能在切会话之后才被 React 执行）。
   */
  const sessionEpochRef = useRef(0)
  /** 当前 `messages` 所属的 talker；与 sessionEpochRef 同步更新。 */
  const messagesTalkerRef = useRef<string | null>(null)
  const sessionsReloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** ── 会话级 AI 面板（「新对话」）──
   *  入口在聊天头部；面板作为第三栏并排。读取范围**恒为当前会话**，线程按会话隔离。 */
  const [aiOpen, setAiOpen] = useState(false)
  const [aiFull, setAiFull] = useState(false)
  const [pollStatus, setPollStatus] = useState<string>('')
  /** Logged-in account wxid (from the messages snapshot) for own avatars. */
  const [selfWxid, setSelfWxid] = useState('')
  const [typeStats, setTypeStats] = useState<readonly { type: number; label: string; count: number }[]>([])
  const msgEndRef = useRef<HTMLDivElement>(null)
  const [viewer, setViewer] = useState<{ images: ViewerImage[]; index: number } | null>(null)
  const [pinnedCollapsed, setPinnedCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem('wc_pinned_collapsed') === '1' } catch { return false }
  })
  const [batchMode, setBatchMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [batchExporting, setBatchExporting] = useState(false)
  const [batchMsg, setBatchMsg] = useState<string | null>(null)
  const [, setAvatarVersion] = useState(0)

  const setWatermarkFrom = (list: readonly WechatMessage[]): void => {
    let w = watermarkRef.current
    for (const m of list) if (m.sortSeq && m.sortSeq > w) w = m.sortSeq
    watermarkRef.current = w
  }

  /**
   * 开始一个会话：令牌自增（作废所有在途请求）并声明 `messages` 将归属该 talker。
   * @param talker - 会话 username。
   * @returns 本次令牌，供后续 `sessionAlive` 校验。
   */
  const beginSession = (talker: string): number => {
    sessionEpochRef.current += 1
    messagesTalkerRef.current = talker
    // 上一个会话的在途轮询已被令牌作废，这里放开闸门让新会话立刻可以轮询。
    inFlightRef.current = false
    return sessionEpochRef.current
  }

  /**
   * 在途结果是否仍属于本次会话。
   * @param epoch - 发起请求时拿到的令牌。
   * @param talker - 发起请求时的会话 username。
   * @returns 令牌未变且 talker 未被切走时为 true。
   */
  const sessionAlive = (epoch: number, talker: string): boolean => (
    sessionEpochRef.current === epoch && messagesTalkerRef.current === talker
  )

  /**
   * 关闭当前会话并把归属令牌作废。
   *
   * 用于切换分类视图（公众号/服务号/客服）时：那三个类目互斥，
   * 列表换类目后右侧绝不能留着上一类目的会话 —— 否则会在「客服」视图里
   * 看到某个公众号的聊天，就是「别人的信息出现在这个界面」。
   *
   * 只清理本函数之前声明的 state；依赖于会话的浮层（聊天记录弹窗、右键菜单）
   * 由调用方 changeView 一并收起。
   */
  const closeCurrentSession = useCallback((): void => {
    sessionEpochRef.current += 1
    messagesTalkerRef.current = null
    inFlightRef.current = false
    watermarkRef.current = 0
    setCurSession(null)
    setMessages([])
    setHasMore(false)
    setCursor(0)
    setCursorLocalId(undefined)
    setTypeStats([])
    setMsgError(null)
    setMsgLoading(false)
    setSelfWxid('')
    setPollStatus('')
    setViewer(null)
  }, [])

  const toggleSelect = (username: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(username)) next.delete(username)
      else next.add(username)
      return next
    })
  }

  const exportBatch = useCallback(async (): Promise<void> => {
    const list = [...selected]
    if (list.length === 0) return
    setBatchExporting(true)
    setBatchMsg(null)
    let done = 0
    const errors: string[] = []
    try {
      for (const username of list) {
        try {
          await apiExportSessionMessages({ username, format: 'txt', count: 0 })
          done += 1
        } catch (e) {
          errors.push(username + ': ' + (e as Error).message)
        }
      }
      setBatchMsg(`已导出 ${done}/${list.length} 个会话${errors.length ? `，失败 ${errors.length} 个` : ''}`)
    } finally {
      setBatchExporting(false)
    }
  }, [selected])

  const togglePinned = (): void => {
    setPinnedCollapsed((v) => {
      const nv = !v
      try { localStorage.setItem('wc_pinned_collapsed', nv ? '1' : '0') } catch { /* ignore */ }
      return nv
    })
  }

  /** Open the lightbox at a message image (strip = all type-3 messages loaded). */
  const openViewer = useCallback((m: WechatMessage): void => {
    const imgs: ViewerImage[] = messages
      .filter(x => x.type === 3)
      .map(x => ({ username: curSession?.username ?? '', localId: x.localId }))
    if (imgs.length === 0) return
    const idx = imgs.findIndex(x => x.localId === m.localId)
    setViewer({ images: imgs, index: idx >= 0 ? idx : 0 })
  }, [messages, curSession])

  const [exporting, setExporting] = useState(false)
  const [exportMsg, setExportMsg] = useState<string | null>(null)
  // export dialog state
  const [exportOpen, setExportOpen] = useState(false)
  const [expFormat, setExpFormat] = useState<'txt' | 'html' | 'md' | 'excel' | 'csv' | 'sql' | 'json'>('txt')
  const [expCount, setExpCount] = useState(0)
  const [expDir, setExpDir] = useState('')
  const [expTypes, setExpTypes] = useState<readonly string[]>([])
  const [expFrom, setExpFrom] = useState('')
  const [expTo, setExpTo] = useState('')
  const [expFilename, setExpFilename] = useState('')
  const [expZip, setExpZip] = useState(false)
  const [pickingDir, setPickingDir] = useState(false)

  const EXPO_FORMATS: ReadonlyArray<{ value: string; label: string }> = [
    { value: 'txt', label: 'TXT' }, { value: 'html', label: 'HTML' }, { value: 'md', label: 'Markdown' },
    { value: 'excel', label: 'Excel' }, { value: 'sql', label: 'SQL' }, { value: 'json', label: 'JSON' },
  ]
  const EXPO_TYPES: ReadonlyArray<{ key: string; label: string; types?: readonly number[]; rich?: readonly string[] }> = [
    { key: 'text', label: '文本', types: [1] },
    { key: 'image', label: '图片', types: [3] },
    { key: 'emoji', label: '表情', types: [47] },
    { key: 'video', label: '视频', types: [43] },
    { key: 'voice', label: '语音', types: [34] },
    { key: 'chatlog', label: '聊天记录', rich: ['chatlog'] },
    { key: 'transfer', label: '转账', rich: ['transfer'] },
    { key: 'redpacket', label: '红包', rich: ['redpacket'] },
    { key: 'file', label: '文件', rich: ['file'] },
    { key: 'link', label: '链接', rich: ['link'] },
    { key: 'quote', label: '引用', rich: ['quote'] },
    { key: 'system', label: '系统', types: [10000, 10002] },
    { key: 'call', label: '通话', types: [50] },
  ]

  const exportSession = useCallback(async (): Promise<void> => {
    if (!curSession || exporting) return
    setExporting(true)
    setExportMsg(null)
    try {
      const chosen = EXPO_TYPES.filter(c => expTypes.includes(c.key))
      const types = chosen.flatMap(c => [...(c.types ?? [])])
      const richTypes = chosen.flatMap(c => [...(c.rich ?? [])])
      const fromSec = expFrom ? Math.floor(new Date(expFrom + 'T00:00:00').getTime() / 1000) : 0
      const toSec = expTo ? Math.floor(new Date(expTo + 'T23:59:59').getTime() / 1000) : 0
      const opts: {
        username: string
        format: string
        count: number
        dir?: string
        types?: number[]
        richTypes?: string[]
        from?: number
        to?: number
        filename?: string
        zip?: boolean
      } = {
        username: curSession.username,
        format: expFormat,
        count: expCount,
      }
      if (expDir.trim()) opts.dir = expDir.trim()
      if (types.length > 0) opts.types = types
      if (richTypes.length > 0) opts.richTypes = richTypes
      if (fromSec > 0) opts.from = fromSec
      if (toSec > 0) opts.to = toSec
      if (expFilename.trim()) opts.filename = expFilename.trim()
      if (expZip) opts.zip = true
      const r = await apiExportSessionMessages(opts)
      setExportMsg(`已导出 ${r.count} 条 → ${r.path}`)
      setExportOpen(false)
    } catch (e) {
      setExportMsg('导出失败: ' + (e as Error).message)
    } finally {
      setExporting(false)
    }
  }, [curSession, exporting, expFormat, expCount, expDir, expTypes, expFrom, expTo, expFilename, expZip])

  const chooseExportDir = async (): Promise<void> => {
    if (pickingDir) return
    setPickingDir(true)
    try {
      const dir = await pickDirectory()
      if (dir) setExpDir(dir)
    } finally {
      setPickingDir(false)
    }
  }

  const openNestedChatlog = async (rec: ChatlogRecord): Promise<void> => {
    if (rec.nested && rec.nested.length > 0) {
      setChatlogStack(prev => [...prev, { title: rec.datatitle || rec.text || '聊天记录', records: rec.nested ?? [] }])
      return
    }
    if (rec.fromnewmsgid && !chatlogResolving) {
      setChatlogResolving(true)
      try {
        const r = await apiResolveChatHistory(rec.fromnewmsgid)
        const rich = r.found ? r.message?.rich : null
        if (r.found && rich && Array.isArray(rich.records) && rich.records.length > 0) {
          setChatlogStack(prev => [...prev, { title: rich.title || '聊天记录', records: rich.records ?? [] }])
        } else {
          window.alert('未找到该聊天记录（可能需要微信端完整同步）')
        }
      } catch (e) {
        window.alert('解析聊天记录失败: ' + (e as Error).message)
      } finally {
        setChatlogResolving(false)
      }
    }
  }

  // ── message edit (C5) ──
  const [editedOpen, setEditedOpen] = useState(false)
  const [edits, setEdits] = useState<readonly EditedMessageRecord[]>([])
  const [editedIds, setEditedIds] = useState<Set<number>>(new Set())
  const [editing, setEditing] = useState(false)
  /** 「编辑消息副本」对话框：目标消息 / 编辑中的文本 / 失败原因 / 保存中 */
  const [editTarget, setEditTarget] = useState<WechatMessage | null>(null)
  const [editText, setEditText] = useState('')
  const [editErr, setEditErr] = useState<string | null>(null)
  const [editBusy, setEditBusy] = useState(false)
  const editAreaRef = useRef<HTMLTextAreaElement | null>(null)

  // 打开即把光标放进编辑框并全选原文（Radix 默认聚焦标题栏的关闭按钮）。
  useEffect(() => {
    if (!editTarget) return undefined
    const t = window.setTimeout(() => { editAreaRef.current?.focus(); editAreaRef.current?.select() }, 60)
    return () => { window.clearTimeout(t) }
  }, [editTarget])

  const loadEdits = useCallback(async (): Promise<void> => {
    try {
      const r = await apiListEditedMessages(curSession ? { sessionId: curSession.username } : undefined)
      setEdits(r.items)
      setEditedIds(new Set(r.items.map(it => it.localId)))
    } catch { setEdits([]); setEditedIds(new Set()) }
  }, [curSession])

  const openEdits = useCallback(async (): Promise<void> => {
    setEditedOpen(v => !v)
    if (!editedOpen) await loadEdits()
  }, [editedOpen, loadEdits])

  const reloadCurrent = useCallback(async (): Promise<void> => {
    if (!curSession) return
    // 记下发起时的归属：编辑后刷新期间用户可能已经切走，回来必须校验。
    const talker = curSession.username
    const epoch = sessionEpochRef.current
    try {
      const cached = readRenderCache<WechatMessage[]>('chat-msgs:' + talker)
      if (!sessionAlive(epoch, talker)) return
      if (cached && cached.length > 0) {
        setMessages(cached)
        setHasMore(true)
      }
      const env = await apiGetMessages({ talker, limit: 100 })
      if (!sessionAlive(epoch, talker)) return
      setMessages(env.messages)
      setWatermarkFrom(env.messages)
      setSelfWxid(env.selfWxid ?? '')
      setHasMore(env.hasMore ?? false)
      setCursor(env.cursor ?? 0)
      setCursorLocalId(env.cursorLocalId)
      setTypeStats(env.typeStats ?? [])
      writeRenderCache('chat-msgs:' + talker, env.messages)
    } catch { /* keep current view */ }
  }, [curSession])

  /**
   * 打开「编辑消息副本」对话框。
   *
   * 原实现用 `window.prompt(...)` 取新内容 —— **Electron 渲染进程不支持 prompt**
   * （调用即抛 `prompt() is not supported.`），于是右键菜单点「编辑消息副本」除了在
   * 控制台留一条报错外什么都不发生（用户反馈「为什么还不能编辑信息」）。
   * 改成应用内对话框：可多行、能显示保存失败的原文、Esc/取消可退。
   */
  const doEdit = useCallback((m: WechatMessage): void => {
    setEditTarget(m)
    setEditText(m.displayText || m.strContent || '')
    setEditErr(null)
  }, [])

  const closeEdit = useCallback((): void => {
    setEditTarget(null)
    setEditErr(null)
  }, [])

  const saveEdit = useCallback(async (): Promise<void> => {
    const m = editTarget
    if (!m || !curSession) return
    setEditBusy(true)
    setEditErr(null)
    try {
      const r = await apiEditChatMessage({ username: curSession.username, localId: m.localId, content: editText })
      if (!r.ok) { setEditErr(r.error ?? '未知错误'); return }
      setEditTarget(null)
      await reloadCurrent()
      await loadEdits()
    } catch (e) {
      setEditErr((e as Error).message)
    } finally {
      setEditBusy(false)
    }
  }, [editTarget, editText, curSession, reloadCurrent, loadEdits])

  const sessionListRef = useRef<HTMLDivElement | null>(null)
  const sessionsPager = usePagedList<WechatSession>({
    pageSize: 120,
    fetchPage: async (offset, limit) => {
      const env = await apiGetSessions({ limit, offset })
      return { items: env.sessions, total: env.total }
    },
  })

  const reloadSessionsList = useCallback((): void => {
    sessionsPager.reset()
  }, [sessionsPager.reset])

  /** Coalesce host-push session refreshes; user actions still refresh inline. */
  const queueReloadSessions = useCallback((): void => {
    if (sessionsReloadTimerRef.current !== null) clearTimeout(sessionsReloadTimerRef.current)
    sessionsReloadTimerRef.current = setTimeout(() => { reloadSessionsList() }, 500)
  }, [reloadSessionsList])

  /** Clear the current session's draft (only the local decrypted copy). */
  const clearDraft = useCallback(async (): Promise<void> => {
    if (!curSession || !curSession.draft) return
    if (!window.confirm('清空「' + (curSession.displayName || curSession.username) + '」的草稿？')) return
    try {
      const r = await apiClearSessionDraft({ username: curSession.username })
      if (r.ok) reloadSessionsList()
    } catch { /* keep view */ }
  }, [curSession, reloadSessionsList])

  const clearAllDrafts = useCallback(async (): Promise<void> => {
    if (!window.confirm('清空所有会话草稿（仅本地解密副本）？')) return
    try {
      const r = await apiClearAllSessionDrafts()
      window.alert(`已清空 ${r.count} 条草稿`)
      reloadSessionsList()
    } catch (e) {
      window.alert('清空失败: ' + (e as Error).message)
    }
  }, [reloadSessionsList])

  const copyMsgJson = useCallback((m: WechatMessage): void => {
    try {
      const json = JSON.stringify({
        localId: m.localId,
        type: m.type,
        isSender: m.isSender,
        createTime: m.createTime,
        displayText: m.displayText,
        typeLabel: m.typeLabel,
        sender: m.sender ?? undefined,
        rich: m.rich ?? undefined,
      }, null, 2)
      void navigator.clipboard.writeText(json).then(() => { window.alert('消息 JSON 已复制') }).catch(() => { window.alert('复制失败') })
    } catch { window.alert('复制失败') }
  }, [])

  const doReset = useCallback(async (rec: EditedMessageRecord): Promise<void> => {
    if (!curSession) return
    if (!window.confirm('恢复该消息为原始内容？')) return
    setEditing(true)
    try {
      const r = await apiResetEditedMessage({ username: rec.sessionId, localId: rec.localId })
      if (!r.ok) window.alert('恢复失败: ' + (r.error ?? ''))
      else { await reloadCurrent(); await loadEdits() }
    } catch (e) {
      window.alert('恢复失败: ' + (e as Error).message)
    } finally {
      setEditing(false)
    }
  }, [curSession, reloadCurrent, loadEdits])

  // ── message search (A7) ──
  const [searchMode, setSearchMode] = useState<'session' | 'message'>('session')
  const [msgHits, setMsgHits] = useState<readonly SearchHit[]>([])
  const [msgSearchLoading, setMsgSearchLoading] = useState(false)
  const [msgSearchError, setMsgSearchError] = useState<string | null>(null)
  const [msgSearched, setMsgSearched] = useState(false)
  const [msgIndexed, setMsgIndexed] = useState(true)
  const [indexBuilding, setIndexBuilding] = useState(false)
  const msgSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const msgSearchSeqRef = useRef(0)

  // ── group chat info panel (群聊信息) ──
  const [groupInfoOpen, setGroupInfoOpen] = useState(false)
  const [groupInfo, setGroupInfo] = useState<GroupInfo | null>(null)
  const [groupInfoLoading, setGroupInfoLoading] = useState(false)
  const [groupInfoErr, setGroupInfoErr] = useState<string | null>(null)
  const [memberSearch, setMemberSearch] = useState('')
  const [memberExpanded, setMemberExpanded] = useState(false)
  /**
   * 群公告展开态。公告是自由文本（实测样本 5 行）。
   * 原先 `.groupInfoValue` 用 -webkit-line-clamp:3 **静默**截断且没有展开入口 ——
   * 用户不知道内容被吃掉了（审计 P1-5）。这里给可展开的行内开关。
   */
  const [annExpanded, setAnnExpanded] = useState(false)
  const [annCanExpand, setAnnCanExpand] = useState(false)
  const annRef = useRef<HTMLDivElement | null>(null)
  const groupInfoTitleId = useId()
  const [profileMember, setProfileMember] = useState<GroupMember | null>(null)
  const [profilePos, setProfilePos] = useState<{ left: number; top: number } | null>(null)
  const [chatlogStack, setChatlogStack] = useState<Array<{ title: string; records: ChatlogRecord[] }>>([])
  const [chatlogResolving, setChatlogResolving] = useState(false)
  const chatlogOpen = chatlogStack.length > 0 ? chatlogStack[chatlogStack.length - 1] : null
  const profileHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const showMemberProfile = (m: GroupMember, el: HTMLElement): void => {
    if (profileHideTimer.current) clearTimeout(profileHideTimer.current)
    setProfileMember(m)
    const rect = el.getBoundingClientRect()
    const width = 232
    const left = rect.left - width - 10 >= 8 ? rect.left - width - 10 : rect.right + 10
    const top = Math.max(8, Math.min(rect.top, window.innerHeight - 170))
    setProfilePos({ left, top })
  }

  const hideMemberProfile = (): void => {
    if (profileHideTimer.current) clearTimeout(profileHideTimer.current)
    profileHideTimer.current = setTimeout(() => {
      setProfileMember(null)
      setProfilePos(null)
    }, 150)
  }
  const buildIndex = useCallback(async (silent = false): Promise<void> => {
    setIndexBuilding(true)
    try {
      const r = await apiBuildSearchIndex({ force: false })
      setMsgIndexed(true)
      // r.message 只在「跳过不可读分片」时出现：索引残缺必须让用户看见
      if (!silent) {
        setMsgSearchError(r.message
          ? `搜索索引已就绪（${r.rows ?? 0} 条，但${r.message}）`
          : `搜索索引已就绪（${r.rows ?? 0} 条）`)
      }
    } catch (e) {
      if (!silent) setMsgSearchError('索引构建失败: ' + (e as Error).message)
    } finally {
      setIndexBuilding(false)
    }
  }, [])

  const checkIndexStatus = useCallback(async (): Promise<void> => {
    try {
      const st = await apiGetSearchIndexStatus()
      setMsgIndexed(st.exists && st.rows > 0)
    } catch { /* keep default */ }
  }, [])

  const onSearchInput = useCallback((q: string): void => {
    if (msgSearchTimer.current) clearTimeout(msgSearchTimer.current)
    const term = q.trim()
    if (term.length < 1) {
      msgSearchSeqRef.current += 1
      setMsgHits([])
      setMsgSearched(false)
      setMsgSearchError(null)
      return
    }
    const seq = ++msgSearchSeqRef.current
    if (!msgIndexed && !indexBuilding) void buildIndex(true)
    msgSearchTimer.current = setTimeout(async () => {
      setMsgSearchLoading(true)
      setMsgSearchError(null)
      try {
        const r = await apiSearchMessages({ query: term, limit: 200 })
        if (seq !== msgSearchSeqRef.current) return
        setMsgHits(r.hits)
        setMsgIndexed(r.indexed)
        setMsgSearched(true)
      } catch (e) {
        if (seq !== msgSearchSeqRef.current) return
        setMsgSearchError((e as Error).message)
        setMsgHits([])
      } finally {
        if (seq === msgSearchSeqRef.current) setMsgSearchLoading(false)
      }
    }, 350)
  }, [msgIndexed, indexBuilding, buildIndex])

  // ── message calendar (A8) ──
  const [calOpen, setCalOpen] = useState(false)
  // 手写覆盖层的 Esc 关闭（kit 的 Drawer/Dialog 由 Radix 提供；这几个是手写的）
  useEscapeToClose(exportOpen, () => { setExportOpen(false) })
  useEscapeToClose(chatlogStack.length > 0, () => { setChatlogStack([]) })
  useEscapeToClose(calOpen, () => { setCalOpen(false) })
  useEscapeToClose(editedOpen, () => { setEditedOpen(false) })
  // 焦点管理：进入移入、Tab 循环、关闭还原（手写弹窗没有 Radix 的那套）
  useDialogFocus(exportOpen, '[data-st-dialog="chats-export"]')
  useDialogFocus(chatlogStack.length > 0, '[data-st-dialog="chats-chatlog"]')
  useDialogFocus(calOpen, '[data-st-dialog="chats-cal"]')
  useDialogFocus(editedOpen, '[data-st-dialog="chats-edited"]')
  const [calYear, setCalYear] = useState(new Date().getFullYear())
  const [calMonth, setCalMonth] = useState(new Date().getMonth() + 1)
  const [calCounts, setCalCounts] = useState<Record<string, number>>({})
  const [calLoading, setCalLoading] = useState(false)

  const calTotal = useMemo(() => Object.values(calCounts).reduce((a, b) => a + b, 0), [calCounts])
  const calActiveDays = useMemo(() => Object.values(calCounts).filter(n => n > 0).length, [calCounts])
  const calAvg = useMemo(() => (calActiveDays > 0 ? Math.round(calTotal / calActiveDays) : 0), [calTotal, calActiveDays])
  const calTop = useMemo(() => {
    let best = 0
    let bestDay = 0
    for (const [k, v] of Object.entries(calCounts)) {
      const d = Number(k)
      if (Number.isFinite(d) && v > best) { best = v; bestDay = d }
    }
    return best > 0 ? { day: bestDay, count: best } : null
  }, [calCounts])
  const calFirstDow = useMemo(() => {
    const dow = new Date(calYear, calMonth - 1, 1).getDay()
    return dow === 0 ? 6 : dow - 1
  }, [calYear, calMonth])
  const calDays = useMemo(() => new Date(calYear, calMonth, 0).getDate(), [calYear, calMonth])
  const calHeat = (cnt: number): string => {
    if (cnt <= 0) return 'transparent'
    const alpha = Math.min(0.15 + cnt / 200, 0.85)
    return 'rgba(34, 211, 238, ' + alpha.toFixed(3) + ')'
  }

  const openCalendar = useCallback(async (): Promise<void> => {
    if (!curSession) return
    setCalOpen(true)
    setCalLoading(true)
    setCalCounts({})
    try {
      const r = await apiGetDailyCounts({ username: curSession.username, year: calYear, month: calMonth })
      setCalCounts(r.counts)
    } catch (e) {
      setMsgError((e as Error).message)
    } finally {
      setCalLoading(false)
    }
  }, [curSession, calYear, calMonth])

  const switchCalMonth = useCallback(async (delta: number): Promise<void> => {
    let m = calMonth + delta
    let y = calYear
    if (m < 1) { m = 12; y -= 1 }
    if (m > 12) { m = 1; y += 1 }
    setCalMonth(m)
    setCalYear(y)
    if (!curSession) return
    setCalLoading(true)
    setCalCounts({})
    try {
      const r = await apiGetDailyCounts({ username: curSession.username, year: y, month: m })
      setCalCounts(r.counts)
    } catch (e) {
      setMsgError((e as Error).message)
    } finally {
      setCalLoading(false)
    }
  }, [curSession, calMonth, calYear])

  const jumpToDay = useCallback((day: number): void => {
    const startTs = Math.floor(new Date(calYear, calMonth - 1, day, 0, 0, 0, 0).getTime() / 1000)
    setCalOpen(false)
    if (curSession) void openSessionAndLocate(curSession.username, undefined, startTs)
  }, [calYear, calMonth, curSession, calOpen])

  const sessionSearch = searchMode === 'session' ? search : ''
  const sessionSearching = sessionSearch.trim() !== ''
  // 普通会话列表：分页逐页加载；会话搜索时一次性拉满 500 条（用户主动操作），保证搜索结果完整。
  useEffect(() => {
    setError(null)
    if (sessionSearching) {
      let cancelled = false
      setLoading(true)
      void apiGetSessions({ keyword: sessionSearch.trim(), limit: 500 })
        .then((env) => {
          if (cancelled) return
          setSessions(env.sessions)
        })
        .catch((e: unknown) => { if (!cancelled) setError((e as Error).message) })
        .finally(() => { if (!cancelled) setLoading(false) })
      return () => { cancelled = true }
    }
    sessionsPager.reset()
    return undefined
  }, [sessionSearching, sessionSearch, sessionsPager.reset])

  useEffect(() => {
    if (sessionSearching) return
    setSessions(sessionsPager.items)
    setLoading(sessionsPager.loading)
    setError(sessionsPager.error)
  }, [sessionSearching, sessionsPager.items, sessionsPager.loading, sessionsPager.error])

  const sessionsLoadMoreRef = useLazySentinel(() => { if (sessionsPager.hasMore && !sessionsPager.loadingMore) sessionsPager.loadMore() }, '600px 0px', () => sessionListRef.current)

  // 搜索索引状态只在用户切到「消息搜索」时检查，进入页签不再触发。
  useEffect(() => { if (searchMode === 'message') void checkIndexStatus() }, [searchMode, checkIndexStatus])
  // 已编辑消息列表仅在打开某个会话时按需加载，避免进入页签就拉全量已编辑记录。
  // 会话内「已编辑」徽标仍会在进入会话后正常出现。
  useEffect(() => { if (curSession) void loadEdits() }, [curSession, loadEdits])

  // Batch-prefetch avatars for the visible session list + message senders so
  // Avatar components hit the module cache instead of one Remote per row.
  useEffect(() => {
    const keys = [
      ...sessions.map(s => s.username),
      ...messages.map(m => m.sender ?? ''),
      ...(curSession ? [curSession.username] : []),
    ]
    const uniq = [...new Set(keys.filter(Boolean))].filter(u => avatarCache.get(u) === undefined)
    if (uniq.length === 0) return
    const batch = uniq.slice(0, 60)
    void apiGetAvatarsLocal({ usernames: batch })
      .then((map) => {
        let changed = false
        for (const u of batch) {
          if (!avatarCache.has(u)) { cacheBounded(avatarCache, u, map[u] ?? null, AVATAR_CACHE_MAX); changed = true }
        }
        if (changed) setAvatarVersion(v => v + 1)
      })
      .catch(() => { /* individual Avatar fallback covers misses */ })
  }, [sessions, messages, curSession])

  const filtered = useMemo(() => {
    // subscription views filter by session kind first（判据与 sessionInView 同源）
    const base = view === 'chats' ? sessions : sessions.filter(s => sessionInView(s, view))
    const q = search.trim().toLowerCase()
    if (!q) return base
    return base.filter(s =>
      (s.displayName || s.username).toLowerCase().includes(q)
      || (s.summary || '').toLowerCase().includes(q))
  }, [sessions, search, view])

  const { pinnedList, normalList } = useMemo(() => {
    const pinned: WechatSession[] = []
    const normal: WechatSession[] = []
    for (const s2 of filtered) {
      if (s2.pinned) pinned.push(s2)
      else normal.push(s2)
    }
    return { pinnedList: pinned, normalList: normal }
  }, [filtered])

  const stats = useMemo(() => ({
    friends: sessions.filter(s => s.type === 'private').length,
    groups: sessions.filter(s => s.type === 'group').length,
    unread: sessions.reduce((a, s) => a + (s.unreadCount || 0), 0),
  }), [sessions])

  /**
   * AI 入口的可见性：单聊与群聊才有「这段聊天」的语义；
   * 公众号/服务号/客服是单向广播，问答没有意义，不给入口。
   */
  const aiEligible = curSession !== null && (curSession.type === 'private' || curSession.type === 'group')

  /**
   * AI 面板的读取范围：**就是当前打开的会话**。
   * 不给下拉选择——面板与右侧消息流是同一个会话，两者范围必须一致，
   * 否则会出现「看着 A 的聊天、问的却是 B」这种无法自证的错位。
   */
  const aiTarget = curSession

  const { count: sessCount, sentinelRef: sessSentinel } = useProgressiveList(normalList.length, 120)

  // 消息流渐进渲染：窗口从底部截取（最新消息永远可见），向上滚动越过哨兵
  // 时逐步展开更早的消息，长会话不再一次性渲染上千条 DOM。
  const { count: msgWinCount, sentinelRef: msgWinSentinel, reveal: revealMsgWindow } = useProgressiveList(messages.length, 120)

  /**
   * 当前 `messages` 是否确实属于正在显示的会话。
   *
   * `curSession` 与 `messages` 是两份 state，中间必然有一段不一致的窗口。
   * 与其只在各个异步回调里保证顺序，这里再加一道**结构性**断言：归属不符时
   * 一律不渲染消息列表（显示骨架），从根上杜绝「把上一个人的消息画在这个
   * 会话的标题下面」。`messagesTalkerRef` 与两份 state 在同一批次里更新，
   * 因此渲染时读到的值一定是自洽的。
   */
  const messagesMatchSession = curSession !== null && messagesTalkerRef.current === curSession.username

  /** Incremental poll: fetch messages newer than the watermark and append. */
  const pollNew = useCallback(async (): Promise<void> => {
    if (!curSession || inFlightRef.current) return
    const talker = curSession.username
    const epoch = sessionEpochRef.current
    const after = watermarkRef.current
    if (!after) return
    inFlightRef.current = true
    try {
      const env = await apiGetNewMessages({ talker, after, limit: 200 })
      // 切走之后到达的响应必须丢弃：否则会把上一个会话的新消息追加进当前会话，
      // 并且写进**上一个会话**的渲染缓存（缓存被污染后重开也还是错的）。
      if (!sessionAlive(epoch, talker)) return
      const fresh = env.messages
      setPollStatus(`✓ ${new Date().toLocaleTimeString()} · ${fresh.length} 条新消息`)
      if (fresh.length === 0) return
      setMessages((prev) => {
        if (!sessionAlive(epoch, talker)) return prev
        const key = (m: WechatMessage): string => `${m.localId}:${m.sortSeq ?? 0}`
        const seen = new Set(prev.map(m => key(m)))
        const add = fresh.filter(m => !seen.has(key(m)))
        if (add.length === 0) return prev
        setWatermarkFrom(add)
        // Keep the render cache current so a session reopen paints the same
        // newest messages before the authoritative fetch returns.
        const merged = [...prev, ...add]
        writeRenderCache('chat-msgs:' + talker, merged)
        return merged
      })
      // follow to the bottom only when the user is already near it
      requestAnimationFrame(() => {
        if (!sessionAlive(epoch, talker)) return
        const el = msgEndRef.current
        if (!el) return
        const rect = el.getBoundingClientRect()
        const vh = window.innerHeight || document.documentElement.clientHeight
        if (rect.top < vh && rect.bottom >= 0) el.scrollIntoView({ block: 'end' })
      })
    } catch (e) {
      if (sessionAlive(epoch, talker)) setPollStatus('✗ ' + ((e as Error).message || '轮询失败').slice(0, 60))
    } finally {
      inFlightRef.current = false
    }
  }, [curSession])

  /** 与快照最近窗口对账：撤回(10002)/删除等就地修改保留原 sort_seq，
   *  增量轮询按 sort_seq 水位看不到它们；宿主推送后拉一次最近 50 条，
   *  按 localId 用新行替换发生变化的行，界面与库保持一致（有界查询）。 */
  const reconcileRef = useRef(false)
  const reconcileRecent = useCallback(async (): Promise<void> => {
    if (!curSession || reconcileRef.current) return
    const talker = curSession.username
    const epoch = sessionEpochRef.current
    reconcileRef.current = true
    try {
      const env = await apiGetMessages({ talker, limit: 50 })
      // 对账按 localId 匹配，而 local_id 只在会话内唯一 —— 切走后拿另一个会话的
      // 行去替换当前会话的行，等于按编号把别人的消息安到这个会话上，必须丢弃。
      if (!sessionAlive(epoch, talker)) return
      const byId = new Map<number, WechatMessage>()
      for (const m of env.messages) byId.set(m.localId, m)
      if (byId.size === 0) return
      setMessages((prev) => {
        if (!sessionAlive(epoch, talker)) return prev
        const next = prev.map((m) => {
          const cur = byId.get(m.localId)
          if (cur && (cur.type !== m.type || (cur.sortSeq ?? 0) !== (m.sortSeq ?? 0))) return cur
          return m
        })
        const changed = next.some((m, i) => m !== prev[i])
        if (!changed) return prev
        writeRenderCache('chat-msgs:' + talker, next)
        return next
      })
    } catch { /* 保持当前视图，等待下一次推送对账 */ } finally {
      reconcileRef.current = false
    }
  }, [curSession])

  useEffect(() => {
    if (!curSession || !realtime) return
    let timer: ReturnType<typeof setInterval> | null = null
    const start = (): void => {
      if (timer !== null) clearInterval(timer)
      const ms = document.visibilityState === 'visible' ? POLL_VISIBLE_MS : POLL_HIDDEN_MS
      timer = setInterval(() => { void pollNew() }, ms)
    }
    start()
    const onVis = (): void => { void pollNew(); start() }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      if (timer !== null) clearInterval(timer)
    }
  }, [curSession, realtime, pollNew])

  // Close the group-info drawer and drop the in-chat search scope on session switch.
  useEffect(() => {
    setGroupInfoOpen(false)
    setGroupInfo(null)
    setGroupInfoErr(null)
    setMemberSearch('')
    setMemberExpanded(false)
    setProfileMember(null)
    setMoreOpen(false)
    setAnnExpanded(false)
    setAnnCanExpand(false)
  }, [curSession?.username])

  // 群公告是否被截断：只在折叠态量（展开后 clientHeight 变大，量了会把「展开」按钮吃掉）。
  useEffect(() => {
    if (!groupInfoOpen || !groupInfo || annExpanded) return
    const el = annRef.current
    if (!el) return
    setAnnCanExpand(el.scrollHeight > el.clientHeight + 1)
  }, [groupInfoOpen, groupInfo, annExpanded])

  // 抽屉是**手写覆盖层**，要自己接 Esc 与焦点管理：
  // 项目已有一套（kit 的 useEscapeToClose / useDialogFocus），其余四个手写弹窗都注册了，
  // 只有这个抽屉漏了 —— 实测 Esc 关不掉、Tab 会跑到抽屉背后的会话列表里（审计 P1-7）。
  useEscapeToClose(groupInfoOpen, () => { setGroupInfoOpen(false); setProfileMember(null) })
  useDialogFocus(groupInfoOpen, '[data-st-dialog="chats-groupinfo"]')

  // 「更多」菜单：Esc 关闭（与其他手写覆盖层共用同一套栈，只让最上层响应）
  useEscapeToClose(moreOpen, () => { setMoreOpen(false) })
  // 点菜单外部关闭。菜单没有遮罩，所以必须自己判 contains。
  useEffect(() => {
    if (!moreOpen) return
    const onDown = (e: MouseEvent): void => {
      const el = document.querySelector('[data-st-menu="msg-header-more"]')
      if (el && e.target instanceof Node && el.contains(e.target)) return
      setMoreOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => { document.removeEventListener('mousedown', onDown) }
  }, [moreOpen])

  // Host push: a WAL increment was decrypted into the snapshot — refresh the
  // open chat immediately, reconcile in-place edits (revoke/delete), and
  // coalesce the session-list refresh.
  useEffect(() => {
    const onUpdated = (): void => {
      void pollNew()
      void reconcileRecent()
      queueReloadSessions()
    }
    window.addEventListener('dsh-wechat-data-updated', onUpdated)
    return () => { window.removeEventListener('dsh-wechat-data-updated', onUpdated) }
  }, [pollNew, reconcileRecent, queueReloadSessions])

  useEffect(() => () => {
    if (sessionsReloadTimerRef.current !== null) clearTimeout(sessionsReloadTimerRef.current)
  }, [])

  const toggleRealtime = (): void => {
    setRealtime((v) => {
      const nv = !v
      try { localStorage.setItem('wc_realtime', nv ? '1' : '0') } catch { /* ignore */ }
      return nv
    })
  }

  const openGroupInfo = (): void => {
    if (!curSession) return
    setGroupInfoOpen(true)
    setGroupInfoLoading(true)
    setGroupInfoErr(null)
    setMemberSearch('')
    setMemberExpanded(false)
    apiGetGroupInfo(curSession.username)
      .then((r) => {
        const g = r.group
        setGroupInfo(g)
      })
      .catch((e: unknown) => { setGroupInfoErr((e as Error).message) })
      .finally(() => { setGroupInfoLoading(false) })
  }

  const openSession = useCallback(async (s: WechatSession): Promise<void> => {
    const epoch = beginSession(s.username)
    setCurSession(s)
    watermarkRef.current = 0
    setCursor(0)
    setCursorLocalId(undefined)
    setTypeStats([])
    setMsgLoading(true)
    setMsgError(null)
    try {
      // 先用上次渲染的消息缓存秒开,后台再同步最近 100 条
      const cached = readRenderCache<WechatMessage[]>('chat-msgs:' + s.username)
      if (!sessionAlive(epoch, s.username)) return
      setMessages(cached ?? [])
      if (cached && cached.length > 0) { setHasMore(true); setMsgLoading(false) }
      const env = await apiGetMessages({ talker: s.username, limit: 100 })
      // 用户在加载期间又点了另一个会话：这份响应已经过期，丢弃，
      // 否则上一个会话的消息会盖到当前会话上。
      if (!sessionAlive(epoch, s.username)) return
      const list = env.messages
      setMessages(list)
      setWatermarkFrom(list)
      setSelfWxid(env.selfWxid ?? '')
      setHasMore(env.hasMore ?? false)
      setCursor(env.cursor ?? 0)
      setCursorLocalId(env.cursorLocalId)
      setTypeStats(env.typeStats ?? [])
      writeRenderCache('chat-msgs:' + s.username, list)
      setTimeout(() => {
        if (!sessionAlive(epoch, s.username)) return
        msgEndRef.current?.scrollIntoView({ block: 'end' })
      }, 50)
    } catch (e) {
      if (sessionAlive(epoch, s.username)) setMsgError((e as Error).message)
    } finally {
      if (sessionAlive(epoch, s.username)) setMsgLoading(false)
    }
  }, [])

  const loadMore = useCallback(async (): Promise<void> => {
    if (!curSession || !hasMore || msgLoading) return
    const talker = curSession.username
    const epoch = sessionEpochRef.current
    setMsgLoading(true)
    try {
      const env = await apiGetMessages({ talker, limit: 100, cursor, cursorLocalId })
      // 翻页结果按会话拼接：切走之后到达的上一页属于上一个会话，必须丢弃。
      if (!sessionAlive(epoch, talker)) return
      const list = env.messages
      setMessages(prev => (sessionAlive(epoch, talker) ? [...list, ...prev] : prev))
      setWatermarkFrom(list)
      setHasMore(env.hasMore ?? false)
      setCursor(env.cursor ?? cursor)
      setCursorLocalId(env.cursorLocalId)
    } catch (e) {
      if (sessionAlive(epoch, talker)) setMsgError((e as Error).message)
    } finally {
      if (sessionAlive(epoch, talker)) setMsgLoading(false)
    }
  }, [curSession, hasMore, msgLoading, cursor, cursorLocalId])

  /** Open a session and scroll to a message (by localId or day start). */
  const openSessionAndLocate = useCallback(async (username: string, localId?: number, dayStart?: number): Promise<void> => {
    const found = sessions.find(x => x.username === username)
    const s: WechatSession = found ?? {
      username,
      displayName: username,
      type: username.endsWith('@chatroom') ? 'group' : 'private',
      lastTimestamp: 0, summary: '', unreadCount: 0, draft: '', pinned: false, hidden: false,
    }
    setCurSession(s)
    const epoch = beginSession(username)
    setMessages([])
    watermarkRef.current = 0
    setCursor(0)
    setCursorLocalId(undefined)
    setTypeStats([])
    setMsgLoading(true)
    setMsgError(null)
    try {
      let env = await apiGetMessages({ talker: username, limit: 100 })
      let list = env.messages
      let pages = 0
      let hit = -1
      const findHit = (): number => {
        if (localId !== undefined) return list.findIndex(m => m.localId === localId)
        if (dayStart !== undefined) return list.findIndex(m => m.createTime >= dayStart)
        return -1
      }
      hit = findHit()
      while (hit < 0 && (env.hasMore ?? false) && pages < 10) {
        const moreOpts: { talker: string; limit: number; cursor?: number; cursorLocalId?: number } = { talker: username, limit: 100 }
        if (env.cursor !== undefined) moreOpts.cursor = env.cursor
        if (env.cursorLocalId !== undefined) moreOpts.cursorLocalId = env.cursorLocalId
        env = await apiGetMessages(moreOpts)
        // 定位可能翻 10 页，期间用户在左侧点了别的会话是很正常的事：
        // 每次翻页后都要确认归属，否则会把目标会话的消息灌进当前会话。
        if (!sessionAlive(epoch, username)) return
        list = [...env.messages, ...list]
        pages += 1
        hit = findHit()
      }
      if (!sessionAlive(epoch, username)) return
      setMessages(list)
      setWatermarkFrom(list)
      setSelfWxid(env.selfWxid ?? '')
      setHasMore(env.hasMore ?? false)
      setCursor(env.cursor ?? 0)
      setCursorLocalId(env.cursorLocalId)
      setTypeStats(env.typeStats ?? [])
      // 渐进渲染窗口从底部截取：先展开到目标消息所在位置，保证定位元素已渲染。
      if (hit >= 0) revealMsgWindow(list.length - hit)
      setTimeout(() => {
        if (!sessionAlive(epoch, username)) return
        if (hit >= 0) {
          const m = list[hit]
          if (m) {
            const el = document.getElementById('msg-' + String(m.localId))
            el?.scrollIntoView({ block: 'center' })
          }
        } else {
          msgEndRef.current?.scrollIntoView({ block: 'end' })
        }
      }, 80)
    } catch (e) {
      if (sessionAlive(epoch, username)) setMsgError((e as Error).message)
    } finally {
      if (sessionAlive(epoch, username)) setMsgLoading(false)
    }
  }, [sessions, revealMsgWindow])

  // External navigation (records/privacy/ask/contacts): open the target
  // session and locate the message (or just open when no localId).
  useEffect(() => {
    if (!initialTarget) return
    void openSessionAndLocate(initialTarget.username, initialTarget.localId)
  }, [initialTarget, openSessionAndLocate])

  const onEditFn = doEdit

  /** 消息右键菜单的光标定位状态（null = 未打开）。 */
  const [msgMenu, setMsgMenu] = useState<{ x: number; y: number; m: WechatMessage; kind: RenderKind } | null>(null)

  /**
   * 切换分类视图（全部 / 公众号 / 服务号 / 客服）。
   *
   * 类目互斥：列表换类目后，右侧那个「打开中的会话」已经不属于当前界面，
   * 必须一并关掉 —— 否则在「客服」视图里会看到之前打开的某个公众号聊天，
   * 就是这个界面上出现了别的类目的信息。会话无关的浮层（聊天记录弹窗、
   * 右键菜单）也一起收起，避免残留指向上一个会话的内容。
   * @param next - the category to switch to.
   */
  const changeView = useCallback((next: ChatView): void => {
    if (next === view) return
    setView(next)
    closeCurrentSession()
    setChatlogStack([])
    setMsgMenu(null)
  }, [view, closeCurrentSession])

  /*
   * 外层 tab 与 `initialView` 的同步（公众号/服务号/客服在侧栏是独立导航项）。
   *
   * 用 ref 转一手，让 effect **不**依赖 `initialView`：如果把 `changeView` 放进依赖，
   * 它在面板内切换分段时会随 `view` 换新身份，effect 便会把视图弹回 `initialView`，
   * 用户就没法在面板内切到「服务号」。
   */
  const changeViewRef = useRef(changeView)
  changeViewRef.current = changeView
  useEffect(() => { changeViewRef.current(initialView) }, [initialView])

  /** 打开「聊天记录」弹窗（合并转发卡片与右键菜单两条入口共用同一实现）。 */
  const openChatlog = useCallback((rich: MessageRich): void => {
    setChatlogStack([{ title: rich.title || '群聊的聊天记录', records: Array.isArray(rich.records) ? rich.records : [] }])
  }, [])

  const copyMsgText = useCallback((t: string): void => {
    void navigator.clipboard.writeText(t).then(() => { window.alert('文本已复制') }).catch(() => { window.alert('复制失败') })
  }, [])

  /**
   * 右键菜单「打开文件」：同样要把消息自带的体积/时间透传给后端，
   * 否则同名文件会在别的会话里随便挑一份。
   * @param fileName - 文件名。
   * @param m - 该消息（取 fileSize 与 createTime 作为归属线索）。
   */
  const openFileFromMenu = useCallback((fileName: string, m: WechatMessage): void => {
    const bytes = Number(m.rich?.fileSize)
    const opts: { size?: number; createTime?: number } = {}
    if (Number.isFinite(bytes) && bytes > 0) opts.size = bytes
    if (m.createTime) opts.createTime = m.createTime
    void downloadMessageFile(fileName, opts).then((err) => { if (err) window.alert('打开失败：' + err) })
  }, [])

  /**
   * 在光标处打开消息菜单。
   *
   * 坐标夹进视口（留 8px 余量）。高度按条目数估算：估大了只是留白，估小了最后一条
   * 会被挤出视口，所以按 34px/条 + 16px 走，菜单本体另有 max-height + overflow 兜底。
   * @param ev - the contextmenu event.
   * @param m - the target message.
   * @param kind - its render kind.
   */
  const openMsgMenu = useCallback((ev: React.MouseEvent, m: WechatMessage, kind: RenderKind): void => {
    ev.preventDefault()
    const estH = buildMsgMenu(m, kind).length * 34 + 16
    const x = Math.max(8, Math.min(ev.clientX, window.innerWidth - 184))
    const y = Math.max(8, Math.min(ev.clientY, window.innerHeight - estH - 8))
    setMsgMenu({ x, y, m, kind })
  }, [])

  /** 菜单项分发：把「声明式条目」落到具体的面板动作上。 */
  const runMenuAction = useCallback((item: MsgMenuItem, m: WechatMessage): void => {
    switch (item.action) {
      case 'copyText': copyMsgText(item.arg ?? ''); break
      case 'copyJson': copyMsgJson(m); break
      case 'openLink': openLink(item.arg ?? ''); break
      case 'openViewer': openViewer(m); break
      case 'openFile': openFileFromMenu(item.arg ?? '', m); break
      case 'openChatlog': if (m.rich) openChatlog(m.rich); break
      case 'edit': void onEditFn(m); break
      default: break
    }
  }, [copyMsgText, copyMsgJson, openViewer, openFileFromMenu, openChatlog, onEditFn])

  /** 菜单打开期间：Esc、滚动、改窗口大小都关闭它（微信点空白处即关）。 */
  useEffect(() => {
    if (!msgMenu) return
    const close = (): void => { setMsgMenu(null) }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') close() }
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [msgMenu])

  const lastTypeIcon = (t: number | undefined): string => {
    switch (t) {
      case 3: return '🖼️'
      case 34: return '🎤'
      case 43: return '🎬'
      case 47: return '😀'
      case 49: return '🔗'
      case 50: return '📞'
      case 10000: return '📢'
      case 10002: return '↩️'
      default: return ''
    }
  }

  const renderSession = (s: WechatSession): React.JSX.Element => (
    // 会话名与摘要都会被省略号截断（实测名 135<230、摘要 187<829），title 给全文
    <button
      key={s.username}
      type="button"
      className={css.sessionItem}
      data-active={!batchMode && curSession?.username === s.username || undefined}
      title={`${s.displayName || s.username}\n${s.username}`}
      onClick={() => { if (batchMode) toggleSelect(s.username); else void openSession(s) }}
    >
      {batchMode && (
        <span className={kitCss.batchCheck} data-checked={selected.has(s.username) || undefined}>
          {selected.has(s.username) ? '✓' : ''}
        </span>
      )}
      <LazyMount placeholder={<span className={css.avatarStub} />} rootMargin="400px 0px">
        <Avatar name={s.displayName} username={s.username} />
      </LazyMount>
      <div className={css.sessionInfo}>
        <div className={css.sessionTop}>
          <span className={css.sessionNameWrap}>
            <span className={css.sessionName}>{s.displayName || s.username}</span>
            {s.hidden && <span className={css.hiddenBadge} title="该会话在微信中被隐藏">已隐藏</span>}
            {isEnterpriseChat(s.username) && <span className={css.entBadge} title="企业微信">企微</span>}
          </span>
          <span className={css.sessionTimeGroup}>
            <span className={css.sessionTime}>{fmtSessionTimeSec(s.lastTimestamp)}</span>
            {s.pinned && <span className={css.pinMark} title="置顶会话"><IconPin /></span>}
          </span>
        </div>
        <div className={css.sessionBottom}>
          {lastTypeIcon(s.lastMsgType) && (
            <span className={css.sessionTypeBadge} title="最后消息类型图标">{lastTypeIcon(s.lastMsgType)}</span>
          )}
          {/* 会话摘要实测最长 829px 而格位 187px（4.4 倍），必须给出全文入口 */}
          <span className={css.sessionSummary} title={s.summary || (s.draft ? `[草稿] ${s.draft}` : '')}>{s.summary || (s.draft ? `[草稿] ${s.draft}` : '')}</span>
          {/*
            未读角标带上「最早一条未读」的时间（第 67 轮）：后端由
            `SessionTable.unread_first_msg_srv_id` 反查该会话的 Msg_ 表得到 `unreadSince`。
            光一个数字看不出「该先看哪个」；「未读 48 · 最早 2 小时前」能直接判断积压有多旧。
            角标本身很小放不下，放在 title 里（悬停可见），不增加视觉噪音。
          */}
          {s.unreadCount > 0 && (
            <span className={css.unread} title={unreadTitle(s.unreadCount, s.unreadSince)}>{s.unreadCount}</span>
          )}
        </div>
      </div>
    </button>
  )

  // 群成员搜索：命中集合、展示上限、「查看更多」的文案都从同一份过滤结果算，
  // 否则会出现「搜出 24 个却写 256 人」这种数字自相矛盾（审计 P1-4）。
  const memberQuery = memberSearch.trim().toLowerCase()
  const memberTotal = groupInfo ? groupInfo.members.length : 0
  const filteredMembers = ((): GroupMember[] => {
    if (!groupInfo) return []
    if (!memberQuery) return groupInfo.members
    return groupInfo.members.filter((m) =>
      m.name.toLowerCase().includes(memberQuery) || m.username.toLowerCase().includes(memberQuery))
  })()
  const memberLimit = memberExpanded ? 200 : 24
  const shownMembers = filteredMembers.slice(0, memberLimit)

  return (
    <div className={css.panel} data-ai-full={(aiOpen && aiFull) || undefined}>
      {/* left: session list */}
      <div className={css.sidebar}>
        <div className={css.search}>
          <SearchInput
            className={css.searchField}
            value={search}
            onChange={(v) => {
              setSearch(v)
              if (searchMode === 'message') onSearchInput(v)
            }}
            placeholder={searchMode === 'message' ? '搜索全部消息' : '搜索会话'}
            ariaLabel={searchMode === 'message' ? '搜索全部消息' : '搜索会话'}
          />
          <button
            type="button"
            className={css.searchActionBtn}
            data-active={searchMode === 'message' || undefined}
            title="全局消息搜索"
            onClick={() => {
              const next = searchMode === 'message' ? 'session' : 'message'
              setSearchMode(next)
              if (next === 'message' && search.trim()) onSearchInput(search)
            }}
          >搜消息</button>
          <button
            type="button"
            className={css.searchActionBtn}
            data-active={batchMode || undefined}
            title="批量导出会话"
            onClick={() => { setBatchMode(v => !v); setSelected(new Set()) }}
          >{batchMode ? '退出批量' : '批量'}</button>
        </div>
        {searchMode === 'session' ? (
          <>
            <div className={css.typeFilter}>
              <Segmented
                options={[
                  { value: 'chats', label: '全部' },
                  { value: 'bizchats', label: '公众号' },
                  { value: 'servicechats', label: '服务号' },
                  { value: 'kefu', label: '客服' },
                ]}
                value={view}
                onChange={(v) => { changeView(v as ChatView) }}
                ariaLabel="会话分类"
              />
            </div>
            <div className={css.stats}>
              {batchMode ? (
                <>
                  <button type="button" className={css.batchBtn} onClick={() => { setSelected(new Set(filtered.map(x => x.username))) }}>全选</button>
                  <button type="button" className={css.batchBtn} onClick={() =>{  setSelected(new Set()) }}>清空</button>
                  <span className={css.statUnread}>已选 {selected.size}</span>
                  <button type="button" className={css.batchBtn} onClick={() => { void exportBatch() }} disabled={batchExporting || selected.size === 0}>
                    {batchExporting ? '导出中…' : '导出所选'}
                  </button>
                  {batchMsg && <span className={css.batchMsg}>{batchMsg}</span>}
                </>
              ) : (
                <>
                  <span>好友 {stats.friends}</span>
                  <span>群聊 {stats.groups}</span>
                  {stats.unread > 0 && <span className={css.statUnread}>未读 {stats.unread}</span>}
                </>
              )}
            </div>
            <div ref={sessionListRef} className={css.list}>
              {loading && <ListSkeleton rows={10} />}
              {error && <div className={kitCss.error} role="alert">{error}</div>}
              {!loading && !error && filtered.length === 0 && <div className={kitCss.emptyInline}>{view === 'chats' ? '暂无会话' : '暂无' + (view === 'kefu' ? '客服会话' : '订阅会话')}</div>}
              {!loading && !error && pinnedList.length > 0 && (
                <div className={css.pinSection}>
                  {!pinnedCollapsed && pinnedList.map(s => renderSession(s))}
                  <button type="button" className={css.pinToggle} onClick={togglePinned}>
                    <span className={css.pinMark}><IconPin /> 置顶（{pinnedList.length}）</span>
                    <span className={css.pinArrow}>{pinnedCollapsed ? '▸' : '▾'}</span>
                  </button>
                </div>
              )}
              {!loading && !error && normalList.slice(0, sessCount).map(s => renderSession(s))}
              {!loading && !error && normalList.length > sessCount && <ListSentinel refFn={sessSentinel} />}
              {!loading && !error && !sessionSearching && sessionsPager.hasMore && <ListSentinel refFn={sessionsLoadMoreRef} />}
            </div>
          </>
        ) : (
          <div className={css.list}>
            {!msgIndexed && (
              <div className={css.searchIndexHint}>
                <span>消息搜索索引尚未构建（当前为全表扫描）</span>
                <button type="button" className={css.loadMore} onClick={() => { void buildIndex() }} disabled={indexBuilding}>
                  {indexBuilding ? '构建中…' : '构建索引'}
                </button>
              </div>
            )}
            {msgSearchLoading && <div className={kitCss.emptyInline}>搜索中…</div>}
            {msgSearchError && <div className={kitCss.emptyInline}>{msgSearchError}</div>}
            {!msgSearchLoading && msgSearched && msgHits.length === 0 && !msgSearchError && <div className={kitCss.emptyInline}>未找到相关消息</div>}
            {!msgSearchLoading && msgHits.length > 0 && (
              <>
                <div className={css.searchHitCount}>命中 {msgHits.length} 条 · 点击定位到原消息</div>
                {msgHits.map(hit => (
                  <button key={`${hit.username}:${hit.local_id}`} type="button" className={css.searchHit} onClick={() => { void openSessionAndLocate(hit.username, hit.local_id) }}>
                    <div className={css.searchHitTop}>
                      <span className={css.searchHitName}>{hit.name || hit.username}</span>
                      <span className={css.searchHitTime}>{hit.time}</span>
                    </div>
                    <div className={css.searchHitSnippet}>{hit.snippet}</div>
                  </button>
                ))}
              </>
            )}
            {!msgSearchLoading && !msgSearched && !msgSearchError && <div className={kitCss.emptyInline}>输入关键词搜索全部消息</div>}
          </div>
        )}
      </div>

      {/* right: message stream */}
      <div className={css.messages}>
        <div className={css.starWrap} data-hidden={curSession !== null || undefined}>
          <RainWindow className={css.starfield} label="" active={curSession === null} />
        </div>
        {curSession === null && (
          <div className={css.msgEmptyState}>
            <div className={css.msgEmptyIcon}>💬</div>
            <div className={css.msgEmptyTitle}>从左侧选择一个会话</div>
            <div className={css.msgEmptyText}>点击会话即可查看聊天记录与文件，数据仅在本机只读预览。</div>
            {filtered.length > 0 && (
              <button type="button" className={css.msgEmptyAction} onClick={() => { const first = filtered[0]; if (first !== undefined) void openSession(first) }}>
                查看最近会话
              </button>
            )}
          </div>
        )}
        {curSession !== null && (
          <>
            <div className={css.msgHeader}>
              <div className={css.msgHeaderInfo}>
                <div className={css.msgHeaderName}>
                  {curSession.displayName || curSession.username}
                  {isEnterpriseChat(curSession.username) && <span className={css.entBadge} title="企业微信">企业微信</span>}
                </div>
                <div className={css.msgHeaderUser}>{curSession.username}{messages.length > 0 ? ` · 共 ${messages.length} 条` : ''}</div>
                {exportMsg && <div className={css.msgHeaderExport} title={exportMsg}>{exportMsg}</div>}
              </div>
              <div className={css.msgHeaderActions}>
                {/* AI 问答入口：只对单聊/群聊出现（详见 aiEligible）。 */}
                {aiEligible && (
                  <button
                    type="button"
                    className={css.calBtn}
                    data-active={aiOpen || undefined}
                    aria-expanded={aiOpen}
                    title="AI 问答：基于本会话聊天记录提问，回答附原文出处"
                    onClick={() => { setAiOpen(v => !v) }}
                  >
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z" />
                    </svg>
                    <span className={css.calBtnLabel}>AI 问答</span>
                  </button>
                )}
                <button type="button" className={css.calBtn} title={realtime ? '实时推送已开启（微信新消息自动出现）' : '实时推送已关闭'} data-active={realtime || undefined} onClick={toggleRealtime}>
                  <span className={css.realtimeDot} /> <span className={css.calBtnLabel}>实时</span>
                </button>
                <button type="button" className={css.calBtn} title="消息日历（每日消息数热力图）" onClick={() => { void openCalendar() }}><IconCalendar /> <span className={css.calBtnLabel}>日历</span></button>
                {curSession.type === 'group' && (
                  <button type="button" className={css.calBtn} data-active={groupInfoOpen || undefined} title="群聊信息" onClick={openGroupInfo}><IconUserOutline16 size={14} /><span className={css.calBtnLabel}>群信息</span></button>
                )}
                {/*
                  低频动作（导出/已编辑/清空草稿）收进溢出菜单：此前它们与上面三个按钮平铺，
                  动作区内容宽 468px 且 flex-shrink:0，窗口一窄就被消息区裁掉 ——
                  1152px 丢 1 个、1024px 丢 3 个、960px 连「群信息」都点不到（审计 P0-2）。
                */}
                <div className={css.msgHeaderMoreWrap} data-st-menu="msg-header-more">
                  <button
                    type="button"
                    className={css.calBtn}
                    title="更多操作"
                    aria-haspopup="menu"
                    aria-expanded={moreOpen || undefined}
                    data-active={moreOpen || undefined}
                    onClick={() => { setMoreOpen(v => !v) }}
                  >
                    <IconEllipsisOutline16 size={14} /><span className={css.calBtnLabel}>更多</span>
                  </button>
                  {moreOpen && (
                    <div className={css.msgHeaderMoreMenu} role="menu" aria-label="更多操作">
                      <button type="button" role="menuitem" className={css.msgHeaderMoreItem} disabled={exporting}
                        onClick={() => { setMoreOpen(false); setExportOpen(true) }}>
                        <IconDownloadOutline16 size={14} />导出消息
                      </button>
                      <button type="button" role="menuitem" className={css.msgHeaderMoreItem} disabled={editing}
                        onClick={() => { setMoreOpen(false); void openEdits() }}>
                        <IconListPenOutline16 size={14} />已编辑消息{edits.length > 0 ? ` (${String(edits.length)})` : ''}
                      </button>
                      <button type="button" role="menuitem" className={css.msgHeaderMoreItem}
                        onClick={() => { setMoreOpen(false); void clearAllDrafts() }}>
                        <IconTrashOutline16 size={14} />清空所有会话草稿
                      </button>
                      {curSession.draft && (
                        <button type="button" role="menuitem" className={css.msgHeaderMoreItem}
                          onClick={() => { setMoreOpen(false); void clearDraft() }}>
                          <IconTrashOutline16 size={14} />清空本会话草稿
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
              {pollStatus && <span className={css.msgHeaderExport} title={pollStatus}>{pollStatus}</span>}
            </div>
            {/*
              类型统计 chip 行此前在 .msgHeader 内，与标题行/动作行争宽 —— 实测头部因此在
              1664px 就有 94.6px 高、到 960px 涨到 195px 且 chip 被挤成三行竖排（审计 P1-9）。
              移出成独立条：头部回到单行，窄窗口下由容器查询整条收起。
            */}
            {typeStats.length > 0 && (
              <div className={css.msgTypeChips}>
                {typeStats.slice(0, 5).map(t => (
                  <span key={t.type} className={css.msgTypeChip} title={`${t.label}共 ${t.count} 条`}>{t.label} {t.count}</span>
                ))}
                {typeStats.length > 5 && (
                  <span className={css.msgTypeChip}>其他 +{typeStats.slice(5).reduce((a, s) => a + s.count, 0)}</span>
                )}
              </div>
            )}
            <div className={css.msgBody}>
              {/* 归属不符（正在切会话）时只显示骨架，绝不把上一个会话的消息画出来 */}
              {!messagesMatchSession && <ListSkeleton rows={8} />}
              {messagesMatchSession && hasMore && (
                <button type="button" className={css.loadMore} onClick={() => { void loadMore() }}>
                  {msgLoading ? '加载中…' : '加载更多'}
                </button>
              )}
              {messagesMatchSession && msgError && <div className={css.msgErr}>{msgError}</div>}
              {messagesMatchSession && messages.length > msgWinCount && <ListSentinel refFn={msgWinSentinel} />}
              {messagesMatchSession && (() => {
                // 渐进窗口：只渲染靠近底部的 msgWinCount 条，向上滚动越过哨兵
                // 时逐步展开更早消息（窗口起点随 count 增长向历史方向移动）。
                const start = Math.max(0, messages.length - msgWinCount)
                // 「消息 → 渲染项」的组装（含图片组归并）已抽到 utils/message-items.ts，
                // 纯函数才好用 scripts/check-message-items.js 逐条断言各分支。
                const items = buildMessageItems(messages, start)
                const kindOf = renderKindOf
                const out: React.JSX.Element[] = []
                for (const item of items) {
                  if (item.kind === 'day') {
                    out.push(<div key={item.key} className={css.msgDayDivider}><span>{item.label}</span></div>)
                    continue
                  }
                  const head = item.kind === 'group' ? item.items[0] : item.m
                  if (!head) continue
                  const kind = kindOf(head)
                  // 系统提示（含撤回）/ 拍一拍 / 无内容：居中行，没有头像与气泡。
                  if (kind === 'system' || kind === 'revoke' || kind === 'pat' || kind === 'empty') {
                    out.push(
                      <div key={`sys-${head.localId}`} id={`msg-${head.localId}`} className={css.msgRowSystem}>
                        <MessageBody m={head} selfName={curSession.username} onOpenImage={openViewer} />
                      </div>,
                    )
                    continue
                  }
                  const isSelf = head.isSender === 1
                  const isGroup = curSession.type === 'group'
                  /*
                   * 头像的身份键必须是真实 wxid，拿不到就留空（只渲染首字母占位）。
                   *
                   *  - 自己：用登录账号的 wxid。以前 fallback 到 `curSession.username`，
                   *    那会把「我」键成**对方**的 username，于是自己和对方显示同一个头像；
                   *    账号 wxid 未知时宁可不取头像，也不要取错。
                   *  - 群成员：用消息里的 sender wxid；解析不出来时留空，
                   *    绝不用昵称当键（群里同名成员会互相顶掉头像）。
                   *  - 私聊对方：就是会话 username 本身。
                   */
                  const avUsername = isSelf
                    ? selfWxid
                    : (isGroup ? (head.sender ?? '') : curSession.username)
                  const avName = isSelf ? '我' : (isGroup ? (head.senderName || head.sender || '') : curSession.displayName)
                  const isEdited = editedIds.has(head.localId)
                  out.push(
                    <div
                      key={item.kind === 'group' ? `grp-${item.gid}-${head.localId}` : head.localId}
                      id={`msg-${head.localId}`}
                      className={`${css.msgRow} ${isSelf ? css.msgRowSelf : ''}`}
                      onContextMenu={(ev) => { openMsgMenu(ev, head, kind) }}
                    >
                      <Avatar name={avName} username={avUsername} size={34} />
                      <div className={css.msgCol}>
                        {/* 悬停才出现的完整时间戳（微信行为）；已编辑折进同一枚气泡提示里 */}
                        <span className={css.msgTimeChip}>
                          {fmtMsgClockSec(head.createTime)}{isEdited ? ' · 已编辑' : ''}
                        </span>
                        {isGroup && !isSelf && head.sender && <div className={css.msgSender}>{avName}</div>}
                        {item.kind === 'group' ? (
                          <div className={`${css.msgBubble} ${css.msgBubbleTight}`}>
                            <MessageImageGroup items={item.items} username={curSession.username} onOpenAt={openViewer} />
                          </div>
                        ) : (
                          <MessageBody
                            m={item.m}
                            selfName={curSession.username}
                            onOpenImage={openViewer}
                            onOpenChatlog={openChatlog}
                          />
                        )}
                      </div>
                    </div>,
                  )
                }
                return out
              })()}
              {msgLoading && messages.length === 0 && <ListSkeleton rows={8} />}
              <div ref={msgEndRef} />
            </div>
          </>
        )}
      </div>

      {groupInfoOpen && curSession?.type === 'group' && (
        <div
          className={css.groupInfo}
          role="dialog"
          aria-modal="true"
          aria-labelledby={groupInfoTitleId}
          data-st-dialog="chats-groupinfo"
        >
          <div className={css.groupInfoHeader}>
            <span className={css.groupInfoTitle} id={groupInfoTitleId}>群聊信息</span>
            <button type="button" className={css.groupInfoClose} title="关闭" aria-label="关闭" onClick={() => { setGroupInfoOpen(false); setProfileMember(null) }}><IconCloseOutline16 size={15} /></button>
          </div>
          <div className={css.groupInfoBody}>
            {groupInfoLoading && <div className={kitCss.emptyInline}>加载中…</div>}
            {groupInfoErr && <div className={kitCss.emptyInline}>{groupInfoErr}</div>}
            {!groupInfoLoading && groupInfo && (
              <>
                <div className={css.memberSearchBox}>
                  <div className={css.searchIcon}><IconSearchOutline16 size={13} /></div>
                  <input
                    type="text"
                    placeholder="搜索群成员"
                    value={memberSearch}
                    onChange={(e) => { setMemberSearch(e.target.value) }}
                  />
                </div>
                {memberQuery && filteredMembers.length === 0 ? (
                  /* 搜索无结果必须给空态：此前网格直接渲染成 0 高度，界面只剩一片空白（审计 P0-3） */
                  <div className={css.memberEmpty}>
                    <div className={css.memberEmptyIcon}><IconSearchOutline16 size={22} /></div>
                    <div className={css.memberEmptyTitle}>未找到相关成员</div>
                    <div className={css.memberEmptyDesc}>
                      群里共 {memberTotal} 位成员，试试昵称或微信号的其它片段
                    </div>
                    <button type="button" className={css.memberEmptyClear} onClick={() => { setMemberSearch('') }}>
                      清空搜索
                    </button>
                  </div>
                ) : (
                  <div className={css.memberGrid}>
                    {shownMembers.map(m => (
                      <button
                        type="button"
                        key={m.username}
                        className={css.memberTile}
                        title={m.name}
                        onMouseEnter={(e) => { showMemberProfile(m, e.currentTarget) }}
                        onMouseLeave={hideMemberProfile}
                      >
                        {/* 与会话列表同一套懒挂载：展开到 200 人时不再一次性发起 200 个头像请求（审计 P2-4） */}
                        <LazyMount placeholder={<span className={css.avatarStub} style={{ width: 40, height: 40 }} />} rootMargin="300px 0px">
                          <Avatar name={m.name} username={m.username} size={40} />
                        </LazyMount>
                        <span className={css.memberName}>{m.name}</span>
                      </button>
                    ))}
                    {/*
                      故意的死控件（L13）：微信「聊天信息」页的成员网格末尾就是这个「＋ 添加」方块，
                      而本应用只**读**本机聊天库，没有可用的邀请/入群通道（往群里加人要么走微信协议、
                      要么直接改对方数据库，两者都不该做）。保留它的理由是布局保真 —— 去掉会让
                      成员网格与官方形态不一致（视觉审计 P1-8 行结构）。
                      因此它刻意不可交互：不是 <button>（键盘/焦点不进来）、不挂 onClick、
                      aria-disabled + title 说明原因，并且不给任何 hover 反馈让外观也不像可点
                      （见 chats.module.css 的 `.memberTile[data-disabled='true']` 规则）。
                      若将来真要做邀请，这里应换成打开确认对话框的按钮，而不是给它挂 onClick。
                    */}
                    {!memberQuery && (
                      <div className={css.memberTile} data-disabled="true" title="暂不支持邀请" aria-disabled="true">
                        <div className={css.memberAdd}><span>＋</span></div>
                        <span className={css.memberName}>添加</span>
                      </div>
                    )}
                  </div>
                )}
                {/* 有查询词时不再用「256 人」这个与过滤结果无关的数字（审计 P1-4） */}
                {memberQuery ? (
                  filteredMembers.length > memberLimit && (
                    <button type="button" className={css.memberMore} onClick={() => { setMemberExpanded(v => !v) }}>
                      {memberExpanded ? '收起' : `展开更多匹配（共 ${filteredMembers.length} 位）`}
                    </button>
                  )
                ) : memberTotal > 24 && (
                  <button type="button" className={css.memberMore} onClick={() => { setMemberExpanded(v => !v) }}>
                    {memberExpanded ? '收起' : `查看更多（${memberTotal} 人）`}
                  </button>
                )}
                {/* 微信的聊天信息是「标签左 / 值右」的列表行，不是「标签上 / 值下」的块（审计 P1-8 行结构） */}
                <div className={css.groupInfoRows}>
                  <div className={css.groupInfoRow}>
                    <span className={css.groupInfoRowLabel}>群聊名称</span>
                    <span className={css.groupInfoRowValue}>{groupInfo.name}</span>
                  </div>
                  {groupInfo.announcement && (
                    <div className={css.groupInfoRowStack}>
                      <span className={css.groupInfoRowLabel}>群公告</span>
                      <div ref={annRef} className={css.groupInfoAnn} data-clamp={!annExpanded || undefined}>
                        {groupInfo.announcement}
                      </div>
                      {annCanExpand && (
                        <button type="button" className={css.groupInfoAnnToggle} onClick={() => { setAnnExpanded(v => !v) }}>
                          {annExpanded ? '收起' : '展开'}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* message export dialog (格式/类型/时间范围/文件名/目录) */}
      {exportOpen && (
        <div className={css.calOverlay} data-st-dialog="chats-export" onClick={(e) => { if (e.target === e.currentTarget) setExportOpen(false) }} role="dialog" aria-modal="true">
          <div className={css.exportDialog}>
            <div className={css.calHeader}>
              <span className={css.calTitle}>导出消息</span>
              <button type="button" className={css.calClose} onClick={() => { setExportOpen(false) }}><IconCloseOutline16 size={15} /></button>
            </div>
            <div className={css.exportBody}>
              <div className={css.exportSection}>
                <div className={css.exportSectionHead}>
                  <span className={css.exportSectionTitle}>格式与内容</span>
                  <span className={css.exportCountBadge}>{expTypes.length === 0 ? '全部消息' : `${expTypes.length} 类消息`}</span>
                </div>
                <div className={css.exportField}>
                  <span className={kitCss.textMeta}>文件格式</span>
                  <div className={css.exportFormatGrid}>
                    {EXPO_FORMATS.map(f => (
                      <button key={f.value} type="button" className={css.exportFormatCard}
                        data-active={expFormat === f.value || undefined}
                        onClick={() => { setExpFormat(f.value as typeof expFormat) }}>
                        <span>{f.label}</span>
                        <i className={css.exportRadio} data-active={expFormat === f.value || undefined} />
                      </button>
                    ))}
                  </div>
                </div>
                <div className={css.exportField}>
                  <span className={kitCss.textMeta}>导出条数</span>
                  <div className={css.exportChips}>
                    {[10, 50, 100, 0].map(n => (
                      <button key={String(n)} type="button" className={css.exportChip} data-active={(expCount === n) || undefined}
                        onClick={() => { setExpCount(n) }}>{n === 0 ? '全部' : String(n) + ' 条'}</button>
                    ))}
                  </div>
                </div>
                <div className={css.exportField}>
                  <div className={css.exportLabelRow}>
                    <span className={kitCss.textMeta}>消息类型</span>
                    <button type="button" className={css.exportLinkBtn}
                      onClick={() => { setExpTypes(prev => prev.length > 0 ? [] : EXPO_TYPES.map(c => c.key)) }}>
                      {expTypes.length > 0 ? '取消全选' : '全选'}
                    </button>
                  </div>
                  <div className={css.exportChips}>
                    {EXPO_TYPES.map(c => (
                      <button key={c.key} type="button" className={css.exportChipCheck}
                        data-active={expTypes.includes(c.key) || undefined}
                        onClick={() => { setExpTypes(prev => prev.includes(c.key) ? prev.filter(k => k !== c.key) : [...prev, c.key]) }}>
                        <i className={css.exportCheck} data-active={expTypes.includes(c.key) || undefined}>{expTypes.includes(c.key) ? '✓' : ''}</i>
                        {c.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <div className={css.exportSection}>
                <div className={css.exportSectionHead}>
                  <span className={css.exportSectionTitle}>时间范围</span>
                  <button type="button" className={css.exportLinkBtn} onClick={() => { setExpFrom(''); setExpTo('') }}>全部时间</button>
                </div>
                <div className={css.exportRangeRow}>
                  <input type="date" className={css.exportDate} value={expFrom}
                    onChange={(e) => { setExpFrom(e.target.value) }} />
                  <span className={kitCss.textMeta}>至</span>
                  <input type="date" className={css.exportDate} value={expTo}
                    onChange={(e) => { setExpTo(e.target.value) }} />
                </div>
              </div>
              <div className={css.exportSection}>
                <div className={css.exportSectionHead}>
                  <span className={css.exportSectionTitle}>导出文件名</span>
                  <span className={css.exportHint}>可选，留空时自动生成</span>
                </div>
                <input type="text" className={css.exportInput} placeholder="例如：微信聊天记录_2026-07-11"
                  value={expFilename} onChange={(e) => { setExpFilename(e.target.value) }} />
                <label className={css.exportCheckbox}>
                  <input type="checkbox" checked={expZip} onChange={(e) => { setExpZip(e.target.checked) }} />
                  打包为 ZIP（含导出文件与 record_media.json）
                </label>
              </div>
              <div className={css.exportSection}>
                <div className={css.exportSectionHead}>
                  <span className={css.exportSectionTitle}>保存目录</span>
                </div>
                <div className={css.exportDirBox} data-chosen={(!!expDir.trim()) || undefined}>
                  <span className={css.exportDirIcon}>📁</span>
                  <div className={css.exportDirInfo}>
                    <span className={css.exportDirTitle}>{expDir.trim() ? '已选择保存目录' : '尚未选择保存目录'}</span>
                    <span className={kitCss.textCaptionTrunc}>{expDir.trim() ? expDir.trim() : '留空时导出到默认目录 ~/.dsh/wechat-data/exports'}</span>
                  </div>
                  <button type="button" className={css.exportBtn} onClick={() => { void chooseExportDir() }} disabled={pickingDir}>
                    {'＋ ' + (pickingDir ? '选择中…' : '选择目录')}
                  </button>
                </div>
              </div>
              <div className={css.exportActions}>
                <button type="button" className={css.exportBtnGhost} onClick={() => { setExportOpen(false) }}>取消</button>
                <button type="button" className={css.exportBtnPrimary} onClick={() => { void exportSession() }} disabled={exporting}>
                  {exporting ? '导出中…' : '导出'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* merged chat log viewer (聊天记录, 支持嵌套) */}
      {chatlogOpen && (
        <div className={css.calOverlay} data-st-dialog="chats-chatlog" onClick={(e) => { if (e.target === e.currentTarget) setChatlogStack([]) }} role="dialog" aria-modal="true">
          <div className={css.chatlogDialog}>
            <div className={css.calHeader}>
              <span className={css.calTitle}>{chatlogOpen.title}</span>
              <span className={css.calHeaderActions}>
                {chatlogStack.length > 1 && (
                  <button type="button" className={css.calClose} title="返回上一级" onClick={() => { setChatlogStack(prev => prev.slice(0, -1)) }} aria-label="返回上一级">‹</button>
                )}
                <button type="button" className={css.calClose} title="关闭" aria-label="关闭" onClick={() => { setChatlogStack([]) }}><IconCloseOutline16 size={15} /></button>
              </span>
            </div>
            <div className={css.chatlogBody}>
              {chatlogResolving && <div className={kitCss.emptyInline}>解析聊天记录…</div>}
              {chatlogOpen.records.length === 0 && !chatlogResolving && <div className={kitCss.emptyInline}>暂无内层消息</div>}
              {chatlogOpen.records.map((r, idx) => {
                const rt = r.renderType || (r.isImage ? 'image' : 'text')
                const nested = rt === 'chatHistory'
                const link = r.link || r.url || ''
                const nestedCount = (r.nested ?? []).length
                // head 来自聊天记录卡片 XML 的 <sourceheadurl>，是**未校验的原始地址**。
                // 实测 360 条内层记录里 193 条是 http，直接当 src 会被 CSP 拦（并写下违规日志）。
                // 过滤后为空则回退到首字母头像（下面的分支本来就是这么设计的）。
                const head = cspSafeSrc(r.head)
                return (
                  <div key={idx} className={css.chatlogRow}>
                    <div className={css.chatlogAvatar}>
                      {head ? (
                        <img src={head} alt="" referrerPolicy="no-referrer" loading="lazy"
                          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
                      ) : (
                        <span>{(r.name || '?').slice(0, 1)}</span>
                      )}
                    </div>
                    <div className={css.chatlogMain}>
                      <div className={css.chatlogTop}>
                        <span className={css.chatlogName}>{r.name}</span>
                        <span className={css.chatlogTime}>{r.time}</span>
                      </div>
                      {nested && (
                        <button type="button" className={css.chatlogNested} onClick={() => { void openNestedChatlog(r) }}>
                          <span>📋 {r.text || '聊天记录'}（{nestedCount > 0 ? String(nestedCount) + ' 条' : '点击查看'}）</span>
                        </button>
                      )}
                      {rt === 'link' && link ? (
                        <div className={css.chatlogText}><a href={link} target="_blank" rel="noopener noreferrer"
                          onClick={(e) => { e.preventDefault(); openLink(link) }} className={css.msgTextLink}>{r.text || link}</a></div>
                      ) : rt === 'voice' ? (
                        <div className={css.chatlogText}>🎤 {r.text || '[语音]'}{r.duration ? String(Math.round(Number(r.duration) / 20)) + '"' : ''}</div>
                      ) : rt === 'video' ? (
                        <div className={css.chatlogText}>🎬 {r.text || '[视频]'}{r.duration ? String(Math.round(Number(r.duration) / 1000)) + 's' : ''}</div>
                      ) : rt === 'emoji' ? (
                        <div className={css.chatlogText}>😀 {r.text || '[表情]'}</div>
                      ) : rt === 'image' ? (
                        <div className={css.chatlogText}>🖼️ [图片]{r.datasize ? ' (' + r.datasize + ' 字节)' : ''}</div>
                      ) : (
                        <div className={css.chatlogText}>{r.text || ''}</div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {/* 编辑消息副本：写入本地解密副本，原文在 message_edits.db 里留底，可用「恢复原文」回退 */}
      <Dialog
        open={editTarget !== null}
        onClose={() => { if (!editBusy) closeEdit() }}
        title="编辑消息副本"
        footer={(
          <div className={css.editFoot}>
            <button type="button" className={css.exportBtn} disabled={editBusy} onClick={closeEdit}>取消</button>
            <button
              type="button"
              className={css.exportBtnPrimary}
              disabled={editBusy || editText.trim() === (editTarget?.displayText || editTarget?.strContent || '').trim()}
              onClick={() => { void saveEdit() }}
            >
              {editBusy ? '保存中…' : '保存'}
            </button>
          </div>
        )}
      >
        <p className={css.editHint}>
          只改动本地解密副本（微信原始数据库不动）。保存后这条消息会标上「已编辑」，
          随时可在「更多 → 已编辑消息」里恢复原文。
        </p>
        <textarea
          ref={editAreaRef}
          className={css.editArea}
          value={editText}
          onChange={(e) => { setEditText(e.target.value) }}
          aria-label="消息内容"
          spellCheck={false}
        />
        {editErr && <p className={css.editErr} role="alert">保存失败：{editErr}</p>}
      </Dialog>

      {/* 消息右键菜单（微信同款）：点空白处 / Esc / 滚动都会关掉 */}
      {msgMenu && (
        <div className={css.msgCtxOverlay} onMouseDown={() => { setMsgMenu(null) }}>
          <div
            className={css.msgCtxMenu}
            style={{ left: msgMenu.x, top: msgMenu.y }}
            role="menu"
            onMouseDown={(e) => { e.stopPropagation() }}
          >
            {buildMsgMenu(msgMenu.m, msgMenu.kind).map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                className={css.msgCtxItem}
                onClick={() => { const m = msgMenu.m; setMsgMenu(null); runMenuAction(item, m) }}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* member profile popover (群成员资料，悬浮于头像旁) */}
      {profileMember && profilePos && (
        <div className={css.memberProfilePop} style={{ left: profilePos.left, top: profilePos.top }}>
          <div className={css.memberProfileBody}>
            <Avatar name={profileMember.name} username={profileMember.username} size={56} />
            <div className={css.memberProfileName}>{profileMember.name}</div>
            <div className={css.memberProfileItem}>
              <span>微信号</span><span className={css.memberProfileMono}>{profileMember.username}</span>
            </div>
            {profileMember.region && (
              <div className={css.memberProfileItem}>
                <span>地区</span><span className={css.memberProfileMono}>{profileMember.region}</span>
              </div>
            )}
            {profileMember.signature && (
              <div className={css.memberProfileItem}>
                <span>签名</span><span className={css.memberProfileMono}>{profileMember.signature}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* message calendar dialog (A8) */}
      {calOpen && (
        <div className={css.calOverlay} data-st-dialog="chats-cal" onClick={(e) => { if (e.target === e.currentTarget) setCalOpen(false) }} role="dialog" aria-modal="true">
          <div className={css.calDialog}>
            <div className={css.calHeader}>
              <span className={css.calTitle}>消息日历</span>
              <button type="button" className={css.calClose} onClick={() =>{  setCalOpen(false) }}><IconCloseOutline16 size={15} /></button>
            </div>
            <div className={css.calBody}>
              <div className={css.calNav}>
                <button type="button" className={css.loadMore} onClick={() => { void switchCalMonth(-1) }} aria-label="上一月">‹</button>
                <span className={css.calMonthTitle}>{calYear} 年 {calMonth} 月</span>
                <button type="button" className={css.loadMore} onClick={() => { void switchCalMonth(1) }} aria-label="下一月">›</button>
              </div>
              {calLoading ? (
                <div className={kitCss.emptyInline}>加载中…</div>
              ) : (
                <>
                  <div className={css.calStats}>
                    <span className={css.calStat}>本月共 <b>{calTotal}</b> 条消息</span>
                    <span className={css.calStat}>活跃 <b>{calActiveDays}</b> 天</span>
                    <span className={css.calStat}>日均 <b>{calAvg}</b> 条</span>
                    {calTop && <span className={css.calStat}>最活跃：{calMonth}月{calTop.day}日（{calTop.count} 条）</span>}
                  </div>
                  <div className={css.calGrid}>
                    {['一', '二', '三', '四', '五', '六', '日'].map(wd => (
                      <div key={wd} className={css.calWd}>{wd}</div>
                    ))}
                    {Array.from({ length: calFirstDow }).map((_, i) => <div key={`e${i}`} className={css.calEmpty} />)}
                    {Array.from({ length: calDays }).map((_, i) => {
                      const day = i + 1
                      const cnt = calCounts[String(day)] ?? 0
                      return (
                        <button key={day} type="button" className={css.calDay} style={{ background: calHeat(cnt) }}
                          title={cnt ? `${calMonth}月${day}日：${cnt} 条消息` : `${calMonth}月${day}日：无消息`}
                          onClick={() =>{  jumpToDay(day) }}>
                          <span className={css.calDayNum}>{day}</span>
                          {cnt > 0 && <span className={css.calDayCnt}>{cnt}</span>}
                        </button>
                      )
                    })}
                  </div>
                  <p className={css.calHint}>点击日期跳转到当天消息（色块深浅表示消息量）</p>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* edited-messages popup */}
      {editedOpen && (
        <div className={css.calOverlay} data-st-dialog="chats-edited" onClick={() =>{  setEditedOpen(false) }} role="dialog" aria-modal="true">
          <div className={css.calDialog}>
            <div className={css.calHeader}>
              <span className={css.calTitle}>本会话已编辑消息</span>
              <button type="button" className={css.calClose} onClick={() =>{  setEditedOpen(false) }} aria-label="关闭">×</button>
            </div>
            <div className={css.calBody}>
              {edits.length === 0 ? (
                <div className={kitCss.emptyInline}>暂无编辑记录（修改仅写入本地解密副本）</div>
              ) : (
                edits.map(rec => (
                  <div key={`${rec.sessionId}:${rec.localId}`} className={css.editRow}>
                    <span className={css.editRowInfo}>
                      #{rec.localId} · 编辑 {rec.editCount} 次 · {new Date(rec.lastEditedAt).toLocaleString()}
                    </span>
                    <button type="button" className={css.loadMore} onClick={() => { void doReset(rec) }} disabled={editing}>恢复原文</button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* 会话级 AI 面板（「新对话」）：.panel 的第三栏，与消息流并排。
          仅单聊/群聊给入口；读取范围固定为当前会话，检索仍走同一条 RAG 流水线。 */}
      {aiOpen && aiEligible && aiTarget && (
        <SessionAsk
          target={aiTarget}
          onClose={() => { setAiOpen(false); setAiFull(false) }}
          onOpenMessage={(u, id) => { void openSessionAndLocate(u, id > 0 ? id : undefined) }}
          full={aiFull}
          onToggleFull={() => { setAiFull(v => !v) }}
        />
      )}

      {/* image lightbox */}
      {viewer && (
        <ImageViewer
          images={viewer.images}
          index={viewer.index}
          onClose={() =>{  setViewer(null) }}
          onIndexChange={(i) =>{  setViewer(v => (v ? { ...v, index: i } : v)) }}
        />
      )}
    </div>
  )
}

