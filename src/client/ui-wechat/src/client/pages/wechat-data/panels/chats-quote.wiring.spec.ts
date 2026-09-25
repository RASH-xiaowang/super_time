/**
 * 引用行（气泡下方那行灰字）的显示守卫。
 *
 * 两条不变量的由来（都是用户截图实测出来的）：
 *
 * ① **引用行必须自己限宽，不能跟着气泡用 100%**。
 *    气泡的 `--wx-bubble-maxw` 是 100%（刻意放宽：桌面端要读大段 AI 文本），
 *    但引用行是「摘要」—— 跟着 100% 会在宽窗口下被撑爆：
 *    实测窗口 1753px 时引用行宽 **1694px**，而同一行的气泡只有 40px 宽。
 *    正确形态（参考图，窗口 413px）：引用行 366px、两行截断。
 *    ⇒ 用 `--wx-quote-maxw`（640px，与分析卡同一个阅读宽度）。
 *
 * ② **摘要最多两行、超出省略**。参考图里那条引用行高 58px
 *    （2 × 19.2 行高 + 内边距），第二行末尾带省略号 —— 早先注释写的「单行省略」是错的，
 *    而且单行 + `nowrap` 正是把行撑爆的直接原因。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (p: string): string => readFileSync(join(HERE, p), 'utf8')

const ROWS = read('chats-rows.module.css')
const MSG = read('chats.module.css')

/** 取某个 class 的声明块（只到第一个 `}`）。 */
function classBlock(css: string, name: string): string {
  const start = css.indexOf(`.${name} {`)
  expect(start, `CSS 里找不到 .${name}`).toBeGreaterThanOrEqual(0)
  return css.slice(start, css.indexOf('}', start))
}

describe('引用行显示', () => {
  it('① 引用行限宽走 --wx-quote-maxw，不得用 100%', () => {
    const strip = classBlock(MSG, 'msgQuoteStrip')
    expect(strip, '引用行要用自己的宽度令牌').toContain('max-width: var(--wx-quote-maxw)')
    expect(strip, '100% 等于整个消息区宽 —— 宽窗口下会把引用行撑到 1694px').not.toContain('max-width: 100%')
  })

  it('①-补 --wx-quote-maxw 有定义，且是「阅读宽度」量级（≤ 720px）', () => {
    const m = /--wx-quote-maxw:\s*(\d+)px/.exec(ROWS)
    expect(m, '找不到 --wx-quote-maxw 的定义').not.toBeNull()
    const v = Number(m![1])
    expect(v, '引用行宽度不该超过气泡区的阅读宽度量级').toBeLessThanOrEqual(720)
    expect(v, '太窄会把摘要挤成一两个字一行').toBeGreaterThanOrEqual(400)
  })

  it('② 摘要两行截断（-webkit-line-clamp: 2），且不能退回单行 nowrap', () => {
    const what = classBlock(ROWS, 'msgQuoteWhat')
    expect(what, '要按参考图做两行截断').toContain('-webkit-line-clamp: 2')
    expect(what, 'line-clamp 需要 -webkit-box 才生效').toContain('display: -webkit-box')
    expect(what, 'nowrap 会把行撑爆（用户截图就是这么来的）').not.toContain('nowrap')
  })

  it('③ 气泡自身的宽度规则不受影响（别为了修引用行把气泡也收窄）', () => {
    expect(ROWS, '气泡仍是 100%（刻意偏离官方 384px，为了读大段 AI 文本）').toContain('--wx-bubble-maxw: 100%')
  })
})
