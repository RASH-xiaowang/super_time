/**
 * M7：LLM / embedding 请求的有界指数退避重试。
 *
 * 用假 fetch 确定性覆盖：可重试状态码、不可重试状态码、网络异常、`Retry-After`、
 * 中止信号、退避上限。断言的是**行为**（调用次数、等待时长、最终返回哪个响应），
 * 不是「mock 被调用过」。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error —— 宿主层是 CommonJS，无类型声明
import { MAX_DELAY_MS, TIMEOUT_ERROR_NAME, backoffDelayMs, fetchWithRetry, isRetryableStatus, parseRetryAfterMs } from '../llm-retry.js'

/** 造一个「按脚本返回」的假 fetch；脚本项可以是 Response 形状或要抛的异常。 */
function scriptedFetch(script) {
  const calls = { count: 0, urls: [] }
  const fn = async (url) => {
    const step = script[Math.min(calls.count, script.length - 1)]
    calls.count += 1
    calls.urls.push(url)
    if (step instanceof Error) throw step
    return step
  }
  return { fn, calls }
}

/** 等到信号中止（模拟「连接超时被 AbortSignal 掐断」的真实形状）。 */
function waitForAbort(signal) {
  return new Promise((resolve) => {
    if (!signal || signal.aborted) { resolve(undefined); return }
    signal.addEventListener('abort', () => { resolve(undefined) })
  })
}

/** 抛出一个与 fetch 超时同形的 AbortError。 */
function abortError() {
  const err = new Error('The operation was aborted')
  err.name = 'AbortError'
  return err
}

const HERE = dirname(fileURLToPath(import.meta.url))

const okResponse = (body = 'ok') => ({
  ok: true,
  status: 200,
  json: async () => ({ choices: [{ message: { content: body } }] }),
  text: async () => body,
  headers: { get: () => null },
})

const statusResponse = (status, retryAfter = null) => ({
  ok: false,
  status,
  json: async () => ({}),
  text: async () => 'err ' + status,
  headers: { get: (k) => (k.toLowerCase() === 'retry-after' ? retryAfter : null) },
})

/** 记录睡了多少毫秒（不真等）。 */
function recorder() {
  const slept = []
  return { slept, sleep: async (ms) => { slept.push(ms) } }
}

describe('可重试性判定', () => {
  it('只有 408/429/5xx 可重试，4xx 立刻失败', () => {
    for (const s of [408, 429, 500, 502, 503, 504]) expect(isRetryableStatus(s)).toBe(true)
    for (const s of [400, 401, 403, 404, 422]) expect(isRetryableStatus(s)).toBe(false)
  })

  it('退避递增且有上限，抖动不超过 20%', () => {
    const noJitter = () => 0
    expect(backoffDelayMs(1, noJitter)).toBe(500)
    expect(backoffDelayMs(2, noJitter)).toBe(1500)
    expect(backoffDelayMs(3, noJitter)).toBe(4500)
    expect(backoffDelayMs(4, noJitter)).toBe(MAX_DELAY_MS) // 夹住
    // 抖动上界
    expect(backoffDelayMs(1, () => 1)).toBe(600)
  })

  it('Retry-After 支持秒数与 HTTP-date，并夹在上限内', () => {
    expect(parseRetryAfterMs('2')).toBe(2000)
    expect(parseRetryAfterMs('0')).toBe(0)
    expect(parseRetryAfterMs('99999')).toBe(MAX_DELAY_MS)
    expect(parseRetryAfterMs('not-a-date')).toBeNull()
    expect(parseRetryAfterMs(null)).toBeNull()
    const now = Date.parse('2026-09-13T00:00:00Z')
    expect(parseRetryAfterMs('Sat, 13 Sep 2026 00:00:03 GMT', now)).toBe(3000)
    expect(parseRetryAfterMs('Sat, 13 Sep 2026 00:00:00 GMT', now)).toBe(0) // 过去时间 → 0
  })
})

describe('fetchWithRetry 行为', () => {
  const retryAll = { maxAttempts: 5, sleep: async () => {}, random: () => 0 }

  it('5xx 会重试，直到成功（断网/抖动后自动恢复）', async () => {
    const { fn, calls } = scriptedFetch([statusResponse(503), statusResponse(502), okResponse('答案')])
    const res = await fetchWithRetry(fn, 'u', {}, retryAll)
    expect(calls.count).toBe(3)
    expect(res.ok).toBe(true)
    expect((await res.json()).choices[0].message.content).toBe('答案')
  })

  it('429 会按 Retry-After 等待（而不是盲目退避）', async () => {
    const { fn } = scriptedFetch([statusResponse(429, '1'), okResponse()])
    const rec = recorder()
    const seen = []
    await fetchWithRetry(fn, 'u', {}, { ...retryAll, sleep: rec.sleep, onRetry: (i) => seen.push(i) })
    expect(rec.slept).toEqual([1000])
    expect(seen[0].reason).toContain('HTTP 429')
  })

  it('401/400 不重试（重试只会浪费时间、还可能触发风控）', async () => {
    for (const status of [400, 401, 403]) {
      const { fn, calls } = scriptedFetch([statusResponse(status), okResponse()])
      const res = await fetchWithRetry(fn, 'u', {}, retryAll)
      expect(calls.count).toBe(1)
      expect(res.status).toBe(status)
    }
  })

  it('网络异常会重试，耗尽后抛出最后一个异常', async () => {
    const { fn, calls } = scriptedFetch([new Error('socket hang up'), new Error('ETIMEDOUT'), new Error('ECONNRESET')])
    await expect(fetchWithRetry(fn, 'u', {}, { ...retryAll, maxAttempts: 3 })).rejects.toThrow('ECONNRESET')
    expect(calls.count).toBe(3)
  })

  it('中止信号一旦生效就立刻停（整体超时/用户取消不做无谓重试）', async () => {
    const controller = new AbortController()
    const { fn, calls } = scriptedFetch([statusResponse(503)])
    const rec = recorder()
    const p = fetchWithRetry(fn, 'u', { signal: controller.signal }, {
      ...retryAll,
      sleep: async (ms) => { rec.slept.push(ms); controller.abort() },
    })
    const res = await p
    expect(res.status).toBe(503) // 返回最后一次响应，而不是继续重试
    expect(calls.count).toBe(1)

    // 网络异常 + 已中止 → 不重试，并抛 AbortError（调用方据此区分「取消」与「网络故障」）
    const c2 = new AbortController()
    const s2 = scriptedFetch([new Error('aborted')])
    c2.abort()
    let thrown = null
    try {
      await fetchWithRetry(s2.fn, 'u', { signal: c2.signal }, retryAll)
    } catch (e) {
      thrown = e as Error
    }
    expect(thrown?.name).toBe('AbortError')
    expect(s2.calls.count).toBe(0) // 已中止 → 连第一个请求都不发
  })

  it('AbortError 直接抛出（不当作可重试的网络抖动）', async () => {
    const err = new Error('The operation was aborted')
    err.name = 'AbortError'
    const { fn, calls } = scriptedFetch([err])
    await expect(fetchWithRetry(fn, 'u', {}, retryAll)).rejects.toThrow(/aborted/)
    expect(calls.count).toBe(1)
  })

  it('重试次数有上界：maxAttempts 次后返回最后一个非 2xx 响应', async () => {
    const { fn, calls } = scriptedFetch([statusResponse(500)])
    const res = await fetchWithRetry(fn, 'u', {}, { ...retryAll, maxAttempts: 3 })
    expect(calls.count).toBe(3)
    expect(res.status).toBe(500)
  })

  it('onRetry 回调带出尝试序号与等待时长（供日志/诊断）', async () => {
    const onRetry = vi.fn()
    const { fn } = scriptedFetch([statusResponse(503), okResponse()])
    await fetchWithRetry(fn, 'u', {}, { ...retryAll, onRetry })
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(onRetry.mock.calls[0][0]).toMatchObject({ attempt: 1, delayMs: 500 })
  })
})

describe('单次尝试的超时（N13：由重试层逐次计时）', () => {
  const quiet = { maxAttempts: 3, sleep: async () => {}, random: () => 0 }

  it('第一次超时后仍会真发第二次请求（不是拿一个已中止的信号去打第二轮）', async () => {
    const signals = []
    let calls = 0
    const fn = async (_url, init) => {
      calls += 1
      signals.push(init.signal)
      if (calls === 1) {
        await waitForAbort(init.signal) // 等重试层自己武装的信号到期
        throw abortError()
      }
      return okResponse('答案')
    }
    const res = await fetchWithRetry(fn, 'u', {}, { ...quiet, timeoutMs: 30 })
    expect(calls).toBe(2)
    expect(res.ok).toBe(true)
    // 关键断言：第二次的信号是**新的**。若沿用调用方给的 AbortSignal.timeout(30)，
    // 这里会是 true —— 而重试层看到 aborted 就再也不发请求了（N13 的核心动机）。
    expect(signals[0]?.aborted).toBe(true)
    expect(signals[1]?.aborted).toBe(false)
  })

  it('每次尝试都超时 → 抛 TimeoutError（不是 AbortError：调用方要区分「对端一直超时」与「用户取消」）', async () => {
    let calls = 0
    const fn = async (_url, init) => {
      calls += 1
      await waitForAbort(init.signal)
      throw abortError()
    }
    let thrown = null
    try {
      await fetchWithRetry(fn, 'u', {}, { ...quiet, maxAttempts: 2, timeoutMs: 20 })
    } catch (e) {
      thrown = e
    }
    expect(calls).toBe(2)
    expect(thrown?.name).toBe(TIMEOUT_ERROR_NAME)
    expect(thrown?.timeoutMs).toBe(20)
    expect(thrown?.message).toContain('20ms')
  })

  it("timeoutScope: 'headers' 在拿到响应头后解除计时（多 GB 的 body 不会被连接超时掐断）", async () => {
    let captured
    const fn = async (_url, init) => { captured = init.signal; return okResponse() }
    await fetchWithRetry(fn, 'u', {}, { maxAttempts: 1, timeoutMs: 20, timeoutScope: 'headers' })
    await new Promise((r) => setTimeout(r, 60))
    expect(captured?.aborted).toBe(false)
  })

  it('默认档（整个请求）相反：同一时长下信号会中止，body 读取因此有上界', async () => {
    let captured
    const fn = async (_url, init) => { captured = init.signal; return okResponse() }
    await fetchWithRetry(fn, 'u', {}, { maxAttempts: 1, timeoutMs: 20 })
    await new Promise((r) => setTimeout(r, 60))
    expect(captured?.aborted).toBe(true)
  })

  it('调用方的取消信号仍然「一次都不发」（新增的超时档不影响 M7 的边界③）', async () => {
    const ctrl = new AbortController()
    const { fn, calls } = scriptedFetch([okResponse()])
    ctrl.abort()
    await expect(fetchWithRetry(fn, 'u', { signal: ctrl.signal }, { ...quiet, timeoutMs: 20 })).rejects.toThrow(/中止/)
    expect(calls.count).toBe(0)
  })
})

describe('接线：出网请求都走 fetchWithRetry', () => {
  /**
   * 覆盖清单（**显式**，新增出网点必须加进来）。
   *
   * 为什么从「只扫 wechat-host.js」扩成清单：M7 之后复审又找出四处 LLM 之外的出网点
   * （N13：封面 / 表情 / 朋友圈视频 / whisper 下载），只扫一个文件的话，
   * 「加了个新出网点忘了包重试」照样全绿 —— 而类型和单测都看不出这种遗漏。
   */
  const RETRY_WIRED_FILES = [
    '../wechat-host.js', // LLM chat / embedding（M7）
    '../wechat-data/src/query/article-cover.ts', // 公众号封面 ×2（N13）
    '../wechat-data/src/query/media-image.ts', // 远端表情取图（N13）
    '../wechat-data/src/query/sns-video.ts', // 朋友圈视频 + 封面（N13）
    '../wechat-data/src/query/whisper.ts', // 引擎 / 模型下载（N13）
  ]

  it('清单覆盖了 LLM 之外的四个出网点（清单被删空时这条会红）', () => {
    const external = RETRY_WIRED_FILES.filter(f => f.startsWith('../wechat-data/'))
    expect(external.map(f => f.split('/').pop())).toEqual([
      'article-cover.ts',
      'media-image.ts',
      'sns-video.ts',
      'whisper.ts',
    ])
  })

  for (const rel of RETRY_WIRED_FILES) {
    it(`${rel} 里不存在绕过重试的裸 fetch(`, () => {
      const src = readFileSync(join(HERE, rel), 'utf8')
      const bare = src.split(/\r?\n/)
        .map((line, i) => ({ line: line.trim(), no: i + 1 }))
        .filter((l) => /(^|[^.\w])fetch\(/.test(l.line) && !l.line.includes('fetchWithRetry'))
      expect(bare, `${rel} 第 ${bare.map(b => b.no).join(',')} 行有裸 fetch(`).toEqual([])
    })
  }
})