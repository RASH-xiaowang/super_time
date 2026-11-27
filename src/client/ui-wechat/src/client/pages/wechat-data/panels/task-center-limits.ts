/**
 * 「触发时携带的文本条数」的取值范围与文案（任务配置侧）。
 *
 * 为什么单独一个文件：`task-center.ts` 已经贴着 M21 的 1000 行上限（棘轮只许变小），
 * 而文本条数是**独立的一条配置轴**（与照片张数并列）。把它搬出来既能给主文件腾行数，
 * 也让「0 = 不带文本」「最多 9 条」这两个口径只有一处。
 *
 * @module panels/task-center-limits
 */

/** 文本条数下限（0 = 不额外携带历史文本）。 */
export const TEXT_LIMIT_MIN = 0
/** 文本条数上限（与后端 `TEXT_LIMIT_MAX` 一致）。 */
export const TEXT_LIMIT_MAX = 9

/**
 * 把输入框里的任意数字收进文本条数的合法区间。
 * @param value - 用户输入。
 * @returns 0..9 的整数；非有限数归 0，小数向下取整。
 */
export function clampTextLimit(value: number): number {
  if (!Number.isFinite(value)) return TEXT_LIMIT_MIN
  return Math.min(TEXT_LIMIT_MAX, Math.max(TEXT_LIMIT_MIN, Math.trunc(value)))
}

/**
 * 文本条数文案（任务列表行/配置摘要用）。
 * @param limit - 文本条数。
 * @returns 文案。
 */
export function textLimitLabel(limit: number): string {
  return limit <= 0 ? '不带文本' : `${String(limit)} 条文本`
}
