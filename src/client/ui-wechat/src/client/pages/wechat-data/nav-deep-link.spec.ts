/**
 * 深链原型键的 **jsdom 渲染判据**。
 *
 * 纯函数判据在 `nav-config.deep-link.spec.ts`；这里再按 `WechatDataPanel` 的初始状态
 * 口径渲染一遍：`#toString` 必须落回「数据总览」且不打开设置，更不许把
 * `TAB_LABELS.toString`（函数）当 React child —— 那会直接炸掉整棵根树。
 *
 * @vitest-environment jsdom
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { hashKey, ownValue, tabFromHash, tabLabelOf } from './nav-config.ts'

/** 与 `WechatDataPanel` 的 `DIALOG_SECTION_OF` 同形的落节表（真实表由接线判据守）。 */
const DIALOG_SECTIONS: Record<string, string> = { settings: 'wechat', health: 'health', privacytrust: 'privacy' }

/**
 * 复刻面板初始状态的两条深链路径：
 *   · hash 命中设置落节 ⇒ 打开设置弹窗（主内容区保持）；
 *   · 否则命中页签 ⇒ 切页签；非法（原型键）⇒ overview + 设置关闭。
 */
function DeepLinkProbe({ hash }: { hash: string }): React.JSX.Element {
  const section = ownValue<string>(DIALOG_SECTIONS, hashKey(hash))
  const tab = section === undefined ? tabFromHash(hash) : null
  const active = tab ?? 'overview'
  return createElement(
    'div',
    null,
    createElement('span', { 'data-probe': 'tab' }, tabLabelOf(active)),
    createElement('span', { 'data-probe': 'settings' }, section === undefined ? 'closed' : `open:${section}`),
  )
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
  // 深链测试会改 location.hash，清掉避免污染同 worker 的其它用例。
  if (window.location.hash !== '') window.location.hash = ''
})

describe('深链原型键（渲染路径）', () => {
  it('#toString 不打开设置，落回数据总览且不出现函数内容', () => {
    root = createRoot(host)
    act(() => {
      root?.render(createElement(DeepLinkProbe, { hash: window.location.hash = '#toString' }))
    })
    const tab = host.querySelector('[data-probe="tab"]')
    const settings = host.querySelector('[data-probe="settings"]')
    expect(tab?.textContent, '#toString 没有落回数据总览').toBe('数据总览')
    expect(settings?.textContent, '#toString 不应该打开设置弹窗').toBe('closed')
    expect(host.textContent, '页面里出现了函数源码（原型键被当成了 React child）').not.toContain('function')
    expect(host.textContent, '页面里出现了 [object Object]').not.toContain('[object Object]')
  })

  it('#__proto__ / #constructor 同样被忽略；#settings 仍能打开设置', () => {
    root = createRoot(host)
    for (const key of ['__proto__', 'constructor']) {
      act(() => { root?.render(createElement(DeepLinkProbe, { hash: `#${key}` })) })
      expect(host.querySelector('[data-probe="tab"]')?.textContent).toBe('数据总览')
      expect(host.querySelector('[data-probe="settings"]')?.textContent).toBe('closed')
    }
    act(() => { root?.render(createElement(DeepLinkProbe, { hash: '#settings' })) })
    expect(host.querySelector('[data-probe="settings"]')?.textContent).toBe('open:wechat')
  })

  it('真实页签深链仍生效（#kbfiles / #overview）', () => {
    root = createRoot(host)
    act(() => { root?.render(createElement(DeepLinkProbe, { hash: '#kbfiles' })) })
    expect(host.querySelector('[data-probe="tab"]')?.textContent).toBe(tabLabelOf('kbfiles'))
    act(() => { root?.render(createElement(DeepLinkProbe, { hash: '' })) })
    expect(host.querySelector('[data-probe="tab"]')?.textContent).toBe('数据总览')
  })
})
