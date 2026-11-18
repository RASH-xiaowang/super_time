import type { ReplyContextEntry } from '../reply-suggest.ts';
/** 单次 AI 回复请求给上下文正文（不含图片）的默认 token 预算。 */
export declare const AI_REPLY_INPUT_TOKEN_BUDGET = 6000;
/** 无论预算多紧，都至少保留最近这么多条（最新一条永远保留）。 */
export declare const AI_REPLY_MIN_RECENT_ENTRIES = 8;
/** 至少保留多少条对方消息，避免模型只看到自己说过的话。 */
export declare const AI_REPLY_MIN_PEER_ENTRIES = 4;
/** 至少保留多少条「我」的消息，作为回复口吻的锚点。 */
export declare const AI_REPLY_MIN_SELF_ENTRIES = 2;
/** 单条正文进提示词前的默认最大字符数（按 code point 计）。 */
export declare const AI_REPLY_MAX_LINE_CHARS = 600;
/** 一张图片/表情在上下文预算里的保守 token 估算。 */
export declare const AI_REPLY_IMAGE_TOKEN_ESTIMATE = 800;
/** 为满足最低条数时，正文最多允许超出预算的倍数。 */
export declare const AI_REPLY_BUDGET_HARD_OVERRUN = 1.35;
/**
 * 时间断层阈值：相邻两条消息间隔超过它，就认为上一段对话已经结束。
 *
 * 上下文最多跨 60 条、可能横跨好几天。模型看到几天前「我」交代过的事，
 * 会把它当成**还没做完的待办**，于是替「我」重新追问一遍 —— 表现就是
 * 「同一个问题被反复回复」。标出断层后，断层之前的内容只作背景。
 */
export declare const CHAT_AI_REPLY_TIME_GAP_SECONDS: number;
/** 断层标记行：只出现在 `lines` 里，不进 `dialogueLines`（不参与检索）。 */
export declare const CHAT_AI_REPLY_GAP_MARKER = "\uFF08\u4EE5\u4E0A\u662F\u66F4\u65E9\u7684\u5BF9\u8BDD\uFF0C\u4E0E\u672C\u6761\u6CA1\u6709\u76F4\u63A5\u5173\u7CFB\uFF09";
/** 调用方可以按模型/场景覆盖的预算参数。 */
export interface ChatAiReplyContextBudgetOptions {
    tokenBudget?: number;
    minRecent?: number;
    minPeer?: number;
    minSelf?: number;
    maxLineChars?: number;
    imageCount?: number;
    imageTokenEstimate?: number;
    hardOverrun?: number;
}
/** 预算装配的可观测结果。 */
export interface ChatAiReplyContextStats {
    /** 输入条数。 */
    collected: number;
    /** 实际进入提示词的条数（不含时间标记与省略行）。 */
    included: number;
    /** 被丢弃的条数；只会是窗口最旧的一段。 */
    dropped: number;
    /** 最终输出所有行（含时间标记/省略行）的 token 估算 + 图片预留。 */
    estimatedTokens: number;
    /** 本次生效的 token 预算。 */
    tokenBudget: number;
    /** 是否在顶部加了「更早的对话已省略」。 */
    truncated: boolean;
    /** 被头尾截断的条数。 */
    shortened: number;
    /** 纳入的对方消息条数。 */
    peerIncluded: number;
    /** 纳入的「我」的消息条数。 */
    selfIncluded: number;
    /** 本次按候选数预留的图片数；实际解码成功数以调用方日志为准。 */
    imageCount: number;
}
/** 装配后的上下文。 */
export interface ChatAiReplyAssembledContext {
    /** 时间正序的提示词行；可能包含时间标记与省略行。 */
    lines: string[];
    /** 只含正文行（`speaker：text`），不含时间标记与省略行；供检索等下游使用。 */
    dialogueLines: string[];
    /** 实际纳入窗口的消息 localId（升序）；图片候选必须落在这个窗口里才有意义。 */
    includedLocalIds: number[];
    stats: ChatAiReplyContextStats;
}
/**
 * 估算一段文本的 token 数。
 *
 * 这是一个刻意保守的跨模型估算，不对齐任何一家的 tokenizer：
 *   · 非 ASCII 视觉字符（汉字、全角标点、emoji 等）按 1 token/字；
 *   · ASCII 连续字符（含空白）每 3 个约 1 token，最后向上取整。
 * 对中文为主的微信对话，这个数通常比真实 tokenizer 略高，宁可在预算上留余量；
 * 长 base64/hex/URL 仍可能被低估，因此预算只是目标值，不声称是模型窗口硬保护。
 * @param text - 待估算文本。
 * @returns 非负整数 token 估算；空串为 0。
 */
export declare function estimateChatAiReplyTokens(text: string): number;
/**
 * 把单条正文压缩到字符上限内，保留开头和结尾。
 *
 * 微信里重要的信息常在首尾（称呼、结论、问句），中段往往只是铺垫；
 * 所以超限时保留约 65% 的头部与其余尾部，用一个 `…` 连接。
 * 全部按 code point 切，避免把 emoji 的代理对劈成乱码。
 * @param text - 原始正文。
 * @param maxChars - 最大字符数，默认 {@link AI_REPLY_MAX_LINE_CHARS}。
 * @returns 压缩后的文本与是否发生截断。
 */
export declare function shortenChatAiReplyLine(text: string, maxChars?: number): {
    text: string;
    shortened: boolean;
};
/**
 * 按 token 预算装配会话上下文。
 *
 * 关键顺序：
 *   1. 图片先占预算；
 *   2. 最新至少 `minRecent` 条无条件保留（最新一条永远保留）；
 *   3. 预算还有余量时继续向旧扩展；
 *   4. 对方/我条数不足时，允许突破预算、在硬上限内继续向旧扩展；
 *   5. 若窗口里有「我」但一条都没纳入，硬上限内至少要捞回一条作口吻锚点；
 *   6. 输出时补时间标记和省略行，最后按实际行重新估算 token。
 * @param entries - 已按时间正序排列的消息；不会被修改。
 * @param options - 预算覆盖项；非法值回退默认值。
 * @returns 提示词行与统计。
 */
export declare function assembleChatAiReplyContext(entries: readonly ReplyContextEntry[], options?: ChatAiReplyContextBudgetOptions): ChatAiReplyAssembledContext;
