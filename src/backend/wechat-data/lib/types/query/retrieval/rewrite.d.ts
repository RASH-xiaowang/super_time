import type { QueryPlan } from './types.ts';
/** 全角 → 半角（数字与常用标点）。 */
export declare function toHalfWidth(s: string): string;
/** 归一化问题：全角转半角 + 压缩空白。 */
export declare function normalizeQuestion(q: string): string;
/**
 * 确定性相对时间解析：把问题里的相对时间换算成绝对日期范围。
 *
 * 只处理**模式明确**的几种（昨天/前天/上周X/周X/N月N日/上个月/去年）。
 * 解析不出来返回空 —— 宁可交给 LLM 规划器，也不要猜错日期把检索收窄成空集。
 * @param text - 归一化后的问题。
 * @param now - 当前时间（可注入，便于测试）。
 * @returns { from, to }（YYYY-MM-DD，未识别为空串）。
 */
export declare function resolveRelativeDate(text: string, now?: Date): {
    from: string;
    to: string;
};
/** 从词项出发做同义扩展（返回新增词，不含原词）。 */
export declare function synonymExpand(terms: string[]): string[];
/** 构建查询计划的输入。 */
export interface BuildPlanInput {
    question: string;
    /** 规划器关键词。 */
    subQueries?: string[];
    /** 规划器点名的人。 */
    entity?: string;
    /** 规划器换算出的日期。 */
    from?: string;
    to?: string;
    /** 用户显式选择的检索范围（硬过滤）。 */
    scopeFrom?: string;
    scopeTo?: string;
    /** 已知实体名（联系人显示名）。 */
    knownEntities?: string[];
    /** 现在时刻（可注入）。 */
    now?: Date;
}
/**
 * 组装查询计划：归一化 + 词项 + 多查询变体 + 实体 + 时间。
 * @param input - 见 BuildPlanInput。
 * @returns 查询计划。
 */
export declare function buildQueryPlan(input: BuildPlanInput): QueryPlan;
