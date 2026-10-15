/**
 * LLM / embedding 请求的有界指数退避重试。
 *
 * 这个模块是 `fetchWithRetry` 的**唯一实现源**。宿主层 `llm-bridge.js` 通过
 * `import('./wechat-data/lib/index.js')` 取同一个导出，后端各 query 模块则直接
 * 从包内导入，不再反向依赖宿主层的 CommonJS 文件（也不再有手写的 `.d.ts`
 * 第二事实源）。
 *
 * 三条边界（有意为之）：
 *   ① 只重试**可重试**的：网络异常、408、429、5xx。401/403/400 这类立刻失败；
 *   ② `Retry-After` 优先（服务端明确要求等多久），但夹在上限内；
 *   ③ 调用方传进来的 `signal` 一旦中止就**立刻停**，不做无谓重试。
 *
 * N13 起它还接管「单次尝试的超时」（`opts.timeoutMs`）：LLM 之外的四条出网点
 * （封面/表情/朋友圈视频/whisper 下载）各自原本只超时一次、失败就整件事失败。
 * 超时必须**由重试层逐次武装**，不能由调用方塞一个 `AbortSignal.timeout()`。
 */

export type TimeoutScope = 'full' | 'headers'

export interface RetryInfo {
  /** 第几次尝试（从 1 开始）。 */
  attempt: number
  /** 本次退避要等多久。 */
  delayMs: number
  /** 为什么重试（状态码 / 错误名）。 */
  reason: string
}

export interface FetchWithRetryOptions {
  /** 最多尝试几次（含第一次）。 */
  maxAttempts?: number
  /** **单次尝试**的超时毫秒数；每次重新计时。0/省略 = 不计时。 */
  timeoutMs?: number
  /** 超时的计时范围。 */
  timeoutScope?: TimeoutScope
  /** 每次重试前的回调（日志/进度用）。 */
  onRetry?: (info: RetryInfo) => void
  /** 注入等待实现（测试用）。 */
  sleep?: (ms: number) => Promise<void>
  /** 注入随机源（退避抖动，测试用）。 */
  random?: () => number
}

/** 真正发请求的那个函数 —— 生产传 `fetch`，测试传桩。 */
export type RetryFetch = (input: string, init?: RequestInit) => Promise<Response>

/** 可重试的 HTTP 状态：408 超时、429 限流、5xx 服务端问题。 */
export const RETRYABLE_STATUS: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504])

/** 默认最大尝试次数（含首次）。 */
export const DEFAULT_MAX_ATTEMPTS = 3
/** 退避基数：500ms → 1500ms（×3 递增）。 */
export const BASE_DELAY_MS = 500
/** 单次等待上限：避免 Retry-After 把界面吊住。 */
export const MAX_DELAY_MS = 5000

/** 单次尝试超时耗尽时抛出的错误名（调用方据此区分「对端一直超时」与「用户取消」）。 */
export const TIMEOUT_ERROR_NAME = 'TimeoutError'

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(Number(status))
}

export function parseRetryAfterMs(headerValue: unknown, now = Date.now()): number | null {
  if (headerValue === null || headerValue === undefined) return null
  const raw = String(headerValue).trim()
  if (raw === '') return null
  if (/^\d+$/.test(raw)) return Math.min(MAX_DELAY_MS, Number(raw) * 1000)
  const at = Date.parse(raw)
  if (Number.isNaN(at)) return null
  return Math.min(MAX_DELAY_MS, Math.max(0, at - now))
}

function timeoutError(timeoutMs: number): Error & { timeoutMs: number } {
  const shown = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`
  const err = new Error(`请求超时（${shown}）`) as Error & { timeoutMs: number }
  err.name = TIMEOUT_ERROR_NAME
  err.timeoutMs = timeoutMs
  return err
}

interface AttemptTimeout {
  signal: AbortSignal
  disarm: () => void
  fired: () => boolean
}

function makeAttemptTimeout(timeoutMs: number, headersOnly: boolean): AttemptTimeout {
  if (headersOnly) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => {
      ctrl.abort()
    }, timeoutMs)
    return { signal: ctrl.signal, disarm: () => clearTimeout(timer), fired: () => ctrl.signal.aborted }
  }
  const signal = AbortSignal.timeout(timeoutMs)
  return { signal, disarm: () => {}, fired: () => signal.aborted }
}

function withAttemptSignal(
  init: RequestInit | undefined,
  armed: AttemptTimeout,
): RequestInit {
  const signal = init?.signal
  if (!signal) return { ...init, signal: armed.signal }
  return { ...init, signal: AbortSignal.any([signal, armed.signal]) }
}

export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
  const exp = BASE_DELAY_MS * Math.pow(3, Math.max(0, attempt - 1))
  // 加最多 20% 抖动：避免多个请求同时退避后再次同时打过去（惊群）。
  return Math.min(MAX_DELAY_MS, Math.round(exp * (1 + 0.2 * random())))
}

export async function fetchWithRetry(
  doFetch: RetryFetch,
  url: string,
  init: RequestInit | undefined,
  opts: FetchWithRetryOptions = {},
): Promise<Response> {
  const maxAttempts = Math.max(1, Number(opts.maxAttempts) || DEFAULT_MAX_ATTEMPTS)
  const sleep = opts.sleep || ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const random = opts.random || Math.random
  const onRetry = opts.onRetry
  const signal = init?.signal
  const timeoutMs = Math.max(0, Number(opts.timeoutMs) || 0)
  const headersOnly = opts.timeoutScope === 'headers'

  let lastError: Error | null = null
  let lastResponse: Response | null = null
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (signal?.aborted) {
      if (lastResponse) return lastResponse
      if (lastError) throw lastError
      const aborted = new Error('请求已中止（已取消或整体超时）')
      aborted.name = 'AbortError'
      throw aborted
    }
    const isLast = attempt === maxAttempts
    const armed = timeoutMs > 0 ? makeAttemptTimeout(timeoutMs, headersOnly) : null
    const attemptInit = armed ? withAttemptSignal(init, armed) : init
    try {
      const res = await doFetch(url, attemptInit)
      // 响应头已到：headers 档的计时到此为止（body 还要流很久）。
      armed?.disarm()
      lastResponse = res
      if (res?.ok) return res
      const status = res ? res.status : 0
      if (isLast || !isRetryableStatus(status)) return res
      const fromHeader = res?.headers && typeof res.headers.get === 'function'
        ? parseRetryAfterMs(res.headers.get('retry-after'))
        : null
      const delayMs = fromHeader === null ? backoffDelayMs(attempt, random) : fromHeader
      onRetry?.({ attempt, delayMs, reason: 'HTTP ' + status })
      await sleep(delayMs)
    } catch (e) {
      const failure = e instanceof Error ? e : new Error(String(e))
      const ownTimeout = Boolean(armed?.fired() && !signal?.aborted)
      armed?.disarm()
      // 中止（整体超时/用户取消）→ 立刻停，重试没有意义
      if (signal?.aborted) throw failure
      if (!ownTimeout && (failure.name === 'AbortError' || (failure as NodeJS.ErrnoException).code === 'ABORT_ERR')) {
        throw failure
      }
      const retryError = ownTimeout ? timeoutError(timeoutMs) : failure
      lastError = retryError
      if (isLast) break
      const delayMs = backoffDelayMs(attempt, random)
      onRetry?.({ attempt, delayMs, reason: retryError.message || String(retryError) })
      await sleep(delayMs)
    }
  }
  throw lastError ?? new Error('fetchWithRetry: 请求失败')
}
