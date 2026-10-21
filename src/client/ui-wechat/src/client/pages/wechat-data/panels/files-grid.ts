/**
 * 网格虚拟化的算术（文件面板那张 `repeat(auto-fill, minmax(200px, 1fr))` 的格子墙）。
 *
 * 为什么单独一份并且必须纯：`useVirtualizer` 数的是**行**，而 CSS 网格数的是**格子**，
 * 中间那层换算（一屏几列、第几行是哪几个格子）是这一族里唯一会算错的地方 ——
 * 列数取错的症状是"最后一行被截掉"或"同一格画两遍"，都不是崩溃而是安静的错。
 * 列数还得现测：`auto-fill` 的列数随容器宽度变，窗口一拉就不同，所以它不能是常量。
 */

/**
 * 从 `getComputedStyle(el).gridTemplateColumns` 里数列。
 * 解析出来的值是 `"200px 200px 200px"` 这种；拿不到（`none`、还留着 `repeat(auto-fill…` 原文）
 * 就返回 **0**，让调用方回退到按宽度换算 —— 返回 0 而不是 1，是为了不把"不知道"混进"就是 1 列"。
 */
export function gridColumnCount(template: string): number {
  const t = (template || '').trim()
  if (!t || t === 'none') return 0
  const rep = /repeat\(\s*(\d+)\s*,/.exec(t)
  if (rep) return Math.max(0, Number(rep[1]) || 0)
  const cells = t.split(/\s+/).filter((s) => /\d/.test(s))
  return cells.length
}

/** 按容器宽度换算列数（`auto-fill + minmax(minColPx, 1fr)` 的语义就是"塞得下几列塞几列"）。 */
export function columnsForWidth(width: number, minColPx: number): number {
  if (!(width > 0) || !(minColPx > 0)) return 1
  return Math.max(1, Math.floor(width / minColPx))
}

/** 两个来源合成一个列数：算出来的样式优先，拿不到才按宽度估。 */
export function resolveGridColumns(template: string, width: number, minColPx: number): number {
  return gridColumnCount(template) || columnsForWidth(width, minColPx)
}

/** 行总数（列数至少 1，条目数为 0 就是 0 行）。 */
export function gridRowCount(items: number, cols: number): number {
  const c = Math.max(1, cols)
  return Math.ceil(Math.max(0, items) / c)
}

/**
 * 第 `row` 行覆盖的半开区间（**不切数组**：虚拟化每帧都要算一次，切出来的数组只是垃圾）。
 * 结尾按条目数截断，所以最后一行不满列也拿得到正确的边界。
 */
export function gridRowRange(row: number, items: number, cols: number): { start: number; end: number } {
  const c = Math.max(1, cols)
  const start = Math.max(0, row) * c
  return { start, end: Math.min(Math.max(0, items), start + c) }
}

/**
 * 每格可用宽度（CSS px）：内容宽扣掉列间距后均分。
 *
 * 缩略图宽度就按它 × DPR 取档（`thumbWidthFor`）—— 写死 320 会在窄格上浪费、
 * 在 2x 屏上发糊；而每拖一次窗口都生成新缓存又会让解码目录膨胀，所以取档。
 * @param contentWidth - 容器内容宽（已扣左右 padding）。
 * @param cols - 列数（至少 1）。
 * @param gapPx - 列间距（与 CSS `gap` 同值）。
 * @returns 格宽；宽度不可用时返回 0（调用方回退最小列宽）。
 */
export function cellWidthFor(contentWidth: number, cols: number, gapPx: number): number {
  const c = Math.max(1, Math.ceil(Number(cols) || 1))
  const width = Number(contentWidth)
  if (!Number.isFinite(width) || width <= 0) return 0
  const gap = Math.max(0, Number(gapPx) || 0)
  return Math.max(0, (width - gap * (c - 1)) / c)
}
