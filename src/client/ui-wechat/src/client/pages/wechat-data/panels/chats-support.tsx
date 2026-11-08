
/**
 * Chats 面板的小工具与头像/图标（M21 第三十二刀自 Chats.tsx 拆出）。
 *
 * 这些原先都是 Chats.tsx 里的顶层函数/组件（不吃面板状态，只吃道具）—— 整段原样搬出，
 * 面板按需 import。依赖由脚本从「这块里真实用到的面板 import」生成。
 */
import { apiExportChatFile, apiExportFileAttachment, apiGetAvatar, apiGetAvatarBatched, apiSaveFileDialog } from '../api.ts'
import { avatarColors, fmtDateTimeSec } from '../utils/format.ts'
import { MessageRenderItem } from '../utils/message-items.ts'
import { cacheBounded, copyTextToClipboard } from '../utils/misc.ts'
import css from './chats.module.css'
import cssrows from './chats-rows.module.css'
import { localImageSrc } from './remote-img.tsx'
import { MessageRenderKind as RenderKind, WechatMessage, WechatSession } from '@deepseek-ai/dsh-wechat-data/types'
import { isEnterpriseWechatUser } from './enterprise-identity.ts'
import { useEffect, useState } from 'react'
import { desktopAction } from '../ui/desktop-only.tsx'
import { mediaExportJobId } from './media-export-job.ts'
/** 16px calendar glyph (kept local; the primitives set has no calendar). */
/**
 * 未读角标的悬停说明（第 67 轮）。
 * @param n - 未读条数。
 * @param since - 最早一条未读的时间（epoch 秒）；后端解析不到时不传。
 * @returns 「未读 N 条 · 最早 X 前」或只有条数。
 */
export function unreadTitle(n: number, since?: number): string {
  const base = `未读 ${n} 条`
  if (!since || since <= 0) return base
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - since)
  const mins = Math.floor(diff / 60)
  const hours = Math.floor(mins / 60)
  const days = Math.floor(hours / 24)
  const ago = days >= 1 ? `${days} 天前` : hours >= 1 ? `${hours} 小时前` : mins >= 1 ? `${mins} 分钟前` : '刚刚'
  return `${base} · 最早一条 ${ago}（${fmtDateTimeSec(since)}）`
}
/**
 * 消息菜单的两个动作（W3-11.1 从 Chats.tsx 下沉）：复制文本 / 打开文件。
 *
 * 为什么下沉：`ChatsPanel` 受 `function-size-ratchet.spec.ts` 的棘轮管着（登记 465 行，
 * 一行都不许多），而这两个动作原本各带一段 JSDoc + 失败分支。它们不依赖组件状态
 * （只拿一个 `flash` 回执写入），放模块里最合适。
 */

/** 复制一段文本，结果走一行回执（成功/失败都说，失败给手动补救）。 */
export function copyTextWithNotice(text: string, flash: (t: string) => void): void {
  void copyTextToClipboard(text).then((ok) => { flash(ok ? '文本已复制' : '复制失败，请手动选中后复制') })
}

export function IconCalendar(): React.JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="12" rx="2" stroke="currentColor" strokeWidth="1.25" />
      <path d="M1.5 6h13M5 1v3M11 1v3" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  )
}
/** 14px pin glyph for pinned sessions. */
export function IconPin(): React.JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M9.2 1.6 14.4 6.8c.4.4.2 1-.3 1.1l-2.4.5-3.1 3.1c-.4.4-1 .4-1.4 0l-.3-.3L4 14.6c-.3.3-.8.3-1.1 0l-.5-.5c-.3-.3-.3-.8 0-1.1l3.4-3.1-.3-.3c-.4-.4-.4-1 0-1.4l3.1-3.1.5-2.4c.1-.5.7-.7 1.1-.3Z" />
    </svg>
  )
}
/** 15px image glyph for media placeholders. */
export function IconImage(): React.JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.25" />
      <circle cx="5.5" cy="6" r="1.4" fill="currentColor" />
      <path d="m2.5 12.5 3.5-3.5 2.5 2.5 2.5-2.5 2.5 2.5" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
    </svg>
  )
}
/** 14px minus glyph for the lightbox zoom control. */
export function IconMinus(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3 8h10" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  )
}
/** 14px 话筒字形（通话气泡：已接通）。 */
export function IconCallOutline(): React.JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4.2 2.3 5.9 5c.2.3.1.7-.1.9l-.9.8c-.2.2-.3.5-.1.8.6 1.1 1.6 2.1 2.7 2.7.3.2.6.1.8-.1l.8-.9c.2-.2.6-.3.9-.1l2.7 1.7c.3.2.4.6.2.9l-.7 1.1c-.5.8-1.5 1.1-2.4.8-2-.7-3.9-2.6-4.6-4.6-.3-.9 0-1.9.8-2.4l1.1-.7c.3-.2.7-.1.9.2Z" fill="currentColor" />
    </svg>
  )
}
/** 15px 话筒+斜线字形（通话气泡：未接通）。 */
export function IconCallMissedOutline(): React.JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4.2 2.3 5.9 5c.2.3.1.7-.1.9l-.9.8c-.2.2-.3.5-.1.8.6 1.1 1.6 2.1 2.7 2.7.3.2.6.1.8-.1l.8-.9c.2-.2.6-.3.9-.1l2.7 1.7c.3.2.4.6.2.9l-.7 1.1c-.5.8-1.5 1.1-2.4.8-2-.7-3.9-2.6-4.6-4.6-.3-.9 0-1.9.8-2.4l1.1-.7c.3-.2.7-.1.9.2Z" fill="currentColor" opacity="0.55" />
      <path d="M10.4 5.6 14 9.2M14 5.6 10.4 9.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}
/** Open an external http(s) URL in a new tab (protocol-checked). */
export function openLink(url: string): void {
  if (/^https?:\/\//i.test(url)) {
    window.open(url, '_blank', 'noopener,noreferrer')
  }
}
/** Convert a transfer-card amount to a display string without inventing `¥0.00`. */
export function transferAmountLabel(raw: string | undefined): string {
  const value = (raw ?? '').trim()
  if (value === '') return ''
  const match = /^(?:CNY|RMB|人民币)?\s*[¥￥]?\s*((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)\s*(?:元|圆)?$/i.exec(value)
  if (match === null) return ''
  return `¥${match[1] ?? ''}`
}
/**
 * 把原图获取失败收敛成用户可理解的提示。
 *
 * HTTP 状态、网络异常名、允许清单等只留在操作日志；消息气泡只说明用户下一步
 * 能做什么，避免把实现细节当成聊天内容展示。
 * @param reason - backend error or note, which may contain technical diagnostics.
 * @returns a short user-facing sentence.
 */
export function imageOriginalFailureText(reason?: string): string {
  const value = (reason ?? '').trim()
  if (/本机只有缩略图|在微信里打开|查看原图/i.test(value)) {
    return '请先在微信中查看原图，再回来重试'
  }
  return '原图暂不可用，请稍后重试'
}
/** White transfer arrow glyph inside the wechat transfer card. */
export function TransferArrowGlyph(): React.JSX.Element {
  return (
    <svg width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3.2 5.2h9.4M9.8 2.6 12.6 5.2 9.8 7.8" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12.8 10.8H3.4M6.2 8.2 3.4 10.8l2.8 2.6" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
/** 右键菜单项要触发的动作。 */
export type MsgMenuAction =
  | 'copyText' | 'copyJson' | 'openLink' | 'openViewer' | 'openFile' | 'openChatlog'
  | 'poster' | 'viewSource' | 'messageInfo' | 'editMessage' | 'editSource'
/**
 * 右键菜单里一项的规格。
 *
 * 做成「声明 + 动作名」而不是直接塞回调，是为了让条目计算保持纯函数：
 * 打开菜单时要先知道条目数才能把菜单夹进视口，塞回调就没法在 setState 之前算。
 */
export interface MsgMenuItem {
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
 * 复制文本 → 复制消息 JSON →（打开链接 / 查看大图 / 打开文件 / 查看聊天记录）
 * → 生成聊天海报 / 查看源码 / 查看消息信息 / 修改消息 / 修改源码。
 * 「语音转文字」仍留在语音气泡下方 —— 微信也是把转写做成气泡下方的按钮，不是菜单项。
 * @param m - the target message.
 * @param kind - its render kind.
 * @returns menu items in display order.
 */
export function buildMsgMenu(m: WechatMessage, kind: RenderKind): MsgMenuItem[] {
  const items: MsgMenuItem[] = []
  const text = m.displayText || ''
  if (text) items.push({ label: '复制文本', action: 'copyText', arg: text })
  items.push({ label: '复制消息 JSON', action: 'copyJson' })
  const url = m.rich && typeof m.rich.url === 'string' ? m.rich.url : ''
  if (/^https?:\/\//i.test(url)) items.push({ label: '打开链接', action: 'openLink', arg: url })
  if (kind === 'image') items.push({ label: '查看大图', action: 'openViewer' })
  if (kind === 'file') items.push({ label: '打开文件', action: 'openFile', arg: m.rich?.title || text })
  if (kind === 'chatlog' && m.rich) items.push({ label: '查看聊天记录', action: 'openChatlog' })
  items.push({ label: '生成聊天海报...', action: 'poster' })
  items.push({ label: '查看源码', action: 'viewSource' })
  items.push({ label: '查看消息信息', action: 'messageInfo' })
  // 普通「修改消息」只对纯文本开放：把图片/引用/文件等结构化载荷拍平成文本会直接毁掉卡片。
  // 这些类型仍可通过「修改源码」显式编辑原始 XML / 载荷，并由后端保留原编码。
  if (kind === 'text') items.push({ label: '修改消息', action: 'editMessage' })
  items.push({ label: '修改源码', action: 'editSource' })
  return items
}

/** 查看/修改源码统一读取本地解密副本里的原始内容（zstd 已在查询层解压）。 */
export function messageSourceText(m: WechatMessage): string {
  return m.msgContent ?? m.strContent ?? ''
}
/** Module-level avatar cache (username -> data URL / remote URL / null). */
export const avatarCache = new Map<string, string | null>()
/** 头像缓存上限：模块级缓存生命周期等于渲染进程，必须设上限（值为 base64 data URL）。 */
export const AVATAR_CACHE_MAX = 300
/**
 * Avatar: lazy-loads the real WeChat avatar via Remote, falls back to a letter tile.
 *
 * 缓存键**只用 `username`**。以前是 `username || name`，而 `name` 是昵称/备注：
 * 群里两个同名成员（或同一个昵称出现在两个会话）会命中同一条缓存、显示同一个头像 ——
 * 属于「用户标识张冠李戴」。调用方必须传真实 username；拿不到时传空串，
 * 此时只渲染首字母占位、不写缓存（宁可没有头像，也不给错的头像）。
 * @param props.name - 展示名（用于首字母、配色；批量未命中时作为单张回落的 nickname）。
 * @param props.username - 真实 wxid；为空表示未知身份。
 * @param props.avatarUrl - 联系人快照里的头像地址；只有本机可直接绘制的地址才会优先使用。
 * @param props.size - 头像边长（px）。
 * @returns the avatar element.
 */
export function Avatar({ name, username, avatarUrl, size }: {
  name: string
  username: string
  avatarUrl?: string
  size?: number
}): React.JSX.Element {
  const key = username
  const px = size ?? 34
  const fontSize = Math.max(10, Math.round(px * 0.42))
  const local = localImageSrc(avatarUrl)
  const [resolved, setResolved] = useState<{ username: string; src: string | null }>(() => {
    const cached = key ? avatarCache.get(key) : undefined
    return { username: key, src: typeof cached === 'string' && cached !== '' ? cached : null }
  })
  const [failedSrc, setFailedSrc] = useState('')

  useEffect(() => {
    const cached = key ? avatarCache.get(key) : undefined
    setResolved({ username: key, src: typeof cached === 'string' && cached !== '' ? cached : null })
    setFailedSrc('')
  }, [key, avatarUrl])

  useEffect(() => {
    let cancelled = false
    if (!key) return
    const cached = avatarCache.get(key)
    if (typeof cached === 'string' && cached !== '') {
      setResolved({ username: key, src: cached })
      return
    }
    // 本机快照里的头像优先；若它绘制失败，failedSrc 会触发这里继续走代理兜底。
    if (local !== '' && failedSrc !== local) return
    // W2-10.2：走攒批队列 —— 一屏 N 个 Avatar 合成一次 `getAvatarsLocal`，而不是 N 次
    // `getAvatar`（实测 200 个头像 5.6×，且少 199 次 IPC 往返）。未命中的那几条由队列
    // 内部退回单张 —— 那里还有一级「按昵称找联系人」的回落，批量接口没有这一级。
    // nickname 只供这一级回落使用；缓存键仍是真实 username，绝不能换成展示名。
    apiGetAvatarBatched({ username: key, nickname: name })
      .then((r) => {
        const value = r.kind === 'data' ? (r.data ?? null) : null
        cacheBounded(avatarCache, key, value, AVATAR_CACHE_MAX)
        if (!cancelled) setResolved({ username: key, src: value })
      })
      .catch(() => { if (!cancelled) setResolved({ username: key, src: null }) })
    return () => { cancelled = true }
  }, [key, name, avatarUrl, local, failedSrc])

  const letter = (name || username || '?').slice(0, 1).toUpperCase()
  // 第 88 轮：统一由 avatarColors 给底色 + 文字色（对比度 ≥4.5；四个面板同一套哈希，同一个人同色）
  const av = avatarColors(username || name || '?')
  const cachedSrc = resolved.username === key ? resolved.src : null
  const src = local !== '' && failedSrc !== local ? local : cachedSrc
  if (src) {
    return (
      <div className={cssrows.avatar} style={{ width: px, height: px, fontSize, overflow: 'hidden' }}>
        <img
          src={src}
          alt=""
          className={cssrows.avatarImg}
          width={px}
          height={px}
          loading="lazy"
          onError={() => {
            if (src === local) {
              setFailedSrc(local)
              return
            }
            setResolved({ username: key, src: null })
            if (key) cacheBounded(avatarCache, key, null, AVATAR_CACHE_MAX)
          }}
        />
      </div>
    )
  }
  return (
    <div className={cssrows.avatar} style={{ width: px, height: px, fontSize, background: av.background, color: av.color }}>
      {letter}
    </div>
  )
}
/** 文件类型只决定颜色和图形，不再使用依赖系统字体的 emoji。 */
const fileKind = (kind: string): { kind: string } => ({ kind })
export const FILE_STYLE: Record<string, { kind: string }> = {
  pdf: fileKind('pdf'),
  doc: fileKind('word'), docx: fileKind('word'),
  xls: fileKind('excel'), xlsx: fileKind('excel'), csv: fileKind('excel'),
  ppt: fileKind('ppt'), pptx: fileKind('ppt'),
  png: fileKind('image'), jpg: fileKind('image'), jpeg: fileKind('image'),
  gif: fileKind('image'), webp: fileKind('image'), bmp: fileKind('image'),
  mp4: fileKind('video'), mov: fileKind('video'), avi: fileKind('video'),
  mp3: fileKind('audio'), wav: fileKind('audio'), m4a: fileKind('audio'),
  zip: fileKind('archive'), rar: fileKind('archive'), '7z': fileKind('archive'),
  tar: fileKind('archive'), gz: fileKind('archive'),
  js: fileKind('code'), ts: fileKind('code'), py: fileKind('code'), sql: fileKind('code'),
  html: fileKind('code'), css: fileKind('code'), json: fileKind('code'), yaml: fileKind('code'),
  yml: fileKind('code'), ini: fileKind('code'), xml: fileKind('code'), bat: fileKind('code'),
  ps1: fileKind('code'), sh: fileKind('code'), java: fileKind('code'),
  txt: fileKind('text'), md: fileKind('text'), log: fileKind('text'), rtf: fileKind('text'),
}
export function fileStyle(fileName: string, declaredExt?: string): { kind: string } {
  const declared = (declaredExt ?? '').replace(/^\./, '').trim().toLowerCase()
  if (/^[a-z0-9]{1,12}$/.test(declared)) return FILE_STYLE[declared] ?? fileKind('file')
  const base = fileName.split(/[\\/]/).pop() ?? fileName
  const dot = base.lastIndexOf('.')
  const ext = dot > 0 && dot < base.length - 1 ? base.slice(dot + 1).toLowerCase() : ''
  return FILE_STYLE[ext] ?? fileKind('file')
}
/** 24px 文档图标；颜色由文件卡的 `data-kind` 提供。 */
export function FileKindIcon({ kind }: { kind: string }): React.JSX.Element {
  const common = {
    width: 24,
    height: 24,
    viewBox: '0 0 24 24',
    fill: 'none',
    'aria-hidden': true,
  } as const
  switch (kind) {
    case 'image':
      return (
        <svg {...common}>
          <rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="1.6" />
          <circle cx="8" cy="9" r="1.6" fill="currentColor" />
          <path d="m4.5 18 5-5 3 3 2.5-2.5 4.5 4.5" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        </svg>
      )
    case 'video':
      return (
        <svg {...common}>
          <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.6" />
          <path d="m10 9 5 3-5 3V9Z" fill="currentColor" />
        </svg>
      )
    case 'audio':
      return (
        <svg {...common}>
          <path d="M10 17V7l8-2v10" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
          <ellipse cx="7.5" cy="17.5" rx="2.5" ry="2" fill="currentColor" />
          <ellipse cx="15.5" cy="15.5" rx="2.5" ry="2" fill="currentColor" />
        </svg>
      )
    case 'archive':
      return (
        <svg {...common}>
          <path d="M4 7h16v12H4V7Zm-1-3h18v3H3V4Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
          <path d="M9 11h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      )
    case 'excel':
      return (
        <svg {...common}>
          <rect x="4" y="3" width="16" height="18" rx="2" stroke="currentColor" strokeWidth="1.5" />
          <path d="M4 9h16M4 15h16M12 3v18" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      )
    case 'ppt':
      return (
        <svg {...common}>
          <rect x="3" y="4" width="18" height="13" rx="2" stroke="currentColor" strokeWidth="1.6" />
          <path d="M12 17v3m-4 0h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <path d="m10 8 5 2.5-5 2.5V8Z" fill="currentColor" />
        </svg>
      )
    case 'code':
      return (
        <svg {...common}>
          <path d="m8 7-5 5 5 5m8-10 5 5-5 5M14 4l-4 16" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    default:
      return (
        <svg {...common}>
          <path d="M6 3h8l4 4v14H6V3Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
          <path d="M14 3v5h5M9 12h6M9 16h6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      )
  }
}
/** 微信红包的小红包图形，避免系统 emoji 在 Windows 上呈现成完全不同的样式。 */
export function RedPacketGlyph(): React.JSX.Element {
  return (
    <svg width="32" height="36" viewBox="0 0 32 36" fill="none" aria-hidden="true">
      <rect x="2.5" y="1.5" width="27" height="33" rx="3.5" fill="#C94A3F" stroke="#F4C771" strokeWidth="1.2" />
      <path d="M3 4.5c7.8 6.6 18.2 6.6 26 0v8.8c-7.8 5.8-18.2 5.8-26 0V4.5Z" fill="#E66555" />
      <circle cx="16" cy="17.2" r="5.2" fill="#F2C45E" stroke="#FFE7A9" strokeWidth="1.1" />
      <path d="M16 14.4v5.6M14.2 17.2h3.6" stroke="#C38C24" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M9 27.5h14" stroke="#8C2F2A" strokeWidth="1" strokeLinecap="round" opacity=".55" />
    </svg>
  )
}
/** 非文件卡的小图标，统一为 SVG，避免 emoji 跨机器字体漂移。 */
export function AppCardIcon({ kind }: { kind: 'announcement' | 'note' | 'card' | 'product' | 'unsupported' | 'message' | 'music' | 'play' | 'live' }): React.JSX.Element {
  const common = { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true } as const
  switch (kind) {
    case 'announcement':
      return (
        <svg {...common}>
          <path d="M4 13v-2l11-5v12L4 13Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
          <path d="M15 9.5c2 1 2 4 0 5M7 14l1 5h3l-1-4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      )
    case 'note':
      return (
        <svg {...common}>
          <path d="M5 3h10l4 4v14H5V3Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
          <path d="M15 3v5h4M8 12h8M8 16h6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      )
    case 'product':
      return (
        <svg {...common}>
          <path d="M5 8h14l-1 13H6L5 8Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
          <path d="M9 9V6a3 3 0 0 1 6 0v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      )
    case 'unsupported':
      return (
        <svg {...common}>
          <path d="M12 3 22 21H2L12 3Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
          <path d="M12 9v5m0 3h.01" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      )
    case 'music':
      return (
        <svg {...common}>
          <path d="M10 17V7l8-2v10" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
          <ellipse cx="7.5" cy="17.5" rx="2.5" ry="2" fill="currentColor" />
          <ellipse cx="15.5" cy="15.5" rx="2.5" ry="2" fill="currentColor" />
        </svg>
      )
    case 'play':
      return <svg {...common}><path d="m8 5 11 7-11 7V5Z" fill="currentColor" /></svg>
    case 'live':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="2.2" fill="currentColor" />
          <path d="M7.5 8a6 6 0 0 0 0 8m9-8a6 6 0 0 1 0 8M4.5 5a10 10 0 0 0 0 14m15-14a10 10 0 0 1 0 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      )
    case 'card':
      return (
        <svg {...common}>
          <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.5" />
          <path d="M3 10h18M8 15h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      )
    default:
      return (
        <svg {...common}>
          <path d="M4 5h16v11H9l-5 4V5Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
          <path d="M8 9h8M8 12h5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      )
  }
}
export interface MessageFileSaveResult {
  path?: string
  error?: string
}

/**
 * Copy a received file from `msg/file` through the backend's original-file RPC.
 *
 * The old data-URL download could not carry files above 16 MB and sent a full
 * base64 copy through the renderer. The save dialog now selects a destination
 * and the backend copies the source bytes, rejecting ambiguous same-name files
 * when no MD5 is available.
 * @param fileName - message attachment name.
 * @param opts - size/time/hash used to disambiguate the source file.
 * @returns saved path, a displayable error, or neither when the user cancels.
 */
export async function downloadMessageFile(
  fileName: string,
  opts: {
    username?: string
    localId?: number
    size?: number
    createTime?: number
    fileMd5?: string
    jobId?: string
  } = {},
): Promise<MessageFileSaveResult> {
  try {
    if (desktopAction()) return { error: '原文件保存仅支持电脑端' }
    const username = String(opts.username ?? '').trim()
    const localId = Number(opts.localId ?? 0)
    const hasMessageContext = username !== '' || opts.localId !== undefined
    if (hasMessageContext && (username === '' || !Number.isSafeInteger(localId) || localId <= 0)) {
      return { error: '缺少消息定位信息，无法确认原文件归属' }
    }
    const safeName = fileName.replace(/[\\/:*?"<>|]/g, '_').trim() || '微信文件'
    const dot = safeName.lastIndexOf('.')
    const ext = dot > 0 ? safeName.slice(dot + 1).toLowerCase() : ''
    const picked = await apiSaveFileDialog({
      defaultName: safeName,
      title: '保存微信原文件',
      filters: [
        ...(ext && ext.length <= 12 ? [{ name: ext.toUpperCase() + ' 文件', extensions: [ext] }] : []),
        { name: '全部文件', extensions: ['*'] },
      ],
    })
    if (picked.canceled || !picked.path) return {}
    const jobId = opts.jobId || mediaExportJobId('chat-file')
    const result = username !== ''
      ? await apiExportChatFile({ username, localId, dest: picked.path, jobId })
      : await apiExportFileAttachment({
        fileName,
        ...(opts.size !== undefined ? { size: opts.size } : {}),
        ...(opts.createTime !== undefined ? { createTime: opts.createTime } : {}),
        ...(opts.fileMd5 !== undefined ? { md5: opts.fileMd5 } : {}),
        dest: picked.path,
        jobId,
      })
    if (!result.ok) return { error: result.error || '原文件写入失败' }
    return { path: result.path ?? picked.path }
  } catch (e) {
    console.warn('[chats] 保存原文件失败：', e)
    return { error: e instanceof Error ? e.message : '文件暂不可用' }
  }
}
/** 直播状态文案：`<livestatus>` 各版本取值不同，做一次归一。 */
export function liveStatusText(raw?: string): string {
  const v = String(raw ?? '').trim().toLowerCase()
  if (!v) return ''
  if (['1', 'live', 'living', 'ongoing', 'started'].includes(v)) return '直播中'
  if (['2', 'end', 'ended', 'finished', 'over', 'closed'].includes(v)) return '已结束'
  if (['0', 'preview', 'notstarted', 'not_started'].includes(v)) return '预告'
  return ''
}
/**
 * 兜底解码 XML 实体（卡片标题/描述用）。
 *
 * 后端 `parseAppmsg` 已经解码，这里只是**渲染缓存里的旧数据**——
 * `readRenderCache` 存的是上一版写入的消息对象，它们的 `rich.title` 里还带着
 * `&#x20;`（公众号标题常把连续空格写成实体）。升级后不清洗会直接显示字面量。
 * @param s - raw text.
 * @returns text with XML entities decoded.
 */
export function decodeEntities(s: string): string {
  if (!s || s.indexOf('&') < 0) return s
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
}
/**
 * Render the chats panel.
 * @returns the chats element tree.
 */
/** Which session view to show: all chats, official accounts, service accounts, or kefu. */
export type ChatView = 'chats' | 'bizchats' | 'servicechats' | 'kefu'
export { isEnterpriseWechatUser } from './enterprise-identity.ts'
/** Enterprise-WeChat conversation detection (@openim / @weclaw / kefu). */
export function isEnterpriseChat(u: string): boolean {
  const s = (u || '').toLowerCase()
  return isEnterpriseWechatUser(s) || s.endsWith('@weclaw')
    || s.includes('@kefu') || s.includes('openim') && (s.includes('chatroom') || s.includes('@'))
}
/** Kefu session detection：真实企业微信/品牌客服会话（不含占位 holder 与 @openim 企业微信用户）。 */
export function isKefuSession(u: string): boolean {
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
export function sessionInView(s: WechatSession, view: ChatView): boolean {
  if (view === 'bizchats') {
    return s.username.startsWith('gh_') && s.accountKind !== 'service' && !isKefuSession(s.username)
  }
  if (view === 'servicechats') {
    return s.username.startsWith('gh_') && s.accountKind === 'service' && !isKefuSession(s.username)
  }
  if (view === 'kefu') return isKefuSession(s.username)
  return true
}
export const POLL_VISIBLE_MS = 1000
export const POLL_HIDDEN_MS = 5000
/**
 * 会话列表是「新消息进来第一眼就要变」的界面：它没有轮询兜底，完全靠
 * `dsh-wechat-data-updated` 推送驱动（WAL 实时触发，后端限频后最快约每 250ms 一次）。
 * 口径（2026-10-13 用户要求「updated 一出来就立刻刷」）：**节流闸归零**——每次推送
 * 都立即刷新（一次只是一页 `getSessions`，120 条）；后端 WAL 监听已经按写簇合并，
 * 前端不再叠加合并窗，负载仍有上界。
 */
export const SESSIONS_REFRESH_MIN_INTERVAL_MS = 0
/**
 * 取渲染项代表的 local_id（日期分隔项没有，返回 -1）。
 * @param item - `buildMessageItems` 的产物。
 * @returns local_id，或 -1。
 */
export function itemLocalId(item: MessageRenderItem | undefined): number {
  if (!item || item.kind === 'day') return -1
  const head = item.kind === 'group' ? item.items[0] : item.m
  return head?.localId ?? -1
}
/**
 * 取渲染项的稳定 key（day 自带 key；消息按 localId，图片组按 gid+首条 localId）。
 * @param item - `buildMessageItems` 的产物。
 * @returns 虚拟化与 React 共用的 key。
 */
export function msgItemKey(item: MessageRenderItem | undefined): string {
  if (!item) return 'nil'
  if (item.kind === 'day') return item.key
  const stableId = (m: WechatMessage | undefined): string =>
    String(m?.localId ?? '') + '-' + String(m?.serverId ?? m?.createTime ?? '')
  if (item.kind === 'group') return 'grp-' + item.gid + '-' + stableId(item.items[0])
  return 'msg-' + stableId(item.m)
}
/**
 * 给虚拟列表 key 加会话命名空间。
 *
 * `local_id` 只在单个会话内唯一；不同会话复用同一个虚拟器时，仅按 `local_id`
 * 作 key 会把上一个会话的动态行高缓存套到当前会话，表现为巨大空白或消息重叠。
 * @param scope - 会话与打开代次组成的命名空间。
 * @param item - `buildMessageItems` 的产物。
 * @returns 跨会话唯一的虚拟项 key。
 */
export function scopedMsgItemKey(scope: string, item: MessageRenderItem | undefined): string {
  return scope + '\u0000' + msgItemKey(item)
}
/**
 * 虚拟化的初始高度估算（真实高度由 `measureElement` 量完回填）。
 *
 * 估得准不准只影响首帧的滚动条长度，不影响正确性；但**偏差太大**会让「回到底部」
 * 之类的定位多跳几次，所以这里按文本长度粗分三档（长文本在气泡里会换行）。
 * @param item - `buildMessageItems` 的产物。
 * @returns 预估像素高度。
 */
export function estimateMsgItemHeight(item: MessageRenderItem | undefined): number {
  if (!item) return 72
  if (item.kind === 'day') return 30
  const head = item.kind === 'group' ? item.items[0] : item.m
  const len = (head?.strContent ?? head?.displayText ?? head?.msgContent ?? '').length
  if (len > 400) return 160
  if (len > 120) return 104
  return 72
}
