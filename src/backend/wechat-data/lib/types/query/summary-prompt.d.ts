/**
 * 总结 prompt 构造 —— 每日、周期与定时任务共用。
 *
 * ## 为什么单独一个文件（2026-10-17）
 *
 * 改前两处各写一句 `'请总结 X 的微信聊天内容，输出简洁的中文要点：'`，问题有三：
 *   ① **没有结构要求** —— 输出是一坨散文，扫不出重点；
 *   ② **没有防编造约束** —— 素材稀疏时模型会"合理推测"，而这是个人聊天记录，
 *      编出来的内容比没有更糟；
 *   ③ 各写一句还会互相漂。
 *
 * 现在统一成：**固定四段结构 + 防编造 + 素材不足就直说**。
 *
 * ## 篇幅为什么不写字数区间（2026-11-18）
 *
 * 2026-10-17 那一版给每种格式钉了硬区间（`150–250 字` / `400–700 字` / `6–10 条`），
 * 目的是让输出可预期。实际用下来代价更大：
 *   · **素材多的时候被硬砍** —— 一个热闹的群聊塞进 700 字，「谁答应做什么、结论是什么」
 *     这类真正要看的东西反而被挤掉了；
 *   · **素材少的时候被逼着凑** —— 区间下界成了指标，模型开始复述寒暄、加铺垫，与
 *     「不要编造」直接打架；
 *   · 用户真正关心的是「该说的有没有说完」，不是「字数在不在区间内」。
 *
 * 所以现在只约束**结构**与**诚实性**，篇幅交给模型按素材量自己判断。
 * 想控制长度的用户仍有出口：选「要点列表」（逐条、不铺垫）或用「自定义格式」自己写要求。
 */
/** 总结格式（与前端 `FORMATS` 口径一致）。 */
export type SummaryFormat = 'brief' | 'detailed' | 'bullets' | 'story' | 'custom';
/**
 * 构造总结 prompt。
 * @param opts.kind - 每日还是周期（决定时间描述与篇幅上限）。
 * @param opts.from - 起始日期（YYYY-MM-DD）。
 * @param opts.to - 结束日期（YYYY-MM-DD，含）。与 `from` 相同即单日。
 * @param opts.lines - 已清洗的消息素材（`【会话名】` + 正文行）。
 * @param opts.stats - 统计（写进 prompt 让模型知道素材规模，由它自己决定篇幅）。
 * @param opts.format - 输出格式。
 * @param opts.customPrompt - `format === 'custom'` 时的用户模板。
 * @param opts.scope - 会话范围描述（定时任务传群名）。缺省表示「全部会话」。
 * @param opts.targets - 关注成员描述（定时任务传成员名）。缺省「全部成员」。
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
    scope?: string;
    targets?: string;
}): string;
/**
 * 素材为空时的固定回复（不调模型，省一次请求）。
 * @param from - 起始日期。
 * @param to - 结束日期。
 * @returns 提示文本。
 */
export declare function emptyMaterialNotice(from: string, to: string): string;
