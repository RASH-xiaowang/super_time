// @vitest-environment jsdom
/**
 * 卡片「折叠」的行为判据（设计稿那一枚）。
 *
 * ## 为什么这一条要真渲染
 *
 * 折叠这件事有两个"看着对"的坏法，只有各自量一次才分得开：
 *  ① **状态没有按卡片分开**（用一个全局布尔）⇒ 折一张，整页的卡一起折；
 *  ② **`hidden` 属性写了、但样式没压回去** —— 卡片体自己声明了 `display:flex`，
 *     作者样式会压过 UA 样式表里的 `[hidden] { display: none }`，于是"折起来的卡片"看上去没折（内容还在），
 *     而 DOM 里 `hidden` 是真的 ⇒ 只读 DOM 的断言全绿。
 *
 * Wave D3（2026-10-18）把卡片换成 kit `Card` + Bootstrap 栅格：DOM 从
 * `section > header + div(hidden)` 变成 `section(card) > div(cardHd) + div(cardBd) > div.ovSectionBd[hidden]`，
 * 判据同步到新结构；`hidden` 的 display:none 兜底规则看 `overview.module.css` 的 `.ovSectionBd[hidden]`。
 */
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OV_COLLAPSED_KEY, OvSection } from './overview-parts.tsx'
import { readText } from '../../../test-helpers/wiring-kit.ts'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  localStorage.clear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  localStorage.clear()
})

/** 挂一张卡；返回 DOM 查询器。`title` 参与折叠键，所以每条用例用它区分。 */
function mount(title = '测试卡'): {
  body: () => HTMLElement
  toggle: () => HTMLButtonElement
} {
  act(() => {
    // 用一层小包装而不是把 children 塞进 props：更直接近似真实调用点（面板里就是这么写 JSX 的）。
    const Wrap = ({ t }: { t: string }): React.JSX.Element =>
      createElement(OvSection, { icon: 'world', title: t, children: createElement('span', { 'data-probe': '1' }, '内容') })
    root.render(createElement(Wrap, { t: title }))
  })
  return {
    // kit Card：section > div.cardHd + div.cardBd > div.ovSectionBd
    body: () => host.querySelector('section > [class*="cardBd"] > div') as HTMLElement,
    toggle: () => host.querySelector('section > [class*="cardHd"] button[aria-expanded]') as HTMLButtonElement,
  }
}
const click = (el: HTMLElement): void => { act(() => { el.click() }) }

describe('OvSection 的折叠：默认展开、按卡片各记各的、刷新后仍折着', () => {
  it('默认是展开的，且按钮自己说明了状态（aria-expanded）', () => {
    const { body, toggle } = mount()
    expect(body().hidden, '默认就折起来了 ⇒ 用户打开面板会以为没数据').toBe(false)
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    expect(toggle().textContent).toContain('折叠')
    expect(toggle().getAttribute('type')).toBe('button')
  })

  it('点一下折、再点一下展开，且 aria-expanded 跟着走', () => {
    const { body, toggle } = mount()
    click(toggle())
    expect(body().hidden, '点了折叠但内容还在 DOM 上露着').toBe(true)
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(toggle().textContent).toContain('展开')
    click(toggle())
    expect(body().hidden).toBe(false)
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
  })

  it('状态按**卡片标题**分开记：折了一张，另一张不受影响', () => {
    const { toggle } = mount('卡甲')
    click(toggle())
    act(() => { root.unmount() })
    root = createRoot(host)
    const 甲 = mount('卡甲')
    expect(甲.body().hidden, '折过的卡没有留在折叠态').toBe(true)
    act(() => { root.unmount() })
    root = createRoot(host)
    const 乙 = mount('卡乙')
    expect(乙.body().hidden, '另一张卡被连坐了 ⇒ 折叠状态没有按卡片分开').toBe(false)
  })

  it('折叠态写进了 localStorage（键是标题，不是下标）', () => {
    const { toggle } = mount('资金快照 · 2026-09')
    click(toggle())
    const raw = JSON.parse(localStorage.getItem(OV_COLLAPSED_KEY) ?? 'null') as unknown
    expect(Array.isArray(raw), `${OV_COLLAPSED_KEY} 不是一个数组`).toBe(true)
    expect(raw as string[]).toContain('资金快照 · 2026-09')
    // 反例自证：再点一次必须从记录里去掉（否则"展开"只是这一次渲染，刷新又折回去）。
    click(toggle())
    const again = JSON.parse(localStorage.getItem(OV_COLLAPSED_KEY) ?? 'null') as string[]
    expect(again).not.toContain('资金快照 · 2026-09')
  })

  it('坏记录不许把内容藏起来（读不出来就当全展开）', () => {
    localStorage.setItem(OV_COLLAPSED_KEY, 'not-json{')
    const { body } = mount('坏记录卡')
    expect(body().hidden, 'localStorage 坏记录把卡片藏了 ⇒ 用户会以为没数据').toBe(false)
  })

  it('样式那半：`hidden` 必须真的把它压成 display:none（作者样式会压过 UA 样式）', () => {
    const css = readText(join(import.meta.dirname, 'overview.module.css'))
    expect(css, 'ovSectionBd[hidden] 没有 display:none 兜底 ⇒ display:flex 会压过 UA [hidden] 规则')
      .toMatch(/\.ovSectionBd\[hidden\]\s*\{\s*display:\s*none\s*;?\s*\}/)
  })
})
