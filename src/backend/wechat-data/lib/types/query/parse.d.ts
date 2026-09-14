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
import type { MessageRich as RichMedia } from '../types.ts';
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
 * Extract the text of the first occurrence of a tag.
 * Handles CDATA-wrapped content (<![CDATA[...]]>) which wechat appmsg uses
 * for title/des/thumburl — the plain text regex would stop at the first '<'.
 * @param xml - raw XML string.
 * @param tag - tag name to extract.
 * @returns the tag's inner text ('' when absent).
 */
export declare function xmlTagText(xml: string, tag: string): string;
/**
 * 取出 XML 里的**文本节点与 CDATA**（忽略标签与属性）。
 *
 * 与 `stripXmlTags` 的区别：后者在「标签未闭合 / 属性特别多 / 没有文本节点」时会
 * 留下属性串或整段原文，而属性串当正文显示是明确的错误（实测表情、系统消息都踩过）。
 * @param xml - 原始 XML。
 * @returns 拼接后的可读文本（可能为空串）。
 */
export declare function extractXmlTextNodes(xml: string): string;
/**
 * 消息的**呈现种类**（界面唯一 switch 依据）。
 *
 * 取值与 WeChatDataAnalysis 的 `renderType` 对齐（text/image/voice/video/
 * emoji/location/contactCard/file/link/quote/chatHistory/transfer/redPacket/
 * live/announcement/voip/system），并补齐本项目的卡片型（miniapp/channels/
 * music/product/card/note/sticker/solitaire/pat/unsupported/revoke/empty）。
 */
export type RenderKind = 'text' | 'image' | 'voice' | 'video' | 'emoji' | 'location' | 'contactCard' | 'file' | 'link' | 'quote' | 'miniapp' | 'channels' | 'live' | 'music' | 'product' | 'card' | 'note' | 'sticker' | 'announcement' | 'solitaire' | 'chatlog' | 'transfer' | 'redpacket' | 'voip' | 'pat' | 'system' | 'revoke' | 'empty' | 'unknown' | 'unsupported';
/** 每种 renderType 的中文短标签（消息类型芯片 / 复制 JSON / 导出用）。 */
export declare const RENDER_LABEL: Record<RenderKind, string>;
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
export declare function classifyRender(msgType: number, rich?: {
    type?: string;
    url?: string;
} | null, sysKind?: string): RenderKind;
/**
 * Parse the duration out of a type-50 call `<msg>` text.
 *
 * 微信把通话时长写在**文本**里（「通话时长 00:21」「通话中断 01:08」），
 * 而 XML 的 `<duration>` 字段实测 **135/135 恒为 0** —— 读它会得到 0 秒。
 * 这是本项目里最容易踩的一个「字段存在但没值」的坑。
 * @param text - the `<msg>` text of a voip bubble.
 * @returns seconds, or undefined when the text carries no duration.
 */
export declare function parseCallDuration(text: string): number | undefined;
/**
 * 通话结局 → 语义分类，界面据此选图标/配色。
 * @param status - the `<msg>` text of a voip bubble.
 * @param connected - whether the call was actually connected.
 * @returns one of connected / cancelled / rejected / no-answer / busy / interrupted / missed / unknown.
 */
export declare function classifyCallStatus(status: string, connected: boolean): string;
/** 通话/语音视频的原始类型（微信 `<room_type>`：0 语音，1 视频）。 */
export type VoipKind = 'audio' | 'video' | '';
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
export declare function parseVoipKind(roomType: string): VoipKind;
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
export declare function parseImageGroup(xml: string): {
    id: string;
    count: number;
    type: string;
} | null;
/**
 * 提取 `<appmsg>` 直系子节点的 `<type>`。
 *
 * **不能**对整段 XML 直接找第一个 `<type>`：`<refermsg>` / `<recorditem>` /
 * `<weappinfo>` 内部都有各自的 `<type>`，先命中它们会把引用消息判成链接、
 * 把小程序判成别的。本机实测因此错判过整批消息。
 * @param xml - the raw appmsg XML.
 * @returns the appmsg subtype (0 when absent).
 */
export declare function parseAppmsgType(xml: string): number;
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
export declare function parseSystemMessage(xml: string): {
    text: string;
    kind: string;
};
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
export declare function parseAtUsernames(source: string): string[];
/**
 * `<msgsource>` 里的签名/来源标记（反垃圾签名），仅用于诊断展示。
 * @param source - the decoded `source` column value.
 * @returns the signature text, or ''.
 */
export declare function parseMsgsourceSignature(source: string): string;
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
