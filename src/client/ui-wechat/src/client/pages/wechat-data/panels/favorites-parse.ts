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

/**
 * Extract text between <tag ...> and </tag> (first occurrence).
 *
 * CDATA 必须剥：微信收藏的 content 里 title/desc 就是 `<![CDATA[…]]>` 写法，
 * 不剥就把整串标记显示到卡片上。后端 `parse-xml.ts` 那份一直有剥，客户端这份兜底解析原先漏了。
 */
export function xmlTagText(xml: string, tag: string): string | null {
  const openExact = '<' + tag + '>'
  const openAttr = '<' + tag + ' '
  const start = xml.indexOf(openExact) >= 0 ? xml.indexOf(openExact) : xml.indexOf(openAttr)
  if (start < 0) return null
  const contentStart = xml.startsWith(openExact, start) ? start + openExact.length : (xml.indexOf('>', start) + 1)
  const close = xml.indexOf('</' + tag + '>', contentStart)
  if (close < 0) return null
  return stripCdata(xml.slice(contentStart, close))
}

/** 解开 `<![CDATA[…]]>` 外壳（两端都可能有空白；不是 CDATA 就原样返回）。 */
function stripCdata(value: string): string {
  const t = value.trim()
  const m = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(t)
  return m ? (m[1] ?? '') : value
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
  // 四条捕获都要用 `([\s\S]*?)` 而不是 `([^<]*)`：微信收藏 content 里这些字段是 CDATA 包的，
  // 而 `<![CDATA[…]]>` 本身以 `<` 开头 —— 旧的 `[^<]*` 连一个字符都匹配不上，
  // 于是"有 CDATA 的收藏"标题/来源直接变空（不只是难看，是那一格信息没了）。
  const title = (content.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || ''
  const raw = (content.match(/<desc>([\s\S]*?)<\/desc>/) || [])[1] || ''
  const fromUsr = (content.match(/<fromusr>([\s\S]*?)<\/fromusr>/) || [])[1] || ''
  const srcName = (content.match(/<datasrcname>([\s\S]*?)<\/datasrcname>/) || [])[1] || ''
  // 三条文本都要过实体解码：只解 `desc` 的话，标题里带 `&amp;` 的收藏会在卡片上显示成
  // 「A&amp;B」这串字面量（写这份测试时才发现，微信收藏的标题里 `&` 很常见）。
  return {
    title: decodeFavText(stripCdata(title)),
    desc: decodeFavText(stripCdata(raw)),
    fromUsr: stripCdata(fromUsr),
    srcName: decodeFavText(stripCdata(srcName)),
  }
}

/** 正数才保留；0/NaN 不显示成假信息。 */
function positiveInteger(value: string | null): number | undefined {
  const n = Number.parseInt(value ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/** 非负整数（`cdn_encryver=0` 是合法协议值，不能被当成缺失）。 */
function nonNegativeInteger(value: string | null): number | undefined {
  const n = Number.parseInt(value ?? '', 10)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

/** 正浮点数才保留。 */
function positiveFloat(value: string | null): number | undefined {
  const n = Number.parseFloat(value ?? '')
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/** 只有真正的 HTTP(S) 地址才能交给图片组件；CDN locator 是二进制协议字段。 */
function httpUrl(value: string): string {
  const text = value.trim()
  return /^https?:\/\//i.test(text) ? text : ''
}

/** 未知收藏资源仍尽量给出可读元信息，而不是只显示类型号。 */
function favMeta(body: string): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = []
  const fields: ReadonlyArray<readonly [string, string]> = [
    ['datafmt', '格式'],
    ['fullsize', '大小'],
    ['duration', '时长'],
    ['appid', 'AppID'],
    ['username', '账号'],
    ['pagepath', '页面'],
    ['url', '链接'],
    ['stream_weburl', '链接'],
    ['cdn_thumburl', '封面'],
    ['datatitle', '标题'],
    ['datadesc', '描述'],
  ]
  for (const [tag, label] of fields) {
    const value = decodeFavText(xmlTagText(body, tag) ?? '').trim()
    if (value) out.push({ label, value })
  }
  return out
}

/** `<appbranditem>` 位于 dataitem 之后，小程序详情必须从整条 content 找。 */
function parseAppBrand(content: string): Pick<FavItemPart, 'appId' | 'appUsername' | 'pagePath' | 'iconUrl'> {
  const start = content.indexOf('<appbranditem>')
  if (start < 0) return {}
  const end = content.indexOf('</appbranditem>', start)
  const body = end >= 0 ? content.slice(start, end) : content.slice(start)
  const appId = decodeFavText(xmlTagText(body, 'appid') ?? '').trim()
  const appUsername = decodeFavText(xmlTagText(body, 'username') ?? '').trim()
  const pagePath = decodeFavText(xmlTagText(body, 'pagepath') ?? '').trim()
  const iconUrl = decodeFavText(xmlTagText(body, 'iconurl') ?? '').trim()
  return {
    ...(appId ? { appId } : {}),
    ...(appUsername ? { appUsername } : {}),
    ...(pagePath ? { pagePath } : {}),
    ...(iconUrl ? { iconUrl } : {}),
  }
}

/** 位置收藏在顶层 `<locitem>`，没有 dataitem。 */
function parseLocation(content: string): FavItemPart | null {
  const start = content.indexOf('<locitem>')
  if (start < 0) return null
  const end = content.indexOf('</locitem>', start)
  const body = end >= 0 ? content.slice(start, end + '</locitem>'.length) : content.slice(start)
  const poiName = decodeFavText(xmlTagText(body, 'poiname') ?? '').trim()
  const address = decodeFavText(xmlTagText(body, 'label') ?? '').trim()
  if (!poiName && !address) return null
  const lat = Number.parseFloat(xmlTagText(body, 'lat') ?? '')
  const lng = Number.parseFloat(xmlTagText(body, 'lng') ?? '')
  const category = decodeFavText(xmlTagText(body, 'poiCategoryTips') ?? '').trim()
  const businessHours = decodeFavText(xmlTagText(body, 'poiBusinessHour') ?? '').trim()
  const phone = decodeFavText(xmlTagText(body, 'poiPhone') ?? '').trim()
  return {
    kind: 'location',
    text: [poiName, address].filter(Boolean).join(' · '),
    title: poiName || address,
    ...(poiName ? { poiName } : {}),
    ...(address ? { address } : {}),
    ...(Number.isFinite(lat) ? { lat } : {}),
    ...(Number.isFinite(lng) ? { lng } : {}),
    ...(category ? { category } : {}),
    ...(businessHours ? { businessHours } : {}),
    ...(phone ? { phone } : {}),
    ...(Number.isFinite(lat) && Number.isFinite(lng)
      ? { url: `https://uri.amap.com/marker?position=${String(lng)},${String(lat)}&name=${encodeURIComponent(poiName || address)}` }
      : {}),
  }
}

/** 客户端兜底解析资源条目；未知 datatype 也必须保留成卡片。 */
export function parseFavParts(content: string): FavItemPart[] {
  if (!content || !content.includes('<')) return []
  const out: FavItemPart[] = []
  const location = parseLocation(content)
  if (location) out.push(location)
  let pos = 0
  for (;;) {
    const start = content.indexOf('<dataitem', pos)
    if (start < 0) break
    const end = content.indexOf('</dataitem>', start)
    const body = end >= 0 ? content.slice(start, end) : content.slice(start)
    const dataType = Number.parseInt(xmlTagAttr(body, 'dataitem', 'datatype') ?? '0', 10) || 0
    const dataId = (xmlTagAttr(body, 'dataitem', 'dataid') ?? '').trim().toLowerCase()
    const fullMd5 = (xmlTagText(body, 'fullmd5') ?? '').trim().toLowerCase() || dataId
    const thumbMd5 = (xmlTagText(body, 'thumbfullmd5') ?? '').trim().toLowerCase()
    const fullSize = positiveInteger(xmlTagText(body, 'fullsize'))
    const thumbSize = positiveInteger(xmlTagText(body, 'thumbfullsize'))
    const cdnDataUrl = (xmlTagText(body, 'cdn_dataurl') ?? '').trim()
    const cdnDataKey = (xmlTagText(body, 'cdn_datakey') ?? '').trim()
    const cdnThumbUrl = (xmlTagText(body, 'cdn_thumburl') ?? '').trim()
    const cdnThumbKey = (xmlTagText(body, 'cdn_thumbkey') ?? '').trim()
    const cdnEncryVer = nonNegativeInteger(xmlTagText(body, 'cdn_encryver'))
    const sourceId = (xmlTagText(body, 'sourceid') ?? '').trim()
    const dataSourceId = (xmlTagAttr(body, 'dataitem', 'datasourceid') ?? '').trim()
    const title = decodeFavText(xmlTagText(body, 'datatitle') ?? '').trim()
    const desc = decodeFavText(xmlTagText(body, 'datadesc') ?? '').trim()
    const text = desc || title
    const sourceName = decodeFavText(xmlTagText(body, 'datasrcname') ?? '').trim()
    const sourceTime = (xmlTagText(body, 'datasrctime') ?? '').trim()
    const sourceHead = (xmlTagText(body, 'sourceheadurl') ?? '').trim()
    const base = (): FavItemPart => {
      const p: FavItemPart = { kind: 'text', dataType }
      if (title) p.title = title
      if (desc) p.desc = desc
      if (sourceName) p.sourceName = sourceName
      if (sourceTime) p.sourceTime = sourceTime
      if (sourceHead) p.sourceHead = sourceHead
      if (fullSize !== undefined) p.fullSize = fullSize
      if (thumbSize !== undefined) p.thumbSize = thumbSize
      if (cdnDataUrl) p.cdnDataUrl = cdnDataUrl
      if (cdnDataKey) p.cdnDataKey = cdnDataKey
      if (cdnThumbUrl) p.cdnThumbUrl = cdnThumbUrl
      if (cdnThumbKey) p.cdnThumbKey = cdnThumbKey
      if (cdnEncryVer !== undefined) p.cdnEncryVer = cdnEncryVer
      if (sourceId) p.sourceId = sourceId
      if (dataSourceId) p.dataSourceId = dataSourceId
      return p
    }
    if (dataType === 1) {
      if (text) { const p = base(); p.text = text; out.push(p) }
    } else if (dataType === 2) {
      const p = base()
      p.kind = 'image'
      if (thumbMd5 || fullMd5) p.md5 = thumbMd5 || fullMd5
      if (fullMd5) p.fullMd5 = fullMd5
      if (thumbMd5) p.thumbMd5 = thumbMd5
      if (text) p.text = text
      out.push(p)
    } else if (dataType === 3) {
      const p = base()
      p.kind = 'voice'
      if (fullMd5) p.md5 = fullMd5
      if (fullMd5) p.fullMd5 = fullMd5
      const format = (xmlTagText(body, 'datafmt') ?? '').trim().toLowerCase()
      if (format) p.format = format
      const durationMs = positiveInteger(xmlTagText(body, 'duration'))
      if (durationMs !== undefined) {
        p.durationMs = durationMs
        p.duration = durationMs / 1000
      }
      const svrId = (xmlTagText(body, 'fromnewmsgid') ?? xmlTagText(body, 'sourceid') ?? '').trim()
      if (svrId) p.svrId = svrId
      out.push(p)
    } else if (dataType === 4) {
      const p = base()
      p.kind = 'video'
      if (thumbMd5 || fullMd5) p.md5 = thumbMd5 || fullMd5
      if (fullMd5) p.fullMd5 = fullMd5
      if (thumbMd5) p.thumbMd5 = thumbMd5
      const duration = positiveFloat(xmlTagText(body, 'duration'))
      if (duration !== undefined) p.duration = duration
      if (text) p.text = text
      out.push(p)
    } else if (dataType === 5 || dataType === 36) {
      const p = base()
      p.kind = 'link'
      if (text) p.text = text
      const url = decodeFavText(xmlTagText(body, 'stream_weburl') ?? xmlTagText(body, 'url') ?? '').trim()
      if (url) p.url = url
      const cover = httpUrl(xmlTagText(body, 'cdn_thumburl') ?? '')
      if (cover) p.coverUrl = cover
      out.push(p)
    } else if (dataType === 8) {
      const p = base()
      p.kind = 'file'
      const name = title || desc
      if (name) p.name = name
      const ext = (xmlTagText(body, 'datafmt') ?? '').trim().toLowerCase()
      if (ext) p.ext = ext
      const size = fullSize
      if (size !== undefined) p.size = size
      if (fullMd5) p.fullMd5 = fullMd5
      out.push(p)
    } else if (dataType === 19) {
      const p = base()
      p.kind = 'miniapp'
      if (text) p.text = text
      Object.assign(p, parseAppBrand(content))
      if (thumbMd5 || fullMd5) p.md5 = thumbMd5 || fullMd5
      if (thumbMd5) p.thumbMd5 = thumbMd5
      if (fullMd5) p.fullMd5 = fullMd5
      out.push(p)
    } else if (dataType === 7 || dataType === 16 || dataType === 18 || dataType === 20) {
      const p = base()
      p.kind = dataType === 7 ? 'music' : dataType === 16 ? 'product' : dataType === 18 ? 'note' : 'channels'
      if (text) p.text = text
      const url = decodeFavText(xmlTagText(body, 'stream_weburl') ?? xmlTagText(body, 'url') ?? '').trim()
      if (url) p.url = url
      const cover = httpUrl(decodeFavText(xmlTagText(body, 'cdn_thumburl') ?? ''))
      if (cover) p.coverUrl = cover
      const musicUrl = decodeFavText(xmlTagText(body, 'music_url') ?? '').trim()
      if (musicUrl) p.url = p.url ?? musicUrl
      if (thumbMd5 || fullMd5) p.md5 = thumbMd5 || fullMd5
      if (thumbMd5) p.thumbMd5 = thumbMd5
      if (fullMd5) p.fullMd5 = fullMd5
      out.push(p)
    } else {
      const p = base()
      p.kind = 'unknown'
      if (text) p.text = text
      const url = decodeFavText(xmlTagText(body, 'stream_weburl') ?? xmlTagText(body, 'url') ?? '').trim()
      if (url) p.url = url
      const cover = httpUrl(decodeFavText(xmlTagText(body, 'cdn_thumburl') ?? ''))
      if (cover) p.coverUrl = cover
      const meta = favMeta(body)
      if (meta.length > 0) p.meta = meta
      if (thumbMd5 || fullMd5) p.md5 = thumbMd5 || fullMd5
      if (thumbMd5) p.thumbMd5 = thumbMd5
      if (fullMd5) p.fullMd5 = fullMd5
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
