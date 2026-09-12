/**
 * 聊天文本气泡的**分段渲染**：把一条消息的文本切成
 * 「普通文本 / 链接 / 表情图 / @提及」四类片段，再用一个组件统一输出。
 *
 * 为什么必须是一趟切分而不是三个独立的 replace：
 * `[微笑] https://x.com/@张三` 这种文本里，@ 恰好落在链接内部，@张三 又可能
 * 与表情代码相邻。分开做「先链后表情」会把链接里的 `//` 当成颜文字、
 * 或把 `@` 高亮进 URL。这里按位置排序、**互不重叠**地切分一次。
 *
 * 三类的判据（都与后端的字段口径对齐）：
 *  - 表情：`utils/wechat-emojis.ts` 的 886 行表情表（中文名/英文名/颜文字）；
 *  - 链接：`https?://` 明文 URL，尾部的中文标点要剥掉（否则复制出来带「，」）；
 *  - 提及：后端 `msg.atUsers`（来自 `source` 列的 `<atuserlist>`）里的
 *    `displayName` / `@所有人`。**只有**结构化列表里的名字才高亮 ——
 *    纯文本里的 `@` 很常见（邮箱、代码），正则猜会大量误标。
 */
import React from 'react'
import type { MessageAtUser } from '@deepseek-ai/dsh-wechat-data/types'
import { parseTextWithEmoji } from './wechat-emojis.ts'
import css from '../panels/chats.module.css'

/** 一个文本片段。 */
export interface MsgSegment {
  type: 'text' | 'link' | 'emoji' | 'mention'
  content: string
  /** 链接片段的目标地址（已剥尾标点）。 */
  url?: string
  /** 表情片段的图片地址。 */
  emojiSrc?: string
  /** 提及片段对应的用户。 */
  user?: MessageAtUser
}

/** 明文 URL（非贪婪到空白/引号/尖括号）。 */
const URL_RE = /https?:\/\/[^\s<>"']+/g
/** URL 尾部被误吞的中文/英文标点。 */
const URL_TAIL_RE = /[。，；、！？）)】》>．,.!?;:]+$/

/** 提及边界：@ 前必须是行首或空白/左括号。 */
const MENTION_LEADING_RE = /[\s\u00a0([（{、,，]/
/** 提及名后面允许的边界字符。 */
const MENTION_TRAILING_RE = /[\s\u00a0,，.。!！?？:：;；、)）】》]/

/**
 * 在文本里定位每个 mention 的出现区间。
 *
 * 优先整词匹配 `@显示名`（要求后一个字符是边界），匹配不到时退回
 * 「下一个 @ 到空白」的通用形态 —— 群里改名后 displayName 可能对不上，
 * 此时仍然高亮更符合预期。
 * @param text - the bubble text.
 * @param atUsers - structured at-users from the backend.
 * @returns non-overlapping [start, end) ranges with their user.
 */
function mentionRanges(text: string, atUsers: readonly MessageAtUser[]): Array<{ start: number; end: number; user: MessageAtUser }> {
  if (!text || atUsers.length === 0 || !text.includes('@')) return []
  const out: Array<{ start: number; end: number; user: MessageAtUser }> = []
  let cursor = 0
  for (const user of atUsers) {
    const label = (user.displayName || '').replace(/^@+/, '').trim()
    let found: { start: number; end: number } | null = null
    if (label) {
      const token = '@' + label
      let from = cursor
      for (;;) {
        const i = text.indexOf(token, from)
        if (i < 0) break
        const before = i > 0 ? text.charAt(i - 1) : ''
        const after = text.charAt(i + token.length)
        if ((!before || MENTION_LEADING_RE.test(before)) && (!after || MENTION_TRAILING_RE.test(after))) {
          found = { start: i, end: i + token.length }
          break
        }
        from = i + 1
      }
    }
    if (!found) {
      // 兜底：下一个 `@` + 到分隔符为止的连续非空白字符
      let i = cursor
      for (;;) {
        const at = text.indexOf('@', i)
        if (at < 0) break
        const before = at > 0 ? text.charAt(at - 1) : ''
        if (before && !MENTION_LEADING_RE.test(before)) { i = at + 1; continue }
        let end = at + 1
        while (end < text.length && !/\s/.test(text.charAt(end))) end += 1
        if (end > at + 1) { found = { start: at, end }; break }
        i = at + 1
      }
    }
    if (found && found.start >= cursor) {
      out.push({ ...found, user })
      cursor = found.end
    }
  }
  return out
}

/**
 * 把消息文本切成互不重叠的片段（表情 / 链接 / 提及 / 文本）。
 * @param text - the bubble text (already the backend's readable displayText).
 * @param atUsers - structured at-users (group messages only; may be undefined).
 * @returns ordered segments covering the whole text.
 */
export function parseMessageSegments(text: string, atUsers?: readonly MessageAtUser[]): MsgSegment[] {
  const raw = text ?? ''
  if (!raw) return []

  // 1. 先按表情切（表情表是权威的，且表情代码里含 `[` `]` `/` `:` 等，
  //    留给后面的 URL/@ 正则处理会互相干扰）。
  const emojiParts = parseTextWithEmoji(raw)
  // 2. 在「非表情」片段里再切链接与提及。
  const out: MsgSegment[] = []
  let offset = 0
  for (const part of emojiParts) {
    const start = offset
    offset += part.content.length
    if (part.type === 'emoji') {
      out.push({ type: 'emoji', content: part.content, ...(part.emojiSrc ? { emojiSrc: part.emojiSrc } : {}) })
      continue
    }
    out.push(...splitPlain(part.content, start, raw, atUsers))
  }
  return out
}

/**
 * 在纯文本片段里切出链接与提及。
 * @param chunk - the plain-text chunk.
 * @param base - the chunk's offset within the original text (for mention lookup).
 * @param full - the original full text (mentions are located there, then clipped).
 * @param atUsers - structured at-users.
 * @returns segments for this chunk.
 */
function splitPlain(chunk: string, base: number, full: string, atUsers?: readonly MessageAtUser[]): MsgSegment[] {
  // 收集本片段范围内的「区间标记」，再按位置排序取并集。
  const marks: Array<{ start: number; end: number; seg: MsgSegment }> = []
  const chunkEnd = base + chunk.length

  for (const m of chunk.matchAll(URL_RE)) {
    const rawUrl = m[0]
    const clean = rawUrl.replace(URL_TAIL_RE, '')
    if (!clean) continue
    const s = m.index ?? 0
    marks.push({ start: s, end: s + clean.length, seg: { type: 'link', content: clean, url: clean } })
  }

  if (atUsers && atUsers.length > 0) {
    for (const r of mentionRanges(full, atUsers)) {
      if (r.start < base || r.end > chunkEnd) continue
      const s = r.start - base
      marks.push({ start: s, end: r.end - base, seg: { type: 'mention', content: full.slice(r.start, r.end), user: r.user } })
    }
  }

  if (marks.length === 0) return chunk ? [{ type: 'text', content: chunk }] : []
  marks.sort((a, b) => a.start - b.start || b.end - a.end)

  const out: MsgSegment[] = []
  let cursor = 0
  for (const mk of marks) {
    if (mk.start < cursor) continue // 与已输出区间重叠（如 @ 落在链接里）→ 丢弃
    if (mk.start > cursor) out.push({ type: 'text', content: chunk.slice(cursor, mk.start) })
    out.push(mk.seg)
    cursor = mk.end
  }
  if (cursor < chunk.length) out.push({ type: 'text', content: chunk.slice(cursor) })
  return out
}

/**
 * 文本气泡渲染：表情走图片、链接可点、提及高亮。
 *
 * 交互约定（与 `check-ui-consistency` / `audit-a11y-clickable` 一致）：
 * 只有链接是真的可点，用真正的 `<a href>`（读屏能播报「链接」、右键可复制地址）；
 * 提及是**展示性**强调，不加 role/tabIndex，避免在 Tab 序列里塞进一堆死焦点。
 * @param props.text - the bubble text.
 * @param props.atUsers - structured at-users.
 * @param props.onOpenLink - external-link handler (protocol-checked by the caller).
 * @returns the inline element list.
 */
export function MessageText({ text, atUsers, onOpenLink }: {
  text: string
  atUsers?: readonly MessageAtUser[]
  onOpenLink: (url: string) => void
}): React.JSX.Element {
  const segments = parseMessageSegments(text, atUsers)
  if (segments.length === 0) return <>{' '}</>
  return (
    <>
      {segments.map((seg, idx) => {
        if (seg.type === 'emoji') {
          return (
            <img
              key={idx}
              className={css.msgEmojiImg}
              src={seg.emojiSrc}
              alt={seg.content}
              title={seg.content}
              loading="lazy"
              decoding="async"
            />
          )
        }
        if (seg.type === 'link') {
          return (
            <a
              key={idx}
              className={css.msgTextLink}
              href={seg.url}
              title={seg.url}
              rel="noopener noreferrer"
              onClick={(e) => { e.preventDefault(); onOpenLink(seg.url ?? '') }}
            >
              {seg.content}
            </a>
          )
        }
        if (seg.type === 'mention') {
          return (
            <span key={idx} className={css.msgMention} title={seg.user?.username}>
              {seg.content}
            </span>
          )
        }
        return <React.Fragment key={idx}>{seg.content}</React.Fragment>
      })}
    </>
  )
}
