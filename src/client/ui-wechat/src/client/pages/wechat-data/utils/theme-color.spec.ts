/**
 * `readableOn` 的边界（H11 第五档补的账）。
 *
 * 为什么现在补：这一档改到了 `parseChannels` 的十六进制分支（三位缩写先展开成六位、再一律用
 * `slice` 取通道 —— 因为 `h[i]` 在 `noUncheckedIndexedAccess` 下是 `string | undefined`）。
 * 这类「写法等价」的改动没有用例就等于没有证据，而它管的是**文字色压在任意底色上是否可读**
 * （对比度审计第 23 轮的结论：社区色徽标在两个主题里各 4 处违规，唯一来源就是这里选错一侧）。
 *
 * 中灰那一档用**独立算一遍 WCAG 对比度**当 oracle，而不是写死「某个灰 ⇒ 某个颜色」的魔数：
 * 后者只是把实现的猜测抄进用例，换不来「选的那一侧确实对比度更高」这条真性质。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { readableOn } from './theme-color.ts'

const WHITE: readonly [number, number, number] = [255, 255, 255]
const INK: readonly [number, number, number] = [11, 18, 32] // #0b1220

/** 朴素实现：自己解析十六进制，自己按 WCAG 2.x 公式算相对亮度与对比度。 */
function hexChannels(hex: string): [number, number, number] {
  const h = hex.slice(1)
  const six = h.length === 3 ? h.split('').map(c => c + c).join('') : h
  // 直接写成三元组：既不需要下标回读（`noUncheckedIndexedAccess` 下每次都是 `number | undefined`），
  // 也让 oracle 与实现的通道顺序各写各的 —— 抄同一份写法就失去差分意义。
  return [parseInt(six.slice(0, 2), 16), parseInt(six.slice(2, 4), 16), parseInt(six.slice(4, 6), 16)]
}
const relLum = (ch: readonly [number, number, number]): number => 0.2126 * lin(ch[0]) + 0.7152 * lin(ch[1]) + 0.0722 * lin(ch[2])
function lin(c: number): number {
  const v = c / 255
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}
const ratio = (a: number, b: number): number => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)

describe('readableOn：在任意底色上挑可读的文字色', () => {
  it('三位缩写与展开后的六位给同一个答案（这正是本次改写的那条分支）', () => {
    for (const short of ['#fff', '#000', '#80a', '#abc', '#123']) {
      const six = short.slice(1).split('').map(c => c + c).join('')
      expect(readableOn(short), short).toBe(readableOn('#' + six))
    }
  })

  it('白底用近黑、黑底用白', () => {
    expect(readableOn('#ffffff')).toBe('#0b1220')
    expect(readableOn('#fff')).toBe('#0b1220')
    expect(readableOn('#000000')).toBe('#ffffff')
    expect(readableOn('#000')).toBe('#ffffff')
  })

  it('rgb() 与 rgba() 都解析（浏览器计算样式回的是这两种，不是十六进制）', () => {
    expect(readableOn('rgb(255, 255, 255)')).toBe('#0b1220')
    expect(readableOn('rgba(0, 0, 0, 1)')).toBe('#ffffff')
    expect(readableOn('  rgb(11, 18, 32)  ')).toBe('#ffffff') // #0b1220 自己是深色
  })

  it('挑的是「对比度更高的那一侧」—— 与独立实现逐色比对（含灰阶与饱和色）', () => {
    const samples = ['#000000', '#0b1220', '#1a1a1a', '#3f3f3f', '#6f6f6f', '#707070', '#7f7f7f',
      '#808080', '#999999', '#b0b0b0', '#cccccc', '#e8e8e8', '#ffffff',
      '#00f0ff', '#8a2be2', '#2e8b57', '#ff6b35', '#f0e68c', '#003b4a', '#f5f5dc']
    for (const hex of samples) {
      const bg = relLum(hexChannels(hex))
      const want = ratio(bg, relLum(WHITE)) >= ratio(bg, relLum(INK)) ? '#ffffff' : '#0b1220'
      expect(readableOn(hex), `${hex}（亮度 ${bg.toFixed(4)}）`).toBe(want)
    }
  })

  it('深浅两个极端的对比度都远高于 4.5（WCAG AA），中间档才由 oracle 决定', () => {
    expect(ratio(relLum(hexChannels('#ffffff')), relLum(INK))).toBeGreaterThan(4.5)
    expect(ratio(relLum(hexChannels('#000000')), relLum(WHITE))).toBeGreaterThan(4.5)
  })

  it('解析不出来时退回白字（与改前一致，不抛）', () => {
    for (const bad of ['', '   ', 'rebeccapurple', '#ff', '#gggggg', 'rgb(1,2)', '#12345', '#1234567']) {
      expect(readableOn(bad), bad).toBe('#ffffff')
    }
  })
})
