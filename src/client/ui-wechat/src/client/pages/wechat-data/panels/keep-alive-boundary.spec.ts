/**
 * keep-alive 面板错误边界的**行为**判据（jsdom）。
 *
 * 背景：保活面板即使隐藏也仍在 DOM 里，任何一个面板在渲染期抛错都会波及整棵根树。
 * 这里守三件事：
 *   ① 某个 pane 抛错只毁它自己，另一个 pane 照常渲染（`active` / hidden 都还在）；
 *   ② 切回该 pane（`resetKey` 从 false 变 true）时清掉上一次的错误卡并重试；
 *   ③ 数据身份（换账号 / 换目录）变化时，pane 子树按新 identity 重挂，旧状态不串味。
 *
 * @vitest-environment jsdom
 */
import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KeepAlivePanes } from './keep-alive.tsx'

let root: Root | null = null
let host: HTMLElement

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
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

function render(node: React.ReactElement): void {
  root = createRoot(host)
  act(() => { root?.render(node) })
}

describe('KeepAlivePanes 的错误边界', () => {
  it('一个 pane 抛错只显示该 pane 的错误卡，其它 pane 不受影响', () => {
    const Boom = (): React.JSX.Element => { throw new Error('chats-boom') }
    render(createElement(KeepAlivePanes, {
      panes: [
        ['chats', createElement(Boom)],
        ['taskinfo', createElement('div', { 'data-ok': 'taskinfo' }, '任务信息正常')],
      ],
      active: 'chats',
      identity: 'acct-1:0',
    }))

    const card = host.querySelector('[role="alert"]')
    expect(card, '抛错的 pane 没有兜底卡').not.toBeNull()
    expect(card?.textContent).toContain('聊天会话')
    expect(card?.textContent).toContain('chats-boom')
    // 另一个 pane 的 DOM 仍在（只是 display:none），没有被整棵卸载。
    expect(host.querySelector('[data-ok="taskinfo"]')?.textContent).toBe('任务信息正常')
    expect(host.querySelector('[data-keep-alive="taskinfo"]')?.getAttribute('style')).toContain('display: none')
  })

  it('切回该 pane 时 resetKey 变化，错误卡自动让位给恢复后的内容', () => {
    let ok = false
    const Flaky = (): React.JSX.Element => {
      if (!ok) throw new Error('flaky-boom')
      return createElement('div', { 'data-ok': 'recovered' }, '已恢复')
    }
    const panes: Array<[string, React.ReactNode]> = [['chats', createElement(Flaky)]]
    render(createElement(KeepAlivePanes, { panes, active: 'overview', identity: 'acct-1:0' }))
    expect(host.querySelector('[role="alert"]')).not.toBeNull()

    ok = true
    act(() => {
      root?.render(createElement(KeepAlivePanes, { panes, active: 'chats', identity: 'acct-1:0' }))
    })
    expect(host.querySelector('[role="alert"]'), '切回 pane 后错误卡还在').toBeNull()
    expect(host.querySelector('[data-ok="recovered"]')?.textContent).toBe('已恢复')
  })

  it('数据身份变化时 pane 子树重挂（旧账号的组件 state 不会带过来）', () => {
    let mounts = 0
    const Probe = (): React.JSX.Element => {
      useEffect(() => { mounts += 1 }, [])
      return createElement('div', { 'data-ok': 'probe' }, 'probe')
    }
    const panes: Array<[string, React.ReactNode]> = [['chats', createElement(Probe)]]
    render(createElement(KeepAlivePanes, { panes, active: 'chats', identity: 'acct-1:0' }))
    expect(mounts).toBe(1)

    // 身份不变：wrapper 与边界 key 都不变，pane 不重挂。
    act(() => {
      root?.render(createElement(KeepAlivePanes, { panes, active: 'chats', identity: 'acct-1:0' }))
    })
    expect(mounts).toBe(1)

    // 换账号 / 换目录：边界 key 带 identity，子树重挂并从新数据源取数。
    act(() => {
      root?.render(createElement(KeepAlivePanes, { panes, active: 'chats', identity: 'acct-2:1' }))
    })
    expect(mounts, '数据身份变化后 pane 没有重挂').toBe(2)
  })
})
