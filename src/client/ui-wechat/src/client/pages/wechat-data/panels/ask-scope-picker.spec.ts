// @vitest-environment jsdom
/**
 * 检索范围浮层的真实 DOM 交互。
 *
 * 纯逻辑只证明「@ 能触发」，这里补上用户真正会做的动作：
 * 点会话行、切到时间页签、Esc 与点外关闭。
 */
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WechatSession } from '@deepseek-ai/dsh-wechat-data/types'

vi.mock('./chats-support.tsx', () => ({
  Avatar: ({ name }: { name: string }): React.JSX.Element =>
    createElement('span', { 'data-test-avatar': name }, name.slice(0, 1)),
}))

import { AskScopePicker } from './ask-scope-picker.tsx'

function session(over: Partial<WechatSession> = {}): WechatSession {
  return {
    username: 'wxid_default',
    displayName: '张三',
    type: 'private',
    lastTimestamp: 1,
    summary: '',
    unreadCount: 0,
    draft: '',
    pinned: false,
    hidden: false,
    ...over,
  }
}

const SESSIONS = [
  session(),
  session({ username: 'group@chatroom', displayName: '项目群', type: 'group' }),
]

let host: HTMLDivElement
let root: Root

function render(over: Partial<React.ComponentProps<typeof AskScopePicker>> = {}): {
  onPickSession: ReturnType<typeof vi.fn>
  onClose: ReturnType<typeof vi.fn>
} {
  const onPickSession = vi.fn()
  const onClose = vi.fn()
  act(() => {
    root.render(createElement(AskScopePicker, {
      open: true,
      sessions: SESSIONS,
      sessionsLoaded: true,
      scopeUsername: '',
      from: '',
      to: '',
      onReloadSessions: vi.fn(),
      onClose,
      onPickSession,
      onFrom: vi.fn(),
      onTo: vi.fn(),
      onClearTime: vi.fn(),
      ...over,
    }))
  })
  return { onPickSession, onClose }
}

function button(text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')]
    .find(el => (el.textContent ?? '').includes(text))
  if (!found) throw new Error(`找不到按钮：${text}`)
  return found
}

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
})

describe('AskScopePicker 交互', () => {
  it('会话页展示头像、群聊/单聊标签，点击行回传 username', () => {
    const { onPickSession } = render()
    expect(host.textContent).toContain('全部会话')
    expect(host.textContent).toContain('项目群')
    expect(host.textContent).toContain('群聊')
    expect(host.textContent).toContain('单聊')
    expect(host.querySelectorAll('[data-test-avatar]')).toHaveLength(2)

    act(() => { button('项目群').click() })
    expect(onPickSession).toHaveBeenCalledWith('group@chatroom')
  })

  it('切到时间页展示全部时间与日期区间', () => {
    render()
    act(() => { button('时间').click() })
    expect(host.textContent).toContain('全部时间')
    expect(host.querySelector('#ask-scope-from')).not.toBeNull()
    expect(host.querySelector('#ask-scope-to')).not.toBeNull()
  })

  it('Esc 关闭并请求恢复焦点，点外关闭不抢焦点', () => {
    const first = render()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(first.onClose).toHaveBeenCalledWith(true)

    act(() => { root.unmount() })
    root = createRoot(host)
    const second = render()
    act(() => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    })
    expect(second.onClose).toHaveBeenCalledWith(false)
  })
})
