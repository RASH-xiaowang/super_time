/**
 * 逐条内嵌分析的接线守卫。
 *
 * 四条不变量的由来（都有实据，不是想当然）：
 *
 * ① **卡片必须限宽，且与气泡「头」对齐**：
 *    - 首版 `.wrap` 只有 margin 没有 max-width，而它挂在虚拟行里
 *      （宽度 = 整个消息滚动容器），于是卡片横跨消息区（实测 1000px+），
 *      `minmax(0, 1fr)` 的概率条被拉到 ~800px、右侧留一大片空白 —— 用户报的回归点。
 *    - 对齐要求：左边缘 = 头像 + 间隙；**padding-left 与气泡一致（12px）**，
 *      这样文字起点与气泡文字起点严格齐平。所以**不能有左侧边框**（会推偏 2px）。
 *
 * ② **默认展开**：用户明确要求「每条消息下都直接看得到全部分析」（参考图里也是全展开）。
 *
 * ③ **展开区必须先短后长**：两列网格里 choice 块最高（4–6 个选项），
 *    按「短命题在前、choice 在后」排才能让最后一行成对；顺序一反就出现 ~90px 的空洞。
 *
 * ④ **选项短名必须覆盖后端全部 criteria**：`SHORT` 是前端硬编码后端 key（`laya/presets.ts`）。
 *    漏一个就回落到长文案 —— 「先搜索历史聊天记录，确认对方之前说过什么」有 20 字，
 *    在窄版面（摘要行 / 选项标签）必然截断。
 *    （命题句不再走短名：两列块每列 300px 放得下完整问句，用后端原文更忠实。）
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
  it('① 限宽 + 与气泡头对齐（同样的 padding，且不得有左边框）', () => {
    const wrap = classBlock(CSS, 'wrap')
    expect(wrap, '没有 max-width 就会横跨整个消息区（用户报的回归点）').toMatch(/max-width:\s*\d+px/)
    expect(wrap, '左边缘要与气泡头对齐：头像 + 间隙').toContain('var(--wx-avatar')
    expect(wrap, '要带 --wx-gap').toContain('var(--wx-gap')
    const pad = /padding:\s*([^;]+);/.exec(wrap)?.[1] ?? ''
    expect(pad, 'padding-left 必须与气泡同为 12px（--nm-s-3），字头才会与气泡对齐').toContain('var(--nm-s-3)')
    expect(wrap, '左侧边框会把文字推偏 2px，破坏与气泡文字的字头对齐').not.toContain('border-left')
  })

  it('①-补 展开区是自适应多列（单列会把列表拉得过高）', () => {
    expect(classBlock(CSS, 'detail')).toMatch(/grid-template-columns:\s*repeat\(auto-fit, minmax\(/)
  })

  it('② 分析默认展开', () => {
    expect(TSX, '用户要求每条消息下直接看到全部分析').toContain('const [open, setOpen] = useState(true)')
    expect(TSX, '收起后要能再展开').toContain("open ? '收起' : '展开'")
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

  it('④ 短名表覆盖后端全部 choice 选项', () => {
    const opts = [...PRESETS.matchAll(/^ {8}([a-z_]+): '/gm)].map((m) => m[1]!)
    expect(opts.length, '从 presets.ts 没解析出 criteria 选项').toBeGreaterThanOrEqual(8)
    const missing = opts.filter((o) => !TSX.includes(`\n  ${o}: '`))
    expect(missing, '这些选项没有短名，20 字的中文标签在窄版面必然截断').toEqual([])
  })

  it('⑤ 命题句用后端原文（不再做短名替换）', () => {
    // 断言必须盯住**每一处**：同一段 JSX 在文件里出现 3 次（noul/score/choice），
    // 只断言 toContain 的话「改掉其中一处」照样绿 —— 变异测试就是这样抓出这个假阳性的。
    const hits = TSX.split('<span className={css.q}>{a.question}</span>').length - 1
    expect(hits, '三种题型的标题都要渲染 a.question').toBe(3)
    expect(TSX, 'qid 不该出现短名替换').not.toContain('short(a.qid')
    expect(TSX, 'qid 不该再进短名表').not.toContain('literal_question:')
  })

  it('⑥ 选项标签不与概率条争宽度（标签独占一行、条整行铺开）', () => {
    expect(classBlock(CSS, 'barRow')).toMatch(/flex-direction:\s*column/)
    expect(classBlock(CSS, 'barHead')).toContain('display: flex')
  })
})
