// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  apiListEnabledChatAiReplyStates: vi.fn(),
}))

vi.mock('../api-chat-ai-reply.ts', () => mocks)

import { MESSAGE_LIST_UPDATED_EVENT } from '../message-list-events.ts'
import {
  useChatAiReplyEnabledIndex,
  type ChatAiReplyEnabledIndex,
} from './use-chat-ai-reply-enabled.ts'

let host: HTMLDivElement
let root: Root
let latest: ChatAiReplyEnabledIndex | null = null

function Probe(): React.JSX.Element {
  const index = useChatAiReplyEnabledIndex()
  latest = index
  return createElement('div', {
    'data-enabled': [...index.enabledUsernames].sort().join(','),
    'data-loading': String(index.loading),
    'data-error': index.error ?? '',
  })
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

const attr = (name: string): string => host.querySelector('div')?.getAttribute(name) ?? ''

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  latest = null
  mocks.apiListEnabledChatAiReplyStates.mockReset().mockResolvedValue({
    ok: true,
    chats: [{ chatUsername: 'wxid_a', chatName: 'A', updatedAt: 1 }],
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
})

describe('会话列表 AI 回复索引', () => {
  it('批量回源后提供集合，本地开关先即时增删', async () => {
    act(() => { root.render(createElement(Probe)) })
    await flush()
    expect(attr('data-enabled')).toBe('wxid_a')
    expect(attr('data-loading')).toBe('false')

    act(() => { latest?.markEnabled('wxid_b', true) })
    expect(attr('data-enabled')).toBe('wxid_a,wxid_b')
    act(() => { latest?.markEnabled('wxid_a', false) })
    expect(attr('data-enabled')).toBe('wxid_b')
    expect(mocks.apiListEnabledChatAiReplyStates).toHaveBeenCalledTimes(1)
  })

  it('消息列表事件触发回源，读取失败保留缓存并显式报错', async () => {
    act(() => { root.render(createElement(Probe)) })
    await flush()
    mocks.apiListEnabledChatAiReplyStates.mockResolvedValueOnce({ ok: false, error: '读取失败' })

    await act(async () => {
      window.dispatchEvent(new Event(MESSAGE_LIST_UPDATED_EVENT))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(attr('data-enabled')).toBe('wxid_a')
    expect(attr('data-error')).toContain('读取失败')
    expect(mocks.apiListEnabledChatAiReplyStates).toHaveBeenCalledTimes(2)
  })

  it('慢回源不能覆盖之后发生的行内乐观切换', async () => {
    const slow = deferred<{
      ok: true
      chats: Array<{ chatUsername: string, chatName: string, updatedAt: number }>
    }>()
    mocks.apiListEnabledChatAiReplyStates.mockImplementationOnce(() => slow.promise)

    act(() => { root.render(createElement(Probe)) })
    expect(attr('data-loading')).toBe('true')

    act(() => {
      latest?.markEnabled('wxid_b', true)
      latest?.markEnabled('wxid_a', false)
    })
    expect(attr('data-enabled')).toBe('wxid_b')
    expect(attr('data-loading')).toBe('false')

    await act(async () => {
      slow.resolve({
        ok: true,
        chats: [{ chatUsername: 'wxid_a', chatName: 'A', updatedAt: 1 }],
      })
    })
    await flush()

    expect(attr('data-enabled')).toBe('wxid_b')
  })
})
