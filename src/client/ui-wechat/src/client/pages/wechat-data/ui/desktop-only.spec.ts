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
  isDesktop: false, isBrowser: true, desktopEquivalent: false, dirPicker: false, capturePanel: false, shellOpen: false, license: false, diag: false, update: false,
}
const DESKTOP: RuntimeCapabilities = {
  isDesktop: true, isBrowser: false, desktopEquivalent: false, dirPicker: true, capturePanel: true, shellOpen: true, license: true, diag: true, update: true,
}
/** 「打开网页」交接态：浏览器传输 + 桌面权限。 */
const HANDOFF: RuntimeCapabilities = {
  isDesktop: false, isBrowser: true, desktopEquivalent: true, dirPicker: true, capturePanel: true, shellOpen: true, license: true, diag: true, update: true,
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

/**
 * 「降级判定必须在 hooks 之后」的**行为**判据。
 *
 * ## 为什么必须有这一条
 *
 * 2026-10-16 实测：`SettingsRemoteAccess` / `BackupPanel` / `HealthPanel` / `HookPanel` /
 * `LicenseSection` / `UpdateSection` / `SetupGuide` 七处都写成「函数体第一行
 * `if (desktopOnlyGate(...) !== null) return ...`」—— 那是 React Hooks 规则违反。
 * 能力表是**注入**的（`setCapabilities`），注入时机与 HMR 都可能让它在两次渲染之间翻转；
 * 一旦翻转，组件就会「上一次渲染跑了 N 个 hook、这一次 0 个」，React 抛
 * "Rendered more hooks than during the previous render" ⇒ **整棵根树被卸载** ⇒
 * 用户看到的是「设置弹窗还在、内容区全黑」。
 *
 * 这一条把「翻转能力表后重新渲染」跑一遍：修复前必抛，修复后必须安静通过。
 * 用 `SettingsRemoteAccess` 当样本 —— 它是用户报障的那一节，且 hooks 最多（7 个）。
 */
describe('降级判定在 hooks 之后（能力表翻转不崩）', (): void => {
  it('桌面态 → 浏览器态翻转后重新渲染，不抛 hooks 数量错误', async (): Promise<void> => {
    // 这一节要读 `window.electronAPI.remoteAccess`；给一个最小桥，让桌面态能真的渲染出卡片。
    const calls: string[] = []
    const bridge = {
      state: async () => { calls.push('state'); return { ok: true, value: { running: false, port: 0, configuredPort: 5032, address: '', addresses: [], enabled: false, hasToken: false, tokenMasked: '', sessions: 0 } } },
      rotate: async () => { calls.push('rotate'); return { ok: true, value: { token: 't', pairingCode: 'p', state: { running: false, port: 0, configuredPort: 5032, address: '', addresses: [], enabled: true, hasToken: true, tokenMasked: 't…t', sessions: 0 } } } },
      toggle: async () => { calls.push('toggle'); return { ok: true, value: { running: false, port: 0, configuredPort: 5032, address: '', addresses: [], enabled: false, hasToken: true, tokenMasked: 't…t', sessions: 0 } } },
    }
    const w = window as unknown as { electronAPI?: unknown }
    const prev = w.electronAPI
    w.electronAPI = { remoteAccess: bridge }

    try {
      const { SettingsRemoteAccess } = await import('../panels/settings-remote-access.tsx')
      const { BackupPanel } = await import('../panels/Backup.tsx')

      // ① 桌面态：卡片必须真的渲染出来（否则下面的翻转测不到 hooks）。
      setCapabilities(DESKTOP)
      const box = document.createElement('div')
      document.body.appendChild(box)
      const r = createRoot(box)
      await act(async () => { r.render(createElement(SettingsRemoteAccess)) })
      expect(box.querySelector('[data-settings-section="remote"]'), '桌面态没渲染出远程访问卡片').not.toBeNull()

      // ② 翻转成浏览器态后重新渲染：修复前这里抛 "Rendered more hooks…"。
      // React 的 hooks 数量错误在 render 阶段抛出，`act` 会把它包成 rejected promise ——
      // 必须显式接住，否则测试会静默通过（这正是这条判据第一版没抓到 bug 的原因）。
      setCapabilities(BROWSER)
      let flipError: unknown = null
      try {
        await act(async () => { r.render(createElement(SettingsRemoteAccess)) })
      } catch (e) {
        flipError = e
      }
      expect(flipError, `能力表翻转后渲染抛错：${String(flipError)}`).toBeNull()
      expect(box.querySelector('[data-desktop-only="remote"]'), '浏览器态没换成降级卡').not.toBeNull()

      // ③ 再翻回桌面态：hook 数量必须仍然恒定。
      setCapabilities(DESKTOP)
      let backError: unknown = null
      try {
        await act(async () => { r.render(createElement(SettingsRemoteAccess)) })
      } catch (e) {
        backError = e
      }
      expect(backError, `翻回桌面态后渲染抛错：${String(backError)}`).toBeNull()
      expect(box.querySelector('[data-settings-section="remote"]'), '翻回桌面态后卡片没回来').not.toBeNull()

      // ④ 同一套翻转对 `BackupPanel` 再跑一遍 —— 它**必须**也过。
      // 这一节比远程访问更危险：它的正常渲染与降级卡**都是 `<div>`**，元素类型相同 ⇒
      // React 会复用组件实例 ⇒ hooks 数量变化**真的**会抛错（远程访问那节因为
      // section↔div 类型不同，React 直接重建实例，反而掩盖了问题）。
      setCapabilities(DESKTOP)
      await act(async () => { r.render(createElement(BackupPanel)) })
      expect(box.querySelector('[class*="panel"]'), '桌面态没渲染出备份面板').not.toBeNull()
      setCapabilities(BROWSER)
      let backupFlipError: unknown = null
      try {
        await act(async () => { r.render(createElement(BackupPanel)) })
      } catch (e) {
        backupFlipError = e
      }
      expect(backupFlipError, `备份面板翻转后渲染抛错：${String(backupFlipError)}`).toBeNull()
      expect(box.querySelector('[data-desktop-only="backup"]'), '浏览器态没换成备份降级卡').not.toBeNull()

      await act(async () => { r.unmount() })
      box.remove()
    } finally {
      if (prev === undefined) delete w.electronAPI
      else w.electronAPI = prev
    }
  })
})
