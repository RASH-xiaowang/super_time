/**
 * 「仅桌面端」降级卡的**行为**判据（jsdom）。
 *
 * ## 与 `capabilities.wiring.spec.ts` 的分工
 *
 * 那份是 AST：数「判环境的写法有没有第二处」「每一节有没有被登记」。这一份是真的把卡渲染出来：
 * 桌面态必须**一张卡都不出**（少一块界面就是回归），手机态必须出**看得懂的话**
 * （写了「不可用」三个字那种卡，用户只会以为应用坏了）。
 *
 * 两种环境各渲染一次靠的是 `setCapabilities()` 注入 —— 这也是当初把能力表做成注入而不是
 * 直接 import 的原因：跨包界不许反向往，而判据必须能在两边都跑。
 *
 * @vitest-environment jsdom
 */
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setCapabilities } from '../api.ts'
import type { RuntimeCapabilities } from '../api-core.ts'
import { DESKTOP_ONLY_KEYS, DESKTOP_ACTION_WHY, desktopAction, desktopActionProps, desktopOnlyGate, desktopOnlyListCard } from './desktop-only.tsx'

const BROWSER: RuntimeCapabilities = {
  isDesktop: false, isBrowser: true, dirPicker: false, capturePanel: false, shellOpen: false, license: false, diag: false, update: false,
}
const DESKTOP: RuntimeCapabilities = {
  isDesktop: true, isBrowser: false, dirPicker: true, capturePanel: true, shellOpen: true, license: true, diag: true, update: true,
}

let root: Root | null = null
let host: HTMLElement

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
})

afterEach(() => {
  if (root) {
    act(() => { root?.unmount() })
    root = null
  }
  host.remove()
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild)
})

function mount(node: React.ReactElement): void {
  root = createRoot(host)
  act(() => { root?.render(node) })
}

/**
 * 一次性渲染到一个**新**容器（循环里复用同一个容器会被 React 警告「已经建过 root」，
 * 而清空 innerHTML 是把当 markup 解析 —— 测试里也没必要）。
 * @param node - 要渲染的元素。
 * @returns 容器与收尾函数。
 */
function renderOnce(node: React.ReactElement): { el: HTMLElement, done: () => void } {
  const box = document.createElement('div')
  document.body.appendChild(box)
  const r = createRoot(box)
  act(() => { r.render(node) })
  return { el: box, done: (): void => { act(() => { r.unmount() }); box.remove() } }
}

describe('desktopOnlyGate / desktopOnlyListCard', (): void => {
  it('桌面态一张卡都不出（多一块界面就是回归）', (): void => {
    setCapabilities(DESKTOP)
    for (const key of DESKTOP_ONLY_KEYS) expect(desktopOnlyGate(key)).toBeNull()
    expect(desktopAction()).toBe(false)
    expect(desktopActionProps()).toEqual({})
  })

  it('手机态每个键都出一张有头有尾的说明卡', (): void => {
    setCapabilities(BROWSER)
    for (const key of DESKTOP_ONLY_KEYS) {
      const el = desktopOnlyGate(key)
      expect(el, key).not.toBeNull()
      const { el: box, done } = renderOnce(el as React.ReactElement)
      const card = box.querySelector(`[data-desktop-only="${key}"]`) as HTMLElement
      expect(card, key).not.toBeNull()
      expect(card.getAttribute('role')).toBe('note')
      // 标题里必须点明「仅桌面端」，正文必须有「为什么」和「去哪做」两段。
      expect(card.querySelector('[class*="title"]')?.textContent).toContain('仅桌面端')
      const ps = [...card.querySelectorAll('p')].map((p) => (p.textContent ?? '').trim())
      expect(ps.length).toBeGreaterThanOrEqual(2)
      expect(ps.some((t) => t.includes('电脑'))).toBe(true)
      done()
    }
  })

  it('文案不许是「不可用」那种废话：每节都要说清为什么只能在电脑上', (): void => {
    setCapabilities(BROWSER)
    for (const key of DESKTOP_ONLY_KEYS) {
      const { el: box, done } = renderOnce(desktopOnlyGate(key) as React.ReactElement)
      const text = (box.textContent ?? '').replace(/\s+/g, '')
      // 长度门槛是量出来的：表里最短的一条也有 40+ 字，而「该功能不可用」只有 6 字。
      expect(text.length, key).toBeGreaterThan(40)
      expect(text, key).not.toMatch(/不可用|暂不支持|敬请期待/)
      done()
    }
  })

  it('清单卡把每一节都列出来，并带上深链用的那一格锚点', (): void => {
    setCapabilities(BROWSER)
    mount(desktopOnlyListCard(DESKTOP_ONLY_KEYS))
    const items = [...host.querySelectorAll('[data-settings-section]')]
    expect(items.length).toBe(DESKTOP_ONLY_KEYS.length)
    expect(items.map((li) => li.getAttribute('data-settings-section')).sort()).toEqual([...DESKTOP_ONLY_KEYS].sort())
    // 每行两截：节名 + 为什么（只给节名等于没解释）
    for (const li of items) {
      const t = (li.textContent ?? '').replace(/\s+/g, '')
      expect(t.length).toBeGreaterThan(30)
    }
  })

  it('表外键不能退化成空卡（写错键名也要看得见，而不是静悄悄一块白）', (): void => {
    setCapabilities(BROWSER)
    mount(desktopOnlyGate('not-a-real-key') as React.ReactElement)
    const card = host.querySelector('[data-desktop-only="not-a-real-key"]') as HTMLElement
    expect(card).not.toBeNull()
    expect((card.textContent ?? '').length).toBeGreaterThan(10)
  })

  it('动作级降级：手机态 disabled + 一句能读的说明', (): void => {
    setCapabilities(BROWSER)
    expect(desktopAction()).toBe(true)
    expect(desktopActionProps()).toEqual({ disabled: true, title: DESKTOP_ACTION_WHY })
    expect(DESKTOP_ACTION_WHY).toContain('电脑')
    // 本文件是 .ts（与同目录其它 spec 一致），所以这里用 createElement 而不是 JSX。
    mount(createElement('button', { type: 'button', onClick: (): void => { /* 判据只看属性，不真点 */ }, ...desktopActionProps() }, '导出 CSV'))
    const btn = host.querySelector('button') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(btn.title).toBe(DESKTOP_ACTION_WHY)
  })

  it('能力表没注入时按浏览器处理（失败方向不能是「去调不存在的桥」）', (): void => {
    setCapabilities(null as unknown as RuntimeCapabilities)
    expect(desktopAction()).toBe(true)
    expect(desktopOnlyGate('backup')).not.toBeNull()
  })
})
