/**
 * 系统消息与 @提及 的解析（M21 拆分）：噪声标签剥离、系统消息文本、@用户名、msgsource 签名。
 *
 * 从 `parse.ts` 原样搬出，**行为逐字节不变**（依赖 `parse-xml.ts`）。
 *
 * @module parse-system
 */

import { cachedRe, extractXmlTextNodes, stripCdata, stripXmlTags, unescapeXmlEntities, xmlAttr, xmlTagText } from './parse-xml.ts'

/* ------------------------------------------------------------------ *
 * 系统消息
 * ------------------------------------------------------------------ */

/**
 * 群置顶/取消置顶系统消息（`<sysmsg type="chatroomtopmsg">`）。
 * @param xml - the raw sysmsg XML.
 * @returns the human sentence, or ''.
 */
export function parseChatroomTop(xml: string): string {
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
export const SYS_NOISE_TAGS = [
  'revoketime', 'revoketime', 'newmsgid', 'oldmsgid', 'clientmsgid', 'msgid',
  'session', 'svrid', 'seq', 'createtime', 'timestamp', 'revoker', 'replacemsg',
]

/** 去重后的噪声标签（原列表里 `revoketime` 写了两遍，等于白跑一趟）。 */
export const SYS_NOISE_TAGS_UNIQUE = [...new Set(SYS_NOISE_TAGS)]

/** 剥掉系统消息里的 id/时间噪声节点，只留可读文本。 */
export function stripSystemNoise(xml: string): string {
  let out = xml || ''
  for (const tag of SYS_NOISE_TAGS_UNIQUE) {
    // 正则走 cachedRe 预编译：这条路径对每条系统消息都要过一遍全部标签，
    // 原先 14 次 `new RegExp` 都是同一个模式（见 cachedRe 的说明）。
    out = out.replace(cachedRe('noise:' + tag, () => new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, 'gi')), ' ')
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
