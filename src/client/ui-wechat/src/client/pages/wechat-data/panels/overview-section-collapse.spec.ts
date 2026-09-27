// @vitest-environment jsdom
/**
 * 卡片「折叠」的行为判据（2026-09-27 按设计稿加的那一枚）。
 *
 * ## 为什么这一条要真渲染
 *
 * 折叠这件事有两个"看着对"的坏法，只有各自量一次才分得开：
 *  ① **状态没有按卡片分开**（用一个全局布尔）⇒ 折一张，整页的卡一起折；
 *  ② **`hidden` 属性写了、但样式没压回去** —— `.ovCardBd` 自己声明了 `display: flex`，
 *     作者样式压过 UA 样式表里的 `[hidden] { display: none }`，于是**折起来的卡片看上去没折**
 *     （内容还在），而 DOM 上 `hidden` 是真的 ⇒ 只读 DOM 的断言全绿。
 * 所以：行为用 jsdom 渲染着量（含"换张卡就是另一回事"与"刷新后仍折着"），
 * 样式那半用源码断言量（`overview-neon.module.css` 里必须有压回 `display:none` 的那一条）。
 *
 * 折叠状态记在 localStorage（按标题），所以每条用例前后都要清干净 —— 否则上一条折过的卡
 * 会让下一条从"已折叠"起步，判据变成"看顺序"。
 */
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OV_COLLAPSED_KEY, OvSection } from './overview-parts.tsx'
import { findRoot, readStripped, readText } from '../../../test-helpers/wiring-kit.ts'

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
    // 用一层小包装而不是把 children 塞进 props：`OvSection` 的 `children` 是必填 prop，
    // 直接 `createElement(OvSection, {icon,title}, child)` 会被 TS 判成缺 prop（children 只认 props 那一侧）。
    // 同时也更接近真实调用点（面板里就是这么写 JSX 的）。
    const Wrap = ({ t }: { t: string }): React.JSX.Element =>
      createElement(OvSection, { icon: 'world', title: t, children: createElement('span', { 'data-probe': '1' }, '内容') })
    root.render(createElement(Wrap, { t: title }))
  })
  return {
    body: () => host.querySelector('section > div') as HTMLElement,
    toggle: () => host.querySelector('section > header > button') as HTMLButtonElement,
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
    const again = JSON.parse(localStorage.getItem(OV_COLLAPSED_KEY) ?? 'null') as unknown
    expect((again as string[]).includes('资金快照 · 2026-09'), '展开后没有从记录里删掉').toBe(false)
  })

  it('坏记录不许把内容藏起来（读不出来就当全展开）', () => {
    localStorage.setItem(OV_COLLAPSED_KEY, '这不是数组')
    const { body } = mount('坏记录卡')
    expect(body().hidden, '存储里是一条坏记录 ⇒ 界面把内容藏了').toBe(false)
  })

  it('样式那半：`hidden` 必须真的把它压成 display:none（作者样式会压过 UA 样式）', () => {
    // 用 findRoot + join 而不是 `new URL(...).pathname`：后者在 Windows 上得到 `/D:/...`，
    // node:fs 读不了（本仓在别的用例里踩过同一形状）。
    const cssPath = join(findRoot(import.meta.dirname), 'src', 'client', 'ui-wechat', 'src', 'client',
      'pages', 'wechat-data', 'panels', 'overview-neon.module.css')
    const cssText = readStripped(cssPath)
    expect(cssText, '皮肤里没有 `.cardBd[hidden]` 这条 ⇒ 折叠只改了 DOM、看上去没折')
      .toMatch(/\.cardBd\[hidden\]\s*\{[^}]*display:\s*none/)
    // 反向：确认这条规则真的在文件里（而不是被 readStripped 吃掉之后的错觉）。
    // 顺带盯住类名别漂：JSX 那边挂的是 ，这里查的是同一个名字。
    expect(readText(cssPath)).toContain('cardBd')
  })
})
