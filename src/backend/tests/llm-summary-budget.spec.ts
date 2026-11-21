/** @vitest-environment node */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLlmBridge } from '../llm-bridge.js'
afterEach(() => vi.unstubAllGlobals())
describe('summary token audit: omitting maxTokens is not an unlimited request', () => {
  it.each([undefined, 4096])('serializes the actual bridge budget for maxTokens=%s', async (maxTokens) => {
    const bodies: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
      return new Response(JSON.stringify({ choices: [{ message: { content: 'synthetic summary' }, finish_reason: 'stop' }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))
    const bridge = createLlmBridge({ apiKey: 'fixture-key', baseUrl: 'https://example.test/v1', model: 'fixture-model', timeoutMs: 1000 })
    for await (const _ of bridge.stream({ model: 'fixture-model', messages: [], ...(maxTokens === undefined ? {} : { maxTokens }) })) { /* consume mock chunks only */ }
    expect(bodies).toHaveLength(1)
    expect(bodies[0]?.max_tokens).toBe(maxTokens ?? 2048)
  })
})