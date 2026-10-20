/**
 * 总结 prompt 构造 —— 每日与周期共用。
 *
 * ## 为什么单独一个文件（2026-10-17）
 *
 * 改前两处各写一句 `'请总结 X 的微信聊天内容，输出简洁的中文要点：'`，问题有三：
 *   ① **没有篇幅约束** —— 模型有时写 3 行、有时写 800 字，用户不知道会得到什么；
 *   ② **没有结构要求** —— 输出是一坨散文，扫不出重点；
 *   ③ **没有防编造约束** —— 素材稀疏时模型会"合理推测"，而这是个人聊天记录，
 *      编出来的内容比没有更糟。
 *
 * 现在统一成：**固定四段结构 + 明确字数区间 + 素材不足就直说**。
 */
/** 总结格式（与前端 `FORMATS` 口径一致）。 */
export type SummaryFormat = 'brief' | 'detailed' | 'bullets' | 'story' | 'custom';
/**
 * 构造总结 prompt。
 * @param opts.kind - 每日还是周期（决定时间描述与篇幅上限）。
 * @param opts.from - 起始日期（YYYY-MM-DD）。
 * @param opts.to - 结束日期（YYYY-MM-DD，含）。与 `from` 相同即单日。
 * @param opts.lines - 已清洗的消息素材（`【会话名】` + 正文行）。
 * @param opts.stats - 统计（写进 prompt 让模型知道素材规模）。
 * @param opts.format - 输出格式。
 * @param opts.customPrompt - `format === 'custom'` 时的用户模板。
 * @returns 完整 prompt。
 */
export declare function buildSummaryPrompt(opts: {
    from: string;
    to: string;
    lines: readonly string[];
    stats: {
        total: number;
        sessions: number;
        messages: number;
    };
    format?: SummaryFormat;
    customPrompt?: string;
}): string;
/**
 * 素材为空时的固定回复（不调模型，省一次请求）。
 * @param from - 起始日期。
 * @param to - 结束日期。
 * @returns 提示文本。
 */
export declare function emptyMaterialNotice(from: string, to: string): string;
