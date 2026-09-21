import { extractXmlTextNodes, stripCdata, stripXmlTags, unescapeXmlEntities, xmlAttr, xmlTagOrAttr, xmlTagText } from './parse-xml.ts'
import { CALL_ANSWERED_ELSEWHERE, classifyCallStatus, parseCallDuration, parseVoipKind } from './parse-call.ts'
import { cleanRichText, parseAppmsg, parseImageGroup, richFallbackLabel } from './parse-rich.ts'
import { parseSystemMessage } from './parse-system.ts'
import type { ChatlogRecord, MessageRich as RichMedia, MpArticle, SolitaireMember } from '../types.ts'
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
export function parseEmbeddedPayload(body: string): { text: string; rich?: RichMedia } | null {
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
export function parseLocation(body: string): RichMedia {
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
export function currentVersionHint(): string {
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


/* M21：拆出去的实现从这里再导出一次，外部 `import … from './parse.ts'` 不受影响。 */
export {
  RE_CACHE,
  RE_CACHE_MAX,
  cachedRe,
  extractXmlTextNodes,
  stripCdata,
  stripXmlTags,
  unescapeXmlEntities,
  xmlAttr,
  xmlTagBlocks,
  xmlTagOrAttr,
  xmlTagText,
} from './parse-xml.ts'
export { CALL_ANSWERED_ELSEWHERE, VoipKind, classifyCallStatus, parseCallDuration, parseVoipKind } from './parse-call.ts'
export { IMAGE_GROUP_ID, QUOTE_APP_LABEL, RENDER_LABEL, RICH_TO_RENDER, RenderKind, TYPE_TO_RENDER, applyMpNews, channelsRich, classifyLinkShare, classifyRender, cleanRichText, parseAppmsg, parseAppmsgType, parseChatlogRecords, parseFileAttach, parseImageGroup, parseSolitaire, quoteTypePlaceholder, quotedAppType, quotedThumbUrl, richFallbackLabel, stripQuotedGroupPrefix, stripRefMsgText, summarizeQuotedXml } from './parse-rich.ts'
export { SYS_NOISE_TAGS, SYS_NOISE_TAGS_UNIQUE, parseAtUsernames, parseChatroomTop, parseMsgsourceSignature, parseSystemMessage, stripSystemNoise } from './parse-system.ts'
