// @vitest-environment jsdom
/**
 * `useAskSession` 的运行时字段映射与 threadState 往返。
 *
 * 这两件事都只能靠行为测试钉住：字段映射漏一个，界面就少一块证据；
 * threadState 不回传，下一轮就会出现「这个群」指代丢失而界面看起来一切正常。
 */
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UseAskSessionOptions, UseAskSessionResult } from './use-ask.ts'

const mocks = vi.hoisted(() => ({
  apiAskWechat: vi.fn(),
  apiCancelAsk: vi.fn(async () => ({ ok: true })),
}))

vi.mock('../api.ts', () => ({
  apiAskWechat: mocks.apiAskWechat,
  apiCancelAsk: mocks.apiCancelAsk,
  remote: vi.fn(),
  apiGetKbs: vi.fn(async () => ({ items: [], total: 0 })),
  readRenderCache: vi.fn(() => undefined),
  writeRenderCache: vi.fn(),
}))

const { useAskSession } = await import('./use-ask.ts')

let host: HTMLDivElement
let root: Root
let hook: UseAskSessionResult | null = null
let options: UseAskSessionOptions = { source: 'ask', threadKey: 'spec' }

function Harness(): React.JSX.Element {
  hook = useAskSession(options)
  return createElement('div')
}

function setOptions(next: UseAskSessionOptions): void {
  options = next
  act(() => { root.render(createElement(Harness)) })
}

const runtimeFields = {
  status: 'degraded' as const,
  statusReason: '一个来源检索失败，已用其余证据回答',
  synthesisError: '',
  toolCalls: [{
    index: 0, round: 1, callId: 'call-1', name: 'search_messages',
    argumentsSummary: 'query=合同', ok: true, deduplicated: false,
    attempts: 1, retries: 0, elapsedMs: 12, hits: 2, facts: 0,
  }],
  evidence: {
    items: [],
    facts: [],
    status: 'degraded' as const,
    missing: ['search_files'],
    stats: {
      count: 0, messages: 0, kb: 0, sessions: 0, candidateCount: 2, total: 0,
      hitCount: 0, factCount: 0, duplicateCount: 0, droppedByBudget: 0,
      truncated: false, snippetChars: 0, sourceCounts: { msg: 0, kb: 0, agg: 0, resource: 0 },
      toolCounts: { search_messages: 2 }, failedTools: ['search_files'],
      attemptedTools: 2, successfulTools: 1,
    },
    assessment: { status: 'missing' as const, sufficient: false, usableItems: 0, reason: '无可用证据' },
  },
  resources: [{
    evidenceId: 'res:1', tool: 'search_files', key: 'file:报价.xlsx', name: '报价.xlsx',
    time: '2026-10-02 12:00', snippet: '18 KB',
    locator: { type: 'resource' as const, tool: 'search_files', key: 'file:报价.xlsx' },
  }],
  threadState: { activeSession: 'wxid_a', turns: 1, history: [{ role: 'user' as const, content: '第一问' }] },
  grounding: { checked: 2, unsupported: [], cited: 1, repaired: false },
}

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  mocks.apiAskWechat.mockReset()
  mocks.apiCancelAsk.mockClear()
  options = { source: 'ask', threadKey: 'spec' }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  hook = null
  act(() => { root.render(createElement(Harness)) })
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
})

describe('useAskSession：运行时结果与多轮状态', () => {
  it('映射新增字段，并把上一轮 threadState 原样带给下一轮请求', async () => {
    mocks.apiAskWechat
      .mockResolvedValueOnce({
        answer: '第一答',
        citations: [],
        ...runtimeFields,
      })
      .mockResolvedValueOnce({ answer: '第二答', citations: [] })

    await act(async () => { await hook?.ask('第一问') })
    const first = hook?.turns.find(t => t.role === 'assistant')
    expect(first).toMatchObject({
      status: 'degraded',
      statusReason: runtimeFields.statusReason,
      toolCalls: runtimeFields.toolCalls,
      evidence: runtimeFields.evidence,
      resources: runtimeFields.resources,
      threadState: runtimeFields.threadState,
      grounding: runtimeFields.grounding,
    })

    const firstRequest = mocks.apiAskWechat.mock.calls[0]?.[0] as Record<string, unknown>
    expect(firstRequest['threadState']).toBeUndefined()

    await act(async () => { await hook?.ask('第二问') })
    const secondRequest = mocks.apiAskWechat.mock.calls[1]?.[0] as Record<string, unknown>
    expect(secondRequest['threadState']).toEqual(runtimeFields.threadState)
    expect(secondRequest['history']).toEqual([
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '第一答' },
    ])
  })

  it('旧后端不返回运行时字段时，不要凭空补默认值', async () => {
    mocks.apiAskWechat.mockResolvedValueOnce({ answer: '旧回答', citations: [] })
    await act(async () => { await hook?.ask('旧问题') })
    const assistant = hook?.turns.find(t => t.role === 'assistant')
    expect(assistant).toBeDefined()
    expect(assistant).not.toHaveProperty('status')
    expect(assistant).not.toHaveProperty('toolCalls')
    expect(assistant).not.toHaveProperty('threadState')
  })

  it('范围切换后不携带旧范围的 threadState', async () => {
    mocks.apiAskWechat
      .mockResolvedValueOnce({ answer: 'A 范围回答', citations: [], ...runtimeFields })
      .mockResolvedValueOnce({ answer: 'B 范围回答', citations: [] })

    await act(async () => { await hook?.ask('A 范围问题') })
    setOptions({ source: 'ask', threadKey: 'spec', from: '2026-10-01', to: '2026-10-07' })
    await act(async () => { await hook?.ask('B 范围问题') })

    const secondRequest = mocks.apiAskWechat.mock.calls[1]?.[0] as Record<string, unknown>
    expect(secondRequest['threadState']).toBeUndefined()
    expect(secondRequest['from']).toBe('2026-10-01')
    expect(secondRequest['to']).toBe('2026-10-07')
    expect(hook?.turns.map(t => t.text)).toEqual(['B 范围问题', 'B 范围回答'])
  })

  it('知识库切换时取消旧请求，不把旧库结果写进新库线程', async () => {
    let resolveOldKb: ((value: unknown) => void) | null = null
    mocks.apiAskWechat
      .mockImplementationOnce(() => new Promise(resolve => { resolveOldKb = resolve }))
      .mockResolvedValueOnce({ answer: '新库回答', citations: [] })

    setOptions({ source: 'ask', threadKey: 'spec', useKb: true, kbId: 1 })
    let oldRequest: Promise<void> | undefined
    act(() => { oldRequest = hook?.ask('旧库问题') })
    expect(mocks.apiAskWechat.mock.calls[0]?.[0]).toMatchObject({ kbId: 1 })

    setOptions({ source: 'ask', threadKey: 'spec', useKb: true, kbId: 2 })
    expect(hook?.asking).toBe(false)
    expect(mocks.apiCancelAsk).toHaveBeenCalledTimes(1)

    await act(async () => { await hook?.ask('新库问题') })
    expect(mocks.apiAskWechat.mock.calls[1]?.[0]).toMatchObject({ kbId: 2 })

    await act(async () => {
      resolveOldKb?.({ answer: '旧库回答', citations: [] })
      await oldRequest
    })
    expect(hook?.turns.map(t => t.text)).toEqual(['新库问题', '新库回答'])
  })

  it('知识库切换后不继承旧库的 threadState', async () => {
    mocks.apiAskWechat
      .mockResolvedValueOnce({ answer: '一库回答', citations: [], ...runtimeFields })
      .mockResolvedValueOnce({ answer: '二库回答', citations: [] })

    setOptions({ source: 'ask', threadKey: 'spec', useKb: true, kbId: 1 })
    await act(async () => { await hook?.ask('一库问题') })
    setOptions({ source: 'ask', threadKey: 'spec', useKb: true, kbId: 2 })
    await act(async () => { await hook?.ask('二库问题') })

    const secondRequest = mocks.apiAskWechat.mock.calls[1]?.[0] as Record<string, unknown>
    expect(secondRequest['threadState']).toBeUndefined()
    expect(secondRequest['kbId']).toBe(2)
    expect(hook?.turns.map(t => t.text)).toEqual(['二库问题', '二库回答'])
  })

  it('请求失败后不向更早轮次回溯 threadState', async () => {
    mocks.apiAskWechat
      .mockResolvedValueOnce({ answer: '第一答', citations: [], ...runtimeFields })
      .mockRejectedValueOnce(new Error('网络失败'))
      .mockResolvedValueOnce({ answer: '第三答', citations: [] })

    await act(async () => { await hook?.ask('第一问') })
    await act(async () => { await hook?.ask('第二问会失败') })
    expect(hook?.error).toBe('网络失败')
    expect(hook?.turns.at(-1)).toMatchObject({
      role: 'assistant',
      status: 'failed',
      statusReason: '网络失败',
      errorCode: 'ASK_FAILED',
    })
    await act(async () => { await hook?.ask('第三问') })

    const thirdRequest = mocks.apiAskWechat.mock.calls[2]?.[0] as Record<string, unknown>
    expect(thirdRequest['threadState']).toBeUndefined()
  })

  it('用户取消后不向更早轮次回溯 threadState', async () => {
    mocks.apiAskWechat
      .mockResolvedValueOnce({ answer: '第一答', citations: [], ...runtimeFields })
      .mockRejectedValueOnce(Object.assign(new Error('已取消'), { code: 'ASK_CANCELED' }))
      .mockResolvedValueOnce({ answer: '第三答', citations: [] })

    await act(async () => { await hook?.ask('第一问') })
    await act(async () => { await hook?.ask('第二问被取消') })
    await act(async () => { await hook?.ask('第三问') })

    const thirdRequest = mocks.apiAskWechat.mock.calls[2]?.[0] as Record<string, unknown>
    expect(thirdRequest['threadState']).toBeUndefined()
  })

  it('停止时立即收尾，保留部分正文、思考与工具过程，迟到回答不再写入', async () => {
    let resolveAsk: ((value: unknown) => void) | null = null
    mocks.apiAskWechat.mockImplementationOnce(() => new Promise(resolve => { resolveAsk = resolve }))

    let asking: Promise<void> | undefined
    act(() => { asking = hook?.ask('会停止的问题') })
    expect(hook?.asking).toBe(true)

    // 模拟后端已推送的正文、思考与工具事件在停止前到达。
    act(() => {
      window.dispatchEvent(new CustomEvent('dsh-wechat-ask-delta', {
        detail: { id: (mocks.apiAskWechat.mock.calls[0]?.[0] as { streamId: string }).streamId, text: '已经写了一半' },
      }))
      window.dispatchEvent(new CustomEvent('dsh-wechat-ask-reasoning', {
        detail: { id: (mocks.apiAskWechat.mock.calls[0]?.[0] as { streamId: string }).streamId, text: '思考片段' },
      }))
      window.dispatchEvent(new CustomEvent('dsh-wechat-ask-stage', {
        detail: {
          id: (mocks.apiAskWechat.mock.calls[0]?.[0] as { streamId: string }).streamId,
          key: 'tool:0:search_messages', label: 'search_messages', status: 'failed',
          phase: 'failed', callId: 'c1', toolName: 'search_messages', errorClass: 'timeout',
        },
      }))
    })
    act(() => { hook?.cancel() })

    const stopped = hook?.turns.at(-1)
    expect(stopped).toMatchObject({ role: 'assistant', stopped: true })
    expect(stopped?.text).toContain('已经写了一半')
    expect(stopped?.reasoning).toBe('思考片段')
    expect(stopped?.stages?.[0]).toMatchObject({ callId: 'c1', status: 'failed' })
    expect(hook?.asking).toBe(false)
    expect(mocks.apiCancelAsk).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveAsk?.({ answer: '迟到的完整回答', citations: [] })
      await asking
    })
    expect(hook?.turns.map(t => t.text)).toEqual(['会停止的问题', '已经写了一半\n\n（已停止生成）'])
  })

  it('失败后保留部分正文与错误码，可一键重试并替换失败轮次', async () => {
    mocks.apiAskWechat
      .mockRejectedValueOnce(Object.assign(new Error('模型请求超时'), { code: 'MODEL_TIMEOUT' }))
      .mockResolvedValueOnce({ answer: '重试成功', citations: [] })

    await act(async () => { await hook?.ask('需要重试的问题') })
    const failedIndex = hook?.turns.findIndex(t => t.status === 'failed') ?? -1
    expect(failedIndex).toBe(1)
    expect(hook?.turns[failedIndex]).toMatchObject({
      status: 'failed',
      errorCode: 'MODEL_TIMEOUT',
      statusReason: '模型请求超时',
    })

    await act(async () => { await hook?.retry(failedIndex) })
    expect(hook?.turns.map(t => t.text)).toEqual(['需要重试的问题', '重试成功'])
    expect(hook?.error).toBeNull()
    expect(mocks.apiAskWechat.mock.calls[1]?.[0]).toMatchObject({ question: '需要重试的问题' })
  })

  it('切换范围时释放旧轮次闸门，并取消旧请求', async () => {
    let resolveFirst: ((value: unknown) => void) | null = null
    mocks.apiAskWechat
      .mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve }))
      .mockResolvedValueOnce({ answer: '新范围回答', citations: [] })

    let firstAsk: Promise<void> | undefined
    act(() => { firstAsk = hook?.ask('旧范围问题') })
    expect(hook?.asking).toBe(true)

    setOptions({ source: 'ask', threadKey: 'spec', scopeUsername: 'wxid_new' })
    expect(hook?.asking).toBe(false)
    expect(mocks.apiCancelAsk).toHaveBeenCalledTimes(1)

    await act(async () => { await hook?.ask('新范围问题') })
    expect(mocks.apiAskWechat.mock.calls[1]?.[0]).toMatchObject({
      question: '新范围问题',
      username: 'wxid_new',
    })

    await act(async () => {
      resolveFirst?.({ answer: '旧范围回答', citations: [] })
      await firstAsk
    })
  })

  it('清空对话时作废在飞回答、释放闸门并立即允许下一问', async () => {
    let resolveFirst: ((value: unknown) => void) | null = null
    mocks.apiAskWechat
      .mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve }))
      .mockResolvedValueOnce({ answer: '新回答', citations: [] })

    let firstAsk: Promise<void> | undefined
    act(() => { firstAsk = hook?.ask('会被清空的问题') })
    expect(hook?.asking).toBe(true)
    act(() => { hook?.resetAndCancel() })
    expect(hook?.asking).toBe(false)
    expect(hook?.turns.map(t => t.text)).toEqual([])
    expect(mocks.apiCancelAsk).toHaveBeenCalledTimes(1)

    await act(async () => { await hook?.ask('清空后的新问题') })
    await act(async () => {
      resolveFirst?.({ answer: '迟到的旧回答', citations: [] })
      await firstAsk
    })

    expect(hook?.turns.map(t => t.text)).toEqual(['清空后的新问题', '新回答'])
  })

  it('切换范围后给旧线程补停止标记，而不只是留下孤立提问', async () => {
    let resolveFirst: ((value: unknown) => void) | null = null
    mocks.apiAskWechat
      .mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve }))
      .mockResolvedValueOnce({ answer: 'B 回答', citations: [] })

    let firstAsk: Promise<void> | undefined
    act(() => { firstAsk = hook?.ask('A 范围问题') })
    setOptions({ source: 'ask', threadKey: 'spec', scopeUsername: 'wxid_b' })
    await act(async () => { await hook?.ask('B 范围问题') })

    setOptions({ source: 'ask', threadKey: 'spec' })
    expect(hook?.turns.map(t => t.text)).toEqual(['A 范围问题', '（已停止生成）'])

    await act(async () => {
      resolveFirst?.({ answer: '迟到的 A 回答', citations: [] })
      await firstAsk
    })
  })
})
