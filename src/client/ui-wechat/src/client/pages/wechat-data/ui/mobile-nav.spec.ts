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
import { MOBILE_HIDDEN_TABS, MOBILE_KEEP_TABS, MOBILE_PRIMARY_TABS, MobileNav, MobileNavHost } from './mobile-nav.tsx'
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

describe('「更多」sheet 覆盖手机端保留的全部条目', () => {
  it('打开后每个保留 tab 都在里面，且点它会选中并关 sheet', () => {
    stubMatchMedia(true)
    const picked: WechatTab[] = []
    mount(createElement(MobileNav, { active: 'overview', onSelect: (t: WechatTab) => picked.push(t) }))

    // 打开 sheet
    const more = [...host.querySelectorAll('nav[aria-label="主导航"] > button')].at(-1) as HTMLElement
    act(() => { more.click() })
    const labels = sheetButtons()

    // 覆盖性：手机端保留的每个 tab 都能在 sheet 里到达
    const missing = MOBILE_KEEP_TABS.filter((t) => {
      const item = NAV_GROUPS.flatMap((g) => [...g.items]).find((i) => i.tab === t)
      return item && !labels.includes(item.label)
    })
    expect(missing, `这些保留 tab 在手机上到不了：${missing.join(', ')}`).toEqual([])
    // 反向：sheet 里不许出现白名单之外的条目（多出来的入口点了会去到不该在手机上出现的页）
    const keepLabels = new Set(
      NAV_GROUPS.flatMap((g) => [...g.items]).filter((i) => MOBILE_KEEP_TABS.includes(i.tab)).map((i) => i.label),
    )
    const extra = labels.filter((l) => !keepLabels.has(l) && l !== '设置')
    expect(extra, `sheet 里出现了白名单之外的条目：${extra.join(', ')}`).toEqual([])
    // hidden 条目不该出现在 sheet 里（桌面侧栏也不渲染它们）
    for (const it of NAV_GROUPS.flatMap((g) => [...g.items]).filter((i) => i.hidden)) {
      expect(labels, `hidden 条目 ${it.tab} 被渲染进了 sheet`).not.toContain(it.label)
    }

    // 点「朋友圈」（它在白名单里；「聊天会话」是底部栏高频位，不在 sheet 里）
    const moments = [...host.querySelectorAll('[role="dialog"] button')]
      .find((b) => (b.textContent ?? '').includes('朋友圈')) as HTMLElement
    act(() => { moments.click() })
    expect(picked).toEqual(['moments'])
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

/**
 * 手机端**刻意收窄**导航（2026-10-16 手机端重设计）。
 *
 * ## 为什么不再要求「覆盖桌面侧栏的全部条目」
 *
 * 这条判据原先要求手机端能到达桌面侧栏的**每一个** tab。那是「手机 = 桌面的缩小版」的假设，
 * 而实测下来它站不住：桌面侧栏有 16 个可见条目，其中 `oplog`（操作日志）在手机上
 * **横向溢出 104 处**（640px 表格塞进 556px 视口），`calls`（通话记录）本机只有个位数条 ——
 * 把它们塞进手机 sheet 只是让用户点进一个读不动的页。
 *
 * 所以口径改成：**手机端保留一份白名单**（{@link MOBILE_KEEP_TABS}），
 * 移除的每一条都必须在 {@link MOBILE_HIDDEN_TABS} 里**写明理由**。
 * 这样「新增 tab 时忘了看手机侧」仍然会红（新 tab 不在白名单里 ⇒ 下面第一条判据红），
 * 而「刻意移除」必须留下理由，不能悄悄消失。
 */
describe('手机端导航白名单（刻意收窄，不是漏了）', () => {
  it('白名单里的每一条都必须是 NAV_GROUPS 里真实存在的可见 tab（写错 id 会静默少一格）', () => {
    const all = NAV_GROUPS.flatMap((g) => [...g.items])
    for (const t of MOBILE_KEEP_TABS) {
      const item = all.find((i) => i.tab === t)
      expect(item, `白名单里的 ${t} 在 nav-config 里不存在`).toBeTruthy()
      expect(item?.hidden, `白名单里的 ${t} 是 hidden 条目（它本来就不该出现在任何导航里）`).not.toBe(true)
    }
  })

  it('桌面可见条目 = 白名单 ∪ 高频位 ∪ 移除项（不许有「既没保留也没写理由」的漏网）', () => {
    const visible = NAV_GROUPS.flatMap((g) => [...g.items])
      .filter((i) => !i.hidden && i.tab !== 'settings')
      .map((i) => i.tab)
    const accounted = new Set<string>([...MOBILE_KEEP_TABS, ...MOBILE_PRIMARY_TABS, ...Object.keys(MOBILE_HIDDEN_TABS)])
    const unaccounted = visible.filter((t) => !accounted.has(t))
    expect(unaccounted, `这些桌面可见 tab 既不在手机白名单、也没写移除理由：${unaccounted.join(', ')}`).toEqual([])
  })

  it('移除的每一条都写了非空理由（没有理由的移除看起来就像漏了）', () => {
    const entries = Object.entries(MOBILE_HIDDEN_TABS)
    expect(entries.length, '移除项为空 —— 那这条判据就是恒真的').toBeGreaterThan(0)
    for (const [tab, why] of entries) {
      expect(why.length, `移除项 ${tab} 的理由太短（少于 10 字），等于没写`).toBeGreaterThan(10)
    }
  })

  it('移除项不许同时出现在白名单或高频位里（自相矛盾）', () => {
    for (const tab of Object.keys(MOBILE_HIDDEN_TABS)) {
      expect(MOBILE_KEEP_TABS, `${tab} 既被移除又在白名单里`).not.toContain(tab)
      expect(MOBILE_PRIMARY_TABS, `${tab} 既被移除又在高频位里`).not.toContain(tab)
    }
  })
})
