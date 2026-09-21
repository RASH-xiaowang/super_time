/**
 * `parse.ts` 的 XML 原语（M21 拆分）：取标签文本/属性、去 CDATA、去实体转义、拼文本节点。
 *
 * 从 `parse.ts` 原样搬出（含 `cachedRe` 预编译缓存），**行为逐字节不变**；放在最底层，
 * 供 `parse-rich.ts` / `parse-call.ts` / `parse-system.ts` / `parse.ts` 共用，避免上层互相 import 成环。
 *
 * @module parse-xml
 */
/** Unwrap a CDATA-wrapped string, returning the raw content. */
export declare function stripCdata(value: string): string;
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
export declare const RE_CACHE_MAX = 128;
export declare const RE_CACHE: Map<string, RegExp>;
export declare function cachedRe(key: string, build: () => RegExp): RegExp;
/**
 * 取出同名标签的**全部**块（多图文的 `<item>` 用；`xmlTagText` 只取第一个）。
 * @param xml - the enclosing XML.
 * @param tag - tag name to collect.
 * @returns the inner slices in document order.
 */
export declare function xmlTagBlocks(xml: string, tag: string): string[];
/**
 * Strip all XML tags from a string, collapsing whitespace.
 * Tags are removed without inserting a separator (mirrors st_control's
 * strip_xml_tags) so system-message placeholders keep their original
 * spacing.
 * @param xml - raw XML string.
 * @returns the tag-stripped, whitespace-collapsed text.
 */
export declare function stripXmlTags(xml: string): string;
/**
 * Decode the XML entities WeChat puts into text fields (`&#x0A;`, `&amp;`, …).
 *
 * 接龙名单里的 `<c>` 是用户手输内容，会带实体（换行/引号/&）。展示文本里残留
 * 实体字面量是 `check:display` 明令禁止的（第 45 轮立的不变量）。
 * @param s - raw text.
 * @returns decoded text.
 */
export declare function unescapeXmlEntities(s: string): string;
/**
 * Extract the text of the first occurrence of a tag.
 * Handles CDATA-wrapped content (<![CDATA[...]]>) which wechat appmsg uses
 * for title/des/thumburl — the plain text regex would stop at the first '<'.
 * @param xml - raw XML string.
 * @param tag - tag name to extract.
 * @returns the tag's inner text ('' when absent).
 */
export declare function xmlTagText(xml: string, tag: string): string;
/** Extract the value of an attribute from the first matching tag. */
export declare function xmlAttr(xml: string, tag: string, attr: string): string;
/**
 * Tag text, else the same-named attribute anywhere in the XML.
 *
 * 微信各版本把同一个字段一会儿写成 `<poiname>xx</poiname>`、一会儿写成
 * `<location poiname="xx">`；只看一种形态会让另一种整条丢失（位置卡实测）。
 * @param xml - raw XML.
 * @param name - tag/attribute name.
 * @returns the first non-empty value.
 */
export declare function xmlTagOrAttr(xml: string, name: string): string;
/**
 * 取出 XML 里的**文本节点与 CDATA**（忽略标签与属性）。
 *
 * 与 `stripXmlTags` 的区别：后者在「标签未闭合 / 属性特别多 / 没有文本节点」时会
 * 留下属性串或整段原文，而属性串当正文显示是明确的错误（实测表情、系统消息都踩过）。
 * @param xml - 原始 XML。
 * @returns 拼接后的可读文本（可能为空串）。
 */
export declare function extractXmlTextNodes(xml: string): string;
