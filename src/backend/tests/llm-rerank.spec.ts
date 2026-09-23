/**
 * 重排序（精排）出网调用的行为用例 —— 打在宿主桥上（真发请求的那一层）。
 *
 * 为什么这一层必须单独测：精排是**新增的出网点**，而它最容易错的四件事
 * 全都在「请求怎么拼、响应怎么读」上，网关那层的桩看不见它们：
 *   ① 模型名解析（`rerankModel` 留空 ⇒ 这个角色就是没配，不能悄悄借用 chat/embedding 的名字
 *      —— 那不是同一个接口，发出去只会拿到一个 400）；
 *   ② 端点与 Key 的回落（只填了精排 Key 的配置不能被误判成「未配置」）；
 *   ③ **返回按输入下标对齐**：厂商不保证 `results` 的顺序，也不保证每条都回。
 *      错位一次，就会把「最相关」的分数贴到一条无关文档上，而这在界面上完全看不出来；
 *   ④ 缺项按 0 分而不是抛错：为一条不完整的响应废掉整轮问答是不成比例的代价。
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error —— 宿主层是 CommonJS，无类型声明
import { createLlmBridge } from '../wechat-host.js'
import { at as strictAt } from './helpers/strict-index.ts'

/** 一次被捕获的请求。 */
type Seen = { url: string; headers: Record<string, string>; body: Record<string, unknown> }

/**
 * 取第 n 次被捕获的请求；越界 = 这条用例的前提不成立。
 * @source-ref src/backend/tests/helpers/strict-index.ts:31
 */
function at (seen: Seen[], n: number): Seen {
  return strictAt(seen, n, '请求')
}

/** 造一个记录请求体的假 fetch，按脚本回响应。 */
function captureFetch(reply: () => unknown) {
  const seen: Seen[] = []
  const fn = async (url: string, init: { body?: string; headers?: Record<string, string> }) => {
    seen.push({ url, headers: init.headers ?? {}, body: JSON.parse(String(init.body ?? '{}')) })
    return {
      ok: true,
      status: 200,
      json: async () => reply(),
      text: async () => 'ok',
      headers: { get: () => null },
    }
  }
  return { fn, seen }
}

const BASE = {
  apiKey: 'sk-chat', baseUrl: 'https://chat.test/v1', model: 'chat-model',
  rerankPath: '/rerank', rerankTimeoutMs: 5000,
}

afterEach(() => { vi.unstubAllGlobals() })

describe('rerank 的请求拼装', () => {
  it('填了 rerankModel ⇒ 用独立端点与 Key；留空则回落 chat 那一对', async () => {
    const { fn, seen } = captureFetch(() => ({ results: [] }))
    vi.stubGlobal('fetch', fn)
    const bridge = createLlmBridge({ ...BASE, rerankModel: 'my-reranker' })
    await bridge.rerank('问题', ['甲', '乙'])
    expect(at(seen, 0).url).toBe('https://chat.test/v1/rerank')
    expect(at(seen, 0).body.model).toBe('my-reranker')
    expect(at(seen, 0).headers.authorization).toBe('Bearer sk-chat')

    const own = captureFetch(() => ({ results: [] }))
    vi.stubGlobal('fetch', own.fn)
    const b2 = createLlmBridge({
      ...BASE, rerankModel: 'my-reranker', rerankApiUrl: 'https://rerank.test/v1', rerankApiKey: 'sk-rerank',
    })
    await b2.rerank('q', ['a'])
    expect(at(own.seen, 0).url).toBe('https://rerank.test/v1/rerank')
    expect(at(own.seen, 0).headers.authorization).toBe('Bearer sk-rerank')
  })

  it('没配 rerankModel ⇒ 直接拒发，不借用 chat/embedding 的模型名', async () => {
    const { fn, seen } = captureFetch(() => ({ results: [] }))
    vi.stubGlobal('fetch', fn)
    const bridge = createLlmBridge({ ...BASE, embeddingModel: 'embed-a', rerankModel: '' })
    expect(bridge.rerankModelName()).toBe('')
    await expect(bridge.rerank('q', ['a'])).rejects.toThrow(/未配置 rerank/)
    expect(seen).toHaveLength(0)
  })

  it('请求体带 query 与全部候选，并声明不回传文档（省带宽）', async () => {
    const { fn, seen } = captureFetch(() => ({ results: [] }))
    vi.stubGlobal('fetch', fn)
    const bridge = createLlmBridge({ ...BASE, rerankModel: 'r1' })
    await bridge.rerank('违约金怎么算', ['第一条', '第二条', '第三条'])
    expect(at(seen, 0).body.query).toBe('违约金怎么算')
    expect(at(seen, 0).body.documents).toEqual(['第一条', '第二条', '第三条'])
    expect(at(seen, 0).body.return_documents).toBe(false)
  })
})

describe('rerank 的响应对齐（错位比报错更糟）', () => {
  it('厂商**乱序**返回也按 index 贴回原位', async () => {
    const { fn } = captureFetch(() => ({
      results: [{ index: 2, relevance_score: 0.9 }, { index: 0, relevance_score: 0.1 }, { index: 1, relevance_score: 0.5 }],
    }))
    vi.stubGlobal('fetch', fn)
    const bridge = createLlmBridge({ ...BASE, rerankModel: 'r1' })
    expect(await bridge.rerank('q', ['a', 'b', 'c'])).toEqual([0.1, 0.5, 0.9])
  })

  it('只回前两条（top_n 语义）⇒ 缺的那条按 0 分而不是抛错', async () => {
    const { fn } = captureFetch(() => ({ results: [{ index: 1, relevance_score: 0.7 }] }))
    vi.stubGlobal('fetch', fn)
    const bridge = createLlmBridge({ ...BASE, rerankModel: 'r1' })
    expect(await bridge.rerank('q', ['a', 'b', 'c'])).toEqual([0, 0.7, 0])
  })

  it('三种响应形状都认：results/relevance_score、results/score、data/score', async () => {
    const cases: Array<[unknown, number[]]> = [
      [{ results: [{ index: 0, relevance_score: 0.2 }] }, [0.2, 0]],
      [{ results: [{ index: 1, score: 0.4 }] }, [0, 0.4]],
      [{ data: [{ index: 0, relevance: 0.6 }] }, [0.6, 0]],
    ]
    for (const [payload, want] of cases) {
      const { fn } = captureFetch(() => payload)
      vi.stubGlobal('fetch', fn)
      const bridge = createLlmBridge({ ...BASE, rerankModel: 'r1' })
      expect(await bridge.rerank('q', ['a', 'b'])).toEqual(want)
    }
  })

  it('越界的 index 与非数值的分被丢掉/归零，不会把数组撑长或写出 NaN', async () => {
    const { fn } = captureFetch(() => ({
      results: [{ index: 99, relevance_score: 1 }, { index: -1, relevance_score: 1 }, { index: 0, relevance_score: 'abc' }],
    }))
    vi.stubGlobal('fetch', fn)
    const bridge = createLlmBridge({ ...BASE, rerankModel: 'r1' })
    const scores = await bridge.rerank('q', ['a', 'b'])
    expect(scores).toHaveLength(2)
    expect(scores.every((s: number) => Number.isFinite(s))).toBe(true)
    expect(scores).toEqual([0, 0])
  })

  it('空候选集不发请求（省一次必然无意义的出网）', async () => {
    const { fn, seen } = captureFetch(() => ({ results: [] }))
    vi.stubGlobal('fetch', fn)
    const bridge = createLlmBridge({ ...BASE, rerankModel: 'r1' })
    expect(await bridge.rerank('q', [])).toEqual([])
    expect(seen).toHaveLength(0)
  })
})

describe('rerank 的失败形状', () => {
  it('HTTP 非 2xx ⇒ 抛错带上状态码（网关那侧会退回本地加权并写明原因）', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
      text: async () => 'upstream busy',
      headers: { get: () => null },
    }))
    const bridge = createLlmBridge({ ...BASE, rerankModel: 'r1' })
    await expect(bridge.rerank('q', ['a'])).rejects.toThrow(/rerank HTTP 503/)
  })

  it('rerankModelName 与真正发出去的名字同源（记账不会指着没参与过的模型）', async () => {
    const { fn, seen } = captureFetch(() => ({ results: [] }))
    vi.stubGlobal('fetch', fn)
    const bridge = createLlmBridge({ ...BASE, rerankModel: 'r-global' })
    await bridge.rerank('q', ['a'])
    expect(at(seen, 0).body.model).toBe(bridge.rerankModelName())
    // 调用方点名时两边都用点名的
    await bridge.rerank('q', ['a'], { model: 'r-per-lib' })
    expect(at(seen, 1).body.model).toBe('r-per-lib')
    expect(bridge.rerankModelName('r-per-lib')).toBe('r-per-lib')
  })
})
