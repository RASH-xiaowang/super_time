/**
 * 调用方数字参数的统一边界（P2：limit 无下界/有限性校验）。
 *
 * SQLite 对非法 `LIMIT` 的行为并不安全：
 *   · 负数 = 「没有上限」⇒ 一次把整表物化（`LIMIT -1` 的语义）；
 *   · NaN / Infinity / 小数在绑定参数时直接抛 `TypeError`（或生成非法 SQL）。
 *
 * 所以凡是把调用方传入的数字拼进 `LIMIT`（或拿它做分页预算）的位置，都必须先过
 * 这里的 helper —— 取整 + 夹紧到 `[1, max]`，非有限值退回默认值。
 *
 * @module limits
 */

/**
 * 归一化调用方传入的每页条数。
 *
 * - `undefined` / `NaN` / `±Infinity` → `fallback`（默认值本身也会被夹紧）；
 * - 小数 → 向零取整；
 * - `< 1` → `1`（负值绝不能落到 SQLite 里变成「全表」）；
 * - `> max` → `max`。
 *
 * @param value - 调用方传入的 limit。
 * @param fallback - 未传或非有限值时使用的默认条数。
 * @param max - 硬上限。
 * @returns 可直接绑定到 `LIMIT ?` 的整数。
 */
export function clampLimit(value: number | undefined, fallback: number, max: number): number {
  const upper = Math.max(1, Math.trunc(max))
  // fallback 本身也可能是 NaN/越界（调用方写错常量），一并夹紧。
  const safeFallback = Number.isFinite(fallback) ? Math.trunc(fallback) : upper
  if (value === undefined || !Number.isFinite(value)) {
    return Math.min(Math.max(safeFallback, 1), upper)
  }
  return Math.min(Math.max(Math.trunc(value), 1), upper)
}

/**
 * 归一化「可选分页条数」，但**不设上限**（用于本来就允许一次取完的接口）。
 *
 * `undefined` 保持 `undefined`（SQL 层不写 LIMIT，保持旧语义）；`+Infinity` 同样视作
 * 「不限制」；`NaN` / 负数 / `-Infinity` → `0`（空页，而不是 SQLite 的「全表」）。
 * @param value - 调用方传入的 limit。
 * @returns 非负整数，或 `undefined` 表示不限制。
 */
export function normalizePageLimit(value: number | undefined): number | undefined {
  if (value === undefined || value === Infinity) return undefined
  if (Number.isNaN(value) || value === -Infinity) return 0
  return Math.max(0, Math.trunc(value))
}

/**
 * 归一化分页偏移量。
 *
 * SQLite 的 `OFFSET -1` 等同于 0，但不同驱动对 NaN/Infinity 的绑定行为不一致；
 * 这里统一成非负整数：`NaN` / 负数 → 0，`+Infinity` → `Number.MAX_SAFE_INTEGER`
 * （必然返回空页，且不会因超出 SQLite 整数范围而报错）。
 * @param value - 调用方传入的 offset。
 * @returns 非负整数。
 */
export function normalizeOffset(value: number | undefined): number {
  if (value === undefined || Number.isNaN(value) || value === -Infinity) return 0
  if (value === Infinity) return Number.MAX_SAFE_INTEGER
  return Math.max(0, Math.trunc(value))
}
