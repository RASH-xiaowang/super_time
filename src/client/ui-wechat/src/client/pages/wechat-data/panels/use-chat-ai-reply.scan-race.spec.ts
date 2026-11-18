// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatAiReplyScanResult, ChatAiReplyState } from '@deepseek-ai/dsh-wechat-data/types'
import {
  useChatAiReply,
  type ChatAiReplyController,
} from './use-chat-ai-reply.ts'
import { MESSAGE_LIST_UPDATED_EVENT } from '../message-list-events.ts'

const mocks = vi.hoisted(() => ({
  apiGetChatAiReplyState: vi.fn(),
  apiScanChatAiReplyNow: vi.fn(),
  apiSetChatAiReplyEnabled: vi.fn(),
}))

vi.mock('../api-chat-ai-reply.ts', () => ({
  apiGetChatAiReplyState: mocks.apiGetChatAiReplyState,
  apiScanChatAiReplyNow: mocks.apiScanChatAiReplyNow,
  apiSetChatAiReplyEnabled: mocks.apiSetChatAiReplyEnabled,
}))

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
} {
  let resolve: (value: T) => void = () => undefined
  let reject: (reason: unknown) => void = () => undefined
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

function scanResult(queued: number): ChatAiReplyScanResult {
  return { scanned: 1, queued, created: queued, dispatched: 0 }
}

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
let notices: string[] = []

function Probe({ chatUsername, sessionEpoch }: {
  chatUsername: string
  sessionEpoch: number
}): React.JSX.Element {
  latest = useChatAiReply({
    chatUsername,
    chatName: chatUsername.toUpperCase(),
    isGroup: false,
    selfWxid: 'wxid_self',
    sessionEpoch,
    alive: (epoch, talker) => epoch === sessionEpoch && talker === chatUsername,
    onNotice: (text) => { notices.push(text) },
  })
  return createElement('div', {
    'data-scanning': String(latest.scanning),
    'data-saving': String(latest.saving),
    'data-enabled': String(latest.state?.enabled === true),
    'data-revision': String(latest.state?.revision ?? 0),
    'data-error': latest.error ?? '',
  })
}

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await act(async () => { await Promise.resolve() })
  }
}

function renderProbe(chatUsername: string, sessionEpoch: number): void {
  act(() => {
    root.render(createElement(Probe, { chatUsername, sessionEpoch }))
  })
}

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  latest = null
  notices = []
  mocks.apiGetChatAiReplyState.mockReset().mockImplementation(
    async ({ chatUsername }: { chatUsername: string }) => stateFor(chatUsername),
  )
  mocks.apiScanChatAiReplyNow.mockReset()
  mocks.apiSetChatAiReplyEnabled.mockReset()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
})

describe('AI 回复立即扫描的会话隔离', () => {
  it('切换会话会释放扫描锁，旧扫描不得刷新、提示或覆盖新会话', async () => {
    const oldScan = deferred<ChatAiReplyScanResult>()
    const newScan = deferred<ChatAiReplyScanResult>()
    mocks.apiScanChatAiReplyNow
      .mockImplementationOnce(() => oldScan.promise)
      .mockImplementationOnce(() => newScan.promise)

    renderProbe('wxid_a', 1)
    await flush()
    act(() => { void latest?.scanNow() })
    await flush()
    expect(host.firstElementChild?.getAttribute('data-scanning')).toBe('true')

    renderProbe('wxid_b', 2)
    await flush()
    expect(host.firstElementChild?.getAttribute('data-scanning')).toBe('false')

    act(() => { void latest?.scanNow() })
    await flush()
    expect(mocks.apiScanChatAiReplyNow).toHaveBeenCalledTimes(2)

    await act(async () => { newScan.resolve(scanResult(0)) })
    await flush()
    const readsAfterNewScan = mocks.apiGetChatAiReplyState.mock.calls.length
    const noticesAfterNewScan = notices.length

    await act(async () => { oldScan.resolve(scanResult(9)) })
    await flush()

    expect(mocks.apiGetChatAiReplyState).toHaveBeenCalledTimes(readsAfterNewScan)
    expect(notices).toHaveLength(noticesAfterNewScan)
    expect(notices.join('\n')).not.toContain('9')
    expect(host.firstElementChild?.getAttribute('data-error')).toBe('')
  })

  it('旧会话扫描迟到失败时不得在新会话报错', async () => {
    const oldScan = deferred<ChatAiReplyScanResult>()
    mocks.apiScanChatAiReplyNow.mockImplementationOnce(() => oldScan.promise)

    renderProbe('wxid_a', 1)
    await flush()
    act(() => { void latest?.scanNow() })
    await flush()

    renderProbe('wxid_b', 2)
    await flush()
    const noticesBefore = notices.length

    await act(async () => { oldScan.reject(new Error('old scan failed')) })
    await flush()

    expect(notices).toHaveLength(noticesBefore)
    expect(notices.join('\n')).not.toContain('old scan failed')
    expect(host.firstElementChild?.getAttribute('data-error')).toBe('')
  })
})

describe('AI 回复开关：关掉之后必须还能再开', () => {
  it('写入期间的静默回源不会让 saving 永久为真（否则按钮永久变灰）', async () => {
    const offWrite = deferred<{ ok: true; state: ChatAiReplyState }>()
    const onWrite = deferred<{ ok: true; state: ChatAiReplyState }>()
    mocks.apiSetChatAiReplyEnabled
      .mockImplementationOnce(() => offWrite.promise)
      .mockImplementationOnce(() => onWrite.promise)

    renderProbe('wxid_a', 1)
    await flush()
    expect(host.firstElementChild?.getAttribute('data-enabled')).toBe('true')
    const readsAfterLoad = mocks.apiGetChatAiReplyState.mock.calls.length

    // ① 关闭：写入在飞
    act(() => { void latest?.toggle() })
    await flush()
    expect(host.firstElementChild?.getAttribute('data-saving')).toBe('true')

    // 写入期间来一次消息列表事件 —— 实测就是这次回源把 requestId 推走，
    // 让写结果被判成过期，`saving` 于是再也收不回来。
    vi.useFakeTimers()
    act(() => { window.dispatchEvent(new Event(MESSAGE_LIST_UPDATED_EVENT)) })
    await act(async () => { vi.advanceTimersByTime(2500) })
    vi.useRealTimers()
    await flush()

    expect(
      mocks.apiGetChatAiReplyState.mock.calls.length,
      '写期间的回源没有让路',
    ).toBe(readsAfterLoad)

    await act(async () => {
      offWrite.resolve({ ok: true, state: { ...stateFor('wxid_a'), enabled: false, revision: 2 } })
    })
    await flush()
    expect(host.firstElementChild?.getAttribute('data-saving'), 'saving 没有收回').toBe('false')
    expect(host.firstElementChild?.getAttribute('data-enabled')).toBe('false')

    // ② 再开启：按钮必须仍可点，且带上一轮的新 revision。
    act(() => { void latest?.toggle() })
    await flush()
    expect(mocks.apiSetChatAiReplyEnabled, '第二次开启没有发出请求').toHaveBeenCalledTimes(2)
    expect(mocks.apiSetChatAiReplyEnabled.mock.calls[1]?.[0]).toMatchObject({
      enabled: true,
      expectedRevision: 2,
    })

    await act(async () => {
      onWrite.resolve({ ok: true, state: { ...stateFor('wxid_a'), enabled: true, revision: 3 } })
    })
    await flush()
    expect(host.firstElementChild?.getAttribute('data-enabled')).toBe('true')
    expect(host.firstElementChild?.getAttribute('data-saving')).toBe('false')
  })
})
