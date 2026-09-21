/**
 * `parse.ts` 的 XML 原语（M21 拆分）：取标签文本/属性、去 CDATA、去实体转义、拼文本节点。
 *
 * 从 `parse.ts` 原样搬出（含 `cachedRe` 预编译缓存），**行为逐字节不变**；放在最底层，
 * 供 `parse-rich.ts` / `parse-call.ts` / `parse-system.ts` / `parse.ts` 共用，避免上层互相 import 成环。
 *
 * @module parse-xml
 */

/** Unwrap a CDATA-wrapped string, returning the raw content. */
export function stripCdata(value: string): string {
  const t = value.trim()
  const m = t.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/)
  return m ? (m[1] ?? '') : value
}

/**
 * 动态正则的编译缓存（L11）。
 *
 * 为什么需要：`xmlTagBlocks` / `xmlAttr` / `xmlTagOrAttr` / `stripSystemNoise` 原先在
 * **每条消息**（甚至每个属性）上 `new RegExp(...)` —— 同一个 (标签, 属性) 组合每次都要
 * 重新构造并编译一遍，而模式里除标签名外没有任何变化。这里按「构造式」缓存编译结果。
 *
 * 键全部来自调用点的字面量，所以缓存规模由**代码**决定、不随数据增长；仍设上限兜底，
 * 避免将来有人把数据当标签名传进来时变成无界 Map。
 */
export const RE_CACHE_MAX = 128
export const RE_CACHE = new Map<string, RegExp>()
export function cachedRe(key: string, build: () => RegExp): RegExp {
  const hit = RE_CACHE.get(key)
  if (hit) return hit
  const re = build()
  if (RE_CACHE.size >= RE_CACHE_MAX) RE_CACHE.clear()
  RE_CACHE.set(key, re)
  return re
}

/**
 * 取出同名标签的**全部**块（多图文的 `<item>` 用；`xmlTagText` 只取第一个）。
 * @param xml - the enclosing XML.
 * @param tag - tag name to collect.
 * @returns the inner slices in document order.
 */
export function xmlTagBlocks(xml: string, tag: string): string[] {
  const re = cachedRe('blocks:' + tag, () => new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>', 'gi'))
  // 缓存的实例是共享且带 `g` 的：`matchAll` 会复制实例，但复制出的那份沿用原实例的
  // lastIndex，所以取用前归零，避免别处（将来）先用 exec 把它挪走。
  re.lastIndex = 0
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
export function unescapeXmlEntities(s: string): string {
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
export function xmlAttr(xml: string, tag: string, attr: string): string {
  // `\s*=\s*`：微信各版本写法不一致，实测同一批表情消息里既有 `md5="…"` 也有
  // `len = "8636"`（等号两边带空格）。原先要求等号紧跟属性名，于是这些消息的
  // 属性全部取不到 —— 表情的 cdnurl 就是这样丢的（8/15 条取不到 → 只能显示占位芯片）。
  const m = xml.match(cachedRe('attr:' + tag + '\u0000' + attr, () => new RegExp(`<\\s*${tag}[^>]*\\b${attr}\\s*=\\s*["']([^"']*)["']`)))
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
export function xmlTagOrAttr(xml: string, name: string): string {
  const t = xmlTagText(xml, name)
  if (t) return t
  const m = xml.match(cachedRe('attrAny:' + name, () => new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i')))
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

