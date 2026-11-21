/**
 * 年度报告加载骨架屏的守卫（2026-11-19 随画布重写）。
 *
 * ## 这版守什么
 *
 * 首屏 8 张卡改成**自由画布**之后，骨架也必须走画布 —— 否则加载完会「从网格跳成画布」，
 * 那正是 2026-10-17 版骨架本来要消灭的「布局跳变」，只是换了个方向。
 *
 * 所以判据从「span 分布逐项一致」换成**画布口径的一致性**：
 *   · 骨架复用同一个 `CardCanvas`（不是自己再搭一套绝对定位）；
 *   · 占位卡的 `id` / `width` 与真实首屏**逐项一致** —— id 尤其重要，
 *     它是位置存储的键，不一致会让加载完成后卡片重排一遍；
 *   · `tone` 逐项一致（加载态与加载完不许闪一下换色）。
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (name: string): string => readFileSync(join(HERE, name), 'utf8')
const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const panel = stripComments(read('Annual.tsx'))
const skeleton = stripComments(read('annual-skeleton.tsx'))
const moreCards = stripComments(read('annual-more-cards.tsx'))
const styleText = read('annual.module.css')
const styleCode = styleText.replace(/\/\*[\s\S]*?\*\//g, '')

/** 首屏 8 张卡在 Annual.tsx / annual-more-cards.tsx 里的调用（带 canvasId）。 */
const MAIN_IDS = ['hero', 'rhythm', 'ranking', 'groups', 'money', 'moments', 'media', 'extremes'] as const

/** 骨架 CELLS 数组。 */
function skeletonCells(): Array<{ id: string; tone: string }> {
  const block = /const CELLS[\s\S]*?\n\]/.exec(skeleton)?.[0] ?? ''
  return [...block.matchAll(
    /\{\s*id:\s*'([\w-]+)',\s*blocks:\s*\[[^\]]*\][^}]*tone:\s*'(\w+)'\s*\}/g,
  )].map((m) => ({ id: m[1] ?? '', tone: m[2] ?? '' }))
}

/** 取某张真实卡的 tone。 */
function realToneOf(id: string): string {
  const re = new RegExp(`canvasId="${id}"[^>]*tone="(\\w+)"`)
  const m = re.exec(panel + moreCards)
  return m?.[1] ?? ''
}

describe('年度报告加载骨架屏', () => {
  it('加载态使用专用骨架屏，而不是通用列表骨架', () => {
    expect(panel, '年度报告的加载态应使用 CardCanvasSkeleton').toContain('<CardCanvasSkeleton')
    expect(panel, '不许退回通用 ListSkeleton').not.toContain('<ListSkeleton')
  })

  it('骨架复用 CardCanvas + CanvasCard（与真实布局同一套机制）', () => {
    expect(skeleton, '骨架必须复用 CardCanvas').toContain('<CardCanvas')
    expect(skeleton, '骨架必须用 CanvasCard 占位').toContain('<CanvasCard')
    // 反例：不许自己再搭一套绝对定位/网格。
    expect(skeleton, '骨架又自己搭网格了').not.toContain('className={css.board}')
  })

  it('占位卡的 id 与首屏 8 张卡逐项一致（顺序也要一致）', () => {
    const cells = skeletonCells()
    expect(cells.length, '骨架格子数量应为 8（页脚已不在画布里）').toBe(8)
    expect(cells.map(c => c.id), '骨架的 id/顺序应与首屏一致').toEqual([...MAIN_IDS])
  })

  it('等宽瀑布流：两边都不声明宽度档（宽度由容器统一给）', () => {
    expect(skeleton, '骨架还在声明 width 档').not.toMatch(/width:\s*'/)
    expect(panel + moreCards, '卡片还在声明 width 档').not.toMatch(/canvasId="[\w-]+"\s+width="/)
  })

  it('tone 与真实卡片逐项一致（加载态与加载完不许"闪一下换色"）', () => {
    const cells = skeletonCells()
    for (const cell of cells) {
      const real = realToneOf(cell.id)
      expect(real, `找不到真实卡片 ${cell.id} 的 tone`).not.toBe('')
      expect(cell.tone, `${cell.id} 的 tone 与真实卡不一致`).toBe(real)
    }
  })

  it('骨架对读屏软件隐藏（占位内容没有语义）', () => {
    expect(skeleton, '骨架屏应 aria-hidden').toContain('aria-hidden="true"')
  })

  it('骨架样式存在，且**不再有呼吸动画**（2026-10-17 用户要求）', () => {
    /**
     * 2026-11-19：画布类（`.canvasCard` / `.canvasHandle` / `.skelHost`）已迁到
     * `card-canvas.module.css`（M21 文件行数棘轮），所以两处都要查。
     */
    const canvasCss = read('card-canvas.module.css')
    const all = styleCode + canvasCss
    for (const cls of ['.skelHost', '.skelBlock', '.canvasCard', '.canvasHandle']) {
      expect(all, `缺少样式 ${cls}`).toContain(`${cls}`)
    }
    expect(styleCode, '骨架不许再有呼吸动画').not.toContain('@keyframes annualSkeletonPulse')
    expect(all, '骨架不许再挂 animation').not.toMatch(/\.skel(Card|Host)\s*\{[^}]*animation:/)
    // 占位卡不该出现拖拽手柄。
    expect(canvasCss, '骨架应隐藏拖拽手柄').toMatch(/\.skelHost \.canvasHandle \{\s*display:\s*none/)
  })

  it('骨架不再声明行数（高度由内容/占位块决定）', () => {
    expect(skeleton, '骨架里还有 rows={N}').not.toMatch(/rows=\{\d+\}/)
    expect(panel, 'Annual.tsx 里还有 rows={N}').not.toMatch(/rows=\{\d+\}/)
  })
})
