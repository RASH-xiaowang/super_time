/**
 * Favorites queries over st_control's decrypted favorite.db (fav_db_item).
 * Parses content XML (favitem type/desc/dataitem) into title/desc/url and
 * resolves sources via contact names, mirroring st_control modules/favorites.rs.
 */
import { DatabaseSync } from './db-open.ts'
import { withWritableDb } from './db-open.ts'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { contactMeta } from './meta.ts'
import { stripCdata } from './parse-xml.ts'
import { fmtDateTimeSec } from '../format.ts'
import { resolveAvatarsLocal } from './avatar.ts'
import type { FavItemPart } from '../types.ts'

/** Coerce a DB cell to a string (null -> '', else String()). */
function cellStr(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === null || v === undefined) return ''
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol') return String(v)
  if (v instanceof Uint8Array) return new TextDecoder('utf-8', { fatal: false }).decode(v)
  return ''
}

/** Unescape XML/HTML entities (keep newlines/tabs). */
function decodeFavText(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x0A;/gi, '\n')
    .replace(/&#10;/g, '\n')
    .replace(/&#x0D;/gi, '\r')
    .replace(/&#13;/g, '\r')
    .replace(/&#x09;/gi, '\t')
    .replace(/&#9;/g, '\t')
}

/**
 * Extract text between <tag ...> and </tag> (first occurrence).
 *
 * 与 `moments.ts` 同一条规则：收藏 content 里的 title/desc/url 也是 CDATA 包的，
 * 不剥就把 `<![CDATA[…]]>` 显示到卡片上（共享原语 parse-xml.ts 一直有剥，本地副本是漏的那几处）。
 */
function xmlTagText(xml: string, tag: string): string | null {
  const openExact = '<' + tag + '>'
  const openAttr = '<' + tag + ' '
  const start = xml.indexOf(openExact) >= 0 ? xml.indexOf(openExact) : xml.indexOf(openAttr)
  if (start < 0) return null
  const contentStart = xml.startsWith(openExact, start) ? start + openExact.length : (xml.indexOf('>', start) + 1)
  const close = xml.indexOf('</' + tag + '>', contentStart)
  if (close < 0) return null
  return stripCdata(xml.slice(contentStart, close))
}

/** Extract an attribute value from a tag open (first occurrence). */
function xmlTagAttr(xml: string, tag: string, attr: string): string | null {
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

/** Extract text of the first nested tag inside a parent tag. */
function xmlNestedText(xml: string, parent: string, child: string): string | null {
  const open = '<' + parent + '>'
  const start = xml.indexOf(open)
  if (start < 0) return null
  const close = xml.indexOf('</' + parent + '>', start + open.length)
  if (close < 0) return null
  return xmlTagText(xml.slice(start, close + open.length + parent.length + 3), child)
}

/** 收藏类型标签（微信 fav type）。 */
export function favTypeLabel(t: number): string {
  switch (t) {
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

/** Strip XML tags for text-type fallback. */
function stripXmlTags(xml: string): string {
  return decodeFavText(xml.replace(/<[^>]+>/g, '')).trim()
}

/** 取文本首行作为卡片标题（去掉空行、限长）。 */
function firstLineTitle(text: string): string {
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t) return t.length > 28 ? t.slice(0, 28) + '…' : t
  }
  return ''
}

/**
 * Parse favourites content XML into (title, desc, url).
 *
 * 第 44 轮修正了四处**取错元素**（都以真实 XML 为据，实测 71 条收藏里约 58 条因此显示不出标题）：
 *
 * | favType | 原始 XML 里的实际位置 | 旧实现读的位置 | 后果 |
 * | --- | --- | --- | --- |
 * | 1 文本 | `<desc>`（含 `&#x0A;` 等实体） | 读了 `<title>`（不存在）且**没解码** | 标题退化成「文本」，正文直接显示 `&#x0A;` |
 * | 8 文件（42 条） | `<desc>` = 文件名 | 读了 `<title>`（不存在） | 标题退化成「文件」 |
 * | 5 链接 | 顶层 `<title>` 可为空，`<dataitem><datatitle>` 有值 | 只读顶层 | 6 条里 5 条标题退化成「链接」 |
 * | 6 位置 | `<locitem><poiname>` / `<locitem><label>`（**元素**） | 读 `<location poiname="…">`（**属性**） | 标题退化成「位置」 |
 *
 * 客户端的 `parseFavItem` 是 `f.title || info.title || typeLabel`，所以后端给空就会一路掉到
 * 类型标签 —— 修复点放在后端，所有消费方一致受益。
 */
export function parseFavContent(favType: number, xml: string): { title: string; desc: string; url: string } {
  if (!xml) return { title: '', desc: '', url: '' }
  const t = 'title'
  const d = 'desc'
  const title = xmlTagText(xml, t) ?? ''
  const descRaw = xmlTagText(xml, d) ?? ''
  if (favType === 1) {
    // 正文在 <desc>；必须解码实体，否则界面显示 `&#x0A;`（实测 5/9 条文本收藏如此）。
    const text = decodeFavText(descRaw || (xml.includes('<') ? stripXmlTags(xml) : xml))
    return { title: firstLineTitle(text), desc: text, url: '' }
  }
  if (favType === 8) {
    // 文件名在 <desc>（与 <dataitem><datatitle> 一致），顶层没有 <title>。
    const name = descRaw || xmlTagText(xml, 'datatitle') || ''
    return { title: decodeFavText(name), desc: decodeFavText(descRaw), url: '' }
  }
  if (favType === 5) {
    const url = (xmlTagText(xml, 'url') ?? '').replace(/&amp;/g, '&')
    const linkTitle = title || xmlTagText(xml, 'datatitle') || ''
    const linkDesc = descRaw || xmlTagText(xml, 'datadesc') || ''
    return { title: decodeFavText(linkTitle), desc: decodeFavText(linkDesc), url }
  }
  if (favType === 14 || favType === 18) {
    const rt = xmlNestedText(xml, 'recordinfo', t) || title
    const rd = xmlNestedText(xml, 'recordinfo', d) || descRaw
    return { title: rt, desc: decodeFavText(rd), url: '' }
  }
  if (favType === 6) {
    // 实测结构：<locitem><poiname>POI 名</poiname><label>地址</label>…；不是 <location> 的属性。
    const name = xmlTagText(xml, 'poiname') || title || xmlTagText(xml, 'label') || ''
    const label = xmlTagText(xml, 'label') || descRaw || ''
    return { title: decodeFavText(name), desc: decodeFavText(label), url: '' }
  }
  return { title, desc: decodeFavText(descRaw), url: '' }
}

/**
 * 收藏来源用户：`realchatname` 是实际发送者，`fromusr` 在群聊收藏里是群 ID。
 * 两者都取，解析时按发送者优先、群头像兜底 —— 以真实 70 条非聊天记录收藏为样本，
 * 单看任一边都会漏掉一部分头像。
 */
function favoriteAvatarUsers(fromUsr: string, chatName: string): string[] {
  const out: string[] = []
  for (const raw of [chatName, fromUsr]) {
    const user = raw.trim()
    if (user && !out.includes(user)) out.push(user)
  }
  return out
}

/** 空串的 MD5：部分收藏 XML 用它表示「没有头像」，不能当成真实头像键。 */
const EMPTY_AVATAR_MD5 = 'd41d8cd98f00b204e9800998ecf8427e'

/**
 * 收藏 XML 自带的来源头像 MD5。
 *
 * `head_image.db` 只按 username 存图，而真实数据里有一批文件收藏的来源用户
 * （`realchatname`）已不在通讯录：这时 contact / head_image 都查不到，只有 XML
 * 里的 `<head256md5>` 仍是有效线索。空 MD5 必须过滤（真实库里有 1 条）。
 */
function favoriteHeadMd5(xml: string): string {
  for (const tag of ['head256md5', 'thumbhead256md5']) {
    const value = (xmlTagText(xml, tag) ?? '').trim().toLowerCase()
    if (value && value !== EMPTY_AVATAR_MD5) return value
  }
  return ''
}

/** One parsed resource part of a favorite (kept open for unknown datatypes). */
export type FavRawPart = FavItemPart

/** 从 XML 片段读第一个数字；非法/非正数返回 undefined。 */
function positiveNumber(value: string | null): number | undefined {
  const n = Number.parseFloat(value ?? '')
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/** 从 XML 片段读第一个整数；非法/非正数返回 undefined。 */
function positiveInt(value: string | null): number | undefined {
  const n = Number.parseInt(value ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/** 非负整数（`cdn_encryver=0` 是合法协议值）。 */
function nonNegativeInt(value: string | null): number | undefined {
  const n = Number.parseInt(value ?? '', 10)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

/** 只有真正的 HTTP(S) 地址才进 `coverUrl`；其余 CDN 字段保留作诊断。 */
function httpUrl(value: string): string {
  const text = value.trim()
  return /^https?:\/\//i.test(text) ? text : ''
}

/** 只保留有值且不重复的 `<tag>` 文本，供未知资源做可读元信息。 */
function favMeta(body: string, fields: ReadonlyArray<readonly [string, string]>): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = []
  for (const [tag, label] of fields) {
    const value = decodeFavText(xmlTagText(body, tag) ?? '').trim()
    if (value) out.push({ label, value })
  }
  return out
}

/** 收藏 XML 里的小程序/公众号绑定信息。 */
function parseAppBrand(xml: string): Pick<FavRawPart, 'appId' | 'appUsername' | 'pagePath' | 'iconUrl'> {
  const start = xml.indexOf('<appbranditem>')
  const end = start >= 0 ? xml.indexOf('</appbranditem>', start) : -1
  if (start < 0) return {}
  const body = end >= 0 ? xml.slice(start, end) : xml.slice(start)
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

/** 位置收藏：真实结构在顶层 `<locitem>`，不在 `<dataitem>` 中。 */
function parseLocationPart(xml: string): FavRawPart | null {
  const start = xml.indexOf('<locitem>')
  if (start < 0) return null
  const end = xml.indexOf('</locitem>', start)
  const body = end >= 0 ? xml.slice(start, end + '</locitem>'.length) : xml.slice(start)
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

/**
 * Parse `<datalist><dataitem>` entries into typed parts (mirror parse_fav_detail).
 *
 * 导出给统一搜索复用：资源定位必须与收藏详情面板使用同一份 XML 解释，
 * 否则同一收藏在两处会得到不同的文件名/MD5/类型。
 */
export function parseFavParts(xml: string): FavRawPart[] {
  const out: FavRawPart[] = []
  // 位置没有 dataitem；先单独收顶层 locitem。
  const location = parseLocationPart(xml)
  if (location) out.push(location)
  let pos = 0
  for (;;) {
    const start = xml.indexOf('<dataitem', pos)
    if (start < 0) break
    const end = xml.indexOf('</dataitem>', start)
    const body = end >= 0 ? xml.slice(start, end) : xml.slice(start)
    const datatype = Number.parseInt(xmlTagAttr(body, 'dataitem', 'datatype') ?? '0', 10) || 0
    const dataid = (xmlTagAttr(body, 'dataitem', 'dataid') ?? '').trim().toLowerCase()
    const fullMd5 = (xmlTagText(body, 'fullmd5') ?? '').trim().toLowerCase() || dataid
    const thumbMd5 = (xmlTagText(body, 'thumbfullmd5') ?? '').trim().toLowerCase()
    const fullSize = positiveInt(xmlTagText(body, 'fullsize'))
    const thumbSize = positiveInt(xmlTagText(body, 'thumbfullsize'))
    const cdnDataUrl = (xmlTagText(body, 'cdn_dataurl') ?? '').trim()
    const cdnDataKey = (xmlTagText(body, 'cdn_datakey') ?? '').trim()
    const cdnThumbUrl = (xmlTagText(body, 'cdn_thumburl') ?? '').trim()
    const cdnThumbKey = (xmlTagText(body, 'cdn_thumbkey') ?? '').trim()
    const cdnEncryVer = nonNegativeInt(xmlTagText(body, 'cdn_encryver'))
    const sourceId = (xmlTagText(body, 'sourceid') ?? '').trim()
    const dataSourceId = (xmlTagAttr(body, 'dataitem', 'datasourceid') ?? '').trim()
    const title = decodeFavText(xmlTagText(body, 'datatitle') ?? '').trim()
    const desc = decodeFavText(xmlTagText(body, 'datadesc') ?? '').trim()
    const text = desc || title
    const sourceName = decodeFavText(xmlTagText(body, 'datasrcname') ?? '').trim()
    const sourceTime = (xmlTagText(body, 'datasrctime') ?? '').trim()
    const sourceHead = (xmlTagText(body, 'sourceheadurl') ?? '').trim()
    const metaPart = (): FavRawPart => {
      const p: FavRawPart = { kind: 'text', dataType: datatype }
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
    const pushPart = (part: FavRawPart): void => { out.push(part) }
    if (datatype === 1) {
      if (text) { const p = metaPart(); p.text = text; pushPart(p) }
    } else if (datatype === 2) {
      const p = metaPart()
      p.kind = 'image'
      if (thumbMd5) p.md5 = thumbMd5
      else if (fullMd5) p.md5 = fullMd5
      if (fullMd5) p.fullMd5 = fullMd5
      if (thumbMd5) p.thumbMd5 = thumbMd5
      if (text) p.text = text
      pushPart(p)
    } else if (datatype === 3) {
      const p = metaPart()
      p.kind = 'voice'
      if (fullMd5) p.md5 = fullMd5
      if (fullMd5) p.fullMd5 = fullMd5
      const fmt = (xmlTagText(body, 'datafmt') ?? '').trim().toLowerCase()
      if (fmt) p.format = fmt
      // 收藏语音的 duration 是毫秒（真实样本 2686 = 2.686s）；同时保留秒口径给老 UI。
      const durMs = positiveInt(xmlTagText(body, 'duration'))
      if (durMs !== undefined) {
        p.durationMs = durMs
        p.duration = durMs / 1000
      }
      const svrId = (xmlTagText(body, 'fromnewmsgid') ?? xmlTagText(body, 'sourceid') ?? '').trim()
      if (svrId) p.svrId = svrId
      pushPart(p)
    } else if (datatype === 4) {
      const p = metaPart()
      p.kind = 'video'
      if (thumbMd5) p.md5 = thumbMd5
      else if (fullMd5) p.md5 = fullMd5
      if (fullMd5) p.fullMd5 = fullMd5
      if (thumbMd5) p.thumbMd5 = thumbMd5
      const dur = positiveNumber(xmlTagText(body, 'duration'))
      if (dur !== undefined) p.duration = dur
      if (text) p.text = text
      pushPart(p)
    } else if (datatype === 5 || datatype === 36) {
      const p = metaPart()
      p.kind = 'link'
      if (text) p.text = text
      const u = decodeFavText(xmlTagText(body, 'stream_weburl') ?? xmlTagText(body, 'url') ?? '').trim()
      if (u) p.url = u
      const cover = httpUrl(xmlTagText(body, 'cdn_thumburl') ?? '')
      if (cover) p.coverUrl = cover
      pushPart(p)
    } else if (datatype === 8) {
      const p = metaPart()
      p.kind = 'file'
      const n = title || desc
      if (n) p.name = n
      const e = (xmlTagText(body, 'datafmt') ?? '').trim().toLowerCase()
      if (e) p.ext = e
      const sz = fullSize
      if (sz !== undefined) p.size = sz
      if (fullMd5) p.fullMd5 = fullMd5
      pushPart(p)
    } else if (datatype === 19) {
      const p = metaPart()
      p.kind = 'miniapp'
      if (text) p.text = text
      const app = parseAppBrand(xml)
      Object.assign(p, app)
      // 小程序的完整封面有时只在 dataitem 的 thumb/full md5 上。
      if (thumbMd5) p.thumbMd5 = thumbMd5
      if (fullMd5) p.fullMd5 = fullMd5
      if (thumbMd5 || fullMd5) p.md5 = thumbMd5 || fullMd5
      pushPart(p)
    } else if (datatype === 7 || datatype === 16 || datatype === 18 || datatype === 20) {
      const p = metaPart()
      p.kind = datatype === 7 ? 'music' : datatype === 16 ? 'product' : datatype === 18 ? 'note' : 'channels'
      if (text) p.text = text
      const u = decodeFavText(xmlTagText(body, 'stream_weburl') ?? xmlTagText(body, 'url') ?? '').trim()
      if (u) p.url = u
      const musicUrl = decodeFavText(xmlTagText(body, 'music_url') ?? '').trim()
      if (musicUrl && !p.url) p.url = musicUrl
      const cover = httpUrl(decodeFavText(xmlTagText(body, 'cdn_thumburl') ?? ''))
      if (cover) p.coverUrl = cover
      if (thumbMd5) p.thumbMd5 = thumbMd5
      if (fullMd5) p.fullMd5 = fullMd5
      if (thumbMd5 || fullMd5) p.md5 = thumbMd5 || fullMd5
      pushPart(p)
    } else {
      // 新版本微信会继续增加 datatype。未知 == 不能显示是错误策略：
      // 只要 XML 里有任何可读字段，就生成一条 unknown 卡片交给前端如实展示。
      const meta = favMeta(body, [
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
      ])
      const p = metaPart()
      p.kind = 'unknown'
      if (text) p.text = text
      const u = decodeFavText(xmlTagText(body, 'stream_weburl') ?? xmlTagText(body, 'url') ?? '').trim()
      if (u) p.url = u
      const cover = httpUrl(decodeFavText(xmlTagText(body, 'cdn_thumburl') ?? ''))
      if (cover) p.coverUrl = cover
      if (meta.length > 0) p.meta = meta
      if (thumbMd5) p.thumbMd5 = thumbMd5
      if (fullMd5) p.fullMd5 = fullMd5
      if (thumbMd5 || fullMd5) p.md5 = thumbMd5 || fullMd5
      // 空 dataitem 也保留，避免「有一条收藏但详情一片空白」。
      pushPart(p)
    }
    pos = end >= 0 ? end + 10 : xml.length
  }
  return out
}

interface FavorItem {
  localId: number
  /** uint64 字符串，避免 JSON/JS number 丢精度。 */
  serverId?: string
  /** 收藏来源消息/资源 uint64 字符串。 */
  sourceId?: string
  type: number
  typeLabel: string
  title: string
  desc: string
  url: string
  updateTime: number
  time: string
  content: string
  fromUsr: string
  chatName: string
  source: string
  /**
   * 来源头像：本机 data URL、contact 表头像地址，或 32 位头像 MD5。
   * MD5 由客户端交给 `apiGetSnsImageDataUrl` 解出本机图（与收藏图片同一条缓存链）。
   */
  avatar?: string
  items: FavRawPart[]
}

/**
 * Read the favorites list with parsed title/desc/url/source.
 * @param decryptedDir - decrypted data root.
 * @param limit - max rows.
 * @param q - 关键词：匹配收藏 XML / 来源账号 / 实际发送者。
 * @param wechatBaseDir - 微信原始账号根目录（仅用于 `temp/head_image` 缓存）。
 * @returns the favorites snapshot.
 */
export function queryFavorites(
  decryptedDir: string,
  limit?: number,
  offset: number = 0,
  q?: string,
  wechatBaseDir?: string,
): { favorites: FavorItem[]; total: number } {
  const db = new DatabaseSync(join(decryptedDir, 'favorite', 'favorite.db'), { readOnly: true })
  try {
    const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fav_db_item'").get() !== undefined
    if (!has) return { favorites: [], total: 0 }
    const cols = new Set(db.prepare('PRAGMA table_info(fav_db_item)').all().map(r => r.name))
    const sel = (c: string, dft: string) => (cols.has(c) ? c : dft)
    const selText = (c: string, dft: string) => (cols.has(c) ? `CAST(${c} AS TEXT) AS ${c}` : `${dft} AS ${c}`)
    const cap = Math.min(limit ?? 200, 2000)
    const kw = (q ?? '').trim()
    const like = '%' + kw.replace(/[\\%_]/g, (m) => '\\' + m) + '%'
    const whereSql = kw
      ? ` WHERE (${sel('content', "''")} LIKE ? ESCAPE '\\' OR ${sel('fromusr', "''")} LIKE ? ESCAPE '\\' OR ${sel('realchatname', "''")} LIKE ? ESCAPE '\\')`
      : ''
    const kwParams: string[] = kw ? [like, like, like] : []
    const sql = [
      'SELECT',
      [
        sel('local_id', '0'),
        selText('server_id', "''"),
        selText('source_id', "''"),
        sel('type', '0'),
        sel('update_time', '0'),
        sel('content', "''"),
        sel('fromusr', "''"),
        sel('realchatname', "''"),
      ].join(', '),
      'FROM fav_db_item',
      whereSql,
      'ORDER BY', sel('update_time', 'local_id'), 'DESC',
      'LIMIT ? OFFSET ?',
    ].join(' ')
    const rows = db.prepare(sql).all(...kwParams, cap, offset) as Array<Record<string, unknown>>
    const total = (db.prepare('SELECT COUNT(*) AS n FROM fav_db_item' + whereSql).get(...kwParams) as { n: number } | undefined)?.n ?? rows.length
    const names = contactMeta(decryptedDir).names
    const avatarUsers: string[] = []
    const avatarUserSet = new Set<string>()
    const parsedRows = rows.map((r) => {
      const xml = cellStr(r[sel('content', '')] ?? '')
      const fromUsr = cellStr(r[sel('fromusr', '')] ?? '')
      const chatName = cellStr(r[sel('realchatname', '')] ?? '')
      const avatarCandidates = favoriteAvatarUsers(fromUsr, chatName)
      for (const user of avatarCandidates) {
        if (!avatarUserSet.has(user)) {
          avatarUserSet.add(user)
          avatarUsers.push(user)
        }
      }
      return { r, xml, fromUsr, chatName, avatarCandidates }
    })
    // 当前页只取一次：避免前端为每条收藏各发一次头像 RPC。
    const avatars = resolveAvatarsLocal(decryptedDir, avatarUsers, {
      wechatBaseDir,
    })
    const favorites: FavorItem[] = parsedRows.map(({ r, xml, fromUsr, chatName, avatarCandidates }) => {
      const type = Number(r[sel('type', '0')] ?? 0)
      const parsed = parseFavContent(type, xml)
      const source = chatName ? (names.get(chatName) ?? chatName) : (fromUsr ? (names.get(fromUsr) ?? fromUsr) : '')
      const updateTime = Number(r[sel('update_time', '0')] ?? 0)
      const serverId = cellStr(r.server_id ?? '')
      const sourceId = cellStr(r.source_id ?? '')
        || (xmlTagAttr(xml, 'source', 'sourceid') ?? '').trim()
        || (xmlTagText(xml, 'sourceid') ?? '').trim()
      const avatar = avatarCandidates.map((u) => avatars[u] ?? '').find((v) => v !== '')
        ?? favoriteHeadMd5(xml)
      return {
        localId: Number(r[sel('local_id', '0')] ?? 0),
        ...(serverId ? { serverId } : {}),
        ...(sourceId ? { sourceId } : {}),
        type,
        typeLabel: favTypeLabel(type),
        title: parsed.title,
        desc: parsed.desc,
        url: parsed.url,
        updateTime,
        time: fmtDateTimeSec(updateTime),
        content: xml,
        fromUsr,
        chatName,
        source,
        avatar,
        items: parseFavParts(xml),
      }
    })
    return { favorites, total }
  } finally {
    db.close()
  }
}

/**
 * Delete favorite items by local_id (writes to favorite.db copy).
 * @param decryptedDir - decrypted data root.
 * @param ids - local_ids to delete.
 * @returns deleted count.
 */
export function deleteFavoriteItems(decryptedDir: string, ids: number[]): { ok: boolean; deleted: number; error?: string } {
  if (ids.length === 0) return { ok: true, deleted: 0 }
  const dbPath = join(decryptedDir, 'favorite', 'favorite.db')
  if (!existsSync(dbPath)) return { ok: false, deleted: 0, error: '收藏库不存在' }
  try {
    return withWritableDb(dbPath, (db) => {
      const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fav_db_item'").get() !== undefined
      if (!has) return { ok: false, deleted: 0, error: 'fav_db_item 表不存在' }
      const stmt = db.prepare('DELETE FROM fav_db_item WHERE local_id = ?')
      let deleted = 0
      for (const id of ids) { deleted += Number(stmt.run(id).changes) }
      return { ok: true, deleted }
    })
  } catch (e) {
    return { ok: false, deleted: 0, error: (e as Error).message }
  }
}
