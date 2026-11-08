/**
 * 图谱参数变化时的坐标过渡。
 *
 * 布局器负责算出“目标形状”，这里负责让屏幕上的坐标连续地走向目标。拖动力度滑杆时
 * 不能每帧整图重排，也不能等滑杆停下后一次性替换坐标；后者肉眼看到的是一次瞬移。
 * 本模块只做可测试的插值，不碰 React、Canvas 或计时器。
 *
 * @module graph-motion
 */
import type { Point } from './graph-canvas.ts'

/** 轻量力度预览每帧向 FA2 单步结果靠近的比例。 */
export const PARAM_PREVIEW_BLEND = 0.28

/** 完整布局结果从当前位置过渡到目标位置的时长。 */
export const LAYOUT_TRANSITION_MS = 280

/**
 * 力度预览的调度间隔。
 *
 * 小图每帧预览都能在几毫秒内算完；大图若仍按每个输入事件重跑 FA2，会把绘制帧挤掉，
 * 表现反而更卡。这里先按节点规模给一个下限，再用上一次的真实耗时留出至少一倍时间
 * 给画布绘制。首次预览没有耗时样本，因此只受规模下限约束。
 *
 * @param input.nodeCount - 当前图节点数。
 * @param input.elapsedMs - 上一次预览的同步计算耗时。
 * @returns 两次预览之间的最小间隔（毫秒；0 表示可逐帧）。
 */
export function forcePreviewIntervalMs(input: {
  nodeCount: number
  elapsedMs?: number
}): number {
  const count = Number.isFinite(input.nodeCount) ? Math.max(0, input.nodeCount) : 0
  const scaleGap = count > 5000 ? 120 : count > 2500 ? 80 : count > 1200 ? 48 : count > 500 ? 24 : 0
  const elapsed = Number.isFinite(input.elapsedMs) && (input.elapsedMs ?? 0) > 0 ? input.elapsedMs ?? 0 : 0
  // 计算与绘制各占一半：耗时为 x 时，下一次至少等 2x，避免连续预览吞掉整个帧预算。
  const measuredGap = Math.min(160, Math.ceil(elapsed * 2))
  return Math.max(scaleGap, measuredGap)
}

/** 一条进行中的坐标过渡。 */
export interface PositionMotion {
  start: Map<string, Point>
  target: Map<string, Point>
  startedAt: number
  durationMs: number
  skip: ReadonlySet<string>
}

/** 三次平滑：两端速度为零，避免过渡开始时突然抖动。 */
export function smoothStep(t: number): number {
  const x = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0))
  return x * x * (3 - 2 * x)
}

/**
 * 把当前坐标向一份轻量布局结果混合。
 *
 * 用于滑杆仍按住时的逐帧预览：每帧只靠近一小步，即使 FA2 的单步结果有轻微抖动，
 * 屏幕也不会跟着跳。新节点的坐标直接落在目标处，避免它们从 `(0,0)` 飞入。
 *
 * @param current - 当前坐标（就地修改）。
 * @param target - 本帧轻量布局结果。
 * @param alpha - 靠近比例，0..1。
 * @param skip - 固定节点，不参与移动。
 * @returns 实际移动过的节点数。
 */
export function blendPositions(
  current: Map<string, Point>,
  target: ReadonlyMap<string, Point>,
  alpha = PARAM_PREVIEW_BLEND,
  skip: ReadonlySet<string> = new Set(),
): number {
  const t = Math.max(0, Math.min(1, Number.isFinite(alpha) ? alpha : PARAM_PREVIEW_BLEND))
  let moved = 0
  for (const [id, next] of target) {
    if (skip.has(id)) continue
    if (!Number.isFinite(next.x) || !Number.isFinite(next.y)) continue
    const pos = current.get(id)
    if (!pos) {
      current.set(id, { x: next.x, y: next.y })
      moved++
      continue
    }
    const dx = next.x - pos.x
    const dy = next.y - pos.y
    if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) continue
    pos.x += dx * t
    pos.y += dy * t
    moved++
  }
  return moved
}

/**
 * 捕获从当前坐标到目标坐标的过渡。
 * @param current - 当前坐标。
 * @param target - 完整布局目标。
 * @param startedAt - `performance.now()` 时间戳。
 * @param durationMs - 过渡时长。
 * @param skip - 固定节点。
 * @returns 可交给 {@link stepPositionMotion} 推进的过渡。
 */
export function createPositionMotion(
  current: ReadonlyMap<string, Point>,
  target: ReadonlyMap<string, Point>,
  startedAt: number,
  durationMs = LAYOUT_TRANSITION_MS,
  skip: ReadonlySet<string> = new Set(),
): PositionMotion {
  const start = new Map<string, Point>()
  for (const id of target.keys()) {
    const pos = current.get(id)
    if (pos) start.set(id, { x: pos.x, y: pos.y })
  }
  return {
    start,
    target: new Map([...target].map(([id, pos]) => [id, { x: pos.x, y: pos.y }])),
    startedAt,
    durationMs: Number.isFinite(durationMs) && durationMs > 0 ? durationMs : LAYOUT_TRANSITION_MS,
    skip,
  }
}

/**
 * 推进一帧坐标过渡。
 * @param current - 当前坐标（就地修改）。
 * @param motion - 过渡状态。
 * @param now - `performance.now()` 时间戳。
 * @returns `done` 以及本帧最大位移（测试与诊断用）。
 */
export function stepPositionMotion(
  current: Map<string, Point>,
  motion: PositionMotion,
  now: number,
): { done: boolean; maxDelta: number } {
  const raw = (now - motion.startedAt) / motion.durationMs
  const progress = smoothStep(raw)
  const done = raw >= 1
  let maxDelta = 0
  for (const [id, target] of motion.target) {
    if (motion.skip.has(id)) continue
    const start = motion.start.get(id)
    const pos = current.get(id)
    if (!start) {
      if (pos) {
        maxDelta = Math.max(maxDelta, Math.hypot(target.x - pos.x, target.y - pos.y))
        pos.x = target.x
        pos.y = target.y
      } else {
        current.set(id, { x: target.x, y: target.y })
      }
      continue
    }
    const nextX = done ? target.x : start.x + (target.x - start.x) * progress
    const nextY = done ? target.y : start.y + (target.y - start.y) * progress
    if (!pos) {
      current.set(id, { x: nextX, y: nextY })
      continue
    }
    maxDelta = Math.max(maxDelta, Math.abs(nextX - pos.x), Math.abs(nextY - pos.y))
    pos.x = nextX
    pos.y = nextY
  }
  return { done, maxDelta }
}
