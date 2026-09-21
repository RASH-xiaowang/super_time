/**
 * rich / appmsg / 引用 / 图片组的解析（M21 拆分）。
 *
 * 从 `parse.ts` 原样搬出的一大块实现（渲染分类、群接龙、引用占位、图片组、appmsg 子类型、
 * 链接卡片与视频号富字段……），**行为逐字节不变**。依赖只往下走（xml/call/system ← 本文件）。
 *
 * @module parse-rich
 */

import { extractXmlTextNodes, stripCdata, stripXmlTags, unescapeXmlEntities, xmlAttr, xmlTagBlocks, xmlTagOrAttr, xmlTagText } from './parse-xml.ts'
import type { ChatlogRecord, MessageRich as RichMedia, MpArticle, SolitaireMember } from '../types.ts'

/**
 * 去掉 title/desc 里夹带的（**转义**）XML 载荷。
 *
 * 引用消息引用到图片/视频时，WeChat 会把被引用消息的 XML 原样塞进 title/desc，
 * 并且是转义过的（`&lt;?xml …&gt;`）。直接展示就是 `&lt;img aeskey="…"` 这种属性串
 * —— 实测全库还有 50 条（引用+合并转发）会这样。检测到就只留可读文本节点。
 * @param s - rich.title / rich.desc。
 * @returns 干净的文本（无内容时返回空串）。
 */
export function cleanRichText(s?: string): string {
  const v = (s ?? '').trim()
  if (!v) return ''
  if (!/&lt;|<\?xml|<msg\b|<img\b|<appmsg\b|<videomsg\b|<voicemsg\b|<emoji\b/.test(v)) return unescapeXmlEntities(v)
  const xml = v
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  // 去掉标签后剩下的就是可读文本；只剩属性说明这条 title 本来就没有正文
  return xml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

/** 兜底标签：rich.type 没被逐一列举时，至少给一个像样的名字而不是空气泡。 */
export function richFallbackLabel(type: string): string {
  switch (type) {
    case 'quote': return ''
    case 'chatlog': return '[聊天记录]'
    case 'unsupported': return '[该消息类型暂不支持预览]'
    default: return ''
  }
}

/* ------------------------------------------------------------------ *
 * renderType —— 界面切换渲染器用的唯一分类
 * ------------------------------------------------------------------ */

/**
 * 消息的**呈现种类**（界面唯一 switch 依据）。
 *
 * 取值与 WeChatDataAnalysis 的 `renderType` 对齐（text/image/voice/video/
 * emoji/location/contactCard/file/link/quote/chatHistory/transfer/redPacket/
 * live/announcement/voip/system），并补齐本项目的卡片型（miniapp/channels/
 * music/product/card/note/sticker/solitaire/pat/unsupported/revoke/empty）。
 */
export type RenderKind =
  | 'text' | 'image' | 'voice' | 'video' | 'emoji' | 'location' | 'contactCard'
  | 'file' | 'link' | 'quote' | 'miniapp' | 'channels' | 'live' | 'music'
  | 'product' | 'card' | 'note' | 'sticker' | 'announcement' | 'solitaire'
  | 'chatlog' | 'transfer' | 'redpacket' | 'voip' | 'pat'
  | 'system' | 'revoke' | 'empty' | 'unknown'
  // 读不出类型/渲染不了的 appmsg：RICH_TO_RENDER 里 `unsupported` 就映射到它，
  // 渲染端也已有对应分支。原先漏了这个成员，于是映射表本身过不了类型检查。
  | 'unsupported'

/** rich.type → renderType（卡片型子类型一一对应）。 */
export const RICH_TO_RENDER: Record<string, RenderKind> = {
  image: 'image',
  voice: 'voice',
  video: 'video',
  emoji: 'emoji',
  location: 'location',
  contact: 'contactCard',
  file: 'file',
  link: 'link',
  newsfeed: 'link',
  quote: 'quote',
  miniapp: 'miniapp',
  channels: 'channels',
  live: 'live',
  music: 'music',
  product: 'product',
  card: 'card',
  note: 'note',
  sticker: 'sticker',
  announcement: 'announcement',
  solitaire: 'solitaire',
  chatlog: 'chatlog',
  transfer: 'transfer',
  redpacket: 'redpacket',
  call: 'voip',
  pat: 'pat',
  unsupported: 'unsupported',
  appmsg: 'link',
}

/** 没有 rich 描述时的 local_type → renderType 兜底表。 */
export const TYPE_TO_RENDER: Record<number, RenderKind> = {
  1: 'text',
  3: 'image',
  34: 'voice',
  42: 'contactCard',
  43: 'video',
  47: 'emoji',
  48: 'location',
  49: 'link',
  50: 'voip',
  66: 'contactCard',
  10000: 'system',
  11000: 'empty',
  859832288: 'pat',
  922746960: 'pat',
  244135593199: 'miniapp',
  244: 'file',
  246: 'file',
}

/** 每种 renderType 的中文短标签（消息类型芯片 / 复制 JSON / 导出用）。 */
export const RENDER_LABEL: Record<RenderKind, string> = {
  text: '文本', image: '图片', voice: '语音', video: '视频', emoji: '表情',
  location: '位置', contactCard: '名片', file: '文件', link: '链接', quote: '引用',
  miniapp: '小程序', channels: '视频号', live: '直播', music: '音乐',
  product: '商品', card: '卡片', note: '笔记', sticker: '表情', announcement: '群公告',
  solitaire: '接龙', chatlog: '聊天记录', transfer: '转账', redpacket: '红包',
  voip: '通话', pat: '拍一拍', system: '系统消息', revoke: '撤回消息',
  empty: '无内容消息', unknown: '未知消息', unsupported: '暂不支持的消息',
}

/**
 * 归一到 renderType。
 *
 * 优先级：rich.type（最有信息量，来自 XML 载荷）> local_type 兜底表。
 * 系统消息按子类型细分（撤回单独成类，界面要单独配色）。
 * @param msgType - 归一化后的 local_type。
 * @param rich - 解析出的富媒体描述（可空）。
 * @param sysKind - 系统消息子类型（仅 msgType=10000 时有意义）。
 * @returns the render kind.
 */
export function classifyRender(
  msgType: number,
  rich?: { type?: string; url?: string } | null,
  sysKind?: string,
): RenderKind {
  if (msgType === 10000) return sysKind === 'revoke' ? 'revoke' : 'system'
  const richType = rich && typeof rich.type === 'string' ? rich.type : ''
  // 未列举的 appmsg 子类型走这里：有 url 才是链接卡，否则按文本显示标题，
  // 避免「有标题没链接」的消息被画成带假链接的卡片。
  if (richType === 'appmsg') return rich && rich.url ? 'link' : 'text'
  if (richType && RICH_TO_RENDER[richType]) return RICH_TO_RENDER[richType] as RenderKind
  const fallback = TYPE_TO_RENDER[msgType]
  return fallback ?? 'unknown'
}

/* ------------------------------------------------------------------ *
 * 群接龙
 * ------------------------------------------------------------------ */

/**
 * 群接龙的参与者名单（`<extinfo><solitaire_info>` 里的 CDATA）。
 *
 * 结构（本机实测，316 条接龙里 268 条带名单）：
 * ```xml
 * <solitaire><au>发起人 wxid</au><sid>1788156783179_8524</sid>
 *   <content><s>3</s><i><u>wxid</u><h>0</h><s>.</s><t>…</t><r>12-2</r><c>云端</c></i>…</content>
 * </solitaire>
 * ```
 * 两个容易读错的点：
 *  - `<content>` 里**带数字的 `<s>` 只有一个**，它是**名单总人数**（本机 266/268 等于
 *    `<i>` 块数；2 条比块数多 1，是有人退出后名单未同步）；`<i>` **内部**还有一个 `<s>`，
 *    但值是分隔符 `"."` —— 拿它当序号会全部变成 0。
 *  - 因此逐条序号只能用**位置**（1..N）。
 * @param app - the raw appmsg XML.
 * @returns 参与者（按名单顺序）与声明人数（无名单时为 0）。
 */
export function parseSolitaire(app: string): { members: SolitaireMember[]; declared: number } {
  const info = xmlTagText(app, 'solitaire_info')
  const members: SolitaireMember[] = []
  if (!info || !info.includes('<solitaire')) return { members, declared: 0 }
  const contentStart = info.indexOf('<content>')
  if (contentStart < 0) return { members, declared: 0 }
  const contentEnd = info.indexOf('</content>', contentStart)
  const body = info.slice(contentStart + 9, contentEnd > 0 ? contentEnd : info.length)
  const re = /<i>([\s\S]*?)<\/i>/g
  let m
  while ((m = re.exec(body))) {
    const item = m[1] ?? ''
    const username = xmlTagText(item, 'u')
    const content = unescapeXmlEntities(xmlTagText(item, 'c'))
    const ts = Number(xmlTagText(item, 't')) || 0
    if (username || content) members.push({ idx: members.length + 1, username, content, ts })
  }
  const firstItem = body.indexOf('<i>')
  const head = body.slice(0, firstItem < 0 ? body.length : firstItem)
  const dm = /<s>(\d+)<\/s>/.exec(head)
  return { members, declared: dm ? Number(dm[1]) : 0 }
}

/* ------------------------------------------------------------------ *
 * 引用消息
 * ------------------------------------------------------------------ */

/**
 * `<ref_msg_text>` 形如 `"莫伟基： [图片]"` —— 引用媒体消息时微信给出的现成文案。
 * 这里去掉外层引号与「昵称：」前缀，只留被引用对象的占位（`[图片]` 等）。
 * @param text - raw `<ref_msg_text>`.
 * @param name - the quoted message's sender display name (stripped prefix).
 * @returns the cleaned placeholder, or '' when it carries nothing.
 */
export function stripRefMsgText(text: string, name: string): string {
  if (!text) return ''
  let t = text.trim().replace(/^["“]/, '').replace(/["”]$/, '').trim()
  if (name && t.startsWith(name)) t = t.slice(name.length).replace(/^[：:]\s*/, '').trim()
  return t
}

/** 被引用的原消息是媒体时，给一个可读的占位（对应 local_type）。 */
export function quoteTypePlaceholder(type: number): string {
  switch (type) {
    case 3: return '[图片]'
    case 34: return '[语音]'
    case 43: return '[视频]'
    case 47: return '[表情]'
    case 48: return '[位置]'
    case 42: return '[名片]'
    case 50: return '[通话]'
    case 10000: return '[系统消息]'
    case 49: return '[应用消息]'
    default: return ''
  }
}

/** appmsg 子类型 → 引用占位标签（被引用的是卡片型消息时）。 */
export const QUOTE_APP_LABEL: Record<number, string> = {
  2: '商品', 3: '音乐', 4: '视频号', 5: '链接', 6: '文件', 8: '表情', 19: '聊天记录',
  24: '笔记', 33: '小程序', 36: '小程序', 42: '名片', 50: '版本不支持', 51: '视频号',
  53: '接龙', 57: '引用', 62: '拍一拍', 63: '直播', 68: '链接', 74: '文件',
  87: '群公告', 88: '直播', 2000: '转账', 2001: '红包', 2003: '红包',
}

/**
 * 把一段（可能内嵌 XML 的）引用内容折成一句可读摘要。
 *
 * 被引用的原消息不是纯文本时，`<refermsg><content>` 里可能是三种形态之一：
 *
 * | 被引用的是 | content 形态 |
 * | --- | --- |
 * | 文本 | 纯文本（直接用） |
 * | 图片/语音/视频/表情/位置 | `wxid_xxx:\n<?xml…><img aeskey=…>`（**带群消息前缀**的单标签 XML） |
 * | appmsg（转账/链接/商品…） | 整段 `<msg><appmsg…><type>2000</type>…` |
 *
 * 直接当文本显示会在界面上糊一大片 XML，所以这里折成一句可读摘要。
 * @param xml - the quoted content.
 * @returns a readable summary (`[转账]`、`[链接] 标题`、`[图片]`, …) or the original text.
 */
export function stripQuotedGroupPrefix(raw: string): string {
  const text = (raw ?? '').trim()
  // 群消息里被引用的原文带「wxid_xxx:\n」前缀（与 parseMessageContent 的群前缀同形）
  const pos = text.indexOf(':\n')
  if (pos > 0 && pos <= 64 && !text.slice(0, pos).includes(' ') && !text.slice(0, pos).includes('<')) return text.slice(pos + 2).trim()
  return text
}

/**
 * 被引用内容若是 appmsg，取出它的子类型（转账 2000 / 红包 2001·2003 / 链接 5…）。
 *
 * 界面要靠它给引用行配**类型图标**（官方参考图里引用一条转账显示的是转账图标 +
 * 「微信转账」，而不是通用链接图标）。refermsg 自己的 `<type>` 只有 49（appmsg 族），
 * 分不出转账与链接，子类型只在内层 appmsg 里。
 * @param xml - the quoted content.
 * @returns the appmsg `<type>`, or 0 when not an appmsg.
 */
export function quotedAppType(xml: string): number {
  const text = stripQuotedGroupPrefix(xml)
  if (!text.includes('<appmsg')) return 0
  return Number((/<appmsg[\s\S]*?<type>(\d+)<\/type>/.exec(text) ?? [])[1] ?? 0) || 0
}

export function summarizeQuotedXml(xml: string): string {
  const text = stripQuotedGroupPrefix(xml)
  if (!text.startsWith('<')) return unescapeXmlEntities(text)
  if (text.includes('<appmsg')) {
    const appType = Number((/<appmsg[\s\S]*?<type>(\d+)<\/type>/.exec(text) ?? [])[1] ?? 0)
    const title = cleanRichText(xmlTagText(text, 'title'))
    if (appType === 2000) return title ? `[转账] ${title}` : '[转账]'
    if (appType === 2001 || appType === 2003) return title ? `[红包] ${title}` : '[红包]'
    const label = QUOTE_APP_LABEL[appType]
    if (label) {
      const summary = title || cleanRichText(xmlTagText(text, 'des'))
      return summary ? `[${label}] ${summary}` : `[${label}]`
    }
  }
  // 单标签媒体（可能被 <msg> 包着）
  const MEDIA: ReadonlyArray<[RegExp, string]> = [
    [/<img\b/, '[图片]'], [/<voicemsg\b/, '[语音]'], [/<videomsg\b/, '[视频]'],
    [/<emoji\b/, '[表情]'], [/<location\b/, '[位置]'], [/<contact\b/, '[名片]'],
    [/<voipmsg\b/, '[通话]'],
  ]
  for (const [re, label] of MEDIA) if (re.test(text)) return label
  const stripped = cleanRichText(text)
  return stripped ? stripped.slice(0, 200) : ''
}

/**
 * 引用消息的缩略图（被引用的是链接/视频号时）。
 * 各版本字段名不一致（thumburl / cdnthumburl / coverurl），逐个兜底。
 * @param raw - the quoted content (may be XML or a `wxid:payload` wrapper).
 * @returns a cdn thumb url, or ''.
 */
export function quotedThumbUrl(raw: string): string {
  let candidate = (raw ?? '').trim()
  if (!candidate) return ''
  const colon = candidate.indexOf(':')
  if (candidate.startsWith('wxid_') && colon > 0 && colon <= 64) candidate = candidate.slice(colon + 1).trim()
  for (const key of ['thumburl', 'cdnthumburl', 'cdnthumurl', 'coverurl', 'cover']) {
    const v = xmlTagOrAttr(candidate, key)
    if (v) return unescapeXmlEntities(v)
  }
  return ''
}

/* ------------------------------------------------------------------ *
 * 图片组（微信「多图合并」）
 * ------------------------------------------------------------------ */

/**
 * 图片组 id 的合法形态。
 *
 * ⚠️ 本机真实数据里是**无连字符的 32 位 hex**（md5 形态，实测 8 条消息共享同一个 id）：
 * `<groupinfo><id>e50fcb7be682d22ab67aded24c9f17e0</id><count>6</count><type>1</type></groupinfo>`
 * WeChatDataAnalysis 的校验只认**带连字符的标准 UUID**，在本机数据上会把这一组全部判成
 * 非图片组（连拍退化成 6 张散图）。所以两种形态都接受 —— 再加上 `count ≥ 2`，
 * 依然足以排除偶发同名节点造成的误判。
 */
export const IMAGE_GROUP_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$/i

/**
 * 解析 `<img>` 里的 `<groupinfo>`，得到「这组图共几张」。
 *
 * 微信把连拍的图片合并成一条「图片组」消息发送：组的元数据在 `<groupinfo>`
 * 里（`type`/`id`/`count`），组内每张图各占一条消息、共享同一个 id。
 * 校验严格（id 必须是 32 位 hex 或标准 UUID、count ≥ 2），避免把普通 `<img>` 上
 * 偶发的同名子节点当成组 —— 误判会让本该单张显示的消息被塞进合并卡里。
 * @param xml - the raw image message XML.
 * @returns group id + declared count, or null when not a valid group.
 */
export function parseImageGroup(xml: string): { id: string; count: number; type: string } | null {
  if (!xml || !xml.includes('<groupinfo')) return null
  const start = xml.indexOf('<groupinfo')
  const end = xml.indexOf('</groupinfo', start)
  if (start < 0 || end < 0) return null
  const block = xml.slice(start, end)
  const type = xmlTagText(block, 'type').trim()
  const id = xmlTagText(block, 'id').trim()
  const count = Number(xmlTagText(block, 'count').trim())
  if (!type || !id || !IMAGE_GROUP_ID.test(id)) return null
  if (!Number.isFinite(count) || count < 2) return null
  return { id: id.toLowerCase(), count, type }
}

/* ------------------------------------------------------------------ *
 * appmsg
 * ------------------------------------------------------------------ */

/**
 * 提取 `<appmsg>` 直系子节点的 `<type>`。
 *
 * **不能**对整段 XML 直接找第一个 `<type>`：`<refermsg>` / `<recorditem>` /
 * `<weappinfo>` 内部都有各自的 `<type>`，先命中它们会把引用消息判成链接、
 * 把小程序判成别的。本机实测因此错判过整批消息。
 * @param xml - the raw appmsg XML.
 * @returns the appmsg subtype (0 when absent).
 */
export function parseAppmsgType(xml: string): number {
  const probe = xml ?? ''
  const m = probe.match(/<appmsg\b[^>]*>([\s\S]*?)<\/appmsg>/i)
  let inner = m ? (m[1] ?? '') : probe
  inner = inner
    .replace(/<refermsg\b[^>]*>[\s\S]*?<\/refermsg>/gi, '')
    .replace(/<patmsg\b[^>]*>[\s\S]*?<\/patmsg>/gi, '')
    .replace(/<recorditem\b[^>]*>[\s\S]*?<\/recorditem>/gi, '')
    .replace(/<weappinfo\b[^>]*>[\s\S]*?<\/weappinfo>/gi, '')
    .replace(/<wxaappinfo\b[^>]*>[\s\S]*?<\/wxaappinfo>/gi, '')
  const t = Number(xmlTagText(inner, 'type'))
  return Number.isFinite(t) ? t : 0
}

/**
 * 链接卡片的语义分类。
 *
 * `公众号文章` vs `普通网页`：`<type>5|68</type>` 且 url 命中 mp.weixin.qq.com
 * 或来源是 `gh_*`。封面式（`cover`）用于公众号「大图 + 底部标题」那种卡片，
 * 判据是摘要以话题标签开头 / 含 ≥2 个 `#话题#` / PC 信息流链接。
 * @returns [linkType, linkStyle].
 */
export function classifyLinkShare(url: string, sourceUsername: string, desc: string, appType: number): [string, string] {
  const src = (sourceUsername || '').toLowerCase()
  let host = ''
  try { host = new URL(url).hostname.toLowerCase() } catch { host = '' }
  const isArticle = (appType === 5 || appType === 68)
    && (host === 'mp.weixin.qq.com' || host.endsWith('.mp.weixin.qq.com') || src.startsWith('gh_'))
  const linkType = isArticle ? 'official_article' : 'web_link'
  const hashtags = (desc.match(/#[^#\s]+/g) ?? []).length
  const feedLike = /exptype=masonry_feed/i.test(url)
  const coverLike = isArticle && (desc.trimStart().startsWith('#') || hashtags >= 2 || feedLike)
  return [linkType, coverLike ? 'cover' : 'default']
}

/** 把 appmsg 的 `<appattach>` 解析成文件卡片字段。 */
export function parseFileAttach(app: string): { size: string; ext: string; md5: string } {
  const size = xmlTagText(app, 'totallen') || xmlTagOrAttr(app, 'filesize')
  const ext = xmlTagText(app, 'fileext')
  const md5 = xmlTagOrAttr(app, 'md5') || xmlTagOrAttr(app, 'filemd5') || xmlTagOrAttr(app, 'file_md5')
  return { size: size || '', ext: ext || '', md5: md5 || '' }
}

/** 视频号解析（`<type>4</type>` / `51` / `63` 共用，字段各版本命名不一致）。 */
export function channelsRich(
  app: string, title: string, des: string, url: string, thumb: string,
  source: string, sourceUsername: string, base: Pick<RichMedia, 'source' | 'thumb'>,
): RichMedia {
  const feed = xmlTagText(app, 'finderFeed')
  const feedDesc = unescapeXmlEntities(
    (feed ? xmlTagText(feed, 'desc') : '') || xmlTagText(app, 'finderdesc') || des,
  )
  const nick = unescapeXmlEntities(
    xmlTagText(app, 'findernickname') || (feed ? xmlTagText(feed, 'nickname') || xmlTagText(feed, 'findernickname') : ''),
  )
  const user = xmlTagText(app, 'finderusername') || (feed ? xmlTagText(feed, 'username') || xmlTagText(feed, 'finderusername') : '')
  const objectId = (feed ? xmlTagOrAttr(feed, 'objectid') : '') || xmlTagOrAttr(app, 'objectid')
  const objectNonce = (feed ? xmlTagOrAttr(feed, 'objectnonceid') : '') || xmlTagOrAttr(app, 'objectnonceid')
  // 51 的 title 常是「当前微信版本不支持展示该内容」——不换掉卡片就只有一句错误提示。
  let displayTitle = title
  if (!displayTitle || displayTitle.includes('不支持')) displayTitle = feedDesc || des
  const rich: RichMedia = {
    type: 'channels',
    title: displayTitle || '[视频号]',
    desc: feedDesc || displayTitle || '',
    url: url || (feed ? xmlTagText(feed, 'url') : '') || xmlTagText(app, 'playurl'),
    ...base,
  }
  const from = nick || source
  if (from) rich.source = from
  if (user || sourceUsername) rich.sourceUsername = user || sourceUsername
  if (objectId) rich.objectId = objectId
  if (objectNonce) rich.objectNonceId = objectNonce
  return rich
}

/**
 * 公众号推送（`<mmreader>`）→ 大图封面 + 次条列表。
 *
 * 实测结构（`biz_message_0.db` 里 gh_ 会话，2026-09）：
 * ```xml
 * <mmreader><category type="20" count="2"><name>公众号名</name>
 *   <topnew><cover>头条封面</cover><width>0</width><height>0</height></topnew>
 *   <item>…头条自身（title/url 与 appmsg 完全重复）…</item>
 *   <item>…次条：title/title_v2/url/cover/summary…</item>
 * </category></mmreader>
 * ```
 * 判据：`items[0]` 与 appmsg 自身的 title/url 相同（实测 #9/#10/#11 三条一致），
 * 所以按「标题或链接与头条相同」跳过它，**次条从第 2 个 item 起**。
 * 界面按官方形态渲染：单篇 = 大图 + 标题在下方；多篇 = 大图（头条）+ 每篇次条一行（标题 + 小方图）。
 *
 * `width`/`height` 实测恒为 0，别拿它算比例；封面统一按 16:9 裁。
 * @param link - the link descriptor to enrich (mutated in place).
 * @param app - the appmsg XML.
 * @param firstTitle - the appmsg-level title (the top article's).
 * @param firstUrl - the appmsg-level url (the top article's).
 * @param fallbackCover - `thumburl`, used when `<topnew><cover>` is absent.
 */
export function applyMpNews(link: RichMedia, app: string, firstTitle: string, firstUrl: string, fallbackCover: string): void {
  if (!app.includes('<mmreader')) return
  const reader = xmlTagText(app, 'mmreader') || app
  const topnew = xmlTagText(reader, 'topnew')
  const topCover = unescapeXmlEntities(topnew ? xmlTagText(topnew, 'cover') : '')
  const cover = topCover || unescapeXmlEntities(fallbackCover)
  const secondary: MpArticle[] = []
  for (const it of xmlTagBlocks(reader, 'item')) {
    const title = unescapeXmlEntities(xmlTagText(it, 'title_v2') || xmlTagText(it, 'title'))
    const url = unescapeXmlEntities(xmlTagText(it, 'url'))
    if (!title || title === firstTitle || (url && url === firstUrl)) continue
    const art: MpArticle = { title, url }
    const c = unescapeXmlEntities(xmlTagText(it, 'cover'))
    if (c) art.cover = c
    const summary = unescapeXmlEntities(xmlTagText(it, 'summary'))
    if (summary) art.summary = summary
    secondary.push(art)
  }
  link.mpNews = true
  // 公众号推送一律走大图卡：`linkStyle` 的既有启发式（摘要带话题标签 / PC 信息流）
  // 对推送无效，实测这些推送的 des 是空的，会被判成小链接卡。
  link.linkStyle = 'cover'
  if (cover) link.thumb = cover
  if (secondary.length) link.mpArticles = secondary
}

/**
 * Parse the appmsg block (type 49) into its rich subtype.
 *
 * 覆盖本机**实测存在**的全部子类型（真实外层 type 普查：
 * 6×2991 文件、33×1690 应用卡、57×1581 引用、5×701 链接、53×209 接龙、
 * 2000×208 转账、19×84 聊天记录、51×56 视频号、24×53 笔记、36×32 卡片、
 * 8×22 表情、1×6 纯文本、50×6 不支持、87×4 群公告、4×2 网页、63×2 直播、
 * 62×1 拍一拍），每个都给出**可读**的 title/desc 与界面需要的定位字段。
 * 未列举的子类型退回 title/desc，而不是空气泡。
 * @param xml - the raw appmsg XML (the whole `<msg>` body is fine).
 * @returns the rich descriptor, or null when nothing readable was found.
 */
export function parseAppmsg(xml: string): RichMedia | null {
  const app = xml
  const appType = parseAppmsgType(app)
  // ⚠️ title/des 必须**解码实体**：微信把连续空格写成 `&#x20;`，公众号标题里很常见
  // （实测「美团每天&#x20;1.2&#x20;亿&#x20;Token&#x20;免费用！」）。不清洗就会在卡片标题里
  // 显示出一串 `&#x20;` —— 这是 `st-verify-msg-render` 在真实 DOM 上抓到的。
  const title = unescapeXmlEntities(xmlTagText(app, 'title'))
  const des = unescapeXmlEntities(xmlTagText(app, 'des') || xmlTagText(app, 'desc'))
  const url = unescapeXmlEntities(xmlTagText(app, 'url'))
  const thumb = xmlTagText(app, 'thumburl') || xmlTagText(app, 'tpthumburl')
    || xmlAttr(app, 'img', 'cdnthumburl') || xmlTagOrAttr(app, 'cdnthumburl')
    || xmlTagOrAttr(app, 'coverurl') || xmlTagOrAttr(app, 'cover') || ''
  const source = unescapeXmlEntities(
    xmlTagText(app, 'sourcedisplayname') || xmlTagText(app, 'sourcedisplaynick')
    || xmlTagText(app, 'appname') || '',
  )
  const sourceUsername = xmlTagText(app, 'sourceusername') || ''
  const base: Pick<RichMedia, 'source' | 'thumb'> = {}
  if (source) base.source = source
  if (thumb) base.thumb = unescapeXmlEntities(thumb)

  switch (appType) {
    case 6:
    case 74: {
      const fileRich: RichMedia = { type: 'file', title, desc: des, url, ...base }
      const attach = parseFileAttach(app)
      if (attach.size) fileRich.fileSize = attach.size
      if (attach.ext) fileRich.fileExt = attach.ext
      if (attach.md5) fileRich.fileMd5 = attach.md5
      return fileRich
    }
    case 5:
    case 68: {
      const [linkType, linkStyle] = classifyLinkShare(url, sourceUsername, des, appType)
      const link: RichMedia = { type: 'link', title, desc: des, url, linkType, linkStyle, ...base }
      if (sourceUsername) link.sourceUsername = sourceUsername
      applyMpNews(link, app, title, url, thumb)
      return link
    }
    case 4: {
      // ⚠️ 实测纠正：`<type>4</type>` **不是**视频号。本机唯一一条 type-4 样本是
      // 小红书笔记分享（标题「大厂的奇闻！立马会被删帖」、url=xiaohongshu.com）。
      // 有 url 就按链接卡渲染（与 WeChatDataAnalysis 对 4/5/68 的处理一致）；
      // 只有确实带 `<finderFeed>` 时才当视频号，避免把普通网页错标成视频号。
      if (url && !/<finderFeed/i.test(app)) {
        const [linkType, linkStyle] = classifyLinkShare(url, sourceUsername, des, appType)
        const link: RichMedia = { type: 'link', title, desc: des, url, linkType, linkStyle, ...base }
        if (sourceUsername) link.sourceUsername = sourceUsername
        return link
      }
      return channelsRich(app, title, des, url, thumb, source, sourceUsername, base)
    }
    case 1: {
      // 以 appmsg 包装的纯文本（本机 6 条）：直接给文本，不该退化成链接卡。
      const plain = cleanRichText(title) || cleanRichText(des)
      if (plain) return { type: 'appmsg', title: plain, desc: cleanRichText(des) === plain ? '' : cleanRichText(des), ...base }
      return null
    }
    case 3: {
      // 音乐分享：标题是歌名，des 是歌手，封面在 songalbumurl。
      const cover = xmlTagOrAttr(app, 'songalbumurl') || xmlTagOrAttr(app, 'mvCoverUrl') || thumb
      const music: RichMedia = { type: 'music', title, desc: des, url: url || xmlTagText(app, 'dataurl') }
      if (cover) music.thumb = unescapeXmlEntities(cover)
      if (source) music.source = source
      return music
    }
    case 57: {
      // 引用（回复某条消息）。**被引用的内容不在 `<refer>`（该标签不存在），而在 `<refermsg>`**：
      //   <refermsg><content>被引用的原文</content><displayname>发送者昵称</displayname>
      //     <type>被引用消息的类型</type><createtime>…</createtime><svrid>…</svrid>
      //     <ref_msg_text>"昵称： [图片]"</ref_msg_text>   ← content 为空（引用的是媒体）时的现成文案
      // 本机 1312 条引用消息 **100%** 带 refermsg，其中 1300 条 content 非空。
      // 旧实现读的是 `<refer>` → 恒为空 → 引用卡只剩「我的回复」，看不到引用了什么。
      const refer = xmlTagText(app, 'refermsg')
      const replyText = cleanRichText(title) || cleanRichText(des)
      let quoted = refer ? unescapeXmlEntities(xmlTagText(refer, 'content')).trim() : ''
      const referName = refer ? unescapeXmlEntities(xmlTagText(refer, 'displayname')).trim() : ''
      const referType = refer ? Number(xmlTagText(refer, 'type')) || 0 : 0
      const referTime = refer ? Number(xmlTagText(refer, 'createtime')) || 0 : 0
      const referSvrId = refer ? xmlTagText(refer, 'svrid').trim() : ''
      const refText = refer ? unescapeXmlEntities(xmlTagText(refer, 'ref_msg_text')).trim() : ''
      // 回复正文与引用原文同形时（同一条消息被完整重复）去掉重复段，
      // 界面就不会出现「回复 X」下面又贴一遍 X 的冗余。
      if (replyText && quoted) {
        if (quoted === replyText) quoted = ''
        else if (quoted.split(/\r?\n/)[0]?.trim() === replyText) quoted = quoted.split(/\r?\n/).slice(1).join('\n').trim()
        else if (quoted.startsWith(replyText)) quoted = quoted.slice(replyText.length).trim()
      }
      let desc = summarizeQuotedXml(quoted) || stripRefMsgText(refText, referName) || quoteTypePlaceholder(referType) || des
      let thumb: string | undefined
      if (referType === 49 || referType === 5 || referType === 68) {
        const t = quotedThumbUrl(quoted)
        if (t) thumb = t
        if (!desc.startsWith('[') && quoted) desc = `[链接] ${cleanRichText(quoted)}`
      } else if (referType === 51 || referType === 4 || referType === 63) {
        const t = quotedThumbUrl(quoted)
        if (t) thumb = t
      }
      const rich: RichMedia = { type: 'quote', title: replyText || cleanRichText(title) || cleanRichText(des), desc, ...base }
      if (thumb) rich.thumb = thumb
      if (referName) rich.referName = referName
      if (referType) rich.referType = referType
      const referAppType = quotedAppType(quoted)
      if (referAppType) rich.referAppType = referAppType
      if (referTime) rich.referTime = referTime
      if (referSvrId) rich.referSvrId = referSvrId
      const referUser = refer ? (xmlTagText(refer, 'fromusr') || xmlTagText(refer, 'chatusr')).trim() : ''
      if (referUser) rich.referUsername = referUser
      return rich
    }
    case 33: {
      // 小程序 / 应用卡（本机 1,690 条，标题是应用卡片文案，url 多为
      // `mp.weixin.qq.com/mp/waerrpage`）。来源与图标在 `<weappinfo>` 里。
      // 页面封面（列表截图）在 cdnthumburl，比 weappiconurl（应用图标）更适合做卡片主图。
      const weapp = xmlTagText(app, 'weappinfo') || xmlTagText(app, 'wxaappinfo')
      const weappUser = weapp ? xmlTagText(weapp, 'username') : ''
      const weappNick = weapp ? (xmlTagText(weapp, 'nickname') || xmlTagText(weapp, 'appname')) : ''
      const appIcon = (weapp ? xmlTagOrAttr(weapp, 'weappiconurl') : '') || xmlTagOrAttr(app, 'weappiconurl')
      // 页面预览图优先（列表/详情截图），应用图标仅作顶栏小圆标。
      const pageCover = (weapp
        ? (xmlTagOrAttr(weapp, 'cdnthumburl') || xmlTagOrAttr(weapp, 'thumburl') || xmlTagOrAttr(weapp, 'coverurl'))
        : '')
        || xmlTagOrAttr(app, 'cdnthumburl') || xmlTagOrAttr(app, 'coverurl') || ''
      // title/des 可能夹带 XML（实测过属性串当摘要）；小程序卡只展示可读文本。
      const miniTitle = cleanRichText(title) || cleanRichText(des) || '[小程序]'
      const miniDesc = cleanRichText(des)
      const mini: RichMedia = { type: 'miniapp', title: miniTitle, url, ...base }
      // desc：与标题相同或仍是 XML 噪声时留空，避免「标题下面再甩一屏标签」。
      if (miniDesc && miniDesc !== miniTitle && !/[<>]/.test(miniDesc)) mini.desc = miniDesc
      const cover = unescapeXmlEntities(pageCover || thumb || '')
      if (cover) mini.thumb = cover
      const icon = unescapeXmlEntities(appIcon || '')
      if (icon) mini.avatar = icon
      const from = source || weappNick
      if (from) mini.source = from
      const fromUser = weappUser || sourceUsername
      if (fromUser) mini.sourceUsername = fromUser
      return mini
    }
    case 36: {
      // ⚠️ 实测纠正：36 **不是**小程序，是第三方「小程序/H5 卡片」——本机样本
      // 形如 `<title>南宁车源推荐</title><url>https://inner-h5.jytche.com/…`，
      // 另一条是美团团购卡。上游 WeChatDataAnalysis 把 33/36 合并成
      // mini_program，会让这类卡片丢失「可跳转网页」的语义。
      const card: RichMedia = { type: 'card', title, desc: des, url, ...base }
      if (sourceUsername) card.sourceUsername = sourceUsername
      return card
    }
    case 51:
      // 视频号 / 直播分享（51 的内容多为「当前微信版本不支持展示该内容」）。
      return channelsRich(app, title, des, url, thumb, source, sourceUsername, base)
    case 53: {
      // 群接龙。title 形如 "#接龙\n明晚球\n\n1. 云端"，但**参与者名单**在
      // `<extinfo><solitaire_info>` 的 CDATA 里（一段独立的 <solitaire> XML）。
      // 旧实现只取 title，本机 316 条接龙里 268 条带着名单却全部丢弃，
      // 界面上退化成一张通用链接卡（标题里只有第一行内容）。
      const sol = parseSolitaire(app)
      const rich: RichMedia = { type: 'solitaire', title, desc: des, ...base }
      if (sol.members.length > 0) {
        rich.members = sol.members
        const info = xmlTagText(app, 'solitaire_info')
        const by = xmlTagText(info, 'au')
        if (by) rich.by = by
        const sid = xmlTagText(info, 'sid')
        if (sid) rich.sid = sid
        if (sol.declared > 0) rich.declared = sol.declared
      }
      return rich
    }
    case 24:
      // 笔记 / 收藏：title 常为空，内容在 des（例如 "[视频]"）。
      return { type: 'note', title: title || des, desc: des && title ? des : '', ...base }
    case 8: {
      // 表情（以 appmsg 形式发送的自定义表情）：md5 在 <emojiinfo><md5>。
      const sticker: RichMedia = { type: 'sticker', title: title || xmlTagText(app, 'md5'), md5: xmlTagText(app, 'md5') || xmlTagText(app, 'emoticonmd5') || '', ...base }
      // 与 type-47 同理：图靠 CDN 取（本地缓存是加密的），字段可能在 <emojiinfo> 里。
      const info = xmlTagText(app, 'emojiinfo')
      const emojiUrl = unescapeXmlEntities((info ? xmlTagOrAttr(info, 'cdnurl') : '') || xmlTagOrAttr(app, 'cdnurl'))
      if (emojiUrl) sticker.emojiUrl = emojiUrl
      return sticker
    }
    case 2:
      // 商品 / 购物卡片：title 是商品名，des 是来源（如「拼多多」）。
      return { type: 'product', title, desc: des, url, ...base }
    case 62: {
      // 拍一拍：title 形如 "我拍了拍 "王国威" 我的屁股"。
      const patText = unescapeXmlEntities(title || des || '拍了拍')
      return { type: 'pat', title: patText, ...base }
    }
    case 87: {
      // 群公告：正文可能在 textannouncement / announcement / content（HTML）。
      const rawBody = xmlTagText(app, 'textannouncement') || xmlTagText(app, 'announcement') || xmlTagText(app, 'content') || des || ''
      const plain = unescapeXmlEntities(stripXmlTags(stripCdata(rawBody)))
      return { type: 'announcement', title: title || '群公告', desc: plain || '', ...base }
    }
    case 63:
    case 88: {
      // 直播卡片：封面字段各版本命名不一致，逐个兜底。
      const cover = xmlTagOrAttr(app, 'coverurl') || xmlTagOrAttr(app, 'cover')
        || xmlTagOrAttr(app, 'livecoverurl') || thumb
      const liveStatus = xmlTagText(app, 'livestatus') || xmlTagText(app, 'status') || xmlTagText(app, 'livestate')
      const liveTitle = unescapeXmlEntities(title || xmlTagText(app, 'live_title') || des)
      const live: RichMedia = { type: 'live', title: liveTitle || '[直播]', desc: des, url, ...base }
      if (cover) live.thumb = unescapeXmlEntities(cover)
      if (liveStatus) live.status = liveStatus.trim()
      return live
    }
    case 50:
      // 当前版本不支持展示的内容。
      return { type: 'unsupported', title: title || des || '当前微信版本不支持展示该内容', ...base }
    case 19: {
      const rt = xmlTagText(app, 'recorditem')
      const records = rt ? parseChatlogRecords(rt) : []
      const preview = des || (rt ? xmlTagText(rt, 'desc') : '')
      const chatlog: RichMedia = { type: 'chatlog', title: title || '群聊的聊天记录' }
      if (preview) chatlog.desc = preview
      if (records.length > 0) chatlog.records = records
      return { ...chatlog, ...base }
    }
    case 42: {
      // 名片（以 appmsg 形式发送）：直系节点或 msg 属性两种形态都要取。
      const cardUser = unescapeXmlEntities((xmlTagText(app, 'username') || xmlAttr(app, 'msg', 'username') || xmlTagText(app, 'fromusername')).trim())
      const cardNick = unescapeXmlEntities((xmlTagText(app, 'nickname') || xmlAttr(app, 'msg', 'nickname') || xmlTagText(app, 'displayname') || title).trim())
      const cardAlias = unescapeXmlEntities((xmlTagText(app, 'alias') || xmlAttr(app, 'msg', 'alias') || xmlTagText(app, 'remark')).trim())
      const cardAvatar = xmlTagOrAttr(app, 'headimgurl') || xmlTagOrAttr(app, 'smallheadimgurl') || xmlTagOrAttr(app, 'headimg') || xmlTagOrAttr(app, 'avatar')
      const card: RichMedia = { type: 'contact', title: cardNick || cardUser || des || '名片', nickname: cardNick, username: cardUser }
      if (cardAlias) card.alias = cardAlias
      if (cardAvatar) card.avatar = unescapeXmlEntities(cardAvatar)
      return card
    }
    case 2000: {
      // wcpayinfo: feedesc carries the amount (￥0.01); the state label is
      // derived client-side from paysubtype + is_sender (st_control mapping).
      const feedesc = unescapeXmlEntities(xmlTagOrAttr(app, 'feedesc'))
      const amount = feedesc || title || ''
      const paySub = xmlTagOrAttr(app, 'paysubtype')
      const recvStatus = xmlTagOrAttr(app, 'receivestatus')
      const memo = unescapeXmlEntities(xmlTagOrAttr(app, 'pay_memo'))
      const transfer: RichMedia = { type: 'transfer', title: amount }
      if (paySub) transfer.paysubtype = paySub
      if (recvStatus) transfer.receiveStatus = recvStatus
      if (memo) transfer.desc = memo
      return { ...transfer, ...base }
    }
    case 2001:
    case 2003: {
      // wcpayinfo.feedesc carries the red packet amount (￥8.88).
      const amount = unescapeXmlEntities(xmlTagOrAttr(app, 'feedesc'))
      const greet = unescapeXmlEntities(title || des || xmlTagText(app, 'sendertitle') || xmlTagText(app, 'receivertitle') || '')
      const cover = xmlTagText(app, 'receiverc2cshowsourceurl')
      const rp: RichMedia = { type: 'redpacket', title: '微信红包' }
      if (greet) rp.desc = greet
      if (amount) rp.amount = amount.replace(/^\s*[Y￥]/, '')
      if (cover) rp.thumb = cover
      if (appType !== 2001) rp.paysubtype = String(appType)
      return { ...rp, ...base }
    }
    default: {
      // 未逐一列举的子类型：**绝不返回空**，退回 title/desc/url。
      if (title || des) return { type: 'appmsg', title: title || des, desc: des, url, ...base }
      const fallback = cleanRichText(extractXmlTextNodes(app))
      if (fallback) return { type: 'appmsg', title: fallback, ...base }
      return null
    }
  }
}

/**
 * Parse an appmsg recorditem (merged chat log) into inner records.
 * Mirrors WeChatDataAnalysis frontend parseChatHistoryRecord: datatype /
 * datafmt classify each dataitem; nested recordxml/recorditem recurses.
 * @param recordXml - the recorditem inner XML (<recordinfo>...</recordinfo>).
 * @param depth - recursion guard for nested chat histories.
 * @returns the inner messages (empty when not parseable).
 */
export function parseChatlogRecords(recordXml: string, depth = 0): ChatlogRecord[] {
  if (depth > 3) return []
  const ri = xmlTagText(recordXml, 'recordinfo')
  if (!ri) return []
  const dl = xmlTagText(ri, 'datalist')
  if (!dl) return []
  const imageFmts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'heif']
  const audioFmts = ['silk', 'amr', 'aud', 'mp3', 'wav', 'm4a', 'aac', 'ogg', 'opus']
  const videoFmts = ['mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm']
  const out: ChatlogRecord[] = []
  let pos = 0
  let idx = 0
  for (;;) {
    const s = dl.indexOf('<dataitem', pos)
    if (s < 0) break
    const e = dl.indexOf('</dataitem>', s)
    if (e < 0) break
    const item = dl.slice(s, e + 11)
    pos = e + 11
    const datatype = xmlAttr(item, 'dataitem', 'datatype')
    const name = unescapeXmlEntities(xmlTagText(item, 'sourcename'))
    const head = xmlTagText(item, 'sourceheadurl')
    const time = xmlTagText(item, 'sourcetime')
    const datatitle = unescapeXmlEntities(xmlTagText(item, 'datatitle'))
    const datadesc = unescapeXmlEntities(xmlTagText(item, 'datadesc'))
    const datafmt = xmlTagText(item, 'datafmt').trim().toLowerCase().replace(/^\./, '')
    const duration = xmlTagText(item, 'duration')
    const datasize = xmlTagText(item, 'datasize')
    const link = xmlTagText(item, 'link') || xmlTagText(item, 'dataurl') || xmlTagText(item, 'url')
    const externurl = xmlTagText(item, 'externurl')
    const cdnurlstring = xmlTagText(item, 'cdnurlstring')
    const encrypturlstring = xmlTagText(item, 'encrypturlstring')
    const fullmd5 = xmlTagText(item, 'fullmd5')
    const thumbfullmd5 = xmlTagText(item, 'thumbfullmd5')
    const md5 = xmlTagText(item, 'md5') || xmlTagText(item, 'emoticonmd5')
    const fromnewmsgid = xmlTagText(item, 'fromnewmsgid')
    const srcMsgLocalid = xmlTagText(item, 'srcMsgLocalid') || xmlTagText(item, 'srcMsgLocalId')
    const srcMsgCreateTime = xmlTagText(item, 'srcMsgCreateTime')
    const nestedRaw = xmlTagText(item, 'recordxml') || xmlTagText(item, 'recorditem')
    if (!name && !datatitle && !datadesc && !link) {
      idx += 1
      continue
    }

    let renderType: ChatlogRecord['renderType'] = 'text'
    if (datatype === '17') renderType = 'chatHistory'
    else if (datatype === '5' || link) renderType = 'link'
    else if (datatype === '4' || videoFmts.includes(datafmt)) renderType = 'video'
    else if (datatype === '3' || audioFmts.includes(datafmt)) renderType = 'voice'
    else if (datatype === '47' || datatype === '37') renderType = 'emoji'
    else if (datatype === '2' || imageFmts.includes(datafmt)) renderType = 'image'

    let content = datatitle || datadesc
    if (!content) {
      if (renderType === 'video') content = '[视频]'
      else if (renderType === 'image') content = '[图片]'
      else if (renderType === 'voice') content = '[语音]'
      else if (renderType === 'emoji') content = '[表情]'
      else if (renderType === 'chatHistory') content = '[聊天记录]'
      else content = '[消息]'
    }

    const rec: ChatlogRecord = {
      name,
      time,
      text: content,
    }
    if (head) rec.head = head
    if (datatype) rec.datatype = datatype
    rec.renderType = renderType
    if (datatitle) rec.datatitle = datatitle
    if (datafmt) rec.datafmt = datafmt
    if (duration) rec.duration = duration
    if (datasize) rec.datasize = datasize
    if (link) { rec.link = link; rec.url = link }
    if (externurl) rec.externurl = externurl
    if (cdnurlstring) rec.cdnurlstring = cdnurlstring
    if (encrypturlstring) rec.encrypturlstring = encrypturlstring
    if (fullmd5) rec.fullmd5 = fullmd5
    if (thumbfullmd5) rec.thumbfullmd5 = thumbfullmd5
    if (md5) rec.md5 = md5
    if (fromnewmsgid) rec.fromnewmsgid = fromnewmsgid
    if (srcMsgLocalid) {
      const v = Number(srcMsgLocalid)
      if (v > 0) rec.srcMsgLocalid = v
    }
    if (srcMsgCreateTime) {
      const v = Number(srcMsgCreateTime)
      if (v > 0) rec.srcMsgCreateTime = v
    }
    rec.recordIndex = idx
    if (renderType === 'chatHistory' && nestedRaw) {
      const nested = parseChatlogRecords(nestedRaw, depth + 1)
      if (nested.length > 0) rec.nested = nested
    }
    if (renderType === 'image') rec.isImage = true
    out.push(rec)
    idx += 1
  }
  return out
}

