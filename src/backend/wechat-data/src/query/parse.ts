/**
 * WeChat message XML content parsing — rewritten from st_control
 * modules/messages/parse.rs + media/rich.rs, then cross-checked field by field
 * against WeChatDataAnalysis' `chat_helpers._parse_app_message` /
 * `_parse_system_message_content` / `_parse_location_message`.
 *
 * 本模块是**唯一的消息分类真源**：`classifyRender()` 把 (local_type, appmsg
 * 子类型, XML 载荷) 归一到一组稳定的 renderType 字符串，界面据此切换渲染器。
 * 在此之前界面是「先看 local_type、再看 rich.type、再看一张白名单」三段判断，
 * 任何一个新子类型漏进白名单就会掉进通用链接卡（实测接龙/笔记/卡片/表情
 * 都掉过），这类不一致是聊天界面最主要的不确定来源。
 *
 * 关键实测事实（本机 138,533 条消息普查 + 复核，勿按直觉改）：
 *  - `local_type` **高 32 位是 appmsg 子类型 / 属性标志**，不是类型本身。
 *    例如 `25769803825 = 0x6_00000031`（文件）、`8589934592049 = 0x7d0_00000031`
 *    （转账）、`8594229559345 = 0x7d1_00000031`（红包）、
 *    `244813135921 = 0x39_00000031`（引用）。低 32 位才是类型（49 = appmsg）。
 *    归一化必须用 `& 0xFFFFFFFF` 语义；用「大于 2^32 才取模」的写法对
 *    恰好等于 2^32 附近的值会判错。
 *  - `10000` 不是「撤回」：1,955 条里 revokemsg 仅 31 条，其余是
 *    sysmsgtemplate（入群/公告/红包）与纯文本系统消息。撤回是它的**子类型**。
 *  - `appmsg type=53` 是**群接龙**不是视频号；视频号是 4/51/63。
 *  - 通话 `<duration>` 恒为 0，时长只在 `<msg>` 文本里。
 *  - 语音时长在 `<voicemsg voicelength>`（毫秒），不在 VoiceInfo 的
 *    `length(voice_data)`（那是压缩后的字节数，界面曾把它当秒用）。
 */

import type { ChatlogRecord, MessageRich as RichMedia, MpArticle, SolitaireMember } from '../types.ts'

/** Unwrap a CDATA-wrapped string, returning the raw content. */
function stripCdata(value: string): string {
  const t = value.trim()
  const m = t.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/)
  return m ? (m[1] ?? '') : value
}

/**
 * 取出同名标签的**全部**块（多图文的 `<item>` 用；`xmlTagText` 只取第一个）。
 * @param xml - the enclosing XML.
 * @param tag - tag name to collect.
 * @returns the inner slices in document order.
 */
function xmlTagBlocks(xml: string, tag: string): string[] {
  const re = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>', 'gi')
  return [...xml.matchAll(re)].map((m) => m[1] ?? '')
}

/**
 * Strip all XML tags from a string, collapsing whitespace.
 * Tags are removed without inserting a separator (mirrors st_control's
 * strip_xml_tags) so system-message placeholders keep their original
 * spacing.
 * @param xml - raw XML string.
 * @returns the tag-stripped, whitespace-collapsed text.
 */
export function stripXmlTags(xml: string): string {
  if (!xml) return ''
  return xml
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Decode the XML entities WeChat puts into text fields (`&#x0A;`, `&amp;`, …).
 *
 * 接龙名单里的 `<c>` 是用户手输内容，会带实体（换行/引号/&）。展示文本里残留
 * 实体字面量是 `check:display` 明令禁止的（第 45 轮立的不变量）。
 * @param s - raw text.
 * @returns decoded text.
 */
function unescapeXmlEntities(s: string): string {
  if (!s || s.indexOf('&') < 0) return s
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

/**
 * Extract the text of the first occurrence of a tag.
 * Handles CDATA-wrapped content (<![CDATA[...]]>) which wechat appmsg uses
 * for title/des/thumburl — the plain text regex would stop at the first '<'.
 * @param xml - raw XML string.
 * @param tag - tag name to extract.
 * @returns the tag's inner text ('' when absent).
 */
export function xmlTagText(xml: string, tag: string): string {
  const open = '<' + tag
  const si = xml.indexOf(open)
  if (si < 0) return ''
  const gt = xml.indexOf('>', si)
  if (gt < 0) return ''
  const close = '</' + tag
  const ei = xml.indexOf(close, gt)
  if (ei < 0) return ''
  return stripCdata(xml.slice(gt + 1, ei))
}

/** Extract the value of an attribute from the first matching tag. */
function xmlAttr(xml: string, tag: string, attr: string): string {
  // `\s*=\s*`：微信各版本写法不一致，实测同一批表情消息里既有 `md5="…"` 也有
  // `len = "8636"`（等号两边带空格）。原先要求等号紧跟属性名，于是这些消息的
  // 属性全部取不到 —— 表情的 cdnurl 就是这样丢的（8/15 条取不到 → 只能显示占位芯片）。
  const m = xml.match(new RegExp(`<\\s*${tag}[^>]*\\b${attr}\\s*=\\s*["']([^"']*)["']`))
  return m ? (m[1] ?? '') : ''
}

/**
 * Tag text, else the same-named attribute anywhere in the XML.
 *
 * 微信各版本把同一个字段一会儿写成 `<poiname>xx</poiname>`、一会儿写成
 * `<location poiname="xx">`；只看一种形态会让另一种整条丢失（位置卡实测）。
 * @param xml - raw XML.
 * @param name - tag/attribute name.
 * @returns the first non-empty value.
 */
function xmlTagOrAttr(xml: string, name: string): string {
  const t = xmlTagText(xml, name)
  if (t) return t
  const m = xml.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i'))
  return m ? (m[1] ?? '') : ''
}

/**
 * 取出 XML 里的**文本节点与 CDATA**（忽略标签与属性）。
 *
 * 与 `stripXmlTags` 的区别：后者在「标签未闭合 / 属性特别多 / 没有文本节点」时会
 * 留下属性串或整段原文，而属性串当正文显示是明确的错误（实测表情、系统消息都踩过）。
 * @param xml - 原始 XML。
 * @returns 拼接后的可读文本（可能为空串）。
 */
export function extractXmlTextNodes(xml: string): string {
  if (!xml) return ''
  const parts: string[] = []
  for (const m of xml.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>|>([^<]+)</g)) {
    const v = (m[1] ?? m[2] ?? '').trim()
    if (v) parts.push(v)
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

/**
 * 去掉 title/desc 里夹带的（**转义**）XML 载荷。
 *
 * 引用消息引用到图片/视频时，WeChat 会把被引用消息的 XML 原样塞进 title/desc，
 * 并且是转义过的（`&lt;?xml …&gt;`）。直接展示就是 `&lt;img aeskey="…"` 这种属性串
 * —— 实测全库还有 50 条（引用+合并转发）会这样。检测到就只留可读文本节点。
 * @param s - rich.title / rich.desc。
 * @returns 干净的文本（无内容时返回空串）。
 */
function cleanRichText(s?: string): string {
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
function richFallbackLabel(type: string): string {
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
const RICH_TO_RENDER: Record<string, RenderKind> = {
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
const TYPE_TO_RENDER: Record<number, RenderKind> = {
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
function parseSolitaire(app: string): { members: SolitaireMember[]; declared: number } {
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
function stripRefMsgText(text: string, name: string): string {
  if (!text) return ''
  let t = text.trim().replace(/^["“]/, '').replace(/["”]$/, '').trim()
  if (name && t.startsWith(name)) t = t.slice(name.length).replace(/^[：:]\s*/, '').trim()
  return t
}

/** 被引用的原消息是媒体时，给一个可读的占位（对应 local_type）。 */
function quoteTypePlaceholder(type: number): string {
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
const QUOTE_APP_LABEL: Record<number, string> = {
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
function stripQuotedGroupPrefix(raw: string): string {
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
function quotedAppType(xml: string): number {
  const text = stripQuotedGroupPrefix(xml)
  if (!text.includes('<appmsg')) return 0
  return Number((/<appmsg[\s\S]*?<type>(\d+)<\/type>/.exec(text) ?? [])[1] ?? 0) || 0
}

function summarizeQuotedXml(xml: string): string {
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
function quotedThumbUrl(raw: string): string {
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
 * 通话
 * ------------------------------------------------------------------ */

/**
 * Parse the duration out of a type-50 call `<msg>` text.
 *
 * 微信把通话时长写在**文本**里（「通话时长 00:21」「通话中断 01:08」），
 * 而 XML 的 `<duration>` 字段实测 **135/135 恒为 0** —— 读它会得到 0 秒。
 * 这是本项目里最容易踩的一个「字段存在但没值」的坑。
 * @param text - the `<msg>` text of a voip bubble.
 * @returns seconds, or undefined when the text carries no duration.
 */
export function parseCallDuration(text: string): number | undefined {
  const m = /(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(text)
  if (!m) return undefined
  const a = Number(m[1] ?? 0)
  const b = Number(m[2] ?? 0)
  return m[3] === undefined ? a * 60 + b : a * 3600 + b * 60 + Number(m[3])
}

/**
 * `<msg>` 文本表示「在其它设备上接通」的通话（没有本机时长，但确实接通了）。
 * 实测本机 135 条里只有这两字串的一种形态；`忙线未接听` 不含此模式。
 */
const CALL_ANSWERED_ELSEWHERE = /已在其它设备接听/

/**
 * 通话结局 → 语义分类，界面据此选图标/配色。
 * @param status - the `<msg>` text of a voip bubble.
 * @param connected - whether the call was actually connected.
 * @returns one of connected / cancelled / rejected / no-answer / busy / interrupted / missed / unknown.
 */
export function classifyCallStatus(status: string, connected: boolean): string {
  const s = status || ''
  if (connected) return 'connected'
  if (s.includes('已取消') || s.includes('对方已取消')) return 'cancelled'
  if (s.includes('已拒绝')) return 'rejected'
  if (s.includes('未应答')) return 'no-answer'
  if (s.includes('忙线')) return 'busy'
  if (s.includes('中断')) return 'interrupted'
  if (s.includes('未接听') || s.includes('未接通')) return 'missed'
  return 'unknown'
}

/** 通话/语音视频的原始类型（微信 `<room_type>`：0 语音，1 视频）。 */
export type VoipKind = 'audio' | 'video' | ''

/**
 * 解析 `<room_type>`：**0 = 语音，1 = 视频**。
 *
 * 这里与上游 WeChatDataAnalysis 的结论（0=video、1=audio）相反，判据是本机数据的时长分布：
 *
 * | room_type | 条数 | 最长通话 | ≥30 分钟 | ≥10 分钟 |
 * | --- | --- | --- | --- | --- |
 * | 0 | 61 | **1 小时 40 分 10 秒** | 1 | 2 |
 * | 1 | 103 | 12 分 40 秒 | 0 | 1 |
 *
 * 100 分钟的视频通话不现实、语音通话很常见；且 25 个有通话的会话里 **12 个两种值都出现**，
 * 说明它是「每次通话」的属性（不是每会话固定），符合媒体类型标志的语义。
 * 另有用户核对：`<msg>=已在其它设备接听` 的那条（room_type=0）在微信里是语音通话。
 *
 * 本文件早前版本已在注释里指出「本机数据判不了」，`query/calls.ts` 也据此**刻意不给通话记录打标签**。
 * 现在有了时长分布这组证据，消息气泡才敢按它画图标与「语音通话 / 视频通话」文案。
 * 若将来拿到官方定义，以本表为准复核这里。
 *
 * @param roomType - raw `<room_type>` value as text.
 * @returns audio / video / '' when unknown.
 */
export function parseVoipKind(roomType: string): VoipKind {
  const v = (roomType ?? '').trim()
  if (v === '0') return 'audio'
  if (v === '1') return 'video'
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
const IMAGE_GROUP_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$/i

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
function classifyLinkShare(url: string, sourceUsername: string, desc: string, appType: number): [string, string] {
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
function parseFileAttach(app: string): { size: string; ext: string; md5: string } {
  const size = xmlTagText(app, 'totallen') || xmlTagOrAttr(app, 'filesize')
  const ext = xmlTagText(app, 'fileext')
  const md5 = xmlTagOrAttr(app, 'md5') || xmlTagOrAttr(app, 'filemd5') || xmlTagOrAttr(app, 'file_md5')
  return { size: size || '', ext: ext || '', md5: md5 || '' }
}

/** 视频号解析（`<type>4</type>` / `51` / `63` 共用，字段各版本命名不一致）。 */
function channelsRich(
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
function applyMpNews(link: RichMedia, app: string, firstTitle: string, firstUrl: string, fallbackCover: string): void {
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
function parseAppmsg(xml: string): RichMedia | null {
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
function parseChatlogRecords(recordXml: string, depth = 0): ChatlogRecord[] {
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

/* ------------------------------------------------------------------ *
 * 系统消息
 * ------------------------------------------------------------------ */

/**
 * 群置顶/取消置顶系统消息（`<sysmsg type="chatroomtopmsg">`）。
 * @param xml - the raw sysmsg XML.
 * @returns the human sentence, or ''.
 */
function parseChatroomTop(xml: string): string {
  const block = xml.match(/<chatroomtopmsg\b[^>]*>[\s\S]*?<\/chatroomtopmsg>/i)
  if (!block) return ''
  const inner = block[0]
  const op = xmlTagText(inner, 'operation').trim() || xmlAttr(inner, 'operation', 'operation')
  const action = op === '1' ? '置顶了一条消息' : op === '2' ? '移除了一条置顶消息' : ''
  if (!action) return ''
  const nick = xmlTagText(inner, 'displayname') || xmlTagText(inner, 'operatorname') || ''
  const user = xmlTagText(inner, 'username') || ''
  return `${nick || user || '有人'}${action}`
}

/**
 * 系统消息里只承载机器语义的节点 —— 展示时必须整块丢掉。
 *
 * 实测撤回两种形态：
 *  - `<revokemsg><content>"Wave" 撤回了一条消息</content><revoketime>0</revoketime></revokemsg>`
 *  - `<revokemsg><replacemsg><![CDATA[…]]></replacemsg><session>…@chatroom</session><newmsgid>…</newmsgid></revokemsg>`
 * 第二种若只做「取文本节点」会得到
 * `50345516636@chatroom 123456789 987654321 "某人" 撤回了一条消息`
 * —— 一串 id 混在正文里（旧实现就是这个症状）。
 */
const SYS_NOISE_TAGS = [
  'revoketime', 'revoketime', 'newmsgid', 'oldmsgid', 'clientmsgid', 'msgid',
  'session', 'svrid', 'seq', 'createtime', 'timestamp', 'revoker', 'replacemsg',
]

/** 剥掉系统消息里的 id/时间噪声节点，只留可读文本。 */
function stripSystemNoise(xml: string): string {
  let out = xml || ''
  for (const tag of SYS_NOISE_TAGS) {
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, 'gi'), ' ')
  }
  return extractXmlTextNodes(out) || stripXmlTags(out)
}

/**
 * 系统消息（local_type 10000）解析。
 *
 * 旧实现对整段 XML 做「取文本节点」，对撤回消息会把 `<session>`/`<msgid>`/
 * `<newmsgid>` 这些 id 一起显示出来（实测
 * `50345516636@chatroom 123456789 987654321 "某人" 撤回了一条消息`）。
 * 这里按子类型分开处理：撤回只取 `replacemsg`/`content`，置顶自己成句，
 * 其余才退回文本节点。
 * @param xml - the decoded `<sysmsg …>` body.
 * @returns the readable text plus the sub-kind (revoke / top / template / plain).
 */
export function parseSystemMessage(xml: string): { text: string; kind: string } {
  const body = (xml ?? '').trim()
  if (!body) return { text: '', kind: 'plain' }
  const lower = body.toLowerCase()
  const declaredType = (body.match(/<sysmsg\b[^>]*\btype\s*=\s*["']([^"']*)["']/i) ?? [])[1] ?? ''

  // 撤回：标记可能缺失（不同客户端形态不一），所以再用文案兜底，
  // 否则「撤回了一条消息」会被当成普通系统消息、拿不到专用配色。
  const isRevoke = declaredType === 'revokemsg' || lower.includes('revokemsg')
    || /撤回了一条消息|撤回了一条|撤回了一條訊息/.test(body)
  if (isRevoke) {
    const revokeBlock = xmlTagText(body, 'revokemsg')
    const candidates = [
      xmlTagText(body, 'replacemsg'),
      revokeBlock ? xmlTagText(revokeBlock, 'content') : '',
      xmlTagText(body, 'content'),
    ]
    for (const candidate of candidates) {
      const t = stripXmlTags(stripCdata(candidate))
      // `<content>123456</content>` 这类纯数字是 id 不是文案，跳过。
      if (t && !/^\d+$/.test(t)) return { text: t, kind: 'revoke' }
    }
    const cleaned = unescapeXmlEntities(stripSystemNoise(revokeBlock || body))
    return { text: cleaned || '撤回了一条消息', kind: 'revoke' }
  }
  if (declaredType === 'chatroomtopmsg' || lower.includes('chatroomtopmsg')) {
    const top = parseChatroomTop(body)
    if (top) return { text: top, kind: 'top' }
  }
  const template = xmlTagText(body, 'plain') || xmlTagText(body, 'text') || extractXmlTextNodes(body)
  return { text: unescapeXmlEntities(stripXmlTags(stripCdata(template))), kind: declaredType || 'plain' }
}

/* ------------------------------------------------------------------ *
 * @提及（群消息）
 * ------------------------------------------------------------------ */

/**
 * 从 `source` 列（`<msgsource><atuserlist>…`）里取被 @ 的 wxid。
 *
 * WeChat 4.x **不在** message_content 里存结构化 @ 列表，而是在 `source` 列的
 * `<msgsource>` XML 里：`<atuserlist><![CDATA[wxid_a,wxid_b]]></atuserlist>`，
 * 全选时是 `notify@all`。没有它，界面只能靠正则猜 `@昵称`，@ 与昵称不对齐时
 * 就会把普通文本里的 `@` 高亮成提及。
 * @param source - the decoded `source` column value.
 * @returns deduped at-usernames (may be empty).
 */
export function parseAtUsernames(source: string): string[] {
  if (!source || source.indexOf('atuserlist') < 0) return []
  const raw = stripCdata(xmlTagText(source, 'atuserlist'))
  if (!raw) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of raw.split(/[,;，；\s]+/)) {
    const v = part.trim()
    if (!v || seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out
}

/**
 * `<msgsource>` 里的签名/来源标记（反垃圾签名），仅用于诊断展示。
 * @param source - the decoded `source` column value.
 * @returns the signature text, or ''.
 */
export function parseMsgsourceSignature(source: string): string {
  if (!source || source.indexOf('<msgsource') < 0) return ''
  return unescapeXmlEntities(xmlTagText(source, 'signature')).trim()
}

/* ------------------------------------------------------------------ *
 * 主入口
 * ------------------------------------------------------------------ */

/**
 * 有的客户端会把「表情 / 视频 / 语音 / 位置 / 名片」的 XML 塞进 **type=1 的文本消息**里。
 * 这时按 XML 里实际出现的载荷给出 rich 描述，界面才能渲染成卡片/图片，
 * 而不是把标签里的属性串当成正文。
 * @param body - 已去掉群前缀的消息正文。
 * @returns rich 结果；没有可识别载荷时返回 null。
 */
function parseEmbeddedPayload(body: string): { text: string; rich?: RichMedia } | null {
  if (/<emoji\b/.test(body)) {
    return { text: '', rich: { type: 'emoji', title: xmlAttr(body, 'emoji', 'md5') || xmlTagText(body, 'emoji'), md5: xmlAttr(body, 'emoji', 'md5') } }
  }
  if (/<videomsg\b/.test(body)) {
    const dur = Number(xmlAttr(body, 'videomsg', 'playlength')) || 0
    const rich: RichMedia = { type: 'video' }
    if (dur > 0) rich.durationSec = dur
    const md5 = xmlAttr(body, 'videomsg', 'md5')
    if (md5) rich.md5 = md5
    return { text: '', rich }
  }
  if (/<voicemsg\b/.test(body)) {
    const ms = Number(xmlAttr(body, 'voicemsg', 'voicelength')) || 0
    const rich: RichMedia = { type: 'voice', title: xmlTagText(body, 'voicemsg'), md5: xmlAttr(body, 'voicemsg', 'md5') }
    if (ms > 0) rich.durationMs = ms
    return { text: '', rich }
  }
  if (/<location\b/.test(body)) {
    const loc = parseLocation(body)
    return { text: '', rich: loc }
  }
  if (/<contact\b/.test(body)) {
    return { text: '', rich: { type: 'contact', nickname: xmlAttr(body, 'contact', 'nickname'), username: xmlAttr(body, 'contact', 'username') } }
  }
  // <img> 也出现在 appmsg 卡片内部，那种情况交给 appmsg 解析
  if (/<img\b/.test(body) && !/<appmsg\b/.test(body)) {
    const rich: RichMedia = { type: 'image' }
    const group = parseImageGroup(body)
    if (group) { rich.groupId = group.id; rich.groupCount = group.count }
    const md5 = xmlAttr(body, 'img', 'md5')
    if (md5) rich.md5 = md5
    return { text: '', rich }
  }
  return null
}

/**
 * 位置消息（local_type 48）→ 富描述。
 *
 * `<location x y scale label poiname poiid poiCategoryTips poiPhone infourl>`：
 * `x` 是**纬度**、`y` 是**经度**（微信沿用 mapkit 的命名）。旧实现只取 label，
 * 界面因此无法画地图缩略图。
 * @param body - the raw location XML.
 * @returns the location rich descriptor.
 */
function parseLocation(body: string): RichMedia {
  const poiname = unescapeXmlEntities(stripCdata(xmlTagOrAttr(body, 'poiname') || xmlTagOrAttr(body, 'poiName') || xmlTagOrAttr(body, 'name')))
  const label = unescapeXmlEntities(stripCdata(xmlTagOrAttr(body, 'label') || xmlTagOrAttr(body, 'labelname') || xmlTagOrAttr(body, 'address')))
  const num = (v: string): number | undefined => {
    const n = Number(v)
    return Number.isFinite(n) && n !== 0 ? n : undefined
  }
  const latRaw = num(xmlTagOrAttr(body, 'x') || xmlTagOrAttr(body, 'latitude') || xmlTagOrAttr(body, 'lat'))
  const lngRaw = num(xmlTagOrAttr(body, 'y') || xmlTagOrAttr(body, 'longitude') || xmlTagOrAttr(body, 'lng') || xmlTagOrAttr(body, 'lon'))
  const lat = latRaw !== undefined && latRaw >= -90 && latRaw <= 90 ? latRaw : undefined
  const lng = lngRaw !== undefined && lngRaw >= -180 && lngRaw <= 180 ? lngRaw : undefined
  const rich: RichMedia = { type: 'location', title: poiname || label || '位置' }
  if (label && label !== (poiname || '')) rich.desc = label
  if (lat !== undefined) rich.lat = lat
  if (lng !== undefined) rich.lng = lng
  const poiId = xmlTagOrAttr(body, 'poiid')
  if (poiId) rich.poiId = poiId
  const infoUrl = xmlTagOrAttr(body, 'infourl')
  if (infoUrl) rich.url = unescapeXmlEntities(infoUrl)
  return rich
}

/**
 * Parse a raw message body into display text + optional rich descriptor.
 * @param msgType - normalized local_type.
 * @param content - decoded message content.
 * @param isGroup - whether the message came from a group chat.
 * @returns display text, an optional rich media descriptor, and (for system
 *   messages) the sub-kind used to pick the bubble style.
 */
export function parseMessageContent(
  msgType: number,
  content: string,
  isGroup?: boolean,
): { text: string; rich?: RichMedia; sysKind?: string } {

  let body = content
  if (isGroup) {
    const pos = body.indexOf(':\n')
    if (pos > 0) {
      const head = body.slice(0, pos)
      const tail = body.slice(pos + 2)
      if (head.length <= 64 && !head.includes('<') && !head.includes(' ') && !tail.trimStart().startsWith('<?xml')) {
        body = tail
      }
    }
  }

  switch (msgType) {
    case 1: {
      const text = body.replace(/^\n+/, '')
      if (text.includes('<mmreader>')) {
        const rich: RichMedia = { type: 'newsfeed', title: xmlTagText(text, 'title'), desc: xmlTagText(text, 'digest'), url: xmlTagText(text, 'url') }
        return { text: '', rich }
      }
      if (text.startsWith('<')) {
        // 先看 XML 里到底是什么载荷（表情/视频/语音…），能给 rich 就给 rich
        const embedded = parseEmbeddedPayload(text)
        if (embedded) return embedded
        // 剥掉标签后**没有文本节点**时不能再返回原始 XML ——
        // 界面会把它当正文渲染，实测 207 条表情消息就是这样变成一串
        // `fromusername = "wxid_..." md5 = "626ac..."` 的。
        const stripped = extractXmlTextNodes(text)
        return { text: stripped || stripXmlTags(text) }
      }
      return { text }
    }
    case 3: {
      const rich: RichMedia = { type: 'image' }
      const group = parseImageGroup(body)
      if (group) { rich.groupId = group.id; rich.groupCount = group.count }
      const md5 = xmlAttr(body, 'img', 'md5')
      if (md5) rich.md5 = md5
      return { text: '', rich }
    }
    case 34: {
      const md5 = xmlAttr(body, 'voicemsg', 'md5') || xmlTagText(body, 'md5')
      // 语音时长在 voicelength（**毫秒**）；旧实现拿 VoiceInfo 的压缩字节数
      // 除以 2000 当秒用，短语音普遍显示成 0″、长语音偏差一倍以上。
      const ms = Number(xmlAttr(body, 'voicemsg', 'voicelength')) || Number(xmlAttr(body, 'voicemsg', 'length')) || 0
      const rich: RichMedia = { type: 'voice', title: xmlTagText(body, 'voicemsg'), md5 }
      if (ms > 0) rich.durationMs = ms
      return { text: '', rich }
    }
    case 42:
      return { text: '', rich: { type: 'contact', nickname: xmlAttr(body, 'contact', 'nickname') || xmlAttr(body, 'msg', 'nickname'), username: xmlAttr(body, 'contact', 'username') || xmlAttr(body, 'msg', 'username'), alias: xmlAttr(body, 'msg', 'alias') } }
    case 66:
      return {
        text: '',
        rich: {
          type: 'contact',
          nickname: xmlAttr(body, 'msg', 'nickname') || xmlAttr(body, 'contact', 'nickname'),
          username: xmlAttr(body, 'msg', 'username') || xmlAttr(body, 'contact', 'username'),
          desc: xmlAttr(body, 'msg', 'openimdesc') || '',
        },
      }
    case 43: {
      const rich: RichMedia = { type: 'video' }
      const dur = Number(xmlAttr(body, 'videomsg', 'playlength')) || 0
      if (dur > 0) rich.durationSec = dur
      const md5 = xmlAttr(body, 'videomsg', 'md5')
      if (md5) rich.md5 = md5
      return { text: '', rich }
    }
    case 47: {
      // 自定义表情（表情包/内置表情）。md5 决定是哪张图，cdnurl 决定去哪取。
      //
      // 本机 1880 条 type-47 普查（output/probe-sticker-coverage.mjs）：
      //   md5 100%、cdnurl **99.3%**(1867)、encrypturl 98.8%、aeskey 99.2%、thumburl 24%。
      // 微信自己的表情缓存（`business/emoticon/Persist|Thumb/<xx>/<md5>`、
      // `cache/<月>/Emoticon/<xx>/<md5>`）是**加密**文件（整文件 16 字节对齐、
      // 单字节 XOR / 配置里的 image_aes_key / 消息里的 aeskey 都解不开，见
      // output/probe-sticker-crypt*.mjs），所以取图主要靠 cdnurl：
      // 它是**未加密**的那一份（去掉 XML 的 `&amp;` 转义后实测 200 + 明文 GIF/PNG/JPEG，
      // 且体积与消息里的 len 完全一致）。下载与缓存见 fetchEmoticonRemote。
      const md5 = xmlAttr(body, 'emoji', 'md5')
      const rich: RichMedia = { type: 'emoji', title: md5 || xmlTagText(body, 'emoji'), md5 }
      const emojiUrl = unescapeXmlEntities(xmlAttr(body, 'emoji', 'cdnurl') || xmlAttr(body, 'emoji', 'thumburl'))
      if (emojiUrl) rich.emojiUrl = emojiUrl
      return { text: '', rich }
    }
    case 48:
      return { text: '', rich: parseLocation(body) }
    case 49: {
      const rich = parseAppmsg(body)
      if (rich) {
        const text = rich.type === 'file' ? `[文件] ${cleanRichText(rich.title)}`
          : rich.type === 'link' ? `[链接] ${cleanRichText(rich.title)}`
            : rich.type === 'quote' ? cleanRichText(rich.title)
              : rich.type === 'miniapp' ? `[小程序] ${cleanRichText(rich.title)}`
                : rich.type === 'channels' ? `[视频号] ${cleanRichText(rich.title)}`
                  : rich.type === 'live' ? `[直播] ${cleanRichText(rich.title)}`
                    : rich.type === 'music' ? `[音乐] ${cleanRichText(rich.title)}`
                      : rich.type === 'chatlog' ? `[聊天记录] ${cleanRichText(rich.title)}`
                        : rich.type === 'transfer' ? '[转账]'
                          : rich.type === 'redpacket' ? '[红包]'
                            : rich.type === 'solitaire' ? `[接龙] ${cleanRichText(rich.title)}`
                              : rich.type === 'note' ? `[笔记] ${cleanRichText(rich.title)}`
                                : rich.type === 'card' ? `[卡片] ${cleanRichText(rich.title)}`
                                  : rich.type === 'sticker' ? '[表情]'
                                    : rich.type === 'product' ? `[商品] ${cleanRichText(rich.title)}`
                                      : rich.type === 'pat' ? cleanRichText(rich.title)
                                        : rich.type === 'announcement' ? (cleanRichText(rich.title) || '[群公告]')
                                          : rich.type === 'contact' ? `[名片] ${cleanRichText(rich.nickname || rich.title)}`
                                            : rich.type === 'unsupported' ? (cleanRichText(rich.title) || currentVersionHint())
                                              // 兜底：任何未逐一列举的 rich.type 都退回 title/desc。
                                              // 这里以前返回 ''，导致未覆盖的子类型渲染成**空气泡**
                                              // （实测有 53 接龙/24 笔记/36 卡片/8 表情/4 视频号/
                                              //  2 商品/62 拍一拍/87 群公告/50·63 不支持 等）。
                                              : (cleanRichText(rich.title) || cleanRichText(rich.desc) || richFallbackLabel(rich.type))
        return { text, rich }
      }
      const title = cleanRichText(xmlTagText(body, 'title'))
      return title ? { text: `[链接] ${title}` } : { text: '' }
    }
    case 50: {
      // type-50 语音/视频通话气泡。正文是 zstd 压缩的
      // `<voipmsg type="VoIPBubbleMsg">` XML（上游 decodeBlobText 已按 0x28B52FFD
      // 魔数解压），实测本机 135 条 type-50 全部可解压。字段实测：
      //   <msg>       人类可读结局：通话时长 00:21 / 对方已取消 / 已拒绝 / 未应答 /
      //               已在其它设备接听 / 通话中断 01:08 …（唯一有信息量的字段）
      //   <room_type> 0（×61）/ 1（×103），**0=语音、1=视频** —— 判据见 parseVoipKind 的注释
      //               （时长分布：100 分钟那条是 0；上游写的 0=视频与数据不符）。
      //   <duration>  **恒为 0**（164/164），时长只能从 <msg> 文本里解析。
      //   <msg_type>  100 / 101（101 只出现在 inviteid=0 的「已在其它设备接听」上）。
      const scope = /<VoIPBubbleMsg[\s\S]*?<\/VoIPBubbleMsg>/i.exec(body)?.[0] ?? body
      const status = xmlTagText(scope, 'msg').trim()
      const durationSec = parseCallDuration(status)
      const roomType = xmlTagText(scope, 'room_type').trim()
      const voipKind = parseVoipKind(roomType)
      // 「接通」的语义：本机接通（<msg> 里有秒数）或**在其它设备接通**。
      // 后者没有秒数，但把它算成「未接通」会让 2 条记录显示成虚线未接样式。
      // 注意不能用 /接听/ 判断：「忙线未接听」也含这两个字。
      const connected = durationSec !== undefined || CALL_ANSWERED_ELSEWHERE.test(status)
      const rich: RichMedia = {
        type: 'call',
        title: status || '通话',
        status,
        connected,
        callStatus: classifyCallStatus(status, connected),
      }
      if (voipKind) rich.voipType = voipKind
      if (roomType) rich.roomType = Number(roomType) || 0
      if (durationSec !== undefined) rich.durationSec = durationSec
      return { text: status ? `[通话] ${status}` : '[通话]', rich }
    }
    case 62: {
      // 群接龙 / 拍一拍在部分客户端里以裸 local_type 出现（高 32 位被丢掉时）。
      const rich = parseAppmsg(body)
      if (rich) {
        const text = rich.type === 'solitaire' ? `[接龙] ${cleanRichText(rich.title)}` : cleanRichText(rich.title)
        return { text, rich }
      }
      return { text: extractXmlTextNodes(body) }
    }
    case 10000: {
      const sys = parseSystemMessage(body)
      return { text: sys.text, sysKind: sys.kind }
    }
    case 10002: {
      const sys = parseSystemMessage(body)
      return { text: sys.text || '撤回了一条消息', sysKind: 'revoke' }
    }
    case 11000:
      return { text: '' }
    default: {
      const rich = /<appmsg\b/.test(body) ? parseAppmsg(body) : null
      if (rich) {
        const text = cleanRichText(rich.title) || cleanRichText(rich.desc) || richFallbackLabel(rich.type)
        return { text, rich }
      }
      if (body && !body.includes('<') && body.length <= 500) return { text: body }
      return { text: '' }
    }
  }
}

/** 「当前微信版本不支持」的标准文案（避免各处硬编码不一致）。 */
function currentVersionHint(): string {
  return '当前微信版本不支持展示该内容，请升级至最新版本。'
}

/**
 * 富描述 → 一句可读占位（消息本身没有文字时，列表/气泡都显示它）。
 *
 * 覆盖全部 renderType：任何一个漏掉都会让气泡变成空气泡，
 * 这是聊天界面里最刺眼的不一致。
 * @param rich - the parsed rich descriptor.
 * @returns the placeholder text ('' when the type has no textual form).
 */
export function richPlaceholder(rich: { type: string; title?: string; nickname?: string; desc?: string; amount?: string }): string {
  switch (rich.type) {
    case 'image': return '[图片]'
    case 'emoji': return '[表情]'
    case 'sticker': return '[表情]'
    case 'voice': return '[语音]'
    case 'video': return '[视频]'
    case 'location': return rich.title ? `[位置] ${rich.title}` : '[位置]'
    case 'contact': return rich.nickname ? `[名片] ${rich.nickname}` : '[名片]'
    case 'newsfeed': return rich.title ? `[图文] ${rich.title}` : '[图文]'
    case 'file': return rich.title ? `[文件] ${rich.title}` : '[文件]'
    case 'link': return rich.title ? `[链接] ${rich.title}` : '[链接]'
    case 'music': return rich.title ? `[音乐] ${rich.title}` : '[音乐]'
    case 'miniapp': return rich.title ? `[小程序] ${rich.title}` : '[小程序]'
    case 'channels': return rich.title ? `[视频号] ${rich.title}` : '[视频号]'
    case 'live': return rich.title ? `[直播] ${rich.title}` : '[直播]'
    case 'product': return rich.title ? `[商品] ${rich.title}` : '[商品]'
    case 'card': return rich.title ? `[卡片] ${rich.title}` : '[卡片]'
    case 'note': return rich.title ? `[笔记] ${rich.title}` : '[笔记]'
    case 'announcement': return rich.title ? `[群公告] ${rich.title}` : '[群公告]'
    case 'solitaire': return rich.title ? `[接龙] ${rich.title}` : '[接龙]'
    case 'chatlog': return rich.title ? `[聊天记录] ${rich.title}` : '[聊天记录]'
    case 'transfer': return '[转账]'
    case 'redpacket': return '[红包]'
    case 'call': return rich.title ? `[通话] ${rich.title}` : '[通话]'
    case 'pat': return rich.title || '[拍一拍]'
    case 'quote': return rich.title || '[引用消息]'
    case 'unsupported': return rich.title || '[该消息类型暂不支持预览]'
    case 'appmsg': return rich.title || rich.desc || ''
    default: return rich.title || ''
  }
}
