/**
 * 年度报告画布的**手动位置**存取（2026-11-19）。
 *
 * 用户拖动过的卡片位置按「年份」分别记住：2025 年摆好的版面不该被 2026 年的拖拽覆盖。
 * 存的是 `{ id: { x, y } }`，**不存尺寸** —— 尺寸由内容与宽度档决定，
 * 存下来会在内容变多时把卡片裁掉。
 *
 * 为什么走 `readRenderCache` / `writeRenderCache`：与年报数据本身同一个缓存层，
 * 换账号/换数据目录时一起失效，不需要额外引入一个存储体系。
 *
 * @module panels/card-canvas-positions
 */

/** 一张卡片的手动位置。 */
export interface CanvasPosition {
  x: number
  y: number
}

/** 一份版面的位置表。 */
export type CanvasPositions = Record<string, CanvasPosition>

/** 缓存键前缀（后缀是年份）。 */
const KEY_PREFIX = 'card-canvas-positions-v1:'

/** 位置坐标的合理上限（px）：挡住脏数据把卡片甩到画布外几万像素的地方。 */
const COORD_MAX = 50_000

/** 位置表的读取接口（由调用方注入，便于单测不打桩全局）。 */
export interface CanvasPositionStore {
  read: <T>(key: string) => T | null
  write: (key: string, value: unknown) => void
}

function keyOf(year: number, scope: string): string {
  // 按「年份 + 画布作用域」分开存：首屏与「更多年度数据」是两个独立画布，
  // 共用一个键会互相覆盖（一边拖动会把另一边的位置整份冲掉）。
  return KEY_PREFIX + String(year) + ':' + scope
}

/** 一个坐标是否可信。 */
function isPosition(v: unknown): v is CanvasPosition {
  if (typeof v !== 'object' || v === null) return false
  const p = v as { x?: unknown; y?: unknown }
  return typeof p.x === 'number' && typeof p.y === 'number'
    && Number.isFinite(p.x) && Number.isFinite(p.y)
    && p.x >= 0 && p.y >= 0 && p.x <= COORD_MAX && p.y <= COORD_MAX
}

/**
 * 读取某一年的手动位置。
 *
 * 损坏的条目**逐条丢弃**而不是整份作废：一个 id 写坏了不该让用户其它卡的摆放全丢。
 * @param store - 缓存读写实现。
 * @param year - 年份。
 * @returns 可用的位置表（没有则为空对象）。
 */
export function readCanvasPositions(store: CanvasPositionStore, year: number, scope = 'main'): CanvasPositions {
  const raw = store.read<unknown>(keyOf(year, scope))
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: CanvasPositions = {}
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isPosition(value)) out[id] = { x: value.x, y: value.y }
  }
  return out
}

/**
 * 保存某一年的手动位置。
 * @param store - 缓存读写实现。
 * @param year - 年份。
 * @param positions - 完整位置表（空对象 = 回到自动排列）。
 */
export function writeCanvasPositions(store: CanvasPositionStore, year: number, positions: CanvasPositions, scope = 'main'): void {
  const clean: CanvasPositions = {}
  for (const [id, value] of Object.entries(positions)) {
    if (isPosition(value)) clean[id] = { x: value.x, y: value.y }
  }
  store.write(keyOf(year, scope), clean)
}
