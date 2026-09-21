import type { MessageRich as RichMedia } from '../types.ts';
/**
 * 有的客户端会把「表情 / 视频 / 语音 / 位置 / 名片」的 XML 塞进 **type=1 的文本消息**里。
 * 这时按 XML 里实际出现的载荷给出 rich 描述，界面才能渲染成卡片/图片，
 * 而不是把标签里的属性串当成正文。
 * @param body - 已去掉群前缀的消息正文。
 * @returns rich 结果；没有可识别载荷时返回 null。
 */
export declare function parseEmbeddedPayload(body: string): {
    text: string;
    rich?: RichMedia;
} | null;
/**
 * 位置消息（local_type 48）→ 富描述。
 *
 * `<location x y scale label poiname poiid poiCategoryTips poiPhone infourl>`：
 * `x` 是**纬度**、`y` 是**经度**（微信沿用 mapkit 的命名）。旧实现只取 label，
 * 界面因此无法画地图缩略图。
 * @param body - the raw location XML.
 * @returns the location rich descriptor.
 */
export declare function parseLocation(body: string): RichMedia;
/**
 * Parse a raw message body into display text + optional rich descriptor.
 * @param msgType - normalized local_type.
 * @param content - decoded message content.
 * @param isGroup - whether the message came from a group chat.
 * @returns display text, an optional rich media descriptor, and (for system
 *   messages) the sub-kind used to pick the bubble style.
 */
export declare function parseMessageContent(msgType: number, content: string, isGroup?: boolean): {
    text: string;
    rich?: RichMedia;
    sysKind?: string;
};
/** 「当前微信版本不支持」的标准文案（避免各处硬编码不一致）。 */
export declare function currentVersionHint(): string;
/**
 * 富描述 → 一句可读占位（消息本身没有文字时，列表/气泡都显示它）。
 *
 * 覆盖全部 renderType：任何一个漏掉都会让气泡变成空气泡，
 * 这是聊天界面里最刺眼的不一致。
 * @param rich - the parsed rich descriptor.
 * @returns the placeholder text ('' when the type has no textual form).
 */
export declare function richPlaceholder(rich: {
    type: string;
    title?: string;
    nickname?: string;
    desc?: string;
    amount?: string;
}): string;
export { RE_CACHE, RE_CACHE_MAX, cachedRe, extractXmlTextNodes, stripCdata, stripXmlTags, unescapeXmlEntities, xmlAttr, xmlTagBlocks, xmlTagOrAttr, xmlTagText, } from './parse-xml.ts';
export { CALL_ANSWERED_ELSEWHERE, VoipKind, classifyCallStatus, parseCallDuration, parseVoipKind } from './parse-call.ts';
export { IMAGE_GROUP_ID, QUOTE_APP_LABEL, RENDER_LABEL, RICH_TO_RENDER, RenderKind, TYPE_TO_RENDER, applyMpNews, channelsRich, classifyLinkShare, classifyRender, cleanRichText, parseAppmsg, parseAppmsgType, parseChatlogRecords, parseFileAttach, parseImageGroup, parseSolitaire, quoteTypePlaceholder, quotedAppType, quotedThumbUrl, richFallbackLabel, stripQuotedGroupPrefix, stripRefMsgText, summarizeQuotedXml } from './parse-rich.ts';
export { SYS_NOISE_TAGS, SYS_NOISE_TAGS_UNIQUE, parseAtUsernames, parseChatroomTop, parseMsgsourceSignature, parseSystemMessage, stripSystemNoise } from './parse-system.ts';
