/**
 * Moments (朋友圈) queries over st_control's decrypted sns.db.
 * Timeline rows live in SnsTimeLine (tid/user_name/content XML); the content
 * XML is parsed into text/media/location/link fields mirroring the Rust
 * modules/moments.rs parse_sns_xml. Author names resolve via contact.db.
 *
 * 2026-10-19 起列表**归档优先**：先把线上行幂等导入 `<数据根>/moments-archive.db`
 * （见 `moments-archive.ts`），再从归档出列表/作者/月度。好友删动态后，线上行消失，
 * 归档行仍在 —— 这就是「防撤回」。解析器只保留一份（本文件），归档存的是解析后的
 * payload + 原始 XML，避免两处各自解释格式。
 */
import { fmtRelativeDaySec } from '../format.ts'
import { DatabaseSync } from './db-open.ts'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { contactMeta } from './meta.ts'
import { stripCdata } from './parse-xml.ts'
import {
  readArchivedAuthors,
  readArchivedMomentHashes,
  readArchivedMoments,
  readArchivedPayloads,
  upsertArchivedMoments,
  type ArchivedMomentInput,
  type ArchivedMomentRow,
} from './moments-archive.ts'

/** Stringify an SQLite cell (TEXT/NUMBER/BLOB) to a string. */
function cellString(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (v instanceof Uint8Array) return new TextDecoder('utf-8', { fatal: false }).decode(v)
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol') return String(v)
  return ''
}

/** One image media entry parsed from the XML (CDN URLs stay unresolved). */
export interface MomentMedia {
  thumb: string
  url: string
  key: string
  md5: string
  /**
   * 媒体标签上的 `token`（`<url token="…">`）。
   *
   * 为什么必须带着：2026-10-08 真机实测，CDN 地址只有 `?token=…` 仍是 400，
   * **必须 `?token=…&idx=1`** 且尺寸段为 `/0`、协议为 https 才返回 200（见 `sns-cdn-url.ts`）。
   */
  token?: string
  /** Media <id> (cache-key input, together with timelineId). */
  id?: string
  /** Timeline <id> (SnsDataItem/TimelineObject id). */
  timelineId?: string
}

/** One video media entry parsed from the XML. */
export interface MomentVideo {
  url: string
  thumb: string
  key: string
  md5: string
  duration: number
  /** Media <id> (cache-key input, together with timelineId). */
  id?: string
  /** Timeline <id> (SnsDataItem/TimelineObject id). */
  timelineId?: string
}

/** One like entry. */
export interface MomentLike {
  username: string
  nickname: string
}

/** One comment entry. */
export interface MomentComment {
  username: string
  nickname: string
  to_username: string
  to_nickname: string
  content: string
  ts: number
  /**
   * Comment-attached image (`<imageinfo>` 里的第一张)。
   *
   * ⚠️ `token` 与 `seed` 是**取到图的前提**，不是可选装饰（2026-10-09 修）：
   * 实测评论图的裸 `<url>`（不带 `token`/`idx=1`）**5/5 全部 HTTP 400、0 字节**，
   * 而经 `snsCdnUrl` 补上 `?token=…&idx=1` 后 **5/5 HTTP 200**（`x-enc=1`，密文）。
   * 之前这里只解析 `url`/`thumb`/`md5`/`media_id`，渲染层拿裸地址去要图必然落空。
   */
  image?: {
    thumb?: string
    url?: string
    md5?: string
    mediaId?: string
    /** `<token>`：CDN 校验标签。实测缺它就是 400。 */
    token?: string
    /** `<key>`：WxIsaac64 解密种子。缺它拿到的是密文。 */
    seed?: string
  }
}

/** One moments entry (mirror Rust MomentEntry, without CDN-dependent fields). */
export interface MomentEntry {
  tid: string
  username: string
  /** **显示名**（备注 → 昵称 → ID 逐级回退），不是发帖人的微信 ID —— 别拿它去 join 会话（P3-6 实测澄清）。 */
  author: string
  text: string
  ts: number
  time: string
  media_count: number
  media_desc: string
  images: MomentMedia[]
  videos: MomentVideo[]
  location: string
  link_title: string
  link_url: string
  /** ContentObject <type>: 3=公众号文章链接, 28=视频号, 1=普通动态. */
  contentType?: number
  /** 公众号/来源显示名 (<sourceNickName>). */
  sourceNickName?: string
  /** 公众号 username (<publicUserName>, gh_xxx). */
  publicUserName?: string
  /** 地理信息（朋友圈 XML 的 location 属主；属性与常见顺序相反，已在解析处修正）。 */
  city?: string
  country?: string
  lat?: number
  lng?: number
  is_self: boolean
  likes: MomentLike[]
  comments: MomentComment[]
}

/** Resolve the sns.db path (sns/db_sns/sns.db or sns/sns.db). */
function snsDb(decryptedDir: string): string | null {
  for (const p of [join(decryptedDir, 'sns', 'db_sns', 'sns.db'), join(decryptedDir, 'sns', 'sns.db')]) {
    if (existsSync(p)) return p
  }
  return null
}

/** Unescape common XML entities. */
function unescapeXml(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'")
}

/**
 * Extract text between <tag ...> and </tag>, tolerating attributes on the open tag.
 *
 * 必须过 `stripCdata`：微信的 SnsTimeLine content 里正文/昵称/链接标题都是
 * `<contentDesc><![CDATA[…]]></contentDesc>` 这种写法（与消息 XML 同一个生产者），
 * 不剥就会把 `<![CDATA[…]]>` 整串当正文显示到卡片上。
 * 共享原语 `parse-xml.ts#xmlTagText` 一直有剥，这份本地版本是漏的那一处。
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
  const tagEnd = xml.indexOf('>', start)
  if (tagEnd < 0) return null
  const tagStr = xml.slice(start, tagEnd)
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

/** Extract text of the first tag among candidates (first non-empty wins). */
function tagTextFirst(xml: string, tags: string[]): string {
  for (const t of tags) {
    const v = xmlTagText(xml, t)
    if (v != null && v.trim() !== '') return unescapeXml(v).trim()
  }
  return ''
}

/** `<media>` / `<media …>`（属性形态）的公共前缀：两种写法一次搜索即可定位。 */
const MEDIA_OPEN = '<media'

/**
 * Iterate <media ...>...</media> blocks.
 *
 * 改前每轮做两件事，两件都在下标偏移上踩了同一个坑（L10）：
 *   ① `const rest = xml.slice(pos)` 重建余串，再用**相对**索引（`pos + idx`）换算回绝对位置；
 *   ② 分别搜 `<media>` 与 `<media `（属性形态）两个针，取更靠前的那个。
 *
 * ②中的「找 `<media `」是真的平方项：正文里全是 `<media>`（实测的常见形态）时它**每次都会
 * 扫到字符串末尾**才放弃，与块数相乘就是 O(k·n)。实测（2.9MB、2 万块）：17.8s；
 * 换成下面的单次前缀搜索后 **2.8ms**（同样的输入，输出逐字节相同）。
 * ①在 V8 上其实不贵（`slice` 是 O(1) 视图，实测 2 万次 `slice(pos)` ≈ 0ms），
 * 但「相对索引 + 手工加回 pos」是可读性陷阱，一并改成绝对偏移 `indexOf(needle, pos)`。
 *
 * 与本函数原先的行为严格同形：只认标签名后紧跟 `>` 或空格（即 `<media>` / `<media key=…>`）；
 * 其它以 media 开头的标签不算块，跳过这 6 个字符继续找。
 */
function mediaBlocks(xml: string): string[] {
  const out: string[] = []
  let pos = 0
  for (;;) {
    const start = xml.indexOf(MEDIA_OPEN, pos)
    if (start < 0) break
    const sep = xml.charAt(start + MEDIA_OPEN.length)
    if (sep !== '>' && sep !== ' ') {
      // 不是媒体块（例如 `<mediaxxx>`）：往后挪一个前缀长度继续找，不会漏掉真正的 `<media>`
      // —— 两个 `<media` 不可能重叠，所以跳过这 6 个字符是安全的。
      pos = start + MEDIA_OPEN.length
      continue
    }
    const tagClose = xml.indexOf('>', start + MEDIA_OPEN.length)
    if (tagClose < 0) break
    const mediaClose = xml.indexOf('</media>', tagClose + 1)
    if (mediaClose < 0) break
    out.push(xml.slice(tagClose + 1, mediaClose))
    pos = mediaClose + 8
  }
  return out
}

/** Whether a URL points at a video (video media is not an image). */
function isVideoUrl(u: string): boolean {
  const l = u.toLowerCase()
  return l.includes('snsvideodownload') || l.includes('video.qq.com') || l.includes('.mp4')
}

/** Parse one moments content XML (mirror parse_sns_xml). */
export function parseSnsXml(xml: string): {
  text: string
  createTime: number
  mediaCount: number
  mediaDesc: string
  images: MomentMedia[]
  videos: MomentVideo[]
  location: string
  /** 位置的城市名（`<location city="南宁市">`），本机 490 条有值。 */
  city: string
  /** 国家名（`<location country="中国">`）。 */
  country: string
  /**
   * 真实纬度/经度（已**修正**）。
   *
   * ⚠️ 微信在朋友圈 XML 里把这两个属性**写反了**：`<location latitude="108.249237"
   * longitude="22.8694096">` 对应的是南宁（真实为 22.87°N / 108.25°E）。
   * 本机 490 条里 **485 条 latitude > 90**（真实纬度不可能超过 90），
   * 而 longitude 侧的值都落在合理范围 —— 所以这里按「纬度=longitude 属性、经度=latitude 属性」输出，
   * 下游拿到的一定是能直接画在地图上的值。
   */
  lat: number
  lng: number
  linkTitle: string
  linkUrl: string
  contentType: number
  sourceNickName: string
  publicUserName: string
  nickname: string
} {
  const text = tagTextFirst(xml, ['contentDesc', 'ContentDesc'])
  const createTime = Number.parseInt(tagTextFirst(xml, ['createTime', 'CreateTime']), 10) || 0
  const mediaCount = xml.split('<media>').length - 1 + xml.split('<media ').length - 1
  const hasVideo = xml.includes('<type>6</type>') || xml.includes('<type>4</type>') || xml.includes('<type>15</type>')
  const mediaDesc = mediaCount === 0 ? '' : hasVideo ? '视频' : `图片×${mediaCount}`

  const images: MomentMedia[] = []
  const videos: MomentVideo[] = []
  const timelineId = tagTextFirst(xml, ['id', 'Id']) || undefined
  for (const inner of mediaBlocks(xml)) {
    const url = tagTextFirst(inner, ['url', 'Url', 'cdnUrl', 'cdnurl'])
    const thumb = tagTextFirst(inner, ['thumb', 'Thumb', 'cdnThumbUrl', 'cdnthumburl', 'thumbUrl', 'thumburl', 'coverUrl', 'coverurl'])
    const key = xmlTagAttr(inner, 'enc', 'key') ?? xmlTagAttr(inner, 'thumb', 'key') ?? xmlTagAttr(inner, 'url', 'key') ?? ''
    const md5 = xmlTagAttr(inner, 'url', 'md5') ?? ''
    // CDN 取图要带：`<url token>` / `<thumb token>`（实测 `token+idx=1` 才 200）
    const token = xmlTagAttr(inner, 'url', 'token') ?? xmlTagAttr(inner, 'thumb', 'token') ?? ''
    const mediaId = tagTextFirst(inner, ['id', 'Id']) || undefined
    const duration = Number.parseFloat(tagTextFirst(inner, ['videoDuration'])) || 0
    if (url && isVideoUrl(url)) {
      const videoEntry: MomentVideo = { url, thumb, key, md5, duration }
      if (mediaId) videoEntry.id = mediaId
      if (timelineId) videoEntry.timelineId = timelineId
      videos.push(videoEntry)
    } else if (url) {
      const mediaEntry: MomentMedia = { thumb, url, key, md5, token }
      if (mediaId) mediaEntry.id = mediaId
      if (timelineId) mediaEntry.timelineId = timelineId
      images.push(mediaEntry)
    }
  }
  const location = xmlTagAttr(xml, 'location', 'poiName') ?? xmlTagAttr(xml, 'location', 'poiname') ?? ''
  const city = xmlTagAttr(xml, 'location', 'city') ?? ''
  const country = xmlTagAttr(xml, 'location', 'country') ?? ''
  // 见上方注释：两个属性的**语义是反的**，这里换回来
  const rawLat = Number(xmlTagAttr(xml, 'location', 'latitude') ?? '') || 0
  const rawLng = Number(xmlTagAttr(xml, 'location', 'longitude') ?? '') || 0
  const lat = rawLng
  const lng = rawLat
  const linkTitle = unescapeXml(xmlNestedText(xml, 'ContentObject', 'title') ?? '') || unescapeXml(xmlNestedText(xml, 'contentObject', 'title') ?? '') || ''
  const linkUrl = unescapeXml(xmlTagText(xml, 'contentUrl') ?? '') || unescapeXml(xmlTagText(xml, 'ContentUrl') ?? '') || ''
  const contentType = Number.parseInt(tagTextFirst(xml, ['type', 'Type']), 10) || 0
  const sourceNickName = tagTextFirst(xml, ['sourceNickName', 'SourceNickName']) || ''
  const publicUserName = tagTextFirst(xml, ['publicUserName', 'PublicUserName']) || ''
  const nickname = tagTextFirst(xml, ['nickname', 'NickName', 'nickName']) || ''
  return {
    text,
    createTime,
    mediaCount,
    mediaDesc,
    images,
    videos,
    location,
    city,
    country,
    lat,
    lng,
    linkTitle,
    linkUrl,
    contentType,
    sourceNickName,
    publicUserName,
    nickname,
  }
}

/**
 * Parse likes + comments embedded in the moments XML LocalExtraInfo.
 * <comment_user_list><user_comment>…</user_comment>…; type 1 = like, type 2 = comment.
 * Reply comments reference ref_comment_id, resolved to the target comment author.
 */
export function parseSnsLikesComments(xml: string): { likes: MomentLike[]; comments: MomentComment[] } {
  const likes: MomentLike[] = []
  const comments: MomentComment[] = []
  const start = xml.indexOf('<LocalExtraInfo>')
  if (start < 0) return { likes, comments }
  const listEnd = xml.indexOf('</LocalExtraInfo>', start)
  const list = listEnd > 0 ? xml.slice(start, listEnd) : xml.slice(start)
  interface RawComment {
    id: string
    username: string
    nickname: string
    content: string
    ts: number
    ref: string
    type: number
    block: string
  }
  const raws: RawComment[] = []
  let pos = 0
  for (;;) {
    const bi = list.indexOf('<user_comment>', pos)
    if (bi < 0) break
    const bc = list.indexOf('</user_comment>', bi)
    if (bc < 0) break
    const b = list.slice(bi + 14, bc)
    raws.push({
      id: xmlTagText(b, 'comment_id') ?? '',
      username: xmlTagText(b, 'username') ?? '',
      nickname: unescapeXml(xmlTagText(b, 'nickname') ?? ''),
      content: unescapeXml(xmlTagText(b, 'content') ?? ''),
      ts: Number.parseInt(xmlTagText(b, 'create_time') ?? '0', 10) || 0,
      ref: xmlTagText(b, 'ref_comment_id') ?? '0',
      type: Number.parseInt(xmlTagText(b, 'type') ?? '0', 10) || 0,
      block: b,
    })
    pos = bc + 15
  }
  const byId = new Map<string, RawComment>()
  for (const r of raws) {
    if (r.id) byId.set(r.id, r)
  }
  for (const r of raws) {
    if (r.type === 1) {
      likes.push({ username: r.username, nickname: r.nickname })
      continue
    }
    const refC = r.ref && r.ref !== '0' ? byId.get(r.ref) : undefined
    const comment: MomentComment = {
      username: r.username,
      nickname: r.nickname,
      to_username: refC ? refC.username : '',
      to_nickname: refC ? refC.nickname : '',
      content: r.content,
      ts: r.ts,
    }
    const b = r.block
    const ii = b.indexOf('<imageinfo>')
    if (ii >= 0) {
      const ie = b.indexOf('</imageinfo>', ii)
      const ib = ie > 0 ? b.slice(ii + 11, ie) : b.slice(ii + 11)
      const image: NonNullable<MomentComment['image']> = {}
      const iu = unescapeXml(xmlTagText(ib, 'url') ?? '')
      if (iu) image.url = iu
      const it = unescapeXml(xmlTagText(ib, 'thumb_url') ?? '')
      if (it) image.thumb = it
      const imd = xmlTagText(ib, 'md5') ?? ''
      if (imd) image.md5 = imd
      const imid = xmlTagText(ib, 'media_id') ?? ''
      if (imid) image.mediaId = imid
      // token 与 key 缺一不可（实测：缺 token 返 400，缺 key 拿到的是密文）。
      // 注意 XML 里查询串的 `&` 是实体，必须先反转义，否则 `token` 里会带 `&amp;`。
      const itok = unescapeXml(xmlTagText(ib, 'token') ?? '')
      if (itok) image.token = itok
      const ikey = unescapeXml(xmlTagText(ib, 'key') ?? '')
      if (ikey) image.seed = ikey
      if (Object.keys(image).length > 0) comment.image = image
    }
    comments.push(comment)
  }
  return { likes, comments }
}


/**
 * Read moments page (XML parsed; likes/comments resolved from SnsMessage_tmp3).
 * @param decryptedDir - decrypted data root.
 * @param offset - page offset.
 * @param limit - page size.
 * @param authorUsername - optional author filter.
 * @returns the moments snapshot.
 */
/** 线上表的一行（归档导入的输入）。 */
interface LiveMomentRow {
  tid: string
  username: string
  content: string
}

/** 一次同步节流：同一目录 1.5s 内不重复读全表（分页/增量刷新会连着调）。 */
const ARCHIVE_SYNC_GAP_MS = 1_500
const LAST_ARCHIVE_SYNC = new Map<string, number>()

/** 线上 sns.db 是否存在（含表结构探测结果）。 */
function liveMomentsAvailable(dbPath: string): { tid: string; uname: string; content: string } | null {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='SnsTimeLine'").get() !== undefined
    if (!has) return null
    const cols = new Set(db.prepare('PRAGMA table_info(SnsTimeLine)').all().map(r => r.name))
    return {
      tid: cols.has('tid') ? 'tid' : 'Id',
      uname: cols.has('user_name') ? 'user_name' : 'userName',
      content: cols.has('content') ? 'content' : 'Content',
    }
  } finally {
    db.close()
  }
}

/**
 * 读线上表**全部**行（归档要的是全量超集，不能只读当前页）。
 * @param decryptedDir - 解密数据根。
 * @returns 行；没有 sns.db / 没有表时为 `null`。
 */
function readLiveMomentRows(decryptedDir: string): LiveMomentRow[] | null {
  const dbPath = snsDb(decryptedDir)
  if (dbPath === null) return null
  const shape = liveMomentsAvailable(dbPath)
  if (shape === null) return null
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const rows = db.prepare(
      `SELECT CAST(${shape.tid} AS TEXT) AS t, ${shape.uname} AS u, ${shape.content} AS c FROM SnsTimeLine`,
    ).all() as Array<{ t?: unknown; u?: unknown; c?: unknown }>
    return rows.map((r) => ({ tid: cellString(r.t), username: cellString(r.u), content: cellString(r.c) }))
  } finally {
    db.close()
  }
}

/** 按 key 去重（保留先出现的，用于合并归档里比线上多出来的点赞/评论/图片）。 */
function unionBy<T>(oldList: readonly T[], nextList: readonly T[], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const item of [...oldList, ...nextList]) {
    const key = keyOf(item)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

/**
 * 合并「已归档」与「线上最新」两版内容。
 *
 * 线上 XML 是**当前状态**：好友删评论、撤点赞、去掉一张图后，XML 里就没有了。
 * 如果直接覆盖 payload，归档就只剩「最后一次看到」而不是「拿到过的全部」——
 * 所以社交/媒体三类按稳定键做并集，正文只在新版为空时回退旧版。
 * @param oldPayload - 归档里的旧 payload（JSON）。
 * @param next - 线上最新解析出的 entry。
 * @returns 合并后的 entry（不修改入参）。
 */
function mergeArchivedEntry(oldPayload: string, next: MomentEntry): MomentEntry {
  let old: MomentEntry
  try { old = JSON.parse(oldPayload) as MomentEntry } catch { return next }
  const merged: MomentEntry = {
    ...next,
    text: next.text === '' ? old.text : next.text,
    likes: unionBy(old.likes ?? [], next.likes, (l) => l.username + '|' + l.nickname),
    comments: unionBy(old.comments ?? [], next.comments, (c) => JSON.stringify(c)),
    images: unionBy(old.images ?? [], next.images, (m) => (m.md5 || '') + '|' + (m.timelineId ?? '') + '|' + (m.id ?? '')),
    videos: unionBy(old.videos ?? [], next.videos, (v) => (v.md5 || '') + '|' + (v.timelineId ?? '') + '|' + (v.id ?? '')),
  }
  if (merged.location === '' && old.location !== '') merged.location = old.location
  if (merged.link_title === '' && old.link_title !== '') {
    merged.link_title = old.link_title
    merged.link_url = old.link_url
  }
  return merged
}

/** 把一行 XML 解析成完整的 `MomentEntry`（线上/归档共用同一份解析）。 */
function buildMomentEntry(tid: string, username: string, xml: string, names: Map<string, string>, self: string): MomentEntry {
  const parsed = parseSnsXml(xml)
  const social = parseSnsLikesComments(xml)
  const author = names.get(username) || parsed.nickname || username || '未知'
  const entry: MomentEntry = {
    tid,
    username,
    author,
    text: parsed.text,
    ts: parsed.createTime,
    time: fmtRelativeDaySec(parsed.createTime),
    media_count: parsed.mediaCount,
    media_desc: parsed.mediaDesc,
    images: parsed.images,
    videos: parsed.videos,
    location: parsed.location,
    link_title: parsed.linkTitle,
    link_url: parsed.linkUrl,
    is_self: username === self,
    likes: social.likes,
    comments: social.comments,
  }
  if (parsed.contentType) entry.contentType = parsed.contentType
  if (parsed.sourceNickName) entry.sourceNickName = parsed.sourceNickName
  if (parsed.publicUserName) entry.publicUserName = parsed.publicUserName
  if (parsed.city) entry.city = parsed.city
  if (parsed.country) entry.country = parsed.country
  // 只有真的带坐标才输出（本机 490 条），且已按 moments XML 的**属性反置**修正过
  if (parsed.lat || parsed.lng) { entry.lat = parsed.lat; entry.lng = parsed.lng }
  return entry
}

/**
 * 把线上表同步进归档库（只解析 `content_hash` 变了的行）。
 *
 * 节流 1.5s：分页 `load` / 增量刷新会在同一秒连调多次，全表 `SELECT` 没必要重复；
 * 但**新动态**仍在下一次 `getMoments`（≤1.5s 后）进来，不会像定时器那样等 30s。
 * @param decryptedDir - 解密数据根。
 * @param force - 跳过 1.5s 节流（测试/需要立即合并时）。
 * @returns 本次解析并写入的条数（0 = 没有变化/无线上表）。
 */
export function ensureMomentsArchiveFresh(decryptedDir: string, force = false): number {
  const now = Date.now()
  const last = LAST_ARCHIVE_SYNC.get(decryptedDir) ?? 0
  if (!force && now - last < ARCHIVE_SYNC_GAP_MS) return 0
  const live = readLiveMomentRows(decryptedDir)
  if (live === null) return 0
  const names = contactMeta(decryptedDir).names
  const hashes = readArchivedMomentHashes(decryptedDir)
  const changedRows: Array<{ tid: string; username: string; content: string; contentHash: string; entry: MomentEntry }> = []
  for (const row of live) {
    if (row.tid === '' || row.content === '') continue
    const contentHash = createHash('sha1').update(row.content).digest('hex')
    if (hashes !== null && hashes.get(row.tid) === contentHash) continue
    const entry = buildMomentEntry(row.tid, row.username, row.content, names, '')
    changedRows.push({ tid: row.tid, username: row.username, content: row.content, contentHash, entry })
  }
  const oldPayloads = readArchivedPayloads(decryptedDir, changedRows.map((r) => r.tid))
  const changed: ArchivedMomentInput[] = changedRows.map((r) => {
    const old = oldPayloads.get(r.tid)
    const entry = old === undefined ? r.entry : mergeArchivedEntry(old, r.entry)
    return {
      tid: r.tid,
      username: r.username,
      author: entry.author,
      ts: entry.ts,
      content: r.content,
      contentHash: r.contentHash,
      payload: JSON.stringify(entry),
    }
  })
  if (changed.length > 0) {
    const res = upsertArchivedMoments(decryptedDir, changed)
    console.error('[moments-archive] 已归档 ' + String(res.added) + ' 条新增 / ' + String(res.updated) + ' 条更新')
  }
  LAST_ARCHIVE_SYNC.set(decryptedDir, now)
  return changed.length
}

/**
 * 读一页朋友圈（归档优先；归档不可用时回退线上表）。
 * @param decryptedDir - decrypted data root.
 * @param offset - page offset.
 * @param limit - page size.
 * @param authorUsername - optional author filter.
 * @returns the moments snapshot.
 */
export function queryMoments(
  decryptedDir: string,
  offset?: number,
  limit?: number,
  /** 按发帖人过滤，传的是会话微信 ID —— 正名见 `WechatSession.username`（P3-6）。 */
  authorUsername?: string,
  selfUsername?: string,
): { moments: MomentEntry[]; total: number } {
  const cap = Math.min(limit ?? 50, 500)
  const off = offset ?? 0
  const self = selfUsername ?? ''
  const liveRows = readLiveMomentRows(decryptedDir) ?? []
  try {
    ensureMomentsArchiveFresh(decryptedDir)
  } catch (e) {
    console.warn('[moments-archive] 同步失败：' + (e instanceof Error ? e.message : String(e)))
  }
  const names = contactMeta(decryptedDir).names
  const archived = readArchivedMoments(decryptedDir, { offset: off, limit: cap, ...(authorUsername !== undefined ? { authorUsername } : {}) })
  // 归档写失败时（库只读/磁盘满）不能拿空列表糊弄：回退到线上表。
  if (archived !== null && (archived.total > 0 || liveRows.length === 0)) {
    const moments: MomentEntry[] = []
    for (const row of archived.rows) {
      try {
        const entry = JSON.parse(row.payload) as MomentEntry
        entry.tid = row.tid
        entry.username = row.username
        entry.author = names.get(row.username) || row.author || entry.author || '未知'
        entry.is_self = row.username === self
        // 相对时间必须按「现在」重算：归档里存的是归档时刻的「3 天前」，一个月后就不对了。
        entry.time = fmtRelativeDaySec(row.ts)
        moments.push(entry)
      } catch (e) {
        console.warn('[moments-archive] 跳过坏 payload tid=' + row.tid + '：' + (e instanceof Error ? e.message : String(e)))
      }
    }
    return { moments, total: archived.total }
  }
  // 归档库不存在/不可用 ⇒ 保留原来的线上分页路径，功能不因归档故障而消失。
  const filtered = authorUsername === undefined ? liveRows : liveRows.filter((r) => r.username === authorUsername)
  const page = filtered.slice(off, off + cap)
  const moments = page.map((row) => buildMomentEntry(row.tid, row.username, row.content, names, self))
  return { moments, total: filtered.length }
}

/**
 * Author-activity counts across the FULL moments archive (deleted posts included),
 * mapped to display names, ranked by count descending.
 * @param decryptedDir - decrypted data root.
 * @returns author name + moment count, highest first.
 */
export function queryMomentsAuthors(decryptedDir: string): Array<{ name: string; count: number }> {
  try { ensureMomentsArchiveFresh(decryptedDir) } catch { /* 归档故障时回退线上表 */ }
  const names = contactMeta(decryptedDir).names
  const archived = readArchivedAuthors(decryptedDir)
  if (archived !== null && archived.length > 0) {
    return archived.map(r => ({ name: names.get(r.username) || r.author || r.username || '未知', count: r.count }))
  }
  const dbPath = snsDb(decryptedDir)
  if (dbPath === null) return []
  const shape = liveMomentsAvailable(dbPath)
  if (shape === null) return []
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const rows = db.prepare(`SELECT ${shape.uname} AS u, COUNT(*) AS n FROM SnsTimeLine GROUP BY ${shape.uname} ORDER BY n DESC`).all() as Array<{ u?: unknown; n?: number }>
    return rows.map(r => ({ name: names.get(cellString(r.u)) || cellString(r.u) || '未知', count: r.n ?? 0 }))
  } finally {
    db.close()
  }
}
