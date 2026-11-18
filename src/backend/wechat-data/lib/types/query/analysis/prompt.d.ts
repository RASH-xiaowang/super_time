/**
 * 「消息分析」的提示词与输出校验。
 *
 * 一次调用产出一份结构化 JSON。设计上刻意的三件事：
 *
 *  1. **单聊与群聊用不同的问题域**。单聊问「他想要什么、我该怎么回」；
 *     群聊问「这条消息是否针对我、他在群里做什么、我该不该接话」。旧实现把
 *     「对方意图」硬套到群聊，于是「@我 报价多少」会被判成「想确认你的态度」。
 *  2. **输出是 JSON 而不是自由文本**，由 {@link parseAnalysisJson} 严格校验并夹紧：
 *     模型多写一层包裹、少给字段、给出越界枚举值时都降级而不是抛错。
 *  3. **不生成可直接发送的回复**。分析只做研判；「推荐回复」是另一条链路，
 *     两者共用同一个模型但提示词不同，混在一起会让分析滑向写稿。
 *
 * @module query/analysis/prompt
 */
import type { MessageAnalysis, MessageAnalysisScope } from '../../types-analysis.ts';
/** 解析结果：成功时带上经过夹紧的分析，失败时给一句可展示的原因。 */
export type ParseAnalysisResult = {
    ok: true;
    analysis: MessageAnalysis;
} | {
    ok: false;
    error: string;
};
/**
 * 校验并夹紧模型输出。
 *
 * 只保留**能展示的最小充分集**：结论、置信、意图、氛围、动作。缺其中任何一项都算失败——
 * 与其显示半张空卡片，不如让用户看到「模型没给出可用结论」并重试。
 * @param raw - 模型原始输出文本。
 * @param scope - 会话类型，决定是否要求 `addressed`。
 * @param addressedFallback - 群聊专用兜底：模型没给出可用「是否针对我」时，用结构化
 *   `atuserlist` 的已知事实代替。宁可给一个**有据可依**的判断，也不要显示半张卡片。
 * @returns 已夹紧的分析，或失败原因。
 */
export declare function parseAnalysisJson(raw: string, scope: MessageAnalysisScope, addressedFallback?: {
    targeted: boolean;
    reason: string;
}): ParseAnalysisResult;
/**
 * 组装分析提示词。
 *
 * 上下文行已由调用方带好 `[时间] 发言者：内容`，这里只负责提问与输出约束。
 * @param input - 会话类型、上下文行、被分析的那句、是否群里点了我的名。
 * @returns 可直接作为 user 消息的提示词。
 */
export declare function buildAnalysisPrompt(input: {
    scope: MessageAnalysisScope;
    /** 时间正序的上下文行（已带时间前缀）。 */
    lines: readonly string[];
    /** 被分析的那一条的正文。 */
    targetText: string;
    /** 群聊：结构化 @ 列表里是否点名了本机账号。 */
    mentionsMe?: boolean;
    /** 群里最近有没有人接话（用于判断这轮对话走向）；可选。 */
    recentSpeakers?: readonly string[];
}): string;
/** 群聊分析里「是否针对我」的兜底：模型没答好时用结构化 @ 反推。 */
export declare function fallbackAddressed(mentionsMe: boolean, talkerName: string): {
    targeted: boolean;
    reason: string;
};
