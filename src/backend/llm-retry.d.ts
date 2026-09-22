/**
 * `llm-retry.js` 的类型面（H11：给宿主层 JS 补声明，而不是在调用处写 `any`）。
 *
 * 为什么单独写这个文件：后端有 5 个模块 `import { fetchWithRetry } from '../../../llm-retry.js'`，
 * 而宿主层是 CommonJS 无声明 —— 开 `noImplicitAny` 之后这 5 处一律报 TS7016。
 * 用 `// @ts-expect-error` 或 `as any` 咽掉等于**把重试层的契约丢掉**：
 * 参数拼错、`opts` 少一个键，全都查不出来，而这一层管的正是「超时/退避/取消」这类最难查的线上行为。
 * 形状与 `llm-retry.js` 的 JSDoc 逐条对齐。
 */

/** 单次尝试的超时作用域：`'headers'` = 只对拿到响应头之前计时（流式下载用）。 */
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
  /** 超时的计时范围，见 {@link TimeoutScope}。 */
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

/**
 * 带退避重试的 fetch：只重试「值得重试」的状态与网络错误，尊重 `Retry-After`，
 * 并支持整体中止（`init.signal`）与单次超时。
 * @returns 最后一次响应；全部失败时抛最后一次的错误。
 */
export function fetchWithRetry(
  doFetch: RetryFetch,
  url: string,
  init: RequestInit | undefined,
  opts?: FetchWithRetryOptions,
): Promise<Response>

/** 该状态码是否值得重试。 */
export function isRetryableStatus(status: number): boolean

/** 解析 `Retry-After`（秒数或 HTTP-date），夹到 `[0, MAX_DELAY_MS]`；无法解析返回 null。 */
export function parseRetryAfterMs(headerValue: unknown, now?: number): number | null

/** 第 `attempt` 次重试前应等待的毫秒数（指数退避 + 抖动）。 */
export function backoffDelayMs(attempt: number, random?: () => number): number

export const BASE_DELAY_MS: number
export const DEFAULT_MAX_ATTEMPTS: number
export const MAX_DELAY_MS: number
export const RETRYABLE_STATUS: ReadonlySet<number>
/** 单次超时的 `Error.name`（调用方靠它区分「超时」与「网络错误」）。 */
export const TIMEOUT_ERROR_NAME: string
