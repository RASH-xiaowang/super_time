/**
 * 手机端底部导航的**行为**判据（jsdom + 受控 matchMedia）。
 *
 * ## 这里守的三件事
 *
 *   ① **窄视口才渲染**：桌面窗口里多出一条底部栏会盖住内容、还会让用户以为界面坏了。
 *      判定在 `MobileNavHost` 内部的 `useMediaQuery(PHONE_QUERY)`，所以把 matchMedia
 *      打桩成「匹配 / 不匹配」两种情况各渲染一次，直接看 DOM 有没有那条 nav。
 *   ② **36 个 tab 全部可达**：底部 4 个高频位 + 「更多」sheet 里按 `NAV_GROUPS` 列出的全部条目，
 *      合起来必须覆盖桌面侧栏渲染的每一个 tab。少一个的症状是「桌面上有这个页、手机上找不到」，
 *      而新增 tab 时最容易只加到 `NAV_GROUPS` 忘了看手机侧 —— 这条让它当场红。
 *   ③ **选完即关 sheet**：不关的话 sheet 会盖在新页面上，用户看到的是「点了没反应」。
 *
 * @vitest-environment jsdom
 */
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NAV_GROUPS, type WechatTab } from '../nav-config.ts'
import { MOBILE_PRIMARY_TABS, MobileNav, MobileNavHost } from './mobile-nav.tsx'
import { PHONE_QUERY } from './use-media-query.ts'

/** 桌面侧栏真正渲染的 tab（与 WechatDataPanel 的过滤口径一致：非 hidden、非 settings）。 */
const SIDEBAR_TABS: WechatTab[] = NAV_GROUPS
  .flatMap((g) => [...g.items])
  .filter((it) => !it.hidden && it.tab !== 'settings')
  .map((it) => it.tab)

/** 把 matchMedia 打桩成固定结果。 */
function stubMatchMedia(matches: boolean): void {
  const listeners = new Set<(e: { matches: boolean }) => void>()
  ;(window as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({
    matches,
    media: query,
    addEventListener: (_t: string, fn: (e: { matches: boolean }) => void) => { listeners.add(fn) },
    removeEventListener: (_t: string, fn: (e: { matches: boolean }) => void) => { listeners.delete(fn) },
  })
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
  // 逐个摘子节点而不是 innerHTML=''：测试里也没有外部数据，但显式移除不留歧义
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild)
})

function mount(node: Parameters<typeof createElement>[1] extends never ? never : React.ReactNode): void {
  root = createRoot(host)
  act(() => { root?.render(node as React.ReactElement) })
}

const barButtons = (): string[] =>
  [...host.querySelectorAll('nav[aria-label="主导航"] > button')].map((b) => (b.textContent ?? '').trim())

const sheetButtons = (): string[] =>
  [...host.querySelectorAll('[role="dialog"][aria-label="全部功能"] button')]
    .map((b) => (b.textContent ?? '').trim())
    .filter((t) => t !== '' && t !== '✕')

describe('窄视口判定', () => {
  it('不匹配手机档时什么都不渲染（桌面窗口不会多出一条底部栏）', () => {
    stubMatchMedia(false)
    mount(createElement(MobileNavHost, { active: 'overview', onSelect: () => undefined }))
    expect(host.querySelector('nav[aria-label="主导航"]'), '桌面态渲染出了底部标签栏').toBeNull()
  })

  it('匹配手机档时渲染出 5 格底部栏（4 高频 + 更多）', () => {
    stubMatchMedia(true)
    mount(createElement(MobileNavHost, { active: 'overview', onSelect: () => undefined }))
    const labels = barButtons()
    expect(labels.length, '底部栏不是 5 格').toBe(5)
    expect(labels[4], '最后一格不是「更多」').toBe('更多')
    // 4 个高频位必须都是真实存在的 tab（写错一个 id 就是点了没反应）
    for (const t of MOBILE_PRIMARY_TABS) {
      expect(SIDEBAR_TABS, `高频位 ${t} 不是 nav-config 里的可见 tab`).toContain(t)
    }
  })

  it('PHONE_QUERY 与 CSS 的手机档是同一个数（JS 判 560、CSS 判别的就会打架）', () => {
    expect(PHONE_QUERY).toBe('(max-width: 560px)')
  })
})

describe('「更多」sheet 覆盖桌面侧栏的全部条目', () => {
  it('打开后每个桌面可见 tab 都在里面，且点它会选中并关 sheet', () => {
    stubMatchMedia(true)
    const picked: WechatTab[] = []
    mount(createElement(MobileNav, { active: 'overview', onSelect: (t: WechatTab) => picked.push(t) }))

    // 打开 sheet
    const more = [...host.querySelectorAll('nav[aria-label="主导航"] > button')].at(-1) as HTMLElement
    act(() => { more.click() })
    const labels = sheetButtons()

    // 覆盖性：桌面侧栏渲染的每个 tab 都能在手机上到达
    const missing = SIDEBAR_TABS.filter((t) => {
      const item = NAV_GROUPS.flatMap((g) => [...g.items]).find((i) => i.tab === t)
      return item && !labels.includes(item.label)
    })
    expect(missing, `这些 tab 在手机上到不了：${missing.join(', ')}`).toEqual([])
    // 反向：sheet 里不许出现桌面侧栏没有的条目（多出来的入口点了会去到不存在的页）
    const extra = labels.filter((l) => !NAV_GROUPS.flatMap((g) => [...g.items]).some((i) => i.label === l) && l !== '设置')
    expect(extra, `sheet 里出现了 nav-config 没有的条目：${extra.join(', ')}`).toEqual([])
    // hidden 条目不该出现在 sheet 里（桌面侧栏也不渲染它们）
    for (const it of NAV_GROUPS.flatMap((g) => [...g.items]).filter((i) => i.hidden)) {
      expect(labels, `hidden 条目 ${it.tab} 被渲染进了 sheet`).not.toContain(it.label)
    }

    // 点「聊天会话」：选中 + 关 sheet
    const chats = [...host.querySelectorAll('[role="dialog"] button')]
      .find((b) => (b.textContent ?? '').includes('聊天会话')) as HTMLElement
    act(() => { chats.click() })
    expect(picked).toEqual(['chats'])
    expect(host.querySelector('[role="dialog"][aria-label="全部功能"]'), '选完没有关掉 sheet').toBeNull()
  })

  it('设置入口在 sheet 里（桌面端它在侧栏页脚，手机上没有那个页脚）', () => {
    stubMatchMedia(true)
    let opened = 0
    mount(createElement(MobileNav, {
      active: 'overview',
      onSelect: () => undefined,
      onOpenSettings: () => { opened += 1 },
    }))
    const more = [...host.querySelectorAll('nav[aria-label="主导航"] > button')].at(-1) as HTMLElement
    act(() => { more.click() })
    const settings = [...host.querySelectorAll('[role="dialog"] button')]
      .find((b) => (b.textContent ?? '').includes('设置')) as HTMLElement
    expect(settings, 'sheet 里没有设置入口').toBeTruthy()
    act(() => { settings.click() })
    expect(opened, '点设置没有触发回调').toBe(1)
    expect(host.querySelector('[role="dialog"]'), '点完设置 sheet 没关').toBeNull()
  })

  it('当前 tab 不在高频位时，「更多」那一格高亮（否则用户看不出自己在哪）', () => {
    stubMatchMedia(true)
    mount(createElement(MobileNav, { active: 'ledger', onSelect: () => undefined }))
    const more = [...host.querySelectorAll('nav[aria-label="主导航"] > button')].at(-1) as HTMLElement
    expect(more.hasAttribute('data-active'), 'ledger 不是高频位，「更多」却没高亮').toBe(true)
    // 反过来：在高频位时不该高亮
    const root2 = createRoot(document.createElement('div'))
    const h2 = document.createElement('div')
    document.body.appendChild(h2)
    const r2 = createRoot(h2)
    act(() => { r2.render(createElement(MobileNav, { active: 'chats', onSelect: () => undefined })) })
    const more2 = [...h2.querySelectorAll('nav[aria-label="主导航"] > button')].at(-1) as HTMLElement
    expect(more2.hasAttribute('data-active'), 'chats 是高频位，「更多」却高亮了').toBe(false)
    act(() => { r2.unmount(); root2.unmount() })
    h2.remove()
  })
})
