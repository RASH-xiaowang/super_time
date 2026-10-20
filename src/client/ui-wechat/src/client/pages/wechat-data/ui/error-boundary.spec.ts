/**
 * `ErrorBoundary` 的**行为**判据（jsdom）。
 *
 * ## 为什么必须有
 *
 * 设置弹窗把 13 节塞进同一个懒加载 chunk，任何一节在渲染期抛错都会让 React 卸载整棵根树 ——
 * 用户看到的是「弹窗还在、内容区全黑」，界面上没有任何线索。这条判据钉住三件事：
 *   ① 子组件抛错时**不**把错误继续往上抛（否则整棵树还是会崩）；
 *   ② 出错时渲染出**可读**的错误卡（含错误消息），而不是空白；
 *   ③ 点「重试」后重新渲染子组件（用户不必重启应用）。
 *
 * @vitest-environment jsdom
 */
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ErrorBoundary } from './error-boundary.tsx'

let root: Root | null = null
let host: HTMLElement

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  // React 会把渲染错误打到 console.error；判据里这是**预期**的，别让它污染测试输出。
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  if (root) {
    act(() => { root?.unmount() })
    root = null
  }
  host.remove()
  vi.restoreAllMocks()
})

/** 一个「第一次渲染抛错、之后正常」的组件（用来验证重试）。 */
function makeFlaky(): { Comp: () => React.JSX.Element, setOk: (v: boolean) => void } {
  let ok = false
  const Comp = (): React.JSX.Element => {
    if (!ok) throw new Error('boom-测试用')
    return createElement('div', { 'data-ok': 'yes' }, '正常内容')
  }
  return { Comp, setOk: (v: boolean): void => { ok = v } }
}

describe('ErrorBoundary', (): void => {
  it('子组件抛错时不把错误继续往上抛，并渲染出含错误消息的卡', (): void => {
    const Boom = (): React.JSX.Element => { throw new Error('boom-测试用') }
    root = createRoot(host)
    // 关键：`act` 里**不**接错误 —— 如果边界没兜住，这里会抛，测试直接红。
    act(() => { root?.render(createElement(ErrorBoundary, { label: '设置', children: createElement(Boom) })) })
    const card = host.querySelector('[role="alert"]')
    expect(card, '出错后没有渲染兜底卡').not.toBeNull()
    expect(card?.textContent, '兜底卡里没有错误消息').toContain('boom-测试用')
    expect(card?.textContent, '兜底卡里没有说明是哪一块').toContain('设置')
  })

  it('点「重试」后重新渲染子组件（不必重启应用）', (): void => {
    const { Comp, setOk } = makeFlaky()
    root = createRoot(host)
    act(() => { root?.render(createElement(ErrorBoundary, { children: createElement(Comp) })) })
    expect(host.querySelector('[role="alert"]'), '第一次应当出错').not.toBeNull()

    setOk(true)
    const btn = host.querySelector('button')
    expect(btn, '兜底卡里没有重试按钮').not.toBeNull()
    act(() => { btn?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(host.querySelector('[data-ok="yes"]'), '重试后没有渲染出正常内容').not.toBeNull()
    expect(host.querySelector('[role="alert"]'), '重试后兜底卡还在').toBeNull()
  })

  it('子组件正常时不渲染任何兜底 UI（不能凭空多一块）', (): void => {
    root = createRoot(host)
    act(() => { root?.render(createElement(ErrorBoundary, null, createElement('div', { 'data-ok': 'yes' }, '正常'))) })
    expect(host.querySelector('[role="alert"]')).toBeNull()
    expect(host.querySelector('[data-ok="yes"]')).not.toBeNull()
  })
})
