/**
 * rich / appmsg / 引用 / 图片组的解析（M21 拆分）。
 *
 * 从 `parse.ts` 原样搬出的一大块实现（渲染分类、群接龙、引用占位、图片组、appmsg 子类型、
 * 链接卡片与视频号富字段……），**行为逐字节不变**。依赖只往下走（xml/call/system ← 本文件）。
 *
 * @module parse-rich
 */
import type { ChatlogRecord, MessageRich as RichMedia, SolitaireMember } from '../types.ts';
/**
 * 去掉 title/desc 里夹带的（**转义**）XML 载荷。
 *
 * 引用消息引用到图片/视频时，WeChat 会把被引用消息的 XML 原样塞进 title/desc，
 * 并且是转义过的（`&lt;?xml …&gt;`）。直接展示就是 `&lt;img aeskey="…"` 这种属性串
 * —— 实测全库还有 50 条（引用+合并转发）会这样。检测到就只留可读文本节点。
 * @param s - rich.title / rich.desc。
 * @returns 干净的文本（无内容时返回空串）。
 */
export declare function cleanRichText(s?: string): string;
/** 兜底标签：rich.type 没被逐一列举时，至少给一个像样的名字而不是空气泡。 */
export declare function richFallbackLabel(type: string): string;
/**
 * 消息的**呈现种类**（界面唯一 switch 依据）。
 *
 * 取值与 WeChatDataAnalysis 的 `renderType` 对齐（text/image/voice/video/
 * emoji/location/contactCard/file/link/quote/chatHistory/transfer/redPacket/
 * live/announcement/voip/system），并补齐本项目的卡片型（miniapp/channels/
 * music/product/card/note/sticker/solitaire/pat/unsupported/revoke/empty）。
 */
export type RenderKind = 'text' | 'image' | 'voice' | 'video' | 'emoji' | 'location' | 'contactCard' | 'file' | 'link' | 'quote' | 'miniapp' | 'channels' | 'live' | 'music' | 'product' | 'card' | 'note' | 'sticker' | 'announcement' | 'solitaire' | 'chatlog' | 'transfer' | 'redpacket' | 'voip' | 'pat' | 'system' | 'revoke' | 'empty' | 'unknown' | 'unsupported';
/** rich.type → renderType（卡片型子类型一一对应）。 */
export declare const RICH_TO_RENDER: Record<string, RenderKind>;
/** 没有 rich 描述时的 local_type → renderType 兜底表。 */
export declare const TYPE_TO_RENDER: Record<number, RenderKind>;
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
export declare function parseSolitaire(app: string): {
    members: SolitaireMember[];
    declared: number;
};
/**
 * `<ref_msg_text>` 形如 `"莫伟基： [图片]"` —— 引用媒体消息时微信给出的现成文案。
 * 这里去掉外层引号与「昵称：」前缀，只留被引用对象的占位（`[图片]` 等）。
 * @param text - raw `<ref_msg_text>`.
 * @param name - the quoted message's sender display name (stripped prefix).
 * @returns the cleaned placeholder, or '' when it carries nothing.
 */
export declare function stripRefMsgText(text: string, name: string): string;
/** 被引用的原消息是媒体时，给一个可读的占位（对应 local_type）。 */
export declare function quoteTypePlaceholder(type: number): string;
/** appmsg 子类型 → 引用占位标签（被引用的是卡片型消息时）。 */
export declare const QUOTE_APP_LABEL: Record<number, string>;
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
export declare function stripQuotedGroupPrefix(raw: string): string;
/**
 * 被引用内容若是 appmsg，取出它的子类型（转账 2000 / 红包 2001·2003 / 链接 5…）。
 *
 * 界面要靠它给引用行配**类型图标**（官方参考图里引用一条转账显示的是转账图标 +
 * 「微信转账」，而不是通用链接图标）。refermsg 自己的 `<type>` 只有 49（appmsg 族），
 * 分不出转账与链接，子类型只在内层 appmsg 里。
 * @param xml - the quoted content.
 * @returns the appmsg `<type>`, or 0 when not an appmsg.
 */
export declare function quotedAppType(xml: string): number;
export declare function summarizeQuotedXml(xml: string): string;
/**
 * 引用消息的缩略图（被引用的是链接/视频号时）。
 * 各版本字段名不一致（thumburl / cdnthumburl / coverurl），逐个兜底。
 * @param raw - the quoted content (may be XML or a `wxid:payload` wrapper).
 * @returns a cdn thumb url, or ''.
 */
export declare function quotedThumbUrl(raw: string): string;
/**
 * 图片组 id 的合法形态。
 *
 * ⚠️ 本机真实数据里是**无连字符的 32 位 hex**（md5 形态，实测 8 条消息共享同一个 id）：
 * `<groupinfo><id>e50fcb7be682d22ab67aded24c9f17e0</id><count>6</count><type>1</type></groupinfo>`
 * WeChatDataAnalysis 的校验只认**带连字符的标准 UUID**，在本机数据上会把这一组全部判成
 * 非图片组（连拍退化成 6 张散图）。所以两种形态都接受 —— 再加上 `count ≥ 2`，
 * 依然足以排除偶发同名节点造成的误判。
 */
export declare const IMAGE_GROUP_ID: RegExp;
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
 * 链接卡片的语义分类。
 *
 * `公众号文章` vs `普通网页`：`<type>5|68</type>` 且 url 命中 mp.weixin.qq.com
 * 或来源是 `gh_*`。封面式（`cover`）用于公众号「大图 + 底部标题」那种卡片，
 * 判据是摘要以话题标签开头 / 含 ≥2 个 `#话题#` / PC 信息流链接。
 * @returns [linkType, linkStyle].
 */
export declare function classifyLinkShare(url: string, sourceUsername: string, desc: string, appType: number): [string, string];
/** 把 appmsg 的 `<appattach>` 解析成文件卡片字段。 */
export declare function parseFileAttach(app: string): {
    size: string;
    ext: string;
    md5: string;
};
/** 视频号解析（`<type>4</type>` / `51` / `63` 共用，字段各版本命名不一致）。 */
export declare function channelsRich(app: string, title: string, des: string, url: string, thumb: string, source: string, sourceUsername: string, base: Pick<RichMedia, 'source' | 'thumb'>): RichMedia;
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
export declare function applyMpNews(link: RichMedia, app: string, firstTitle: string, firstUrl: string, fallbackCover: string): void;
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
export declare function parseAppmsg(xml: string): RichMedia | null;
/**
 * Parse an appmsg recorditem (merged chat log) into inner records.
 * Mirrors WeChatDataAnalysis frontend parseChatHistoryRecord: datatype /
 * datafmt classify each dataitem; nested recordxml/recorditem recurses.
 * @param recordXml - the recorditem inner XML (<recordinfo>...</recordinfo>).
 * @param depth - recursion guard for nested chat histories.
 * @returns the inner messages (empty when not parseable).
 */
export declare function parseChatlogRecords(recordXml: string, depth?: number): ChatlogRecord[];
