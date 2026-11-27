// @vitest-environment jsdom
/**
 * 「回复过程 · 工具调用」的渲染守卫（2026-11-24）。
 *
 * 为什么需要这一条：用户报「天气配好了却查不到」，而详情里既没有工具调用记录、
 * 也看不到失败原因 —— 那句 `tools=weather:unavailable` 只被拼进阶段行的一串文本里。
 * 现在它必须**单独成块**，并把失败码翻成人话。这里用假留痕真渲染一遍，
 * 断言界面真的出现了那三样东西。
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatAiReplyTraceRead } from '../api-chat-ai-reply.ts'

const TRACE: ChatAiReplyTraceRead = {
  ok: true,
  trace: {
    recordId: 114,
    sourceRef: 'ai-reply:wxid_self:wxid_peer:1000:2',
    accountKey: 'wxid_self',
    chatUsername: 'wxid_peer',
    model: 'deepseek/deepseek-flash',
    startedAt: 1_000,
    finishedAt: 12_000,
    context: '[2026-11-24 15:02] 对方：南宁明天会下雨吗？',
    kb: '',
    systemPrompt: '你是助手',
    userPrompt: '请回复最后一条',
    imageCount: 0,
    voiceCount: 0,
    output: '暂时无法查到实时天气，不能确认具体预报。',
    error: '',
    redacted: false,
    stages: [{ name: 'generated', at: 11_000, detail: 'chars=20 tools=weather:tool_network' }],
    tools: [
      { name: 'weather', ok: false, code: 'tool_network', elapsedMs: 6500 },
      { name: 'current_datetime', ok: true, elapsedMs: 1 },
    ],
    updatedAt: 12_000,
  },
}

const apiGetChatAiReplyTrace = vi.fn(async () => TRACE)
vi.mock('../api-chat-ai-reply.ts', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../api-chat-ai-reply.ts')>()
  return { ...mod, apiGetChatAiReplyTrace }
})

/** 在 mock 生效之后再导入组件（模块顶层会抓到被 mock 的实现）。 */
const { MessageListTraceSection } = await import('./message-list-detail-trace.tsx')

let host: HTMLDivElement
let root: Root

const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) await act(async () => { await Promise.resolve() })
}

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  apiGetChatAiReplyTrace.mockClear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
})

describe('回复过程：工具调用块', () => {
  it('列出每次调用的名称、成败、失败原因与耗时', async () => {
    await act(async () => { root.render(createElement(MessageListTraceSection, { recordId: 114 })) })
    await flush()
    const text = host.textContent ?? ''
    expect(text).toContain('工具调用')
    expect(text).toContain('weather')
    expect(text).toContain('失败')
    // 失败码翻成人话：用户要能判断是查网络还是改配置
    expect(text).toContain('网络不通')
    expect(text).toContain('6500 ms')
    // 成功的调用同样列出（否则看不出「到底调没调」）
    expect(text).toContain('current_datetime')
    expect(text).toContain('成功')
  })

  it('没有工具调用时不渲染这一块（不留一个空标题）', async () => {
    apiGetChatAiReplyTrace.mockResolvedValueOnce({
      ok: true,
      trace: { ...TRACE.trace, tools: [] },
    } as never)
    await act(async () => { root.render(createElement(MessageListTraceSection, { recordId: 115 })) })
    await flush()
    expect(host.textContent ?? '').not.toContain('工具调用')
  })
})
