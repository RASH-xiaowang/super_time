// @vitest-environment jsdom
/**
 * 历史记录展开后的阅读顺序必须与实时/完成态一致：
 * 执行轨迹（本轮思考在工具调用之前）→ 正式回答正文 → 证据。
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AskHistoryEntry } from '@deepseek-ai/dsh-wechat-data/types'

const mocks = vi.hoisted(() => ({
  apiGetAskHistory: vi.fn(),
  apiDeleteAskHistory: vi.fn(),
  apiClearAskHistory: vi.fn(),
}))

vi.mock('../api.ts', () => ({
  apiGetAskHistory: mocks.apiGetAskHistory,
  apiDeleteAskHistory: mocks.apiDeleteAskHistory,
  apiClearAskHistory: mocks.apiClearAskHistory,
}))

import { AskHistoryDialog } from './AskHistoryDialog.tsx'

const entry: AskHistoryEntry = {
  id: 1,
  ts: Date.parse('2026-11-02T10:00:00+08:00'),
  question: '上次是怎么处理的？',
  answer: '正式回答正文',
  source: 'ask',
  username: '',
  usernameName: '',
  from: '',
  to: '',
  model: 'test-model',
  intent: 'lookup',
  terms: ['处理'],
  citations: [],
  citedIndexes: [],
  basis: '基于 1 条消息',
  status: 'ok',
  error: '',
  retrieval: null,
  runtimeTrace: {
    version: 1,
    truncated: false,
    toolCallTotal: 1,
    stages: [{
      key: 'tool:search:1',
      label: 'search_messages',
      status: 'done',
      phase: 'completed',
      round: 1,
      callId: 'call-1',
      toolName: 'search_messages',
    }],
    toolCalls: [{
      index: 0,
      round: 1,
      callId: 'call-1',
      name: 'search_messages',
      ok: true,
      deduplicated: false,
      attempts: 1,
      retries: 0,
      elapsedMs: 12,
      hits: 1,
      facts: 0,
    }],
    reasoningSegments: [{
      key: 'reasoning:tool:1',
      round: 1,
      phase: 'tool_selection',
      text: '第一轮思考',
      seq: 1,
    }],
  },
  elapsedMs: 20,
}

let host: HTMLDivElement
let root: Root

const flush = async (times = 5): Promise<void> => {
  for (let i = 0; i < times; i += 1) await act(async () => { await Promise.resolve() })
}

const need = (selector: string): Element => {
  const found = document.querySelector(selector)
  expect(found, `${selector} 没找到`).not.toBeNull()
  return found as Element
}

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  mocks.apiGetAskHistory.mockReset()
  mocks.apiDeleteAskHistory.mockReset()
  mocks.apiClearAskHistory.mockReset()
  mocks.apiGetAskHistory.mockResolvedValue({
    items: [entry],
    total: 1,
    statusCounts: { ok: 1 },
    sourceCounts: { ask: 1 },
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
})

describe('AskHistoryDialog 展示顺序', () => {
  it('会话范围会写入历史查询，且不提供清空全局历史的入口', async () => {
    act(() => {
      root.render(createElement(AskHistoryDialog, {
        open: true,
        onClose: () => undefined,
        scopeUsername: 'wxid_room',
        scopeName: '项目群',
      }))
    })
    await flush()

    expect(mocks.apiGetAskHistory).toHaveBeenCalledWith(expect.objectContaining({
      username: 'wxid_room',
    }))
    expect(document.querySelector('[data-clear-ask-history]')).toBeNull()
    expect(document.body.textContent).toContain('项目群的问答历史')
  })

  it('本轮思考在工具调用之前，正式回答在证据之前', async () => {
    act(() => {
      root.render(createElement(AskHistoryDialog, { open: true, onClose: () => undefined }))
    })
    await flush()

    const expand = [...document.querySelectorAll('button')]
      .find(button => button.textContent?.trim() === '展开')
    expect(expand, '历史记录展开按钮没找到').toBeDefined()
    act(() => { expand?.click() })
    const thinkingToggle = need('[data-thinking-toggle]')
    act(() => { (thinkingToggle as HTMLButtonElement).click() })

    const meta = need('[data-ask-history-meta]')
    const trace = need('[data-ask-history-trace]')
    const evidence = need('[data-ask-history-evidence]')
    const answer = need('[data-ask-history-answer]')

    expect(meta.compareDocumentPosition(trace) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    expect(trace.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    expect(answer.compareDocumentPosition(evidence) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)

    const traceText = trace.textContent ?? ''
    expect(traceText.indexOf('消息检索')).toBeGreaterThan(-1)
    expect(traceText.indexOf('第一轮思考')).toBeGreaterThan(-1)
    expect(traceText.indexOf('第一轮思考')).toBeLessThan(traceText.indexOf('消息检索'))
  })
})
