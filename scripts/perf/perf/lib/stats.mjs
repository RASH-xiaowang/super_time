/**
 * 统计小工具：分位数 / 中位 / 噪声带。
 *
 * 专项里的所有"中位"都走这里，保证不同脚本同一口径（最近秩法，样本内取下标）。
 */

/**
 * 把一组数值排序后取分位（最近秩，做法同 `src/backend/http-queue.js#summarizeSamples`）。
 * @param {number[]} values - 任意数值序列（NaN/Infinity 会被过滤）。
 * @param {number} q - 0..1。
 * @returns {number} 分位数；空样本返回 0。
 */
export function quantile (values, q) {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  if (xs.length === 0) return 0
  const idx = Math.min(xs.length - 1, Math.max(0, Math.ceil(xs.length * q) - 1))
  return xs[idx]
}

/** 中位数（=quantile 0.5）。 */
export const median = (values) => quantile(values, 0.5)

/** 算术平均（空样本 0）。 */
export function mean (values) {
  const xs = values.filter((v) => Number.isFinite(v))
  if (xs.length === 0) return 0
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

/**
 * 一组重复测量的摘录：中位 + 噪声带（min~max + 相对展宽）。
 *
 * 相对展宽定义为 `(max-min)/median`；median 为 0 时给 0（不要制造 Infinity）。
 * @param {number[]} values
 * @returns {{ n: number, median: number, min: number, max: number, spreadRel: number, mean: number, p50: number, p95: number }}
 */
export function series (values) {
  const xs = values.filter((v) => Number.isFinite(v))
  if (xs.length === 0) return { n: 0, median: 0, min: 0, max: 0, spreadRel: 0, mean: 0, p50: 0, p95: 0 }
  const med = median(xs)
  const min = Math.min(...xs)
  const max = Math.max(...xs)
  return {
    n: xs.length,
    median: round(med),
    min: round(min),
    max: round(max),
    spreadRel: med === 0 ? 0 : round((max - min) / med, 4),
    mean: round(mean(xs)),
    p50: round(quantile(xs, 0.5)),
    p95: round(quantile(xs, 0.95)),
  }
}

/** 四舍五入到指定小数位，默认 1 位；整数原样返回。 */
export function round (v, digits = 1) {
  if (!Number.isFinite(v)) return null
  const p = 10 ** digits
  return Math.round(v * p) / p
}

/**
 * 递归地把对象里的数字字段变成 `series()`（对 samples 数组按同一路径聚合）。
 *
 * 只用于报告汇总：把每个 sample 的 `metrics` 展平成 `{path: [v1,v2,v3]}`。
 * @param {Record<string, number>[]} maps - 每个 sample 的扁平淡数值表。
 * @returns {Record<string, ReturnType<typeof series>>}
 */
export function aggregateSeries (maps) {
  const keys = new Set()
  for (const m of maps) for (const k of Object.keys(m)) keys.add(k)
  const out = {}
  for (const k of [...keys].sort()) {
    out[k] = series(maps.map((m) => m[k]).filter((v) => Number.isFinite(v)))
  }
  return out
}

/** 扁平化对象（只保留 number 值），key 用 `.` 连接；数组不计入。 */
export function flattenNumbers (obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    const key = prefix === '' ? k : `${prefix}.${k}`
    if (typeof v === 'number') { if (Number.isFinite(v)) out[key] = v } else if (v && typeof v === 'object' && !Array.isArray(v)) flattenNumbers(v, key, out)
  }
  return out
}
