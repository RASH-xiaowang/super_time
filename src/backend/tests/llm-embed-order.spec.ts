/**
 * embedding 返回值的**顺序映射**契约（2026-11-20）。
 *
 * ## 守的是一个静默错配
 *
 * 硅基流动（`Qwen/Qwen3-VL-Embedding-8B`）一次 16 条的批量请求返回的 `index` 是
 * **循环编号**：`[0..7, 0..7]`。原实现无条件 `sort by index`，于是第二组的 0 被排到
 * 第一组的 7 前面 —— 16 条向量被彻底打乱，**向量与文本错配**。
 *
 * 后果是全静默的：维度对、条数对、索引建成、状态报就绪，只有检索质量莫名下降
 * （真机表现就是「语义检索不准、换个说法搜不到」）。而这条链路是消息域与知识库**共用**的，
 * 所以它污染的是整个 RAG 的召回质量。
 */
import { describe, expect, it, vi } from 'vitest'

const EMBED_DIM = 4

/** 造一个假 fetch：按 cases 依次返回预设响应。 */
function mockFetch(responder: (body: Record<string, unknown>) => unknown): typeof fetch {
  return (async (_url: string, init: { body?: string }) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    const payload = responder(body)
    return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) }
  }) as unknown as typeof fetch
}

const BASE = { apiKey: 'k', baseUrl: 'https://example.test/v1', embedPath: '/embeddings', timeoutMs: 5000, embeddingModel: 'm' }

/** 动态引入桥（模块内部读全局 fetch）。 */
async function makeBridge(responder: (body: Record<string, unknown>) => unknown): Promise<{ embed: (t: string[]) => Promise<number[][]> }> {
  vi.stubGlobal('fetch', mockFetch(responder))
  const mod = await import('../llm-bridge.js') as { createLlmBridge: (cfg: Record<string, unknown>) => { embed: (t: string[]) => Promise<number[][]> } }
  return mod.createLlmBridge({ ...BASE })
}

describe('embedding 顺序：index 循环时不许打乱', () => {
  it('index 循环 [0..7,0..7] ⇒ 按返回顺序映射，每条向量对应它自己的输入', async () => {
    // 每条文本的向量首分量携带它的输入下标，便于验证「哪条配了哪条」。
    const bridge = await makeBridge((body) => {
      const input = body.input as string[]
      return {
        data: input.map((_, i) => ({
          // 故意用循环编号（真机实测就是这个）
          index: i % 8,
          embedding: new Array(EMBED_DIM).fill(0).map((_v, k) => (k === 0 ? Number(input[i]!.replace('t', '')) : 0)),
        })),
      }
    })
    const texts = Array.from({ length: 16 }, (_v, i) => 't' + String(i))
    const out = await bridge.embed(texts)
    expect(out).toHaveLength(16)
    // 第 i 条必须是「下标 i」那条文本的向量
    for (let i = 0; i < 16; i += 1) expect(out[i]?.[0], `第 ${String(i)} 条错配了`).toBe(i)
  })

  it('index 真的是乱序的排列 ⇒ 仍按 index 归位', async () => {
    const bridge = await makeBridge((body) => {
      const input = body.input as string[]
      const rows = input.map((_, i) => ({
        index: i,
        embedding: new Array(EMBED_DIM).fill(0).map((_v, k) => (k === 0 ? Number(input[i]!.replace('t', '')) : 0)),
      }))
      // 倒序返回 + 保留正确 index ⇒ 必须能靠 index 复原
      return { data: rows.slice().reverse() }
    })
    const texts = Array.from({ length: 6 }, (_v, i) => 't' + String(i))
    const out = await bridge.embed(texts)
    for (let i = 0; i < 6; i += 1) expect(out[i]?.[0], `第 ${String(i)} 条错配了`).toBe(i)
  })

  it('返回条数少于输入 ⇒ 抛错，不许静默少给（否则库里永远缺那几块而状态仍报就绪）', async () => {
    const bridge = await makeBridge((body) => {
      const input = body.input as string[]
      return { data: input.slice(0, 2).map((_v, i) => ({ index: i, embedding: new Array(EMBED_DIM).fill(1) })) }
    })
    await expect(bridge.embed(['a', 'b', 'c', 'd'])).rejects.toThrow(/条数与输入不一致/)
  })
})
