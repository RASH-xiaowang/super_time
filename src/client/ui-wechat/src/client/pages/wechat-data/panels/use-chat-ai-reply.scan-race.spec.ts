// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatAiReplyScanResult, ChatAiReplyState } from '@deepseek-ai/dsh-wechat-data/types'
import {
  useChatAiReply,
  type ChatAiReplyController,
} from './use-chat-ai-reply.ts'

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
