/**
 * 本地分析渲染的接线守卫。
 *
 * 不变量的由来（都有实据）：
 *
 * ⓪ **消息流里不再挂内嵌分析卡**（2026-09-26 用户要求「移除聊天框内的分析面板」）：
 *    逐条内嵌卡曾把每条对方消息下方都铺一块六命题卡，消息流被撑得很长。移除后分析只在
 *    右栏「分析」区块里看（点消息切换）。这条钉住「别再挂回来」+「组件文件确实删了」。
 *
 * ① **答案块只有一个宿主**：`AnswerBlock` 曾与内嵌卡同住 `InlineMessageAnalysis.tsx`，
 *    内嵌卡删除后单独成 `AnalysisBlocks.tsx`（名字指向的东西必须存在）。
 *
 * ② **展开顺序先短后长**：choice 块最高（4–6 个选项），按「短命题在前、choice 在后」排
 *    才能让两列/末行配平；顺序一反就出空洞。
 *
 * ③ **选项短名必须覆盖后端全部 criteria**：`SHORT` 是前端硬编码后端 key（`laya/presets.ts`）。
 *    漏一个就回落到长文案 ——「先搜索历史聊天记录，确认对方之前说过什么」有 20 字，
 *    在选项标签这种窄版面必然截断。（命题句不走短名：完整问句更忠实。）
 *
 * ④ **内嵌卡的外壳样式必须随组件一起删**：`.wrap`/`.summary`/`.detail` 等只为卡片存在，
 *    留着就是死样式，几何守卫还会继续为它们记账。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (...p: string[]): string => readFileSync(join(HERE, ...p), 'utf8')

const TSX = read('AnalysisBlocks.tsx')
const CSS = read('analysis-blocks.module.css')
const PANEL = read('ChatAnalysisPanel.tsx')
const VIEW = read('chats-view.tsx')
/** panels → wechat-data → pages → client → src(ui-wechat) → ui-wechat → client(src) → src(项目) */
const PRESETS = read('..', '..', '..', '..', '..', '..', '..', 'backend', 'wechat-data', 'src', 'laya', 'presets.ts')

/** 取某个 class 的声明块（只到第一个 `}`，本文件的类都是扁平的）。 */
function classBlock(css: string, name: string): string {
  const start = css.indexOf(`.${name} {`)
  expect(start, `CSS 里找不到 .${name}`).toBeGreaterThanOrEqual(0)
  return css.slice(start, css.indexOf('}', start))
}

describe('本地分析 · 渲染不变量', () => {
  it('⓪ 消息流里不再挂内嵌分析卡（用户要求：聊天框内不要有分析面板）', () => {
    expect(VIEW, '内嵌卡已移除，不该再挂回消息流').not.toContain('<InlineMessageAnalysis')
    expect(existsSync(join(HERE, 'InlineMessageAnalysis.tsx')), '内嵌卡组件文件应已删除，而不是留着不挂').toBe(false)
    // 移除的是**展示位置**，不是分析能力：右栏仍要拿到选中那条的分析
    expect(VIEW, '右栏分析区仍要拿到当前选中消息的分析条目').toContain('analysisEntry={')
  })

  it('① 答案块只有一个宿主：右栏「分析」区块', () => {
    expect(PANEL, '右栏分析区块必须复用答案块').toContain("import { AnswerBlock } from './AnalysisBlocks.tsx'")
    expect(TSX, '答案块用自己的样式文件').toContain("from './analysis-blocks.module.css'")
  })

  it('② 展开顺序按「短命题在前、choice 在后」', () => {
    const at = PANEL.indexOf('const ordered')
    expect(at, '找不到排序（右栏分析区）').toBeGreaterThan(-1)
    const seg = PANEL.slice(at, at + 220)
    const shortFirst = seg.indexOf("kind !== 'choice'")
    const longSecond = seg.indexOf("kind === 'choice'")
    expect(shortFirst).toBeGreaterThan(-1)
    expect(longSecond, 'choice 必须在后（最高，排最后一行正好成对）').toBeGreaterThan(shortFirst)
  })

  it('③ 短名表覆盖后端全部 choice 选项', () => {
    const opts = [...PRESETS.matchAll(/^ {8}([a-z_]+): '/gm)].map((m) => m[1]!)
    expect(opts.length, '从 presets.ts 没解析出 criteria 选项').toBeGreaterThanOrEqual(8)
    const missing = opts.filter((o) => !TSX.includes(`\n  ${o}: '`))
    expect(missing, '这些选项没有短名，20 字的中文标签在窄版面必然截断').toEqual([])
  })

  it('④ 命题句用后端原文（三种题型都要渲染 a.question）', () => {
    // 必须盯住**每一处**：同一段 JSX 出现 3 次（noul/score/choice），
    // 只断言 toContain 的话「改掉其中一处」照样绿 —— 变异测试抓过这类假阳性。
    const hits = TSX.split('<span className={css.q}>{a.question}</span>').length - 1
    expect(hits, '三种题型的标题都要渲染 a.question').toBe(3)
    expect(TSX, 'qid 不该出现短名替换').not.toContain('short(a.qid')
    expect(TSX, 'qid 不该再进短名表').not.toContain('literal_question:')
  })

  it('⑤ 选项标签不与概率条争宽度（标签独占一行、条整行铺开）', () => {
    expect(classBlock(CSS, 'barRow')).toMatch(/flex-direction:\s*column/)
    expect(classBlock(CSS, 'barHead')).toContain('display: flex')
  })

  it('⑥ 内嵌卡的外壳样式已随组件一起删除（不留死样式）', () => {
    for (const cls of ['wrap', 'summary', 'transcript', 'detail', 'muted']) {
      expect(CSS, `.${cls} 是内嵌卡外壳样式，应随组件删掉`).not.toContain(`.${cls} {`)
    }
  })
})
