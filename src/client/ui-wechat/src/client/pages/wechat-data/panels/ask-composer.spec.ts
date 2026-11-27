// @vitest-environment jsdom
/**
 * 问答输入面范围标签上的小叉：取消已选会话、取消已设时间，互不影响。
 */
import { act, createElement, type RefObject } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./chats-support.tsx', () => ({
  Avatar: ({ name }: { name: string }): React.JSX.Element =>
    createElement('span', { 'data-test-avatar': name }, name.slice(0, 1)),
}))

import { AskComposer } from './ask-composer.tsx'

const textareaRef = { current: null } as RefObject<HTMLTextAreaElement>

let host: HTMLDivElement
let root: Root

function render(over: Partial<React.ComponentProps<typeof AskComposer>> = {}): {
  onPickScope: ReturnType<typeof vi.fn>
  onClearTime: ReturnType<typeof vi.fn>
} {
  const onPickScope = vi.fn()
  const onClearTime = vi.fn()
  act(() => {
    root.render(createElement(AskComposer, {
      question: '',
      setQuestion: vi.fn(),
      onSubmit: vi.fn(),
      asking: false,
      onStop: vi.fn(),
      optLoading: false,
      onOptimize: vi.fn(),
      textareaRef,
      scopeUsername: 'group@chatroom',
      scopeDisplayName: '极速注销小程序',
      sessions: [],
      sessionsLoaded: true,
      from: '2026-11-01',
      to: '2026-11-26',
      onReloadSessions: vi.fn(),
      onPickScope,
      onFrom: vi.fn(),
      onTo: vi.fn(),
      onClearTime,
      ...over,
    }))
  })
  return { onPickScope, onClearTime }
}

function button(label: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll('button')].find(el => el.getAttribute('aria-label') === label)
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

describe('问答范围标签的小叉', () => {
  it('已选会话和时间时，两个小叉各自只取消自己那一项', () => {
    const { onPickScope, onClearTime } = render()
    const clearChat = button('取消选择的会话')
    const clearTime = button('取消时间范围')
    expect(clearChat).toBeTruthy()
    expect(clearTime).toBeTruthy()
    act(() => { clearChat?.click() })
    expect(onPickScope).toHaveBeenCalledWith('')
    expect(onClearTime).not.toHaveBeenCalled()
    act(() => { clearTime?.click() })
    expect(onClearTime).toHaveBeenCalledOnce()
    expect(onPickScope).toHaveBeenCalledOnce()
  })

  it('没选会话、也没设时间时不出现小叉', () => {
    render({ scopeUsername: '', scopeDisplayName: '', from: '', to: '' })
    expect(button('取消选择的会话')).toBeUndefined()
    expect(button('取消时间范围')).toBeUndefined()
    expect(host.textContent).not.toContain('范围：')
  })

  it('只选了会话时，时间仍是全部时间，不出现取消时间的小叉', () => {
    render({ from: '', to: '' })
    expect(button('取消选择的会话')).toBeTruthy()
    expect(button('取消时间范围')).toBeUndefined()
    expect(host.textContent).toContain('全部时间')
  })

  it('只设了时间时，不出现取消会话的小叉', () => {
    render({ scopeUsername: '', scopeDisplayName: '', from: '2026-11-01', to: '' })
    expect(button('取消选择的会话')).toBeUndefined()
    expect(button('取消时间范围')).toBeTruthy()
  })
})
