/**
 * Favorites queries over st_control's decrypted favorite.db (fav_db_item).
 * Parses content XML (favitem type/desc/dataitem) into title/desc/url and
 * resolves sources via contact names, mirroring st_control modules/favorites.rs.
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { contactMeta } from './meta.ts'

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

/** Extract text between <tag ...> and </tag> (first occurrence). */
function xmlTagText(xml: string, tag: string): string | null {
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
function parseFavContent(favType: number, xml: string): { title: string; desc: string; url: string } {
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

/** One parsed dataitem part of a favorite (text/image/voice/video/link/file). */
interface FavRawPart {
  kind: 'text' | 'image' | 'voice' | 'video' | 'link' | 'file'
  text?: string
  md5?: string
  url?: string
  duration?: number
  name?: string
  ext?: string
  size?: number
  sourceName?: string
  sourceTime?: string
  sourceHead?: string
}

/** Parse `<datalist><dataitem>` entries into typed parts (mirror parse_fav_detail). */
function parseFavParts(xml: string): FavRawPart[] {
  const out: FavRawPart[] = []
  let pos = 0
  for (;;) {
    const start = xml.indexOf('<dataitem', pos)
    if (start < 0) break
    const end = xml.indexOf('</dataitem>', start)
    const body = end >= 0 ? xml.slice(start, end) : xml.slice(start)
    const datatype = Number.parseInt(xmlTagAttr(body, 'dataitem', 'datatype') ?? '0', 10) || 0
    const dataid = (xmlTagAttr(body, 'dataitem', 'dataid') ?? '').trim().toLowerCase()
    const md5 = (xmlTagText(body, 'fullmd5') ?? '').trim().toLowerCase() || dataid
    const thumbMd5 = (xmlTagText(body, 'thumbfullmd5') ?? '').trim().toLowerCase()
    const text = decodeFavText(xmlTagText(body, 'datadesc') ?? '') || decodeFavText(xmlTagText(body, 'datatitle') ?? '')
    const sourceName = xmlTagText(body, 'datasrcname') ?? ''
    const sourceTime = xmlTagText(body, 'datasrctime') ?? ''
    const sourceHead = xmlTagText(body, 'sourceheadurl') ?? ''
    const metaPart = (): FavRawPart => {
      const p: FavRawPart = { kind: 'text' }
      if (sourceName) p.sourceName = sourceName
      if (sourceTime) p.sourceTime = sourceTime
      if (sourceHead) p.sourceHead = sourceHead
      return p
    }
    const pushPart = (part: FavRawPart): void => { out.push(part) }
    if (datatype === 1) {
      if (text) { const p = metaPart(); p.text = text; pushPart(p) }
    } else if (datatype === 2) {
      const p = metaPart()
      p.kind = 'image'
      if (thumbMd5) p.md5 = thumbMd5
      else if (md5) p.md5 = md5
      if (text) p.text = text
      pushPart(p)
    } else if (datatype === 3) {
      const p = metaPart()
      p.kind = 'voice'
      if (md5) p.md5 = md5
      pushPart(p)
    } else if (datatype === 4) {
      const p = metaPart()
      p.kind = 'video'
      if (md5) p.md5 = md5
      const dur = Number.parseFloat(xmlTagText(body, 'duration') ?? '0')
      if (dur > 0) p.duration = dur
      if (text) p.text = text
      pushPart(p)
    } else if (datatype === 5 || datatype === 19 || datatype === 36) {
      const p = metaPart()
      p.kind = 'link'
      if (text) p.text = text
      const u = (xmlTagText(body, 'stream_weburl') ?? xmlTagText(body, 'url') ?? '').replace(/&amp;/g, '&')
      if (u) p.url = u
      pushPart(p)
    } else if (datatype === 8) {
      const p = metaPart()
      p.kind = 'file'
      const n = xmlTagText(body, 'datatitle') ?? ''
      if (n) p.name = n
      const e = xmlTagText(body, 'datafmt') ?? ''
      if (e) p.ext = e
      const sz = Number.parseInt(xmlTagText(body, 'fullsize') ?? '0', 10)
      if (sz > 0) p.size = sz
      pushPart(p)
    }
    pos = end >= 0 ? end + 10 : xml.length
  }
  return out
}

/** Format a unix timestamp as `YYYY-MM-DD HH:mm`. */
function fmtDateTime(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

interface FavorItem {
  localId: number
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
  items: FavRawPart[]
}

/**
 * Read the favorites list with parsed title/desc/url/source.
 * @param decryptedDir - decrypted data root.
 * @param limit - max rows.
 * @returns the favorites snapshot.
 */
export function queryFavorites(decryptedDir: string, limit?: number, offset: number = 0): { favorites: FavorItem[]; total: number } {
  const db = new DatabaseSync(join(decryptedDir, 'favorite', 'favorite.db'), { readOnly: true })
  try {
    const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fav_db_item'").get() !== undefined
    if (!has) return { favorites: [], total: 0 }
    const cols = new Set(db.prepare('PRAGMA table_info(fav_db_item)').all().map(r => r.name))
    const sel = (c: string, dft: string) => (cols.has(c) ? c : dft)
    const cap = Math.min(limit ?? 200, 2000)
    const sql = [
      'SELECT',
      [sel('local_id', '0'), sel('type', '0'), sel('update_time', '0'), sel('content', "''"), sel('fromusr', "''"), sel('realchatname', "''")].join(', '),
      'FROM fav_db_item',
      'ORDER BY', sel('update_time', 'local_id'), 'DESC',
      'LIMIT ? OFFSET ?',
    ].join(' ')
    const rows = db.prepare(sql).all(cap, offset) as Array<Record<string, unknown>>
    const total = (db.prepare('SELECT COUNT(*) AS n FROM fav_db_item').get() as { n: number } | undefined)?.n ?? rows.length
    const names = contactMeta(decryptedDir).names
    const favorites: FavorItem[] = rows.map((r) => {
      const type = Number(r[sel('type', '0')] ?? 0)
      const xml = cellStr(r[sel('content', '')] ?? '')
      const fromUsr = cellStr(r[sel('fromusr', '')] ?? '')
      const chatName = cellStr(r[sel('realchatname', '')] ?? '')
      const parsed = parseFavContent(type, xml)
      const source = chatName ? (names.get(chatName) ?? chatName) : (fromUsr ? (names.get(fromUsr) ?? fromUsr) : '')
      const updateTime = Number(r[sel('update_time', '0')] ?? 0)
      return {
        localId: Number(r[sel('local_id', '0')] ?? 0),
        type,
        typeLabel: favTypeLabel(type),
        title: parsed.title,
        desc: parsed.desc,
        url: parsed.url,
        updateTime,
        time: fmtDateTime(updateTime),
        content: xml,
        fromUsr,
        chatName,
        source,
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
    const db = new DatabaseSync(dbPath)
    const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fav_db_item'").get() !== undefined
    if (!has) { db.close(); return { ok: false, deleted: 0, error: 'fav_db_item 表不存在' } }
    const stmt = db.prepare('DELETE FROM fav_db_item WHERE local_id = ?')
    let deleted = 0
    for (const id of ids) { deleted += Number(stmt.run(id).changes) }
    db.close()
    return { ok: true, deleted }
  } catch (e) {
    return { ok: false, deleted: 0, error: (e as Error).message }
  }
}
