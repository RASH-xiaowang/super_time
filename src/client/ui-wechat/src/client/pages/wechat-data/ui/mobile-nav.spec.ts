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
import { act, createElement } from 'react'
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
  // 焦点 / 滚动锁用例会改 body 行内样式；每个用例从干净状态开始。
  document.body.style.overflow = ''
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

/**
 * Radix 弹窗的挂载/卸载跨多个微任务与 portal 提交：jsdom 下单轮 act 不够，
 * 多轮 `setTimeout(0)` 才等到 DOM 稳定（与 `confirm.a11y.spec.ts` 同一个套路）。
 */
async function flush(n = 8): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
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
    // 反向：sheet 里不许出现白名单之外的条目（多出来的入口点了会去到不该在手机上出现的页）。
    // 「Bug 反馈」显式放行：它是**全局动作**（和「设置」并列的配置组入口），不是导航 tab，
    // 不参与手机导航可达性白名单 —— 它由 MobileNav 自己维护，不来自 NAV_GROUPS。
    const keepLabels = new Set(
      NAV_GROUPS.flatMap((g) => [...g.items]).filter((i) => MOBILE_KEEP_TABS.includes(i.tab)).map((i) => i.label),
    )
    const extra = labels.filter((l) => !keepLabels.has(l) && l !== '设置' && l !== 'Bug 反馈')
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

  it('「更多」→ Bug 反馈：先关 sheet 再开弹窗，关闭后弹窗消失且焦点回到「更多」', async () => {
    stubMatchMedia(true)
    // 这个用例刻意不传 onOpenSettings：Bug 入口不能依赖宿主是否接了设置回调。
    mount(createElement(MobileNav, { active: 'overview', onSelect: () => undefined }))

    const more = [...host.querySelectorAll('nav[aria-label="主导航"] > button')].at(-1) as HTMLElement
    act(() => { more.click() })

    // 注意只在 sheet 自己的 dialog 里找；Bug 弹窗是另一个 Radix dialog，不能污染 sheet 列表。
    const bug = [...host.querySelectorAll('[role="dialog"][aria-label="全部功能"] button')]
      .find((b) => (b.textContent ?? '').trim() === 'Bug 反馈') as HTMLElement | undefined
    expect(bug, '「更多」的配置分组里没有 Bug 反馈入口').toBeTruthy()
    act(() => { bug!.click() })
    await flush()

    // sheet 必须先关：否则弹窗叠在「全部功能」上，Esc 和焦点陷阱会互相抢。
    expect(host.querySelector('[role="dialog"][aria-label="全部功能"]'), '点 Bug 反馈后 sheet 没关').toBeNull()

    // Bug 弹窗走 Radix portal 到 document.body，不在 host 子树里。
    const bugDialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')]
      .find((d) => (d.textContent ?? '').includes('提交 Bug 与建议'))
    expect(bugDialog, 'sheet 关闭后没有出现「提交 Bug 与建议」弹窗').toBeTruthy()

    // Radix 的关闭按钮是 X（aria-label="关闭"）；若实现改用「取消」按钮也应能关。
    const close = [...(bugDialog as HTMLElement).querySelectorAll<HTMLElement>('button')]
      .find((b) => (b.getAttribute('aria-label') ?? '').includes('关闭') || (b.textContent ?? '').includes('取消'))
    expect(close, 'Bug 弹窗里找不到关闭/取消按钮').toBeTruthy()
    act(() => { close!.click() })
    await flush()

    const stillOpen = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')]
      .some((d) => (d.textContent ?? '').includes('提交 Bug 与建议'))
    expect(stillOpen, '点关闭后 Bug 弹窗还在').toBe(false)

    // 打开弹窗前 sheet 已卸载，Radix 恢复不到原按钮；关闭后必须把焦点还给「更多」。
    expect(document.activeElement, '关闭 Bug 弹窗后焦点掉到了 body').toBe(more)
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

const sheetEl = (): HTMLElement | null => host.querySelector<HTMLElement>('[role="dialog"][aria-label="全部功能"]')

const moreButton = (): HTMLElement =>
  [...host.querySelectorAll('nav[aria-label="主导航"] > button')].at(-1) as HTMLElement

/** 与 mobile-nav 里的焦点陷阱用同一组选择器。 */
const sheetFocusables = (): HTMLElement[] => {
  const panel = sheetEl()
  return panel === null
    ? []
    : [...panel.querySelectorAll<HTMLElement>('button:not([disabled]),[href],input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])')]
}

describe('「更多」sheet 的焦点管理与滚动锁', () => {
  it('打开后焦点进入 sheet、body 滚动锁定；关闭后焦点回到「更多」且滚动恢复', () => {
    stubMatchMedia(true)
    mount(createElement(MobileNav, { active: 'overview', onSelect: () => undefined }))
    const more = moreButton()
    const before = document.body.style.overflow

    act(() => { more.click() })
    const focusables = sheetFocusables()
    expect(focusables.length, 'sheet 里没有可聚焦元素').toBeGreaterThan(1)
    expect(document.activeElement, '打开 sheet 后焦点没有进入面板').toBe(focusables[0])
    expect(document.body.style.overflow, 'sheet 打开时页面仍可滚动').toBe('hidden')

    const close = sheetEl()?.querySelector<HTMLElement>('button[aria-label="关闭"]')
    expect(close, 'sheet 里没有关闭按钮').toBeTruthy()
    act(() => { close!.click() })
    expect(sheetEl(), '点关闭后 sheet 还在').toBeNull()
    expect(document.activeElement, '关闭后焦点没有还给「更多」').toBe(more)
    expect(document.body.style.overflow, '关闭后 body 滚动没有恢复').toBe(before)
  })

  it('Tab 在首尾之间循环，焦点不会逃到页面其它元素', () => {
    stubMatchMedia(true)
    mount(createElement(MobileNav, { active: 'overview', onSelect: () => undefined }))
    act(() => { moreButton().click() })

    const items = sheetFocusables()
    const first = items[0] as HTMLElement
    const last = items[items.length - 1] as HTMLElement

    last.focus()
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })) })
    expect(document.activeElement, '在最后一个元素按 Tab 没有回到第一个').toBe(first)

    first.focus()
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true })) })
    expect(document.activeElement, '在第一个元素按 Shift+Tab 没有跳到最后一个').toBe(last)

    // 焦点意外落到面板外（例如脚本/辅助技术移走）时，Tab 也要拉回面板内。
    ;(document.activeElement as HTMLElement | null)?.blur()
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })) })
    expect(document.activeElement, '焦点落回 body 后 Tab 没有回到面板').toBe(first)
  })

  it('Esc 关闭 sheet，并同样把焦点还给「更多」', () => {
    stubMatchMedia(true)
    mount(createElement(MobileNav, { active: 'overview', onSelect: () => undefined }))
    const more = moreButton()
    act(() => { more.click() })
    expect(sheetEl()).not.toBeNull()

    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(sheetEl(), '按 Esc 没有关闭 sheet').toBeNull()
    expect(document.activeElement, 'Esc 关闭后焦点没有还给「更多」').toBe(more)
    expect(document.body.style.overflow).toBe('')
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
