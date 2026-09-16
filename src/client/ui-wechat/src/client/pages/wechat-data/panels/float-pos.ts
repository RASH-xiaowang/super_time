/**
 * 悬浮面板的位置：读取、夹取、持久化（纯函数，不碰 DOM / React）。
 *
 * 为什么单独成模块：位置计算（夹进可视区、窗口变小后回位）是最容易出错又最该有回归的部分，
 * `useDraggableFloat` 只负责把它接到指针事件上。本模块不 import react，可在 node 环境直接测。
 */

export interface FloatPos { x: number; y: number }
export interface Size { w: number; h: number }

/** localStorage 键：按面板 id 分开存，互不干扰。 */
export function floatPosKey(id: string): string {
  return `super-time-float-pos-${id}`
}

/** 离视口边缘至少留出的空隙（px）。 */
export const FLOAT_MARGIN = 8

/**
 * 把位置夹进可视范围。
 *
 * 两个方向都要夹：既要防止拖出视口外找不回来，也要处理「面板比视口还大」的情况 ——
 * 那时 `view - size - margin` 会小于 `margin`，取两者较大值保证左上角仍可见（至少留得住把手）。
 * @param pos - 期望位置。
 * @param size - 面板尺寸。
 * @param view - 视口尺寸。
 * @param margin - 边缘空隙。
 * @returns 夹取后的位置（不改入参）。
 */
export function clampFloatPos(pos: FloatPos, size: Size, view: Size, margin: number = FLOAT_MARGIN): FloatPos {
  const maxX = Math.max(margin, view.w - size.w - margin)
  const maxY = Math.max(margin, view.h - size.h - margin)
  return {
    x: Math.round(Math.min(Math.max(pos.x, margin), maxX)),
    y: Math.round(Math.min(Math.max(pos.y, margin), maxY)),
  }
}

/**
 * 解析存下来的位置。
 * @param raw - localStorage 原文。
 * @returns 合法的位置；缺字段/不是数字/越界到 NaN 时 null（回落到 CSS 里的默认位置）。
 */
export function parseFloatPos(raw: string | null): FloatPos | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as Partial<FloatPos>
    if (typeof v.x !== 'number' || typeof v.y !== 'number') return null
    if (!Number.isFinite(v.x) || !Number.isFinite(v.y)) return null
    return { x: v.x, y: v.y }
  } catch {
    return null
  }
}
