/**
 * 用户问题里的显式日期范围。
 *
 * 与 `date-expression.ts` 的分工：那一层解析工具参数里的单个日期表达式；
 * 这一层解析自然语言问题中的完整区间和「截至某日」锚点，并优先于单日期匹配。
 *
 * @module query/answer-runtime/explicit-time-range
 */
import type { AnswerTimeRange } from './intent.ts';
/** 严格组装 ISO 日期；非法年月日（如 2 月 30 日）返回 undefined。 */
export declare function strictIsoDay(year: number, month: number, day: number): string | undefined;
/** 按月偏移并按月底截断，避免 1 月 31 日减一个月滚到 3 月。 */
export declare function addMonthsClamped(date: Date, months: number): Date;
/**
 * 完整起止区间优先于单日期。
 *
 * 若先按单日期解析，`2026-09-16至2026-10-16` 会缩成 `2026-10-16`，
 * 随后模型按原文填入完整范围时反而被服务端判成越界。
 */
export declare function resolveExplicitDateRange(question: string): AnswerTimeRange | undefined;
/**
 * 「最近 N 天/周/月（截至某日）」以用户给出的截止日为锚点。
 *
 * 不能用当前时间重算：历史对话里的范围会漂移，模型照抄原文日期时还会冲突。
 */
export declare function resolveAnchoredRecentDateRange(question: string): AnswerTimeRange | undefined;
/** 不带锚点的「最近 N 天/周/月」，以当前时刻为截止日。 */
export declare function resolveRecentDateRange(question: string, now: Date): AnswerTimeRange | undefined;
