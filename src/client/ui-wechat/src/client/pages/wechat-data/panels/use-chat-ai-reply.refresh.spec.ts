// @vitest-environment jsdom
/**
 * 当前会话 AI 状态的事件刷新守卫。
 *
 * 消息列表事件只做尾随去抖后的静默回源；隐藏页不发请求；静默刷新不得把
 * loading 翻起来，否则整个 AI 回复菜单会在后台轮询时闪烁“处理中”。
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatAiReplyState } from '@deepseek-ai/dsh-wechat-data/types'
import {
  CHAT_AI_REPLY_REFRESH_DEBOUNCE_MS,
  useChatAiReply,
  type ChatAiReplyController,
} from './use-chat-ai-reply.ts'
import { MESSAGE_LIST_UPDATED_EVENT } from '../message-list-events.ts'

const mocks = vi.hoisted(() => ({
  apiGetChatAiReplyState: vi.fn(),
  apiScanChatAiReplyNow: vi.fn(),
  apiSetChatAiReplyEnabled: vi.fn(),
  apiSetChatAiReplyPersona: vi.fn(),
}))

vi.mock('../api-chat-ai-reply.ts', () => ({
  apiGetChatAiReplyState: mocks.apiGetChatAiReplyState,
  apiScanChatAiReplyNow: mocks.apiScanChatAiReplyNow,
  apiSetChatAiReplyEnabled: mocks.apiSetChatAiReplyEnabled,
  apiSetChatAiReplyPersona: mocks.apiSetChatAiReplyPersona,
}))

function stateFor(chatUsername: string): ChatAiReplyState {
  return {
    accountKey: 'wxid_self',
    chatUsername,
    chatName: chatUsername.toUpperCase(),
    enabled: true,
    provider: 'dsh-wechat-bridge',
    splitReply: true,
    personaName: '',
    personaPrompt: '',
    kbEnabled: false,
    kbId: 0,
    contextWindowHours: 0,
    revision: 1,
    updatedAt: 1,
    cursor: '',
    stage: 'idle',
  }
}

let host: HTMLDivElement
let root: Root
let latest: ChatAiReplyController | null = null
let hidden = false

function Probe(): React.JSX.Element {
  latest = useChatAiReply({
    chatUsername: 'wxid_a',
    chatName: 'WXID_A',
    isGroup: false,
    selfWxid: 'wxid_self',
    sessionEpoch: 1,
    alive: (epoch, talker) => epoch === 1 && talker === 'wxid_a',
    onNotice: () => {},
  })
  return createElement('div', {
    'data-loading': String(latest.loading),
    'data-has-state': String(latest.state !== null),
  })
}

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await act(async () => { await Promise.resolve() })
  }
}

const attr = (name: string): string => host.querySelector('div')?.getAttribute(name) ?? ''

async function mount(): Promise<void> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => { root.render(createElement(Probe)) })
  await flush()
}

function dispatchUpdated(times: number): void {
  act(() => {
    for (let i = 0; i < times; i += 1) {
      window.dispatchEvent(new Event(MESSAGE_LIST_UPDATED_EVENT))
    }
  })
}

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  latest = null
  hidden = false
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => hidden,
  })
  mocks.apiGetChatAiReplyState.mockReset().mockImplementation(
    async ({ chatUsername }: { chatUsername: string }) => stateFor(chatUsername),
  )
  mocks.apiScanChatAiReplyNow.mockReset()
  mocks.apiSetChatAiReplyEnabled.mockReset()
  mocks.apiSetChatAiReplyPersona.mockReset()
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  vi.useRealTimers()
})

describe('当前会话 AI 状态的事件刷新', () => {
  it('连续 5 次消息列表事件只回源一次', async () => {
    await mount()
    expect(mocks.apiGetChatAiReplyState).toHaveBeenCalledTimes(1)
    expect(attr('data-has-state')).toBe('true')

    dispatchUpdated(5)
    await act(async () => {
      vi.advanceTimersByTime(CHAT_AI_REPLY_REFRESH_DEBOUNCE_MS - 1)
    })
    expect(mocks.apiGetChatAiReplyState, '去抖窗口内不得提前请求').toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(1)
    })
    await flush()
    expect(mocks.apiGetChatAiReplyState).toHaveBeenCalledTimes(2)
    expect(attr('data-loading')).toBe('false')
  })

  it('页面隐藏时事件刷新完全跳过', async () => {
    hidden = true
    await mount()
    expect(mocks.apiGetChatAiReplyState).toHaveBeenCalledTimes(1)

    dispatchUpdated(5)
    await act(async () => {
      vi.advanceTimersByTime(CHAT_AI_REPLY_REFRESH_DEBOUNCE_MS * 3)
    })
    await flush()

    expect(mocks.apiGetChatAiReplyState, '隐藏页不应回源').toHaveBeenCalledTimes(1)
  })

  it('静默刷新不改 loading，状态照常回写', async () => {
    let finish: ((state: ChatAiReplyState) => void) | null = null
    mocks.apiGetChatAiReplyState
      .mockImplementationOnce(async ({ chatUsername }: { chatUsername: string }) => stateFor(chatUsername))
      .mockImplementationOnce(() => new Promise<ChatAiReplyState>((resolve) => {
        finish = resolve
      }))

    await mount()
    expect(attr('data-loading')).toBe('false')

    dispatchUpdated(1)
    await act(async () => {
      vi.advanceTimersByTime(CHAT_AI_REPLY_REFRESH_DEBOUNCE_MS)
    })
    await flush()
    expect(mocks.apiGetChatAiReplyState).toHaveBeenCalledTimes(2)
    expect(attr('data-loading'), '静默请求在飞期间不得翻 loading').toBe('false')

    await act(async () => {
      finish?.(stateFor('wxid_a'))
      await Promise.resolve()
    })
    await flush()
    expect(attr('data-loading')).toBe('false')
    expect(attr('data-has-state')).toBe('true')
  })
})
