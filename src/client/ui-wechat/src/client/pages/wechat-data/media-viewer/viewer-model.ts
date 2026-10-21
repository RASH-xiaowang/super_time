/**
 * 资源查看器的纯逻辑（2026-10-21，统一聊天/文件/收藏/ClawBot 的大图预览）。
 *
 * 为什么单独成纯函数：这族里最容易写错且**不会报错**的三件事是
 * 「缩放越界变成 0.3 倍」「点最后一张得到 undefined / 跳回第一张」「预取把相邻图全
 * 拉进内存」。把它们做成可注入边界的纯函数，用用例钉住，组件只负责画。
 */

/** 默认缩放区间：允许略缩小以看全图（文件面板旧行为是 0.5–5）。 */
export const DEFAULT_MIN_ZOOM = 0.5
/** 默认放大上限：再大只会糊。 */
export const DEFAULT_MAX_ZOOM = 6

/**
 * 把缩放钳进 `[min, max]`。
 * @param zoom - 期望倍率。
 * @param min - 下限（默认 {@link DEFAULT_MIN_ZOOM}）。
 * @param max - 上限（默认 {@link DEFAULT_MAX_ZOOM}）。
 * @returns 钳过的倍率；非有限值回 1。
 */
export function clampZoom(zoom: number, min = DEFAULT_MIN_ZOOM, max = DEFAULT_MAX_ZOOM): number {
  const lo = Number.isFinite(min) ? Math.max(0.05, min) : DEFAULT_MIN_ZOOM
  const hi = Number.isFinite(max) ? Math.max(lo, max) : DEFAULT_MAX_ZOOM
  const z = Number.isFinite(zoom) ? zoom : 1
  return Math.min(hi, Math.max(lo, z))
}

/**
 * 按固定步长缩放（按钮/键盘用）。
 * @param zoom - 当前倍率。
 * @param direction - `1` 放大、`-1` 缩小。
 * @param min - 下限。
 * @param max - 上限。
 * @returns 新倍率（1.25 倍步长，钳在区间内）。
 */
export function zoomStep(zoom: number, direction: number, min = DEFAULT_MIN_ZOOM, max = DEFAULT_MAX_ZOOM): number {
  const factor = direction >= 0 ? 1.25 : 1 / 1.25
  return clampZoom(clampZoom(zoom, min, max) * factor, min, max)
}

/**
 * 轮播索引（循环）。
 * @param length - 条目数；`0` 回 0。
 * @param index - 当前索引。
 * @param delta - `+1` 下一张、`-1` 上一张。
 * @returns 循环后的索引。
 */
export function wrapIndex(length: number, index: number, delta: number): number {
  const n = Math.max(0, Math.floor(length))
  if (n === 0) return 0
  const cur = Number.isFinite(index) ? Math.floor(index) : 0
  const next = (cur + (Number.isFinite(delta) ? Math.floor(delta) : 0)) % n
  return next < 0 ? next + n : next
}

/**
 * 需要预取的相邻索引（当前 ± radius，去重、按距离从近到远、循环）。
 * @param length - 条目数。
 * @param index - 当前索引。
 * @param radius - 向两侧各预取几张（默认 1）。
 * @returns 相邻索引数组（不含当前，可能为空）。
 */
export function neighborIndexes(length: number, index: number, radius = 1): number[] {
  const n = Math.max(0, Math.floor(length))
  const r = Math.max(0, Math.floor(radius))
  if (n <= 1 || r === 0) return []
  const cur = wrapIndex(n, index, 0)
  const out: number[] = []
  for (let d = 1; d <= Math.min(r, n - 1); d += 1) {
    out.push(wrapIndex(n, cur, -d), wrapIndex(n, cur, d))
  }
  return [...new Set(out)]
}

/**
 * 缩放百分比文案（用于工具条）。
 * @param zoom - 倍率。
 * @returns 例如 `100%`；非有限值按 100%。
 */
export function percentOf(zoom: number): string {
  const pct = Math.round((Number.isFinite(zoom) ? zoom : 1) * 100)
  return `${String(pct)}%`
}

/**
 * 计数文案。
 * @param index - 当前索引（0 基）。
 * @param length - 总数。
 * @returns 例如 `3 / 12`；空集合回 `0 / 0`。
 */
export function counterText(index: number, length: number): string {
  const n = Math.max(0, Math.floor(length))
  if (n === 0) return '0 / 0'
  return `${String(wrapIndex(n, index, 0) + 1)} / ${String(n)}`
}
