/**
 * 「画布上的卡片永不相互遮挡」—— 这条不变式的规格测试（2026-11-19）。
 *
 * ## 为什么单独一个文件
 *
 * 这条不变式有**四个独立入口**，任何一个漏掉都会让用户看到卡片压在一起：
 *   ① 拖拽落点只吸附列、y 自由（旧实现「刻意不避让」）；
 *   ② 手动版式建立后自动排版退出，**内容变高**就压住下方；
 *   ③ 新出现的卡（条件渲染）拿的是无视手动位置的自动槽位；
 *   ④ 窗口变窄、列数变少，旧的像素 x 与新列宽错位。
 *
 * 所以实现没有在四处分别判重，而是让**每次排版都过一遍 `settleCanvas`**。
 * 这个文件就针对那一条出口做穷举 + 随机化验证 —— 只要它成立，四个入口同时被堵住。
 *
 * ## 为什么用固定种子的伪随机
 *
 * 纯手写用例只能覆盖我想得到的组合；而遮挡最容易出现在「高度差很大 + 跨列 + 窄容器」
 * 这类边角。用固定种子跑几百组随机版面，既能扫到边角，又不会因为随机性导致偶发红
 * （失败可复现：种子是常量，报错会打出当前 `seed`）。
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  CANVAS_GAP,
  clampCanvasX,
  packCanvas,
  settleCanvas,
  type CanvasSlot,
} from './card-canvas-layout.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (f: string): string => readFileSync(join(HERE, f), 'utf8')

/** 两张卡是否真的压在一起（间距**小于** `gap` 才算；正好等于 `gap` 是合法紧邻）。 */
function overlaps(a: CanvasSlot, b: CanvasSlot, gap = CANVAS_GAP): boolean {
  return a.x < b.x + b.w + gap
    && b.x < a.x + a.w + gap
    && a.y < b.y + b.h + gap
    && b.y < a.y + a.h + gap
}

/** 断言一整组版面里任意两张都不重叠。 */
function expectNoOverlap(slots: readonly CanvasSlot[], where: string): void {
  for (let i = 0; i < slots.length; i += 1) {
    for (let j = i + 1; j < slots.length; j += 1) {
      const a = slots[i]!
      const b = slots[j]!
      expect(overlaps(a, b), `${where}：${a.id} 与 ${b.id} 重叠`).toBe(false)
    }
  }
}

/** 固定种子的线性同余发生器（可复现，不依赖 Math.random）。 */
function rng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

describe('settleCanvas：压实之后一定无重叠', () => {
  it('已经无重叠的版面原样保留（幂等 —— 不会每次渲染都往下漂）', () => {
    const packed = packCanvas([
      { id: 'a', height: 300 },
      { id: 'b', height: 120 },
      { id: 'c', height: 500 },
      { id: 'd', height: 90 },
    ], { containerWidth: 1280 })
    const settled = settleCanvas(packed)
    expect(settled).toEqual(packed)
    // 再跑一遍仍然一样。
    expect(settleCanvas(settled)).toEqual(settled)
  })

  it('拖到别人身上：被拖的那张被让到下沿之外，两张都还在', () => {
    // a 占 0..200，b 原本在下面；把 b 拖到 a 的头上。
    const desired: CanvasSlot[] = [
      { id: 'a', x: 0, y: 0, w: 400, h: 200 },
      { id: 'b', x: 0, y: 212, w: 400, h: 150 },
    ]
    const settled = settleCanvas(desired)
    expectNoOverlap(settled, '拖拽落到别人身上')
    const b = settled.find(s => s.id === 'b')!
    expect(b.y).toBeGreaterThanOrEqual(200 + CANVAS_GAP)
  })

  it('拖到别人身上且 y 相同：按阅读顺序决定谁先占位，仍然无重叠', () => {
    const settled = settleCanvas([
      { id: 'a', x: 0, y: 0, w: 400, h: 240 },
      { id: 'b', x: 0, y: 0, w: 400, h: 100 },
    ])
    expectNoOverlap(settled, '同 y 相撞')
    const ys = settled.map(s => s.y).sort((p, q) => p - q)
    expect(ys[1]! - ys[0]!).toBeGreaterThanOrEqual(240 + CANVAS_GAP)
  })

  it('内容变高会**推下去**而不是压上去（手动版式不自愈的旧病）', () => {
    // 拖拽固化成：a 在 0、b 在 212。随后 a 的数据刷新，高度从 200 变成 400。
    const afterGrow: CanvasSlot[] = [
      { id: 'a', x: 0, y: 0, w: 400, h: 400 },
      { id: 'b', x: 0, y: 212, w: 400, h: 150 },
    ]
    const settled = settleCanvas(afterGrow)
    expectNoOverlap(settled, '内容变高')
    expect(settled.find(s => s.id === 'b')!.y).toBeGreaterThanOrEqual(400 + CANVAS_GAP)
  })

  it('新卡插到中间也不会压住人', () => {
    const settled = settleCanvas([
      { id: 'a', x: 0, y: 0, w: 400, h: 200 },
      { id: 'new', x: 0, y: 100, w: 400, h: 200 },  // 条件渲染出来的、拿了错误的槽位
      { id: 'b', x: 0, y: 212, w: 400, h: 100 },
    ])
    expectNoOverlap(settled, '新卡插队')
    expect(settled).toHaveLength(3)
  })

  it('跨列卡压住两列时，两列的下方卡都要让位', () => {
    const settled = settleCanvas([
      { id: 'left', x: 0, y: 0, w: 400, h: 300 },
      { id: 'right', x: 412, y: 0, w: 400, h: 500 },
      { id: 'wide', x: 0, y: 100, w: 812, h: 200 },
    ])
    expectNoOverlap(settled, '跨列压住两列')
    const wide = settled.find(s => s.id === 'wide')!
    // 它必须落在两列**较低**那个的下沿之下。
    expect(wide.y).toBeGreaterThanOrEqual(500 + CANVAS_GAP)
  })

  it('不修改入参（纯函数，可安全用于 useMemo）', () => {
    const input: CanvasSlot[] = [
      { id: 'a', x: 0, y: 0, w: 100, h: 100 },
      { id: 'b', x: 0, y: 20, w: 100, h: 100 },
    ]
    const snapshot = JSON.stringify(input)
    settleCanvas(input)
    expect(JSON.stringify(input)).toBe(snapshot)
  })

  it('随机化：几百组「任意高度 + 任意跨列 + 任意落点」都不重叠', () => {
    for (let seed = 1; seed <= 120; seed += 1) {
      const rand = rng(seed)
      const containerWidth = 320 + Math.floor(rand() * 1_600)
      const count = 2 + Math.floor(rand() * 9)
      // 先用自动排版得到一组合法宽度（x/w 与列网格一致）。
      const packed = packCanvas(
        Array.from({ length: count }, (_unused, i) => ({
          id: `c${String(i)}`,
          height: 60 + Math.floor(rand() * 900),
          cols: rand() < 0.25 ? 2 : 1,
        })),
        { containerWidth },
      )
      // 再给每张卡一个随机的期望位置（模拟用户乱拖）。
      const desired = packed.map((slot) => {
        const maxY = 1_500
        return { ...slot, y: Math.floor(rand() * maxY) }
      })
      const settled = settleCanvas(desired)
      expectNoOverlap(settled, `随机版面 seed=${String(seed)} width=${String(containerWidth)}`)
      // 张数不能丢。
      expect(settled.map(s => s.id)).toEqual(packed.map(s => s.id))
    }
  })

  it('随机化：反复压实不会持续下移（幂等，避免越滚越远）', () => {
    for (let seed = 200; seed <= 240; seed += 1) {
      const rand = rng(seed)
      const packed = packCanvas(
        Array.from({ length: 5 }, (_unused, i) => ({ id: `c${String(i)}`, height: 80 + Math.floor(rand() * 400) })),
        { containerWidth: 900 },
      )
      const desired = packed.map(slot => ({ ...slot, y: Math.floor(rand() * 600) }))
      const once = settleCanvas(desired)
      const twice = settleCanvas(once)
      expect(twice, `seed=${String(seed)} 第二次压实改变了版面`).toEqual(once)
    }
  })
})

describe('clampCanvasX：旧版面的像素 x 不能把卡挤出右边界', () => {
  it('窗口从 5 列缩到 2 列：旧的 x 被收回合法列', () => {
    // 5 列（约 1600px）时第三列的 x ≈ 644；缩到 700px 两列。
    const options = { containerWidth: 700 }
    const x = clampCanvasX(644, 1, options)
    expect(x).toBeGreaterThanOrEqual(0)
    expect(x).toBeLessThan(700)
  })

  it('跨列卡不会被吸到最后一列（否则右边缘溢出一个 step）', () => {
    const options = { containerWidth: 924 }
    // 3 列：最后一列起点 = 2*step。2 列宽的卡起点最右只能到第 1 列之后。
    const x = clampCanvasX(99_999, 2, options)
    const packed = packCanvas([{ id: 'wide', height: 100, cols: 2 }], options)[0]!
    expect(x + packed.w).toBeLessThanOrEqual(924)
  })

  it('负数与 0 都收成 0', () => {
    expect(clampCanvasX(-500, 1, { containerWidth: 900 })).toBe(0)
    expect(clampCanvasX(0, 1, { containerWidth: 900 })).toBe(0)
  })

  it('跨列数超过容器列数时按容器收敛（窄屏不溢出）', () => {
    // 320px 只放得下 1 列，cols=2 应退化为整行、x=0。
    const x = clampCanvasX(400, 2, { containerWidth: 320 })
    const packed = packCanvas([{ id: 'wide', height: 100, cols: 2 }], { containerWidth: 320 })[0]!
    expect(x).toBe(0)
    expect(x + packed.w).toBeLessThanOrEqual(320)
  })
})

describe('真实面板的完整卡片集合：任何宽度下都不重叠', () => {
  /**
   * 各面板的卡（id + 代表性高度 + 跨列）。
   * 高度取实测量级：朋友圈地图 420、词云 320、体检损坏卡可能上千等。
   */
  const PANELS: ReadonlyArray<{
    name: string
    cards: ReadonlyArray<{ id: string; height: number; cols?: number }>
    /** 模拟「用户把某张卡拖到任意位置」的额外场景。 */
    drag?: string
  }> = [
    {
      name: '数据健康（损坏卡极高）',
      cards: [
        { id: 'health-stores', height: 140 },
        { id: 'health-corrupted', height: 1_080 },
        { id: 'health-unreadable', height: 320 },
        { id: 'health-failures', height: 260 },
        { id: 'health-status', height: 96 },
      ],
      drag: 'health-status',
    },
    {
      name: '收藏表情统计',
      cards: [
        { id: 'asset-types', height: 320 },
        { id: 'asset-years', height: 280 },
      ],
      drag: 'asset-years',
    },
    {
      name: '数据边界与出网',
      cards: [
        { id: 'trust-boundary', height: 340 },
        { id: 'trust-guard', height: 120 },
        { id: 'trust-local', height: 210 },
        { id: 'trust-ai', height: 180 },
        { id: 'trust-audit', height: 300 },
        { id: 'trust-scan', height: 90 },
      ],
      drag: 'trust-scan',
    },
    {
      name: '朋友圈洞察（词云/地图跨两列）',
      cards: [
        { id: 'moments-liked', height: 200 },
        { id: 'moments-commented', height: 200 },
        { id: 'moments-words', height: 400, cols: 2 },
        { id: 'moments-monthly', height: 320 },
        { id: 'moments-map', height: 480, cols: 2 },
        { id: 'moments-places', height: 200 },
      ],
      drag: 'moments-places',
    },
    {
      name: '数据总览（世界地图跨两列）',
      cards: [
        { id: 'ov-hero', height: 180 },
        { id: 'ov-worldmap', height: 420, cols: 2 },
        { id: 'ov-trend', height: 300 },
        { id: 'ov-heat', height: 300 },
        { id: 'ov-relation', height: 240 },
        { id: 'ov-topchats', height: 240 },
        { id: 'ov-wordcloud', height: 320 },
        { id: 'ov-region-prov', height: 260 },
      ],
      drag: 'ov-relation',
    },
  ]

  for (const panel of PANELS) {
    for (const containerWidth of [320, 520, 700, 924, 1_100, 1_280, 1_920]) {
      it(`${panel.name} @ ${String(containerWidth)}px：自动排版与拖动后都不重叠`, () => {
        const packed = packCanvas(panel.cards, { containerWidth })
        expectNoOverlap(packed, `${panel.name} 自动排版`)

        // 自动版面的右边界不能溢出容器。
        for (const slot of packed) {
          expect(slot.x + slot.w, `${slot.id} 右溢出`).toBeLessThanOrEqual(containerWidth + 0.5)
        }

        if (panel.drag === undefined) return
        // 模拟把某张卡拖到「可能压住任何人的任意位置」，再压实。
        for (const fraction of [0, 0.15, 0.4, 0.75, 1]) {
          const dragged = packed.find(s => s.id === panel.drag)
          if (dragged === undefined) continue
          const maxY = Math.ceil(Math.max(...packed.map(s => s.y + s.h)))
          const desired = packed.map(slot => (
            slot.id === panel.drag
              ? {
                ...slot,
                x: clampCanvasX(containerWidth * fraction, 1, { containerWidth }),
                y: Math.round(maxY * fraction),
              }
              : slot
          ))
          const settled = settleCanvas(desired)
          expectNoOverlap(settled, `${panel.name} 拖动 fraction=${String(fraction)}`)
          for (const slot of settled) {
            expect(slot.x + slot.w, `${slot.id} 拖动后右溢出`).toBeLessThanOrEqual(containerWidth + 0.5)
          }
        }
      })
    }
  }
})

describe('接线：画布真的用上了压实（否则上面全是空转）', () => {
  const canvas = read('card-canvas.tsx')
  const card = read('card-canvas-card.tsx')
  const canvasCss = read('card-canvas.module.css')
  const strip = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

  /**
   * 从源码里截出某个 `const X = useMemo(` 的整块，供"这一块里必须有/必须没有某调用"的断言用。
   *
   * 为什么不能全文件 grep：`settleCanvas(desired` 在 `placed` 与拖拽处理器里各出现一次，
   * 全文件匹配会在删掉 `placed` 那一处后**仍然通过**（变异验证时实测过）。
   */
  const block = (src: string, startMarker: string): string => {
    const at = src.indexOf(startMarker)
    if (at < 0) return ''
    const end = src.indexOf('\n  }, [', at)
    return end < 0 ? src.slice(at) : src.slice(at, end)
  }

  it('`placed` 里对整份版面跑 settleCanvas（不是别处的偶然调用）', () => {
    const code = strip(canvas)
    expect(code, 'CardCanvas 没导入 settleCanvas').toMatch(/import\s*\{[^}]*settleCanvas/)
    const placed = block(code, 'const placed = useMemo(')
    expect(placed, '找不到 placed 的 useMemo 块').not.toBe('')
    expect(placed, 'placed 没有跑压实').toContain('settleCanvas(desired')
    // 压实的输出必须是 placed 的返回值 —— 算了却不用等于没算。
    expect(placed, 'placed 没用压实的结果').toMatch(/new Map\(settled/)
  })

  it('落点用 clampCanvasX（考虑跨列），而不是只管 x 的旧吸附', () => {
    const code = strip(canvas)
    expect(code, '落点没考虑跨列数').toMatch(/clampCanvasX\(\s*d\.originX \+ d\.dx/)
  })

  it('拖动结束**存进位置表的是压实后的版面**，不是原始落点', () => {
    const code = strip(canvas)
    // `for (const slot of settleCanvas(desired, CANVAS_GAP)) next[slot.id] = ...`
    expect(code, '存盘前没压实').toMatch(/settleCanvas\(desired, CANVAS_GAP\)\)\s*next\[/)
  })

  it('布局没算出来时卡片是隐藏的，不会静止叠在 0,0', () => {
    const code = strip(card)
    expect(code).toContain("visibility: 'hidden'")
  })

  it('卡片位置**没有** left/top 过渡（重排时不会从邻居身上穿过去）', () => {
    const css = strip(canvasCss)
    expect(css, 'canvasCard 又加了 left/top 过渡，重排时会瞬时遮挡').not.toMatch(/transition:\s*left/)
  })

  it('开发期会报出重复 canvasId 与漏用外壳的元素', () => {
    const code = strip(canvas)
    expect(code).toContain('warnCanvasMisuse')
    expect(code).toContain('重复的 canvasId')
  })
})
