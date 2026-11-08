// @vitest-environment jsdom
/**
 * 外部会话导航只能消费一次。
 *
 * 回归背景：取数完成会改变 `openSessionAndLocate` 的函数身份；消费 effect 若跟着
 * 这个身份重跑，就会不断清空刚加载的消息，最终只剩骨架屏。
 */
import { act, createElement, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatNavigationTarget } from './chats-target.ts'
import { useChatTargetNavigation } from './chats-target.ts'

let host: HTMLDivElement
let root: Root
let handled: ReturnType<typeof vi.fn>

function Harness({
  target,
  open,
}: {
  target: ChatNavigationTarget
  open: (username: string, localId?: number) => Promise<void>
}): null {
  useChatTargetNavigation({ target, open, onHandled: handled })
  return null
}

function render(target: ChatNavigationTarget, open: (username: string, localId?: number) => Promise<void>): void {
  act(() => {
    root.render(createElement(StrictMode, null, createElement(Harness, { target, open })))
  })
}

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  handled = vi.fn()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
})

describe('useChatTargetNavigation', () => {
  it('同一个 target 在 open 回调换身份后也只消费一次', () => {
    const target: ChatNavigationTarget = { username: 'wxid_target', localId: 42, nonce: 1 }
    const first = vi.fn(() => Promise.resolve())
    const second = vi.fn(() => Promise.resolve())

    render(target, first)
    render(target, second)

    expect(first).toHaveBeenCalledTimes(1)
    expect(first).toHaveBeenCalledWith('wxid_target', 42)
    expect(second).not.toHaveBeenCalled()
    expect(handled).toHaveBeenCalledTimes(1)
    expect(handled).toHaveBeenCalledWith(1)
  })

  it('新的 nonce 会再次消费，并允许同一会话重新定位', () => {
    const first = vi.fn(() => Promise.resolve())
    const second = vi.fn(() => Promise.resolve())

    render({ username: 'wxid_target', localId: 42, nonce: 1 }, first)
    render({ username: 'wxid_target', localId: 42, nonce: 2 }, second)

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledWith('wxid_target', 42)
    expect(handled).toHaveBeenLastCalledWith(2)
  })

  it('空 username 只消费导航意图，不发起无效会话请求', () => {
    const open = vi.fn(() => Promise.resolve())

    render({ username: '   ', nonce: 3 }, open)

    expect(open).not.toHaveBeenCalled()
    expect(handled).toHaveBeenCalledWith(3)
  })
})
