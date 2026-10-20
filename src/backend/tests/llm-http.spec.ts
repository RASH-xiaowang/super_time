/**
 * `llm-http.js` 的统一传输契约。
 *
 * 这里只测「三个 LLM 出网调用方共享的底座」：地址卫生、Bearer 头、body 序列化、
 * 以及经 `fetchWithRetry` 的重试/超时选项真的被转发。具体语义（目录回退、探针分类、
 * 余额候选）仍由各自 spec 负责。
 * @vitest-environment node
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const HERE = dirname(fileURLToPath(import.meta.url))
const llmHttpSource = readFileSync(join(HERE, '..', 'llm-http.js'), 'utf8')
const bundleBuildSource = readFileSync(join(HERE, '..', '..', '..', 'scripts', 'build-wechat-bundle.js'), 'utf8')
const {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_TIMEOUT_MS,
  parseLlmBaseUrl,
  joinLlmEndpoint,
  headersFor,
  llmRequest,
} = require('../llm-http.js')

afterEach(() => { vi.unstubAllGlobals() })

describe('LLM base URL 卫生', () => {
  it('去掉尾斜杠并保留 http(s)（自建/内网端点是合法配置）', () => {
    expect(parseLlmBaseUrl('https://api.example.com/v1///')).toMatchObject({
      base: 'https://api.example.com/v1',
      host: 'api.example.com',
      origin: 'https://api.example.com',
    })
    expect(parseLlmBaseUrl('http://127.0.0.1:8000/').base).toBe('http://127.0.0.1:8000')
  })

  it('拒绝非 http(s)、URL 凭据和 query/hash（防止地址语义被悄悄改变）', () => {
    expect(() => parseLlmBaseUrl('api.example.com/v1')).toThrow(/http/)
    expect(() => parseLlmBaseUrl('ftp://api.example.com')).toThrow(/http/)
    expect(() => parseLlmBaseUrl('https://user:secret@api.example.com/v1')).toThrow(/用户名或密码/)
    expect(() => parseLlmBaseUrl('https://api.example.com/v1?model=m')).toThrow(/查询参数/)
    expect(() => parseLlmBaseUrl('https://api.example.com/v1#fragment')).toThrow(/查询参数或片段/)
  })
})

/**
 * 端点拼接的容错（2026-10-16 实测踩到）。
 *
 * 用户把 `embeddingApiUrl` 填成**完整端点**（`.../v1/embeddings`）而 `embedPath` 仍是
 * 默认 `/embeddings` ⇒ 拼出 `.../v1/embeddings/embeddings` ⇒ **404**。
 * 后果不是报错弹窗，而是**稠密检索整条通道静默失效**（`dense:0(off)`）——
 * 用户看到的是「搜索不准确」，而不是「配置错了」。
 */
describe('端点拼接容错（用户填完整端点也不重复拼路径）', () => {
  it('base 不含端点路径时正常拼接', () => {
    expect(joinLlmEndpoint('https://api.siliconflow.cn/v1', '/embeddings'))
      .toBe('https://api.siliconflow.cn/v1/embeddings')
    expect(joinLlmEndpoint('https://api.siliconflow.cn/v1', '/rerank'))
      .toBe('https://api.siliconflow.cn/v1/rerank')
  })

  it('base 已含端点路径时不再重复拼（本轮修的那个 404）', () => {
    expect(joinLlmEndpoint('https://api.siliconflow.cn/v1/embeddings', '/embeddings'))
      .toBe('https://api.siliconflow.cn/v1/embeddings')
    expect(joinLlmEndpoint('https://api.siliconflow.cn/v1/rerank', '/rerank'))
      .toBe('https://api.siliconflow.cn/v1/rerank')
    // 尾斜杠也要能识别
    expect(joinLlmEndpoint('https://api.siliconflow.cn/v1/embeddings/', '/embeddings'))
      .toBe('https://api.siliconflow.cn/v1/embeddings')
  })

  it('base 的尾段是**别的**已知端点时剥掉它（本轮修的第二个 404）', () => {
    // 用户把 `rerankApiUrl` 也填成了 embedding 端点（复制粘贴忘了改）⇒
    // 拼出 `.../v1/embeddings/rerank` ⇒ 404，精排整条通道失效。
    expect(joinLlmEndpoint('https://api.siliconflow.cn/v1/embeddings', '/rerank'))
      .toBe('https://api.siliconflow.cn/v1/rerank')
    expect(joinLlmEndpoint('https://api.siliconflow.cn/v1/rerank', '/embeddings'))
      .toBe('https://api.siliconflow.cn/v1/embeddings')
    expect(joinLlmEndpoint('https://api.deepseek.com/v1/chat/completions', '/embeddings'))
      .toBe('https://api.deepseek.com/v1/embeddings')
  })

  it('只认白名单里的端点名，不做模糊匹配（猜错会把请求发到别的端点）', () => {
    // `/v1/embed` 不在白名单里 ⇒ 照常拼
    expect(joinLlmEndpoint('https://api.example.com/v1/embed', '/embeddings'))
      .toBe('https://api.example.com/v1/embed/embeddings')
    // 自定义路径（不是已知端点名）⇒ 照常拼
    expect(joinLlmEndpoint('https://api.example.com/v1/my-embed', '/embeddings'))
      .toBe('https://api.example.com/v1/my-embed/embeddings')
  })

  it('path 为空时直接用 base；path 不带前导斜杠也能拼', () => {
    expect(joinLlmEndpoint('https://api.example.com/v1', '')).toBe('https://api.example.com/v1')
    expect(joinLlmEndpoint('https://api.example.com/v1', 'embeddings'))
      .toBe('https://api.example.com/v1/embeddings')
  })
})

describe('请求头', () => {
  it('有 Key 写 Bearer，没有 Key 绝不写空 Authorization', () => {
    expect(headersFor('sk-x', { accept: 'text/event-stream' })).toEqual({
      accept: 'text/event-stream',
      authorization: 'Bearer sk-x',
    })
    const noKey = headersFor('')
    expect(noKey.accept).toBe('application/json')
    expect('authorization' in noKey).toBe(false)
  })
})

describe('统一请求与重试转发', () => {
  function fetchProbe(script: Array<{ status: number, json: unknown }>) {
    const calls: Array<{ url: string, init?: RequestInit }> = []
    vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      const step = script[Math.min(calls.length - 1, script.length - 1)]!
      return {
        ok: step.status >= 200 && step.status < 300,
        status: step.status,
        statusText: String(step.status),
        json: async () => step.json,
        text: async () => '',
        headers: { get: () => null },
      } as unknown as Response
    })
    return calls
  }

  it('503 按 fetchWithRetry 重试到成功，且只做一次真正的 JSON 序列化', async () => {
    const calls = fetchProbe([
      { status: 503, json: {} },
      { status: 200, json: { ok: true } },
    ])
    const res = await llmRequest('https://api.example.com/v1/chat/completions', {
      method: 'POST',
      apiKey: 'sk-x',
      body: { model: 'm', messages: [] },
      timeoutMs: 5000,
      maxAttempts: 3,
      sleep: async () => {},
      random: () => 0,
    })
    expect(res.ok).toBe(true)
    expect(calls).toHaveLength(2)
    expect(calls[0]!.url).toBe('https://api.example.com/v1/chat/completions')
    expect(calls[0]!.init?.headers).toMatchObject({
      authorization: 'Bearer sk-x',
      'content-type': 'application/json',
    })
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ model: 'm', messages: [] })
  })

  it('默认快速失败（交互式探针与余额查询仍是一次尝试）', async () => {
    expect(DEFAULT_MAX_ATTEMPTS).toBe(1)
    expect(DEFAULT_TIMEOUT_MS).toBe(20_000)
    const calls = fetchProbe([{ status: 503, json: {} }])
    const res = await llmRequest('https://api.example.com/v1/models', {
      timeoutMs: 20_000,
      sleep: async () => {},
      random: () => 0,
    })
    expect(res.status).toBe(503)
    expect(calls).toHaveLength(1)
  })
})

describe('宿主重试模块的加载边界', () => {
  it('构建出独立的小 bundle，宿主优先加载它，完整网关 bundle 仅作未构建回退', () => {
    expect(bundleBuildSource).toContain("fetch-retry.ts")
    expect(bundleBuildSource).toContain('entryPoints: [entry, fetchRetryEntry]')

    const smallImport = llmHttpSource.indexOf("import('./wechat-data/lib/net/fetch-retry.js')")
    const fullImport = llmHttpSource.indexOf("import('./wechat-data/lib/index.js')")
    expect(smallImport).toBeGreaterThan(-1)
    expect(fullImport).toBeGreaterThan(-1)
    expect(smallImport).toBeLessThan(fullImport)
    expect(llmHttpSource).toContain("'ERR_MODULE_NOT_FOUND'")
  })
})
