/**
 * 文本气泡宽度上界的守卫。
 *
 * 起因（2026-09-26 用户截图）：一条长文本气泡宽 1082px、几乎横跨整个消息区，
 * 同行的头像被挤到容器内容区之外。逐像素量过之后，根因是 `--wx-bubble-maxw: 100%`：
 *
 *   ① **百分比相对整行（`.msgRow`）解析，没扣掉同行占位的头像与间隙**：
 *      一行 = 头像 34 + 间隙 10 + 气泡列，所以「气泡 + 头像」天然超出容器 44px。
 *      而 `.avatar` 是 `flex-shrink: 0`（压不动）⇒ 被挤出去的是头像：
 *      实测气泡右边缘 x1099，头像落在 x1108–1139，而内容区右边缘只有 x1137。
 *   ② **没有任何绝对上限**：窗口越宽气泡越宽（1082px 在 14px 字号下约 77 字/行）。
 *
 * **2026-09-26 第二次（用户第二次截图）：气泡被压成一列一个字。**
 * 修上面那条时，我把 `min(640px, calc(100% − 44px))` 同时写到了 `.msgCol` 与 `.msgBubble`。
 * 而 `.msgBubble` 的包含块是 `.msgCol`，`.msgCol` 又是 flex 子项、宽度由内容撑开
 * ⇒ 子元素上的百分比成了**循环百分比**：第一趟按 0 算，`calc(0 − 44)` 夹成 0，
 * 气泡只剩左右 padding（逐像素量：2 字消息气泡 **24px**、8 字 **93px**、其余 79/27/25px，
 * 全是 2~5 字/行）；第二趟再按这个窄列重算百分比。
 * 旧值裸 `100%` 没塌，是因为裸百分比在循环场景按规范当 `none` 处理；写成 `calc()` 之后
 * Chromium 就把它算成 0 而不是忽略 —— 这就是那次回归的**确切来源**。
 *
 * 三条不变量：
 *   A. 上界必须**同时**含绝对阅读宽度与「容器宽 − 头像 − 间隙」（缺任一条就复现第一次截图）；
 *   B. 那条 44px 的扣减有前提 —— 头像不参与收缩，否则前提不成立、扣多少都不对；
 *   C. 含百分比的上界**只准挂在 `.msgCol`**（相对 `.msgRow`，行宽由虚拟行的 `width:100%`
 *      定死）—— 子元素一律不写，否则就是上面那条循环百分比（复现第二次截图）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (p: string): string => readFileSync(join(HERE, p), 'utf8')

const ROWS = read('chats-rows.module.css')
const MSG = read('chats.module.css')

/** 取某个 class 的声明块（只到第一个 `}`，本文件的类都是扁平的）。 */
function classBlock(css: string, name: string): string {
  const start = css.indexOf(`.${name} {`)
  expect(start, `CSS 里找不到 .${name}`).toBeGreaterThanOrEqual(0)
  return css.slice(start, css.indexOf('}', start))
}

/**
 * 剥掉 CSS 块注释再断言。
 *
 * 必须剥：解释「为什么不写某条声明」的注释里会**原样出现那条声明的片段**
 * （`max-width`、`--wx-bubble-maxw`、`100%` 都会出现），直接把整块拿去匹配等于拿注释当实现。
 * 项目里同类假阳性已出现三次（见 MEMORY 的 gate 纪律），所以这里显式剥。
 */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '')
}

describe('消息气泡 · 宽度上界', () => {
  it('① 上界同时含「容器扣减」与「绝对阅读宽度」（缺一条就复现横跨消息区）', () => {
    const m = /--wx-bubble-maxw:\s*([^;]+);/.exec(ROWS)
    expect(m, '找不到 --wx-bubble-maxw 的定义').not.toBeNull()
    const value = m![1]!
    expect(value, '没有容器扣减：长文本时「气泡 + 头像」会超出容器 44px，头像被挤出去')
      .toContain('100% - var(--wx-avatar) - var(--wx-gap)')
    expect(value, '没有绝对上限：窗口越宽气泡越宽，一行能排 70+ 字').toMatch(/var\(--wx-read-maxw\)/)
    expect(value.trim(), '退成裸 100% 就是旧行为（实测气泡 1082px）').not.toBe('100%')
  })

  it('② 阅读宽度在可读量级，且引用摘要与气泡同源（别各写一个数）', () => {
    const m = /--wx-read-maxw:\s*(\d+)px/.exec(ROWS)
    expect(m, '找不到 --wx-read-maxw 的定义').not.toBeNull()
    const v = Number(m![1])
    expect(v, '一行超过约 45 字（≈640px @14px）读起来吃力').toBeLessThanOrEqual(720)
    expect(v, '太窄会把长句挤成碎行').toBeGreaterThanOrEqual(400)
    expect(ROWS, '引用摘要要引用同一个阅读宽度令牌').toContain('--wx-quote-maxw: var(--wx-read-maxw)')
  })

  it('③ .msgCol 必须 min-width: 0（否则 max-width 管不住长 URL）', () => {
    // flex 子项的默认 min-width 是 auto（不窄于内容）——长 URL / 连续英文没有断点，
    // 会把这一列顶破到超过 max-width。置 0 才让上界真正说了算。
    expect(classBlock(MSG, 'msgCol'), '缺 min-width: 0，上界会被内容顶破').toContain('min-width: 0')
  })

  it('④ 扣 44px 的前提：头像不参与收缩', () => {
    expect(classBlock(ROWS, 'avatar'), '头像一旦可收缩，扣减的假设就不成立（改成压头像而不是限气泡）')
      .toContain('flex-shrink: 0')
  })

  it('⑤ 含百分比的上界只准挂 .msgCol（挂到 .msgBubble 上会塌成 0 宽）', () => {
    // .msgBubble 的包含块是 .msgCol，而 .msgCol 的宽度由内容撑开 ⇒ 子元素上的百分比是
    // 循环百分比：第一趟按 0 算 → max-width 被夹成 0 → 气泡只剩左右 padding（实测 24px，
    // 文字一列一个字）。守卫同时钉住「谁不许挂」与「谁必须挂」——只在一边删干净也算漏。
    const bubble = stripComments(classBlock(MSG, 'msgBubble'))
    expect(bubble, '气泡自己不许带宽度上界：它的父容器是内容撑开的，百分比会塌成 0')
      .not.toMatch(/(^|\{|;)\s*(max-)?width\s*:/)
    // 只禁字面 % 不够：`var(--wx-bubble-maxw)` 一样会塌（这令牌的展开式里就有百分比）。
    // 变异测试实录：第一版只查字面 %，把上界以 var() 形态加回来照样绿。
    expect(bubble, '也不许引用那个含百分比的令牌 —— 效果与直接写一模一样')
      .not.toContain('--wx-bubble-maxw')
    expect(stripComments(classBlock(MSG, 'msgCol')), '上界必须留在 .msgCol（相对 .msgRow，行宽确定）')
      .toContain('max-width: var(--wx-bubble-maxw)')
  })
})
