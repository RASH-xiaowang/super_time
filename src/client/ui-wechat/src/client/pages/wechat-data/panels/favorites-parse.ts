/**
 * 收藏条目的解析族（纯函数，不依赖 React）—— 从 `Favorites.tsx` 搬出来，
 * 一是让虚拟化的行组件能引用它（面板与卡片互相 import 会撞循环依赖守卫），
 * 二是这 160 行「后端字段优先、缺失时客户端兜底解析 XML」的逻辑第一次能单独测。
 *
 * 口径没动：后端字段有就用，没有才解 XML；`desc`/`title` 的空值回退顺序保持原样
 * （占位符在这里必须传空串，`f.time ||` 那一串依赖「空值仍是空串而不是破折号」）。
 */
import type { FavItemPart, FavorItem } from '@deepseek-ai/dsh-wechat-data/types'
import { fmtDateTimeSec } from '../utils/format.ts'

/** 收藏类型 → 中文标签（微信 fav type）。 */
export function favTypeLabel(type: number): string {
  switch (type) {
    case 1: return '文本'
    case 2: return '图片'
    case 3: return '语音'
    case 4: return '视频'
    case 5: return '链接'
    case 6: return '位置'
    case 7: return '音乐'
    case 8: return '文件'
    case 14: return '聊天记录'
    case 16: return '商品'
    case 18: return '笔记'
    case 19: return '小程序'
    case 20: return '视频号'
    default: return '其他'
  }
}

/** Unescape XML/HTML entities (keep newlines). */
export function decodeFavText(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x0A;/gi, '\n')
    .replace(/&#10;/g, '\n')
}

/** Extract text between <tag ...> and </tag> (first occurrence). */
export function xmlTagText(xml: string, tag: string): string | null {
  const openExact = '<' + tag + '>'
  const openAttr = '<' + tag + ' '
  const start = xml.indexOf(openExact) >= 0 ? xml.indexOf(openExact) : xml.indexOf(openAttr)
  if (start < 0) return null
  const contentStart = xml.startsWith(openExact, start) ? start + openExact.length : (xml.indexOf('>', start) + 1)
  const close = xml.indexOf('</' + tag + '>', contentStart)
  if (close < 0) return null
  return xml.slice(contentStart, close)
}

/** Extract an attribute value from a tag open (first occurrence). */
export function xmlTagAttr(xml: string, tag: string, attr: string): string | null {
  const openExact = '<' + tag + '>'
  const openAttr = '<' + tag + ' '
  const start = xml.indexOf(openExact) >= 0 ? xml.indexOf(openExact) : xml.indexOf(openAttr)
  if (start < 0) return null
  const tagStr = xml.slice(start, xml.indexOf('>', start))
  const search = attr + '="'
  const a = tagStr.indexOf(search)
  if (a < 0) return null
  const v = a + search.length
  const e = tagStr.indexOf('"', v)
  if (e < 0) return null
  return tagStr.slice(v, e)
}

/** 客户端兜底解析收藏 XML 的标题/描述/来源。 */
export function parseFavXml(content: string): { title: string; desc: string; fromUsr: string; srcName: string } {
  if (!content || !content.includes('<')) return { title: '', desc: content || '', fromUsr: '', srcName: '' }
  const title = (content.match(/<title>([^<]*)<\/title>/) || [])[1] || ''
  const raw = (content.match(/<desc>([\s\S]*?)<\/desc>/) || [])[1] || ''
  const fromUsr = (content.match(/<fromusr>([^<]*)<\/fromusr>/) || [])[1] || ''
  const srcName = (content.match(/<datasrcname>([^<]*)<\/datasrcname>/) || [])[1] || ''
  // 三条文本都要过实体解码：只解 `desc` 的话，标题里带 `&amp;` 的收藏会在卡片上显示成
  // 「A&amp;B」这串字面量（写这份测试时才发现，微信收藏的标题里 `&` 很常见）。
  return { title: decodeFavText(title), desc: decodeFavText(raw), fromUsr, srcName: decodeFavText(srcName) }
}

/** 客户端兜底解析 `<datalist><dataitem>` 资源条目。 */
export function parseFavParts(content: string): FavItemPart[] {
  if (!content || !content.includes('<dataitem')) return []
  const out: FavItemPart[] = []
  let pos = 0
  for (;;) {
    const start = content.indexOf('<dataitem', pos)
    if (start < 0) break
    const end = content.indexOf('</dataitem>', start)
    const body = end >= 0 ? content.slice(start, end) : content.slice(start)
    const datatype = Number.parseInt(xmlTagAttr(body, 'dataitem', 'datatype') ?? '0', 10) || 0
    const dataid = (xmlTagAttr(body, 'dataitem', 'dataid') ?? '').trim().toLowerCase()
    const fullmd5 = (xmlTagText(body, 'fullmd5') ?? '').trim().toLowerCase()
    const thumbmd5 = (xmlTagText(body, 'thumbfullmd5') ?? '').trim().toLowerCase()
    const text = decodeFavText(xmlTagText(body, 'datadesc') ?? '') || decodeFavText(xmlTagText(body, 'datatitle') ?? '')
    const sourceName = decodeFavText(xmlTagText(body, 'datasrcname') ?? '')
    const sourceTime = xmlTagText(body, 'datasrctime') ?? ''
    const base = (): FavItemPart => {
      const p: FavItemPart = { kind: 'text' }
      if (sourceName) p.sourceName = sourceName
      if (sourceTime) p.sourceTime = sourceTime
      return p
    }
    if (datatype === 1) {
      if (text) { const p = base(); p.text = text; out.push(p) }
    } else if (datatype === 2) {
      const p = base()
      p.kind = 'image'
      const m = thumbmd5 || fullmd5 || dataid
      if (m) p.md5 = m
      if (text) p.text = text
      out.push(p)
    } else if (datatype === 3) {
      const p = base()
      p.kind = 'voice'
      const m = fullmd5 || dataid
      if (m) p.md5 = m
      out.push(p)
    } else if (datatype === 4) {
      const p = base()
      p.kind = 'video'
      const m = fullmd5 || dataid
      if (m) p.md5 = m
      const dur = Number.parseFloat(xmlTagText(body, 'duration') ?? '0')
      if (dur > 0) p.duration = dur
      out.push(p)
    } else if (datatype === 5 || datatype === 19 || datatype === 36) {
      const p = base()
      p.kind = 'link'
      if (text) p.text = text
      const u = (xmlTagText(body, 'stream_weburl') ?? xmlTagText(body, 'url') ?? '').replace(/&amp;/g, '&')
      if (u) p.url = u
      out.push(p)
    } else if (datatype === 8) {
      const p = base()
      p.kind = 'file'
      const n = xmlTagText(body, 'datatitle') ?? ''
      if (n) p.name = n
      const e = xmlTagText(body, 'datafmt') ?? ''
      if (e) p.ext = e
      const sz = Number.parseInt(xmlTagText(body, 'fullsize') ?? '0', 10)
      if (sz > 0) p.size = sz
      out.push(p)
    }
    pos = end >= 0 ? end + 10 : content.length
  }
  return out
}

/** 规范化一条收藏：后端字段优先，缺失时客户端兜底解析。 */
export function parseFavItem(f: FavorItem): {
  title: string
  desc: string
  url: string
  source: string
  time: string
  typeLabel: string
  items: FavItemPart[]
} {
  const info = parseFavXml(f.content)
  const typeLabel = f.typeLabel || favTypeLabel(f.type)
  const items = f.items ?? parseFavParts(f.content)
  const source = f.source || f.chatName || info.srcName || info.fromUsr || f.fromUsr || ''
  // 占位符传空串：这里与 `f.time ||` 配合，空值必须仍是空串而不是 '—'。
  const time = f.time || fmtDateTimeSec(f.updateTime, '')
  return {
    title: f.title || info.title || typeLabel,
    desc: f.desc || info.desc || '',
    url: f.url || '',
    source,
    time,
    typeLabel,
    items,
  }
}
