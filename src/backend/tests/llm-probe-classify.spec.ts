/**
 * W2-12.1：LLM 探针的失败要能**分类**，不能只有一段各链路各写各的文案。
 *
 * ## 这条要守的事
 *
 * 配置里有三套地址·Key·路径（主模型 / 向量 / 精排），探针也按三条链路各测各的。
 * 失败文案是**故意**不统一的（chat 的 401 说「请检查后重试」，embed 说「检查接口路径」）——
 * 文案要贴着那条链路说人话。但「这是哪一类问题」原先**没有统一答案**：
 * 网络层在 `humanizeNetworkError` 里翻、HTTP 层在两处各翻一遍（chat 内联一份、
 * embed/rerank 走 `httpError`），三份表、三种覆盖，404 在 embed/rerank 上
 * 甚至连「可能少了 /v1」这句最常见的配置错都没提。
 *
 * 本条把分类收敛到一张纯函数表（`classifyProbeFailure`），文案仍各写各的，
 * 抛出的错上挂 `probeCode` / `retryable`。
 *
 * ## 判据分两层
 *
 * ① 表本身：九类逐个钉住，含 `retryable`（哪些值得让用户点「重试」）；
 * ② 三条链路**对同一失败必须给出同一个 code** —— 这才是「分类」的意义，
 *    如果 embed 的 404 与 chat 的 404 分到两个类，这张表就白建了。
 * @vitest-environment node
 */
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const {
  PROBE_FAILURE_CODES, classifyProbeFailure, testLlmEndpoint, testLlmConnection,
} = require('../llm-balance.js')

afterEach(() => { vi.unstubAllGlobals() })

/** fetch 探针：按给定响应作答，并记录请求。 */
function probe(reply: { ok?: boolean; status?: number; statusText?: string; json?: unknown; text?: string; fail?: Error } = {}): Array<{ url: string }> {
  const called: Array<{ url: string }> = []
  vi.stubGlobal('fetch', async (url: unknown) => {
    called.push({ url: String(url) })
    if (reply.fail) throw reply.fail
    return {
      ok: reply.ok ?? true,
      status: reply.status ?? 200,
      statusText: reply.statusText ?? 'Not Found',
      json: async () => reply.json ?? {},
      text: async () => reply.text ?? '',
    }
  })
  return called
}

/** 接住一次探针抛出的错（`rejects.toThrow` 拿不到自定义字段）。 */
async function catchOf(p: Promise<unknown>): Promise<Error & { probeCode?: string; retryable?: boolean }> {
  try { await p } catch (e) { return e as Error & { probeCode?: string; retryable?: boolean } }
  throw new Error('探针居然没抛错')
}

describe('W2-12.1 分类表：九类逐个钉住', () => {
  it('清单就是这九类，不许悄悄多一类少一类', () => {
    expect(PROBE_FAILURE_CODES).toEqual([
      'dns', 'timeout', 'tls', 'refused', 'reset', 'unauthorized', 'not-found', 'server', 'unknown',
    ])
  })

  it('网络层五类：DNS / 超时 / TLS / 拒绝 / 重置', () => {
    expect(classifyProbeFailure({ errCode: 'ENOTFOUND' }).code).toBe('dns')
    expect(classifyProbeFailure({ errCode: 'EAI_AGAIN' }).code).toBe('dns')
    // 超时有两条来路：连接超时（UND_ERR_*）与我们自己 20 秒到了主动 abort。
    expect(classifyProbeFailure({ errCode: 'UND_ERR_CONNECT_TIMEOUT' }).code).toBe('timeout')
    expect(classifyProbeFailure({ errCode: 'ETIMEDOUT' }).code).toBe('timeout')
    expect(classifyProbeFailure({ errName: 'AbortError' }).code).toBe('timeout')
    expect(classifyProbeFailure({ errName: 'TimeoutError' }).code).toBe('timeout')
    expect(classifyProbeFailure({ errCode: 'CERT_HAS_EXPIRED' }).code).toBe('tls')
    expect(classifyProbeFailure({ errCode: 'ECONNREFUSED' }).code).toBe('refused')
    expect(classifyProbeFailure({ errCode: 'ECONNRESET' }).code).toBe('reset')
  })

  it('HTTP 层三类：401/403 → unauthorized，404 → not-found，5xx → server', () => {
    expect(classifyProbeFailure({ status: 401 }).code).toBe('unauthorized')
    expect(classifyProbeFailure({ status: 403 }).code).toBe('unauthorized')
    expect(classifyProbeFailure({ status: 404 }).code).toBe('not-found')
    expect(classifyProbeFailure({ status: 500 }).code).toBe('server')
    expect(classifyProbeFailure({ status: 503 }).code).toBe('server')
  })

  it('认不出来就归 unknown，**不**硬套某一类', () => {
    expect(classifyProbeFailure({}).code).toBe('unknown')
    expect(classifyProbeFailure({ status: 200 }).code).toBe('unknown')
    expect(classifyProbeFailure({ status: 400 }).code).toBe('unknown')
    expect(classifyProbeFailure({ errCode: 'EWEIRD' }).code).toBe('unknown')
  })

  it('可重试的只有四类：超时 / 重置 / 5xx / **认不出来的那类**', () => {
    const retryable = PROBE_FAILURE_CODES.filter((c: string) => classifyProbeFailure(
      c === 'dns' ? { errCode: 'ENOTFOUND' }
        : c === 'timeout' ? { errName: 'AbortError' }
          : c === 'tls' ? { errCode: 'CERT_HAS_EXPIRED' }
            : c === 'refused' ? { errCode: 'ECONNREFUSED' }
              : c === 'reset' ? { errCode: 'ECONNRESET' }
                : c === 'unauthorized' ? { status: 401 }
                  : c === 'not-found' ? { status: 404 }
                    : c === 'server' ? { status: 503 }
                      : {},
    ).retryable)
    expect(retryable, '「换个时刻/换个链路可能就通了」才值得让用户点重试；unknown 也算 —— 认不出来时不敢断言它没救，允许重试比直接判死安全').toEqual(['timeout', 'reset', 'server', 'unknown'])
  })

  it('是纯函数：反复调用不改输入、结果稳定', () => {
    const input = Object.freeze({ status: 404 })
    expect(classifyProbeFailure(input)).toEqual(classifyProbeFailure(input))
    expect(Object.keys(input)).toEqual(['status'])
  })
})

describe('W2-12.1 三条链路对同一失败必须给出同一个 code', () => {
  const EMBED = { baseUrl: 'https://a.example/v1', apiKey: 'k', kind: 'embed' as const, path: '/embeddings', model: 'm' }
  const RERANK = { baseUrl: 'https://a.example/v1', apiKey: 'k', kind: 'rerank' as const, path: '/rerank', model: 'm' }

  it('404：chat / embed / rerank 都归 not-found', async () => {
    probe({ ok: false, status: 404 })
    const chat = await catchOf(testLlmConnection('https://a.example/v1', 'sk-x'))
    probe({ ok: false, status: 404 })
    const embed = await catchOf(testLlmEndpoint(EMBED))
    probe({ ok: false, status: 404 })
    const rerank = await catchOf(testLlmEndpoint(RERANK))
    expect([chat.probeCode, embed.probeCode, rerank.probeCode]).toEqual(['not-found', 'not-found', 'not-found'])
    expect([chat.retryable, embed.retryable, rerank.retryable]).toEqual([false, false, false])
  })

  it('401：文案区分「Key 无效」与「Key 为空」，但分类相同', async () => {
    probe({ ok: false, status: 401 })
    const badKey = await catchOf(testLlmConnection('https://a.example/v1', 'sk-bad'))
    probe({ ok: false, status: 403 })
    const noKey = await catchOf(testLlmEndpoint({ ...EMBED, apiKey: '' }))
    expect(badKey.message).toMatch(/无效或无权限/)
    expect(noKey.message).toMatch(/Key 为空/)
    expect([badKey.probeCode, noKey.probeCode]).toEqual(['unauthorized', 'unauthorized'])
  })

  it('DNS 与超时：文案与分类都要对上（分类不能丢在翻译之后）', async () => {
    probe({ fail: Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } }) })
    const dns = await catchOf(testLlmConnection('https://nope.example/v1', 'sk-x'))
    probe({ fail: Object.assign(new Error('aborted'), { name: 'AbortError' }) })
    const slow = await catchOf(testLlmEndpoint(EMBED))
    expect([dns.message, dns.probeCode, dns.retryable]).toEqual([expect.stringContaining('域名解析失败'), 'dns', false])
    expect([slow.message, slow.probeCode, slow.retryable]).toEqual([expect.stringContaining('超时'), 'timeout', true])
  })

  it('5xx：三条链路都归 server 且**可重试**', async () => {
    probe({ ok: false, status: 503, statusText: 'Service Unavailable' })
    const chat = await catchOf(testLlmConnection('https://a.example/v1', 'sk-x'))
    probe({ ok: false, status: 502, statusText: 'Bad Gateway' })
    const embed = await catchOf(testLlmEndpoint(EMBED))
    probe({ ok: false, status: 500, statusText: 'Internal Server Error' })
    const rerank = await catchOf(testLlmEndpoint(RERANK))
    expect([chat.probeCode, embed.probeCode, rerank.probeCode]).toEqual(['server', 'server', 'server'])
    expect([chat.retryable, embed.retryable, rerank.retryable]).toEqual([true, true, true])
  })
})

/**
 * 把**地址本身**从文案里剔掉再找 `/v1`。
 *
 * 不剔会假绿：报错文案里带着请求地址，而地址（`https://a.example/v1/embeddings`）
 * **本来就含 `/v1`** —— 哪怕那句提示被整段删掉，`/404[\s\S]*\/v1/` 照样匹配。
 * 这是本仓栽过的假绿形状（测过的东西其实没测到），这里显式剔掉。
 * @param message - 错误文案。
 * @param url - 那次请求实际打到的地址。
 * @returns 去掉地址后的文案。
 */
function withoutUrl(message: string, url: string): string {
  return message.split(url).join('<URL>')
}

describe('W2-12.1「缺 /v1」是最常见的配置错，三条链路都必须说', () => {
  const EMBED = { baseUrl: 'https://a.example/v1', apiKey: 'k', kind: 'embed' as const, path: '/embeddings', model: 'm' }
  const RERANK = { baseUrl: 'https://a.example/v1', apiKey: 'k', kind: 'rerank' as const, path: '/rerank', model: 'm' }

  it('chat / embed / rerank 的 404 文案里都出现 /v1（剔掉地址再找，否则假绿）', async () => {
    const chatUrl = 'https://a.example/v1/models'
    probe({ ok: false, status: 404 })
    const chat = await catchOf(testLlmConnection('https://a.example/v1', 'sk-x'))
    const embedUrl = 'https://a.example/v1/embeddings'
    probe({ ok: false, status: 404 })
    const embed = await catchOf(testLlmEndpoint(EMBED))
    const rerankUrl = 'https://a.example/v1/rerank'
    probe({ ok: false, status: 404 })
    const rerank = await catchOf(testLlmEndpoint(RERANK))
    // 改之前 embed / rerank 只说「检查接口路径」，用户拿不到最常见的那个猜测。
    expect(withoutUrl(chat.message, chatUrl)).toMatch(/404[\s\S]*\/v1/)
    expect(withoutUrl(embed.message, embedUrl), '向量链路丢了「少了 /v1」这句').toMatch(/404[\s\S]*\/v1/)
    expect(withoutUrl(rerank.message, rerankUrl), '精排链路丢了「少了 /v1」这句').toMatch(/404[\s\S]*\/v1/)
  })
})

describe('W2-12.1 成功路径不许被分类逻辑污染', () => {
  it('探通了就只回 `{ms, detail, url}`，不挂任何 probeCode', async () => {
    probe({ json: { data: [{ id: 'm1' }] } })
    const r = await testLlmConnection('https://a.example/v1', 'sk-x')
    expect(r.detail).toMatch(/可见 1 个模型/)
    expect(Object.keys(r).sort()).toEqual(['detail', 'models', 'ms', 'url'])
  })
})
