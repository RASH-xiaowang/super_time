/**
 * 模型「连接测试 / 余额查询」的判据（2026-09-30）。
 *
 * 为什么值得一份 spec：这两件事**都要出网**，而且失败形态全是"看不出来"的那种：
 *   · 地址拼错（DeepSeek 的余额接口不带 `/v1`，取 origin 才对）；
 *   · 厂商不提供余额接口（OpenAI 就是），此时**不能猜一个数字**给用户看；
 *   · Key 无效被当成"厂商不支持"；
 *   · 网络错误原文（`fetch failed` / `UND_ERR_CONNECT_TIMEOUT`）直接抛给用户。
 * 所以这里既测纯函数（地址推导 / 响应解析），也测取数路径（stub fetch，逐个状态码走一遍）。
 *
 * 出网口径：这两条是新的出网点（余额还会被左下角 5 分钟定时触发），
 * 已写进 `docs/PRIVACY.md` 与同意屏 —— 改这里请同步那两处。
 * @vitest-environment node
 */
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const {
  balanceUrlsFor, normalizeBase, parseBalance, testLlmEndpoint, testLlmConnection, queryLlmBalance,
} = require('../llm-balance.js')

afterEach(() => { vi.unstubAllGlobals() })

/** 把 `globalThis.fetch` 换成探针：记录 URL / 请求头，并按给定响应作答。 */
function fetchProbe(reply: { ok?: boolean; status?: number; statusText?: string; json?: unknown; text?: string; fail?: Error } = {}) {
  const called: Array<{ url: string; headers: Record<string, string> }> = []
  vi.stubGlobal('fetch', async (url: unknown, init: { headers?: Record<string, string> } = {}) => {
    called.push({ url: String(url), headers: init?.headers ?? {} })
    if (reply.fail) throw reply.fail
    return {
      ok: reply.ok ?? true,
      status: reply.status ?? 200,
      statusText: reply.statusText ?? 'OK',
      json: async () => reply.json ?? {},
      text: async () => reply.text ?? '',
    }
  })
  return { called }
}

describe('地址推导与归一化', () => {
  it('DeepSeek：余额接口在 origin 下的 /user/balance（**不带 /v1**）', () => {
    expect(balanceUrlsFor('https://api.deepseek.com/v1')).toEqual(['https://api.deepseek.com/user/balance'])
    expect(balanceUrlsFor('https://api.deepseek.com/v1/')).toEqual(['https://api.deepseek.com/user/balance'])
  })

  it('其它厂商：先 /user/info（SiliconFlow 惯例）再 /user/balance', () => {
    expect(balanceUrlsFor('https://api.siliconflow.cn/v1')).toEqual([
      'https://api.siliconflow.cn/v1/user/info',
      'https://api.siliconflow.cn/v1/user/balance',
    ])
  })

  it('结尾斜杠会被去掉；非 http(s) 地址明确报错（不静默当相对路径）', () => {
    expect(normalizeBase('https://a.example/v1///')).toBe('https://a.example/v1')
    expect(() => normalizeBase('api.example.com/v1')).toThrow(/http/)
    expect(() => balanceUrlsFor('')).toThrow(/http/)
  })
})

describe('余额解析：按字段名表尽力识别，认不出返回 null（绝不猜数字）', () => {
  it('DeepSeek：balance_infos[0] 的字符串金额 + is_available', () => {
    expect(parseBalance({
      is_available: true,
      balance_infos: [{ currency: 'CNY', total_balance: '12.34', granted_balance: '2.00', topped_up_balance: '10.34' }],
    })).toEqual({ currency: 'CNY', total: 12.34, granted: 2, toppedUp: 10.34, isAvailable: true })
  })

  it('余额不足时 is_available=false 也要如实带出来', () => {
    const b = parseBalance({ is_available: false, balance_infos: [{ currency: 'USD', total_balance: '0.00' }] })
    expect(b?.isAvailable).toBe(false)
    expect(b?.total).toBe(0)
  })

  it('通用形态：挂在 data 下的 balance / totalBalance（SiliconFlow 一类）', () => {
    expect(parseBalance({ code: 20000, data: { balance: '5.5', chargeBalance: '5.5' } })?.total).toBe(5.5)
    expect(parseBalance({ data: { totalBalance: 7 } })?.total).toBe(7)
  })

  it('认不出来一律 null（宁可不显示，也不显示一个编的数）', () => {
    expect(parseBalance(null)).toBeNull()
    expect(parseBalance({ data: { id: 'u1', name: '张三' } })).toBeNull()
    expect(parseBalance({ balance_infos: [] })).toBeNull()
    expect(parseBalance({ data: { balance: '不是数字' } })).toBeNull()
  })
})

describe('连接测试', () => {
  it('成功：返回耗时、可见模型数与实际地址；带 Bearer Key', async () => {
    const { called } = fetchProbe({ json: { data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }, { id: 'deepseek-chat' }] } })
    const r = await testLlmConnection('https://api.deepseek.com/v1', 'sk-x')
    expect(r.url).toBe('https://api.deepseek.com/v1/models')
    expect(r.models, '重复 id 只算一个').toBe(2)
    expect(r.ms).toBeGreaterThanOrEqual(0)
    expect(called[0]!.headers.authorization).toBe('Bearer sk-x')
  })

  it('401/403：区分「Key 无效」与「Key 为空」', async () => {
    fetchProbe({ ok: false, status: 401, statusText: 'Unauthorized' })
    await expect(testLlmConnection('https://a.example/v1', 'sk-bad')).rejects.toThrow(/无效或无权限/)
    fetchProbe({ ok: false, status: 403, statusText: 'Forbidden' })
    await expect(testLlmConnection('https://a.example/v1', '')).rejects.toThrow(/Key 为空/)
  })

  it('404 给出「可能缺 /v1」的提示（这是最常见的配置错）', async () => {
    fetchProbe({ ok: false, status: 404, statusText: 'Not Found' })
    await expect(testLlmConnection('https://a.example/v1', 'sk-x')).rejects.toThrow(/404.*\/v1/s)
  })

  it('网络错误翻译成人话（超时 / 域名解析 / 连接被拒）', async () => {
    fetchProbe({ fail: Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } }) })
    await expect(testLlmConnection('https://nope.example/v1', 'sk-x')).rejects.toThrow(/域名解析失败/)

    fetchProbe({ fail: Object.assign(new Error('aborted'), { name: 'AbortError' }) })
    await expect(testLlmConnection('https://slow.example/v1', 'sk-x')).rejects.toThrow(/超时/)

    fetchProbe({ fail: Object.assign(new Error('refused'), { cause: { code: 'ECONNREFUSED' } }) })
    await expect(testLlmConnection('https://x.example/v1', 'sk-x')).rejects.toThrow(/连接被拒绝/)
  })
})

/**
 * 三类端点各测各的（2026-09-30 扩展）。
 *
 * 为什么必须有这些用例：配置里主模型 / 向量 / 精排是**三套地址·Key·路径**，
 * 实测就有「主模型 DeepSeek、向量与精排指向 SiliconFlow」这种组合。
 * 只测 `/models` 会让后两条链路的错（Key 错、路径错、模型名错）**静默通过** ——
 * 问答照常能用，只是检索退化成稀疏、精排整段跳过。
 */
describe('连接测试：embed / rerank 各发一条最小请求', () => {
  /** 记录 method 与 body 的探针。 */
  function postProbe(reply: { ok?: boolean; status?: number; statusText?: string; json?: unknown; fail?: Error } = {}) {
    const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> = []
    vi.stubGlobal('fetch', async (url: unknown, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET', headers: init?.headers ?? {}, body: String(init?.body ?? '') })
      if (reply.fail) throw reply.fail
      return {
        ok: reply.ok ?? true,
        status: reply.status ?? 200,
        statusText: reply.statusText ?? 'OK',
        json: async () => reply.json ?? {},
        text: async () => '',
      }
    })
    return { calls }
  }

  it('embed：POST 到 base+path，body 带模型与固定测试串；返回向量维度', async () => {
    const { calls } = postProbe({ json: { data: [{ embedding: new Array(1024).fill(0.01) }] } })
    const r = await testLlmEndpoint({
      baseUrl: 'https://api.siliconflow.cn/v1', apiKey: 'sk-vec', kind: 'embed',
      path: '/embeddings', model: 'Qwen/Qwen3-VL-Embedding-8B',
    })
    expect(calls[0]!.url).toBe('https://api.siliconflow.cn/v1/embeddings')
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.headers.authorization).toBe('Bearer sk-vec')
    const body = JSON.parse(calls[0]!.body)
    expect(body.model).toBe('Qwen/Qwen3-VL-Embedding-8B')
    expect(body.input, '发的是固定测试串，不是用户内容').toBe('连接测试')
    expect(r.detail).toBe('向量维度 1024')
  })

  it('embed：路径留空回落到 /embeddings；顶层 embeddings 形态也认', async () => {
    const { calls } = postProbe({ json: { embeddings: [[0.1, 0.2, 0.3]] } })
    const r = await testLlmEndpoint({ baseUrl: 'https://a.example/v1', apiKey: 'k', kind: 'embed', model: 'm' })
    expect(calls[0]!.url).toBe('https://a.example/v1/embeddings')
    expect(r.detail).toBe('向量维度 3')
  })

  it('rerank：POST 到 base+path，body 带 query + documents；返回相关度', async () => {
    const { calls } = postProbe({ json: { results: [{ index: 0, relevance_score: 0.8312 }] } })
    const r = await testLlmEndpoint({
      baseUrl: 'https://api.siliconflow.cn/v1', apiKey: 'sk-re', kind: 'rerank',
      path: '/rerank', model: 'Qwen/Qwen3-VL-Reranker-8B',
    })
    expect(calls[0]!.url).toBe('https://api.siliconflow.cn/v1/rerank')
    const body = JSON.parse(calls[0]!.body)
    expect(body.model).toBe('Qwen/Qwen3-VL-Reranker-8B')
    expect(body.query).toBe('连接测试')
    expect(body.documents).toEqual(['连接测试'])
    expect(r.detail).toBe('相关度 0.8312')
  })

  it('rerank：认不出相关度时如实报告返回条数（不编一个分数）', async () => {
    postProbe({ json: { results: [{ index: 0 }, { index: 1 }] } })
    const r = await testLlmEndpoint({ baseUrl: 'https://a.example/v1', apiKey: 'k', kind: 'rerank', model: 'm' })
    expect(r.detail).toBe('返回 2 条结果')
  })

  it('未填向量 / 精排模型：直接报错、**不发请求**（那两条链路本来就没启用）', async () => {
    const { calls } = postProbe({ json: {} })
    await expect(testLlmEndpoint({ baseUrl: 'https://a.example/v1', apiKey: 'k', kind: 'embed', model: '' }))
      .rejects.toThrow(/未填写向量模型/)
    await expect(testLlmEndpoint({ baseUrl: 'https://a.example/v1', apiKey: 'k', kind: 'rerank', model: '' }))
      .rejects.toThrow(/未填写重排序模型/)
    expect(calls.length, '没模型就不该发请求').toBe(0)
  })

  it('路径写错（404）：错误里点明去改「接口路径」那一栏，并带上是哪个地址', async () => {
    postProbe({ ok: false, status: 404, statusText: 'Not Found' })
    await expect(testLlmEndpoint({ baseUrl: 'https://a.example/v1', apiKey: 'k', kind: 'embed', path: '/wrong', model: 'm' }))
      .rejects.toThrow(/404.*\/wrong.*接口路径/s)
  })

  it('向量 Key 错（401）：错误点明是 Key 的问题，而不是"厂商不支持"', async () => {
    postProbe({ ok: false, status: 401, statusText: 'Unauthorized' })
    await expect(testLlmEndpoint({ baseUrl: 'https://a.example/v1', apiKey: 'sk-bad', kind: 'embed', model: 'm' }))
      .rejects.toThrow(/401.*API Key 无效/s)
  })

  it('老签名 testLlmConnection 仍等价于 kind=chat（既有调用方不必改）', async () => {
    const { calls } = postProbe({ json: { data: [{ id: 'a' }, { id: 'b' }] } })
    const r = await testLlmConnection('https://api.deepseek.com/v1', 'sk-x')
    expect(calls[0]!.method).toBe('GET')
    expect(calls[0]!.url).toBe('https://api.deepseek.com/v1/models')
    expect(r.detail).toBe('该接口可见 2 个模型')
    expect(r.models).toBe(2)
  })
})

describe('余额查询', () => {
  it('没有 Key 直接报错（余额接口一律要凭据，不该白跑一趟）', async () => {
    const { called } = fetchProbe({ json: {} })
    await expect(queryLlmBalance('https://api.deepseek.com/v1', '')).rejects.toThrow(/需要 API Key/)
    expect(called.length).toBe(0)
  })

  it('DeepSeek：命中 /user/balance，带回地址与取回时间', async () => {
    const { called } = fetchProbe({ json: { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '9.99' }] } })
    const b = await queryLlmBalance('https://api.deepseek.com/v1', 'sk-x')
    expect(called[0]!.url).toBe('https://api.deepseek.com/user/balance')
    expect(b.total).toBe(9.99)
    expect(b.currency).toBe('CNY')
    expect(b.url).toBe('https://api.deepseek.com/user/balance')
    expect(typeof b.fetchedAt).toBe('number')
  })

  it('第一个候选 404 时换第二个候选（SiliconFlow 与 DeepSeek 两种路径都要能走）', async () => {
    const called: string[] = []
    vi.stubGlobal('fetch', async (url: unknown) => {
      called.push(String(url))
      if (String(url).endsWith('/user/info')) {
        return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}), text: async () => '' }
      }
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ balance_infos: [{ currency: 'CNY', total_balance: '3' }] }), text: async () => '' }
    })
    const b = await queryLlmBalance('https://api.siliconflow.cn/v1', 'sk-x')
    expect(called).toEqual(['https://api.siliconflow.cn/v1/user/info', 'https://api.siliconflow.cn/v1/user/balance'])
    expect(b.total).toBe(3)
  })

  it('两个候选都不可用：错误里带上是哪些地址、并说明"部分厂商不提供"', async () => {
    fetchProbe({ ok: false, status: 404, statusText: 'Not Found' })
    await expect(queryLlmBalance('https://api.openai.com/v1', 'sk-x')).rejects.toThrow(/不提供余额接口/)
  })

  it('401 直接判 Key 问题（不继续试下一个候选）', async () => {
    const { called } = fetchProbe({ ok: false, status: 401, statusText: 'Unauthorized' })
    await expect(queryLlmBalance('https://api.deepseek.com/v1', 'sk-bad')).rejects.toThrow(/API Key 无效/)
    expect(called.length).toBe(1)
  })

  it('返回里认不出余额字段：如实报错，绝不编一个数字', async () => {
    fetchProbe({ json: { code: 20000, data: { id: 'u1' } } })
    await expect(queryLlmBalance('https://api.siliconflow.cn/v1', 'sk-x')).rejects.toThrow(/没有可识别的余额字段/)
  })
})
