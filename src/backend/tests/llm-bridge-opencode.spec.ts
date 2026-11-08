/**
 * OpenCode 聊天出网契约。
 *
 * 模型列表路径由统一传输层适配；聊天仍走 OpenAI 兼容的 `/chat/completions`，
 * 但必须带产品 User-Agent 和稳定的 x-opencode-session。
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLlmBridge } from '../llm-bridge.js'

type Seen = {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

function sseResponse(body: ReadableStream<Uint8Array>): Response {
  return {
    ok: true,
    status: 200,
    body,
    headers: {
      get: (name: string) => name.toLowerCase() === 'content-type' ? 'text/event-stream' : null,
    },
    json: async () => ({}),
    text: async () => '',
  } as unknown as Response
}

function sseChunk(text: string): Uint8Array {
  return new TextEncoder().encode(
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
  )
}

function sseDone(): Uint8Array {
  return new TextEncoder().encode('data: [DONE]\n\n')
}

function captureFetch(): { fn: typeof fetch, seen: Seen[] } {
  const seen: Seen[] = []
  const fn = async (url: string, init: { body?: string, headers?: Record<string, string> } = {}) => {
    seen.push({
      url,
      headers: init.headers ?? {},
      body: JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>,
    })
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '收到' } }] }),
      text: async () => '',
      headers: { get: () => 'application/json' },
    } as unknown as Response
  }
  return { fn: fn as typeof fetch, seen }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('OpenCode 聊天请求', () => {
  it('走正确的 chat 路径，并为同一会话复用同一个散列会话 ID', async () => {
    const probe = captureFetch()
    vi.stubGlobal('fetch', probe.fn)
    const bridge = createLlmBridge({
      provider: 'opencode',
      apiKey: 'sk-opencode',
      baseUrl: 'https://opencode.ai/inference/go/openai/v1',
      apiPath: '/chat/completions',
      model: 'glm-5.3-flash',
      timeoutMs: 5000,
    })
    const sessionId = 'supertime:ai-reply:wxid_self:wxid_peer' as never

    await expect(bridge.generate({
      messages: [{ role: 'user', content: '你好' }],
      sessionId,
    })).resolves.toEqual({ content: '收到' })
    await bridge.generate({
      messages: [{ role: 'user', content: '再问一句' }],
      sessionId,
    })

    expect(probe.seen).toHaveLength(2)
    expect(probe.seen[0]?.url).toBe('https://opencode.ai/inference/go/openai/v1/chat/completions')
    expect(probe.seen[0]?.body.model).toBe('glm-5.3-flash')
    expect(probe.seen[0]?.headers['user-agent']).toMatch(/^SuperTime\//)
    expect(probe.seen[0]?.headers['x-opencode-session']).toMatch(/^supertime-[a-f0-9]{32}$/)
    expect(probe.seen[1]?.headers['x-opencode-session']).toBe(probe.seen[0]?.headers['x-opencode-session'])
  })

  it('低复杂度请求可关闭思考，缩短结构化识别等待时间', async () => {
    const probe = captureFetch()
    vi.stubGlobal('fetch', probe.fn)
    const bridge = createLlmBridge({
      provider: 'opencode',
      apiKey: 'sk-opencode',
      baseUrl: 'https://opencode.ai/inference/go/openai/v1',
      apiPath: '/chat/completions',
      model: 'qwen3.8-flash',
      timeoutMs: 5000,
    })

    await bridge.generate({
      messages: [{ role: 'user', content: '识别图片字段' }],
      thinking: { type: 'disabled' },
    })

    expect(probe.seen[0]?.body.thinking).toEqual({ type: 'disabled' })
  })

  it('厂商不认识 thinking 时自动去掉该参数重试一次', async () => {
    const bodies: Array<Record<string, unknown>> = []
    let calls = 0
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      calls += 1
      if (calls === 1) {
        return {
          ok: false,
          status: 400,
          text: async () => '{"error":{"message":"Unrecognized request argument: thinking"}}',
          headers: { get: () => 'application/json' },
        } as unknown as Response
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: '{"姓名":"张三"}' } }] }),
        text: async () => '',
        headers: { get: () => 'application/json' },
      } as unknown as Response
    })
    const bridge = createLlmBridge({
      provider: 'openai-compat',
      apiKey: 'sk-test',
      baseUrl: 'https://example.test/v1',
      apiPath: '/chat/completions',
      model: 'vision-test',
      timeoutMs: 5000,
    })

    await expect(bridge.generate({
      messages: [{ role: 'user', content: '识别图片字段' }],
      thinking: { type: 'disabled' },
    })).resolves.toEqual({ content: '{"姓名":"张三"}' })

    expect(bodies).toHaveLength(2)
    expect(bodies[0]?.thinking).toEqual({ type: 'disabled' })
    expect(bodies[1]).not.toHaveProperty('thinking')
  })

  it('隐私授权错误会给出可操作提示，并保留厂商原始响应', async () => {
    const detail = '{"error":{"type":"server_error","message":"Upstream request failed: '
      + 'This Go model trains on request data. Allow paid endpoints that train on request data '
      + 'in your workspace\'s Privacy settings to use it."}}'
    const fn = async () => ({
      ok: false,
      status: 400,
      text: async () => detail,
      json: async () => ({}),
      headers: { get: () => 'application/json' },
    } as unknown as Response)
    vi.stubGlobal('fetch', fn)
    const bridge = createLlmBridge({
      provider: 'opencode',
      apiKey: 'sk-opencode',
      baseUrl: 'https://opencode.ai/inference/go/openai/v1',
      apiPath: '/chat/completions',
      model: 'qwen3.8-flash',
      timeoutMs: 5000,
    })

    await expect(bridge.generate({
      messages: [{ role: 'user', content: '你好' }],
    })).rejects.toThrow(
      /Settings › Privacy.*切换.*原始响应.*trains on request data/s,
    )
  })

  it('流式请求同样把训练数据限制映射成可操作提示', async () => {
    const detail = '{"error":{"type":"server_error","message":"Upstream request failed: '
      + 'This Go model trains on request data. Allow paid endpoints that train on request data '
      + 'in your workspace\'s Privacy settings to use it."}}'
    const fn = async () => ({
      ok: false,
      status: 400,
      text: async () => detail,
      json: async () => ({}),
      headers: { get: () => 'application/json' },
    } as unknown as Response)
    vi.stubGlobal('fetch', fn)
    const bridge = createLlmBridge({
      provider: 'opencode',
      apiKey: 'sk-opencode',
      baseUrl: 'https://opencode.ai/inference/go/openai/v1',
      apiPath: '/chat/completions',
      model: 'qwen3.8-flash',
      timeoutMs: 5000,
    })

    const consume = async () => {
      for await (const _chunk of bridge.stream({
        messages: [{ role: 'user', content: '你好' }],
        sessionId: 'supertime:ai-reply:self:peer' as never,
      })) {
        // 错误应在开始消费流时抛出。
      }
    }
    await expect(consume()).rejects.toThrow(/Settings › Privacy.*切换.*原始响应/s)
  })

  it('持续返回 chunk 时，正文总时长可以超过 timeoutMs 而不会被握手超时中断', async () => {
    const chunks = ['一', '二', '三', '四', '五', '六']
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (let i = 0; i < chunks.length; i += 1) {
          if (i > 0) await new Promise((resolve) => setTimeout(resolve, 15))
          controller.enqueue(sseChunk(chunks[i] ?? ''))
        }
        controller.close()
      },
    })
    vi.stubGlobal('fetch', async () => sseResponse(body))
    const bridge = createLlmBridge({
      provider: 'opencode',
      apiKey: 'sk-opencode',
      baseUrl: 'https://opencode.ai/inference/go/openai/v1',
      apiPath: '/chat/completions',
      model: 'qwen3.8-flash',
      timeoutMs: 50,
    })

    let text = ''
    for await (const chunk of bridge.stream({
      messages: [{ role: 'user', content: '你好' }],
      sessionId: 'supertime:ai-reply:self:peer' as never,
    })) {
      if (chunk.type === 'text-delta') text += chunk.text
    }

    expect(text).toBe('一二三四五六')
  })

  it('响应头到达后若正文长期无 chunk，会以中文空闲超时终止而不是永久挂起', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(sseChunk('先返回一段'))
      },
    })
    vi.stubGlobal('fetch', async () => sseResponse(body))
    const bridge = createLlmBridge({
      provider: 'opencode',
      apiKey: 'sk-opencode',
      baseUrl: 'https://opencode.ai/inference/go/openai/v1',
      apiPath: '/chat/completions',
      model: 'qwen3.8-flash',
      timeoutMs: 40,
    })

    const consume = async () => {
      for await (const _chunk of bridge.stream({
        messages: [{ role: 'user', content: '你好' }],
        sessionId: 'supertime:ai-reply:self:peer' as never,
      })) {
        // 第一个 chunk 之后，测试流不再产生数据。
      }
    }

    await expect(consume()).rejects.toThrow(/模型流式响应空闲超时/)
  })

  it('用户主动取消仍按 cancellation 结束，不会被误报成空闲超时', async () => {
    const requestAbort = new AbortController()
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller
        controller.enqueue(sseChunk('开始生成'))
      },
    })
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      init?.signal?.addEventListener('abort', () => {
        bodyController?.error(new DOMException('Aborted', 'AbortError'))
      })
      return sseResponse(body)
    })
    const bridge = createLlmBridge({
      provider: 'opencode',
      apiKey: 'sk-opencode',
      baseUrl: 'https://opencode.ai/inference/go/openai/v1',
      apiPath: '/chat/completions',
      model: 'qwen3.8-flash',
      timeoutMs: 500,
    })

    const consume = async () => {
      for await (const chunk of bridge.stream({
        messages: [{ role: 'user', content: '你好' }],
        sessionId: 'supertime:ai-reply:self:peer' as never,
        signal: requestAbort.signal,
      })) {
        if (chunk.type === 'text-delta') requestAbort.abort()
      }
    }

    await expect(consume()).rejects.not.toThrow(/空闲超时/)
  })

  it('收到 [DONE] 后立即完成，不等待供应商关闭长连接', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(sseChunk('完整回答'))
        controller.enqueue(sseDone())
        // 故意不 close：模拟供应商保留 SSE 连接。
      },
    })
    vi.stubGlobal('fetch', async () => sseResponse(body))
    const bridge = createLlmBridge({
      provider: 'opencode',
      apiKey: 'sk-opencode',
      baseUrl: 'https://opencode.ai/inference/go/openai/v1',
      apiPath: '/chat/completions',
      model: 'qwen3.8-flash',
      timeoutMs: 500,
    })

    const startedAt = Date.now()
    let text = ''
    for await (const chunk of bridge.stream({
      messages: [{ role: 'user', content: '你好' }],
      sessionId: 'supertime:ai-reply:self:peer' as never,
    })) {
      if (chunk.type === 'text-delta') text += chunk.text
    }

    expect(text).toBe('完整回答')
    expect(Date.now() - startedAt).toBeLessThan(300)
  })
})
