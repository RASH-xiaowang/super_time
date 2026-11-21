/**
 * 自由画布布局引擎（2026-11-19，等宽瀑布流）。
 *
 * 这是整页版面的**唯一计算源**：卡片放哪儿、画布多高、拖动后吸附到哪个坐标，
 * 全在 `card-canvas-layout.ts` 这几个纯函数里。所以它必须能被单独钉死 ——
 * 画到屏幕上再"看着对不对"既不可重复，也测不到边界。
 *
 * 重点守四件事：
 *   ① **不重叠**：任意两张卡的矩形不相交（否则卡片会互相压住，内容被盖）；
 *   ② **矮卡下方被填上**：这是换掉网格的全部理由 —— 高卡旁边一张矮卡落下后，
 *      下一张必须能塞进矮卡下方，而不是等整行；
 *   ③ **等宽**：所有卡宽度一致（参考图是等宽瀑布流，参差宽度会让扫视失去左边界）；
 *   ④ **列数随容器变**：宽容器多列、窄容器一列，且都不越界。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  CANVAS_GAP,
  CANVAS_MIN_COLUMN_WIDTH,
  canvasHeight,
  packCanvas,
  snapCanvasPosition,
  type CanvasCardInput,
  type CanvasSlot,
} from './card-canvas-layout.ts'

/** 两张卡是否重叠（半开区间，贴边不算重叠）。 */
function overlaps(a: CanvasSlot, b: CanvasSlot): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

function assertNoOverlap(slots: readonly CanvasSlot[]): void {
  for (let i = 0; i < slots.length; i += 1) {
    for (let j = i + 1; j < slots.length; j += 1) {
      const a = slots[i]
      const b = slots[j]
      if (a === undefined || b === undefined) continue
      expect(overlaps(a, b), `${a.id} 与 ${b.id} 重叠了`).toBe(false)
    }
  }
}

/** 三列容器：3×300 + 2×12 = 924。 */
const THREE_COLUMNS = 924
/** 五列容器：5×300 + 4×12 = 1548。 */
const FIVE_COLUMNS = 1548

describe('packCanvas：不重叠、等宽、不越界', () => {
  it('同一组卡任意两张都不重叠', () => {
    const cards: CanvasCardInput[] = [
      { id: 'a', height: 300 },
      { id: 'b', height: 90 },
      { id: 'c', height: 120 },
      { id: 'd', height: 240 },
      { id: 'e', height: 160 },
      { id: 'f', height: 420 },
    ]
    const slots = packCanvas(cards, { containerWidth: FIVE_COLUMNS })
    expect(slots).toHaveLength(cards.length)
    assertNoOverlap(slots)
    for (const s of slots) expect(s.x + s.w).toBeLessThanOrEqual(FIVE_COLUMNS + 1)
  })

  it('所有卡宽度相同（等宽瀑布流，参考图的形态）', () => {
    const slots = packCanvas([
      { id: 'a', height: 100 },
      { id: 'b', height: 400 },
      { id: 'c', height: 220 },
    ], { containerWidth: FIVE_COLUMNS })
    const widths = new Set(slots.map(s => s.w))
    expect(widths.size, '出现了不同宽度 ⇒ 不是等宽瀑布流').toBe(1)
  })

  it('卡片顺序与入参一致（阅读顺序 = 源码顺序）', () => {
    const cards: CanvasCardInput[] = [
      { id: 'one', height: 100 },
      { id: 'two', height: 100 },
      { id: 'three', height: 100 },
    ]
    expect(packCanvas(cards, { containerWidth: THREE_COLUMNS }).map(s => s.id)).toEqual(['one', 'two', 'three'])
  })
})

describe('矮卡下方必须被后续卡填上（换掉网格的唯一理由）', () => {
  it('高卡与矮卡并排后，下一张落进矮卡下方而不是等整行', () => {
    /**
     * 限定 2 列（2×300 + 12 = 612）：没有多余的空列可去，第三张只能落到矮卡下面。
     * 列多的时候算法会把下一张放到更靠右的全空列（y=0）—— 那更紧凑，也是正确行为。
     */
    const slots = packCanvas([
      { id: 'tall', height: 400 },
      { id: 'short', height: 80 },
      { id: 'next', height: 80 },
    ], { containerWidth: 612 })
    const tall = slots.find(s => s.id === 'tall')
    const short = slots.find(s => s.id === 'short')
    const next = slots.find(s => s.id === 'next')
    expect(tall).toBeDefined()
    expect(short).toBeDefined()
    expect(next).toBeDefined()
    // 前两张各占一列且顶部齐平；第三张紧跟矮卡（差一个 gap）。
    expect(short?.y).toBe(0)
    expect(next?.y).toBe((short?.y ?? 0) + (short?.h ?? 0) + CANVAS_GAP)
    expect(next?.y ?? 0).toBeLessThan(400)
    // 第三张回到矮卡那一列，而不是去高卡下面等。
    expect(next?.x).toBe(short?.x)
    assertNoOverlap(slots)
  })
})

describe('跨列卡（世界地图）', () => {
  const THREE = 3 // 列数常量见下面的容器宽
  const threeCols = 3 * 300 + 2 * 12 // 924

  it('cols=2 的卡宽度 = 两列 + 中间一个间隙', () => {
    const slots = packCanvas(
      [{ id: 'map', cols: 2, height: 300 }, { id: 'a', height: 100 }],
      { containerWidth: threeCols },
    )
    const map = slots.find(s => s.id === 'map')
    const normal = slots.find(s => s.id === 'a')
    expect(map).toBeDefined()
    expect(normal).toBeDefined()
    // 300 * 2 + 12 = 612
    expect(map?.w).toBe(300 * 2 + 12)
    expect(normal?.w).toBe(300)
    expect(map?.w).toBe((normal?.w ?? 0) * 2 + 12)
  })

  it('跨列卡与其它卡不重叠', () => {
    const slots = packCanvas([
      { id: 'a', height: 120 },
      { id: 'map', cols: 2, height: 300 },
      { id: 'b', height: 160 },
      { id: 'c', height: 200 },
      { id: 'd', cols: 2, height: 90 },
    ], { containerWidth: threeCols })
    for (let i = 0; i < slots.length; i += 1) {
      for (let j = i + 1; j < slots.length; j += 1) {
        const a = slots[i]
        const b = slots[j]
        if (a === undefined || b === undefined) continue
        const hit = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
        expect(hit, `${a.id} 与 ${b.id} 重叠`).toBe(false)
      }
    }
  })

  it('跨列数超过容器列数时收敛到容器（窄屏不溢出）', () => {
    const slots = packCanvas(
      [{ id: 'map', cols: 5, height: 100 }],
      { containerWidth: 320 }, // 只有 1 列
    )
    // 单列时列宽会被**拉伸**到正好铺满容器（2026-11-19 起不再固定 300）。
    expect(slots[0]?.w).toBe(320)
    expect(slots[0]?.x).toBe(0)
  })

  it('跨列卡落在「这几列都空出来的最高点」，不会骑在别的卡上', () => {
    /**
     * 三列容器。第一张占第 0 列（高 400）、第二张占第 1 列（高 50）：
     * 跨两列的卡有两个候选起点 ——
     *   · start=0（第 0、1 列）：要等第 0 列，top = 412；
     *   · start=1（第 1、2 列）：第 2 列还空着，top = 62。
     * 算法取**更靠上**的后者 —— 这才是瀑布流该有的行为（不是傻等最左两列）。
     */
    const slots = packCanvas([
      { id: 'tall', height: 400 },
      { id: 'short', height: 50 },
      { id: 'wide', cols: 2, height: 80 },
    ], { containerWidth: 924 })
    const wide = slots.find(s => s.id === 'wide')
    expect(wide, 'wide 没排出来').toBeDefined()
    // 第 1 列已被 short 占到 62（50 + gap），所以它落在第 1 列起、y = 62。
    expect(wide?.y).toBe(50 + CANVAS_GAP)
    expect(wide?.x).toBe(300 + CANVAS_GAP)
    expect(wide?.w).toBe(300 * 2 + CANVAS_GAP)
    // 而且不能压到 tall（第 0 列）—— 它的 x 从第 1 列开始。
    const tall = slots.find(s => s.id === 'tall')
    expect(wide?.x).toBeGreaterThanOrEqual((tall?.x ?? 0) + (tall?.w ?? 0))
  })
})

describe('列宽拉伸铺满（不许在右侧留空白）', () => {
  /** 把任意容器宽下排出的最大右边缘算出来。 */
  function maxRight(slots: readonly CanvasSlot[]): number {
    return Math.max(...slots.map(s => s.x + s.w))
  }

  it('任意容器宽度下，卡片右边缘都正好等于容器宽（不溢出、不留白）', () => {
    for (const width of [640, 700, 760, 900, 1000, 1100, 1280, 1440, 1600, 1920, 2560]) {
      // 每张卡都矮（不触发换列影响）—— 这里只关心横向铺满。
      const slots = packCanvas(
        Array.from({ length: 12 }, (_, i) => ({ id: `c${String(i)}`, height: 100 })),
        { containerWidth: width },
      )
      // 12 张卡一定填满每一列，所以最右的下沿必然是容器右边缘。
      expect(maxRight(slots), `容器 ${String(width)}px 时右侧留了空白`)
        .toBeCloseTo(width, 1)
      // 反向：不许溢出。
      for (const s of slots) expect(s.x + s.w, `容器 ${String(width)}px 时溢出了`).toBeLessThanOrEqual(width + 0.5)
    }
  })

  it('卡片宽度落在「最小列宽 ~ 最小列宽 + 一个步长」之间（不会窄到读不了）', () => {
    for (const width of [700, 1000, 1280, 1600, 1920, 2560]) {
      const slots = packCanvas([{ id: 'a', height: 100 }], { containerWidth: width })
      const w = slots[0]?.w ?? 0
      expect(w, `容器 ${String(width)}px 时卡片宽度 ${String(w)}px 小于最小列宽`).toBeGreaterThanOrEqual(CANVAS_MIN_COLUMN_WIDTH - 0.5)
      // 上界：比最小列宽多不超过「一个最小步长」（再宽就该多排一列了）。
      expect(w, `容器 ${String(width)}px 时卡片过宽`).toBeLessThan(2 * CANVAS_MIN_COLUMN_WIDTH)
    }
  })

  it('窗口变宽时列数增加（响应式的判据是列数，不是固定列宽）', () => {
    const cards = Array.from({ length: 20 }, (_, i) => ({ id: `c${String(i)}`, height: 100 }))
    const colsAt = (width: number): number =>
      new Set(packCanvas(cards, { containerWidth: width }).map(s => s.x)).size
    expect(colsAt(700)).toBeLessThan(colsAt(1400))
    expect(colsAt(1400)).toBeLessThan(colsAt(2200))
  })
})

describe('列数随容器宽度变', () => {  it('容器很窄时退化成一列，宽度不超出容器', () => {
    const slots = packCanvas([
      { id: 'a', height: 50 },
      { id: 'b', height: 50 },
    ], { containerWidth: 320 })
    for (const s of slots) expect(s.x + s.w).toBeLessThanOrEqual(321)
    // 一列：两张卡上下相接。
    expect(slots[1]?.y).toBe(50 + CANVAS_GAP)
    assertNoOverlap(slots)
  })

  it('更宽的容器排出更多列（同高度下首列不再堆叠）', () => {
    const cards: CanvasCardInput[] = Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, height: 100 }))
    const narrow = packCanvas(cards, { containerWidth: 612 })
    const wide = packCanvas(cards, { containerWidth: FIVE_COLUMNS })
    const firstColumnCount = (slots: readonly CanvasSlot[]): number => slots.filter(s => s.x === 0).length
    expect(firstColumnCount(wide)).toBeLessThan(firstColumnCount(narrow))
  })
})

describe('canvasHeight 与吸附', () => {
  it('画布高度 = 最靠下的下沿 + 一个间隙', () => {
    const slots: CanvasSlot[] = [
      { id: 'a', x: 0, y: 0, w: 300, h: 100 },
      { id: 'b', x: 0, y: 120, w: 300, h: 50 },
    ]
    expect(canvasHeight(slots)).toBe(120 + 50 + CANVAS_GAP)
    expect(canvasHeight([])).toBe(0)
  })

  it('拖动落点吸附到列边界，y 只挡负数', () => {
    const snapped = snapCanvasPosition({ x: 310, y: -20 }, { containerWidth: FIVE_COLUMNS })
    const step = 300 + CANVAS_GAP
    expect(snapped.x % step).toBe(0)
    expect(snapped.y).toBe(0)
  })

  it('拖到最右侧也不会超出最后一列', () => {
    const snapped = snapCanvasPosition({ x: 99_999, y: 40 }, { containerWidth: FIVE_COLUMNS })
    expect(snapped.x).toBeLessThan(FIVE_COLUMNS)
  })
})
