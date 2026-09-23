/**
 * 「实际发出去的嵌入模型名」与「给调用方记账用的名字」必须是同一个值。
 *
 * 这条为什么要单独测（而不是靠网关那层的用例）：网关测试注入的是**桩 llm**，
 * 真宿主桥根本不在链路上 —— 于是 `embed()` 与 `embeddingModelName()` 之间一旦分家
 * （各写一遍优先级），网关用例全绿而线上照错。这正是 §7 F1 的成因形状：
 * 记账那条链读 `rag-config.embedding.model || 'default'`，发送那条链读 llm.json 的值。
 *
 * 断言的是**行为**：假 fetch 收到的 `body.model` 与 `embeddingModelName()` 的返回逐字相同。
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error —— 宿主层是 CommonJS，无类型声明
import { createLlmBridge } from '../wechat-host.js'
import { at } from './helpers/strict-index.ts'

/** 造一个记录请求体的假 fetch，返回固定的 embedding 响应。 */
function captureFetch(dim = 3) {
  const seen: Array<{ url: string; body: Record<string, unknown> }> = []
  const fn = async (url: string, init: { body?: string }) => {
    seen.push({ url, body: JSON.parse(String(init.body ?? '{}')) })
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: [{ index: 0, embedding: new Array(dim).fill(0.5) }] }),
      text: async () => 'ok',
      headers: { get: () => null },
    }
  }
  return { fn, seen }
}

const BASE = { apiKey: 'k', baseUrl: 'https://example.test/v1', embedPath: '/embeddings', timeoutMs: 5000 }

afterEach(() => { vi.unstubAllGlobals() })

describe('嵌入模型名的单一解析', () => {
  it('配了 embeddingModel ⇒ 发出去的名字与报给调用方的名字逐字相同', async () => {
    const { fn, seen } = captureFetch()
    vi.stubGlobal('fetch', fn)
    const bridge = createLlmBridge({ ...BASE, model: 'chat-model', embeddingModel: 'embed-model-a' })

    expect(bridge.embeddingModelName()).toBe('embed-model-a')
    await bridge.embed(['一段文本'])
    expect(seen).toHaveLength(1)
    // 这条是重点：记账方拿到的名字必须就是请求里那个
    expect(at(seen, 0, '请求').body.model).toBe(bridge.embeddingModelName())
  })

  it('没配 embeddingModel ⇒ 回退到 chat 模型，且两边同样一致', async () => {
    const { fn, seen } = captureFetch()
    vi.stubGlobal('fetch', fn)
    const bridge = createLlmBridge({ ...BASE, model: 'chat-only', embeddingModel: '' })

    expect(bridge.embeddingModelName()).toBe('chat-only')
    await bridge.embed(['x'])
    expect(at(seen, 0, '请求').body.model).toBe('chat-only')
  })

  it('调用方点名一个模型 ⇒ 两边都用点名的那个（按库绑定的通路）', async () => {
    const { fn, seen } = captureFetch()
    vi.stubGlobal('fetch', fn)
    const bridge = createLlmBridge({ ...BASE, model: 'chat-model', embeddingModel: 'embed-model-a' })

    expect(bridge.embeddingModelName('per-library-bge')).toBe('per-library-bge')
    await bridge.embed(['x'], { model: 'per-library-bge' })
    expect(at(seen, 0, '请求').body.model).toBe('per-library-bge')
  })

  it('嵌入端点/Key 留空 ⇒ 回落 chat 那一对；填了就用自己的（判定用回落后的值）', async () => {
    const { fn, seen } = captureFetch()
    vi.stubGlobal('fetch', fn)
    const bridge = createLlmBridge({
      ...BASE, model: 'chat-model', embeddingModel: 'embed-a',
      embeddingApiUrl: 'https://embed.internal/v1', embeddingApiKey: 'sk-embed',
    })
    await bridge.embed(['x'])
    expect(at(seen, 0, '请求').url).toBe('https://embed.internal/v1/embeddings')
    // 用的是嵌入那对 Key，不是 chat 的 'k'
    expect(at(seen, 0, '请求').url).not.toContain('example.test')

    const { fn: fn2, seen: seen2 } = captureFetch()
    vi.stubGlobal('fetch', fn2)
    const shared = createLlmBridge({ ...BASE, model: 'chat-model', embeddingModel: 'embed-a', embeddingApiUrl: '', embeddingApiKey: '' })
    await shared.embed(['x'])
    expect(at(seen2, 0, '请求').url).toBe('https://example.test/v1/embeddings')
  })

  it('只填了 embeddingApiKey、chat 侧什么都没有 ⇒ 不能被误判成「未配置」', async () => {
    const { fn, seen } = captureFetch()
    vi.stubGlobal('fetch', fn)
    const bridge = createLlmBridge({
      apiKey: '', baseUrl: '', model: 'chat-model', embeddingModel: 'embed-a',
      apiUrl: '', embeddingApiUrl: 'https://embed.internal/v1', embeddingApiKey: 'sk-only-embed',
    })
    await bridge.embed(['x'])
    expect(seen).toHaveLength(1)
    expect(at(seen, 0, '请求').url).toBe('https://embed.internal/v1/embeddings')
  })

  it('什么都没配 ⇒ 名字为空串，且 embed 直接拒发（不会带着空 model 出网）', async () => {
    const { fn, seen } = captureFetch()
    vi.stubGlobal('fetch', fn)
    const bridge = createLlmBridge({ apiKey: '', baseUrl: '', model: '', embeddingModel: '' })
    expect(bridge.embeddingModelName()).toBe('')
    await expect(bridge.embed(['x'])).rejects.toThrow(/未配置 embedding/)
    expect(seen).toHaveLength(0)
  })
})
