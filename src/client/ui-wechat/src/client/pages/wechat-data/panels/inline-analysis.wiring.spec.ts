/**
 * 逐条内嵌分析的接线守卫。
 *
 * 三条不变量的由来（都有实据，不是想当然）：
 *
 * ① **卡片必须限宽**：首版 `.wrap` 只有 margin 没有 max-width，而它挂在虚拟行里
 *    （宽度 = 整个消息滚动容器），于是卡片横跨消息区（实测 1000px+），
 *    `minmax(0, 1fr)` 的概率条被拉到 ~800px、右侧留一大片空白 —— 这是用户报的回归点。
 *    同时必须与气泡列对齐（左边缘 = 头像 + 间隙），否则它看起来像另一层容器。
 *
 * ② **短名表必须覆盖后端全部命题与选项**：`SHORT` 是前端硬编码后端 key（`laya/presets.ts`）。
 *    漏一个就回落到长文案 —— 「先搜索历史聊天记录，确认对方之前说过什么」有 20 字，
 *    在窄块里必然截断，等于把首版那个毛病又请回来。
 *
 * ③ **展开区必须先短后长**：两列网格里 choice 块最高（4–6 个选项），
 *    按「短命题在前、choice 在后」排才能让最后一行成对；顺序一反就出现 ~90px 的空洞。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (...p: string[]): string => readFileSync(join(HERE, ...p), 'utf8')

const TSX = read('InlineMessageAnalysis.tsx')
const CSS = read('inline-analysis.module.css')
/** panels → wechat-data → pages → client → src(ui-wechat) → ui-wechat → client(src) → src(项目) */
const PRESETS = read('..', '..', '..', '..', '..', '..', '..', 'backend', 'wechat-data', 'src', 'laya', 'presets.ts')

/** 取某个 class 的声明块（只到第一个 `}`，本文件的类都是扁平的）。 */
function classBlock(css: string, name: string): string {
  const start = css.indexOf(`.${name} {`)
  expect(start, `CSS 里找不到 .${name}`).toBeGreaterThanOrEqual(0)
  return css.slice(start, css.indexOf('}', start))
}

describe('逐条分析 · 布局不变量', () => {
  it('① 卡片限宽，且左边缘与气泡列对齐（头像 + 间隙）', () => {
    const wrap = classBlock(CSS, 'wrap')
    expect(wrap, '没有 max-width 就会横跨整个消息区（用户报的回归点）').toMatch(/max-width:\s*\d+px/)
    expect(wrap, '左边缘要与气泡对齐，不能再靠固定 margin 猜').toContain('var(--wx-avatar')
    expect(wrap, '头像与间隙之间必须带 --wx-gap').toContain('var(--wx-gap')
  })

  it('①-补 展开区是自适应多列（单列会把列表拉得过高）', () => {
    expect(classBlock(CSS, 'detail')).toMatch(/grid-template-columns:\s*repeat\(auto-fit, minmax\(/)
  })

  it('② 短名表覆盖后端全部命题 qid', () => {
    const qids = [...PRESETS.matchAll(/^ {4}([a-z_]+): \{/gm)].map((m) => m[1]!)
    expect(qids.length, '从 presets.ts 没解析出命题，正则或缩进变了').toBeGreaterThanOrEqual(6)
    const missing = qids.filter((q) => !TSX.includes(`\n  ${q}: '`))
    expect(missing, '这些命题没有短名，窄块里会回落到长命题句').toEqual([])
  })

  it('②-补 短名表覆盖后端全部 choice 选项', () => {
    const opts = [...PRESETS.matchAll(/^ {8}([a-z_]+): '/gm)].map((m) => m[1]!)
    expect(opts.length, '从 presets.ts 没解析出 criteria 选项').toBeGreaterThanOrEqual(8)
    const missing = opts.filter((o) => !TSX.includes(`\n  ${o}: '`))
    expect(missing, '这些选项没有短名，20 字的中文标签在窄块里必然截断').toEqual([])
  })

  it('③ 展开区按「短命题在前、choice 在后」排序（两列才配得平）', () => {
    const at = TSX.indexOf('const ordered = [')
    expect(at).toBeGreaterThan(-1)
    const seg = TSX.slice(at, at + 220)
    const shortFirst = seg.indexOf("kind !== 'choice'")
    const longSecond = seg.indexOf("kind === 'choice'")
    expect(shortFirst).toBeGreaterThan(-1)
    expect(longSecond, 'choice 必须在后（最高，排最后一行正好成对）').toBeGreaterThan(shortFirst)
  })

  it('④ 选项标签不与概率条争宽度（标签独占一行、条整行铺开）', () => {
    expect(classBlock(CSS, 'barRow')).toMatch(/flex-direction:\s*column/)
    const head = classBlock(CSS, 'barHead')
    expect(head).toContain('display: flex')
  })
})
