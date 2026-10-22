
/**
 * Chats 面板的小工具与头像/图标（M21 第三十二刀自 Chats.tsx 拆出）。
 *
 * 这些原先都是 Chats.tsx 里的顶层函数/组件（不吃面板状态，只吃道具）—— 整段原样搬出，
 * 面板按需 import。依赖由脚本从「这块里真实用到的面板 import」生成。
 */
import { apiGetAvatar, apiGetMessageFile, apiGetAvatarBatched } from '../api.ts'
import { avatarColors, fmtDateTimeSec } from '../utils/format.ts'
import { MessageRenderItem } from '../utils/message-items.ts'
import { cacheBounded, copyTextToClipboard } from '../utils/misc.ts'
import css from './chats.module.css'
import cssrows from './chats-rows.module.css'
import { MessageRenderKind as RenderKind, WechatMessage, WechatSession } from '@deepseek-ai/dsh-wechat-data/types'
import { useEffect, useState } from 'react'
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

/**
 * 右键菜单「打开文件」：把消息自带的体积/时间透传给后端，
 * 否则同名文件会在别的会话里随便挑一份。
 * @param fileName - 文件名。
 * @param m - 该消息（取 fileSize 与 createTime 作为归属线索）。
 * @param flash - 回执写入。
 */
export function openMessageFileWithNotice(fileName: string, m: WechatMessage, flash: (t: string) => void): void {
  const bytes = Number(m.rich?.fileSize)
  const opts: { size?: number; createTime?: number } = {}
  if (Number.isFinite(bytes) && bytes > 0) opts.size = bytes
  if (m.createTime) opts.createTime = m.createTime
  void downloadMessageFile(fileName, opts).then((err) => { if (err) flash('打开失败：' + err) })
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
/** Wechat transfer state label (mirrors st_control transfer_status_label). */
export function transferStatusLabel(self: boolean, paySub: string | undefined): string {
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
export function transferStateKey(paySub: string | undefined): 'pending' | 'accepted' | 'refunded' {
  switch (paySub) {
    case '1': case '7': return 'pending'
    case '4': case '5': case '9': case '10': return 'refunded'
    default: return 'accepted'
  }
}
/** White check glyph: transfer received/accepted state. */
export function TransferCheckGlyph(): React.JSX.Element {
  return (
    <svg width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="m4 8.4 2.6 2.6L12 5.6" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
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
 * @param props.size - 头像边长（px）。
 * @returns the avatar element.
 */
export function Avatar({ name, username, size }: { name: string; username: string; size?: number }): React.JSX.Element {
  const key = username
  const cached = key ? avatarCache.get(key) : undefined
  const [, force] = useState(0)
  useEffect(() => {
    let cancelled = false
    if (!key || cached !== undefined) return
    // W2-10.2：走攒批队列 —— 一屏 N 个 Avatar 合成一次 `getAvatarsLocal`，而不是 N 次
    // `getAvatar`（实测 200 个头像 5.6×，且少 199 次 IPC 往返）。未命中的那几条由队列
    // 内部退回单张 —— 那里还有一级「按昵称找联系人」的回落，批量接口没有这一级。
    // nickname 只供这一级回落使用；缓存键仍是真实 username，绝不能换成展示名。
    apiGetAvatarBatched({ username: key, nickname: name })
      .then((r) => {
        const value = r.kind === 'data' ? (r.data ?? null) : null
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
      <div className={cssrows.avatar} style={{ width: size ?? 34, height: size ?? 34, overflow: 'hidden' }}>
        <img src={src} alt={letter} className={cssrows.avatarImg} width={size ?? 34} height={size ?? 34} />
      </div>
    )
  }
  return (
    <div className={cssrows.avatar} style={{ width: size ?? 34, height: size ?? 34, background: av.background, color: av.color }}>
      {letter}
    </div>
  )
}
/** 不同扩展名的图标风格（kind + emoji），便于按类型区分样式。 */
export const FILE_STYLE: Record<string, { kind: string; emoji: string }> = {
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
export function fileStyle(fileName: string): { kind: string; emoji: string } {
  const ext = (fileName.split('.').pop() || '').toLowerCase()
  return FILE_STYLE[ext] || { kind: 'file', emoji: '📁' }
}
/**
 * 从 `msg/file` 本地缓存取回收到的文件并触发下载。
 *
 * 抽成模块级函数的唯一原因：文件卡的点击区与右键菜单的「打开文件」
 * 都要走同一条链路，不能各写一份（两份实现迟早会在错误文案上分叉）。
 * @param fileName - 消息里的文件名。
 * @param opts - 归属线索：消息里的文件字节数、接收时间与附件 MD5。
 *   `msg/file` 只按月份分目录，同名文件可能属于别的会话；同名同大小时
 *   `fileMd5` 是唯一可靠的消歧键。
 * @returns 成功返回空串，失败返回可展示的错误文案。
 */
export async function downloadMessageFile(
  fileName: string,
  opts: { size?: number; createTime?: number; fileMd5?: string } = {},
): Promise<string> {
  try {
    const r = await apiGetMessageFile({
      fileName,
      ...(opts.size !== undefined ? { size: opts.size } : {}),
      ...(opts.createTime !== undefined ? { createTime: opts.createTime } : {}),
      ...(opts.fileMd5 !== undefined ? { fileMd5: opts.fileMd5 } : {}),
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
/**
 * 引用消息里被引用类型 → 中文短标签（后端已写好 `rich.referType`）。
 *
 * 微信 refermsg 的 type 与消息 local_type 同一编码族：媒体用本类型号，
 * 应用消息多在 49 族。没有映射时返回空串，界面不硬造标签。
 * @param t - refermsg <type>.
 * @returns 中文标签（''）。
 */
export function quoteTypeLabel(t: number | undefined): string {
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
/** Enterprise-WeChat conversation detection (@openim / @weclaw / kefu). */
export function isEnterpriseChat(u: string): boolean {
  const s = (u || '').toLowerCase()
  return s.endsWith('@openim') || s.endsWith('@weclaw')
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
 * `dsh-wechat-data-updated` 推送驱动（WAL 实时触发，活跃聊天时约每 1.5–7s 一次）。
 * 口径（2026-10-13 用户要求「updated 一出来就立刻刷」）：**节流闸归零**——每次推送
 * 都立即刷新（一次只是一页 `getSessions`，120 条），风暴由 50ms 合并窗吸收；
 * 后端推送本身已带 1.5s 限频，所以最坏也只是每 1.5s 一次刷新，负载无压力。
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
  if (item.kind === 'group') return 'grp-' + item.gid + '-' + String(item.items[0]?.localId ?? '')
  return 'msg-' + String(item.m.localId)
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
