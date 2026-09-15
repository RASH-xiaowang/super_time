'use strict';

/**
 * LLM / embedding 请求的**有界指数退避重试**。
 *
 * 为什么要单独抽出来：这段逻辑原先不存在 —— 一次网络抖动、一次 429、一次网关 502
 * 就等于整轮问答失败（用户看到「LLM HTTP 503」，只能自己再点一次）。而它又只能靠
 * 「真的断网/真的打到一个会抖的服务」才观察得到，没法在 CI 里回归。把 `fetch` 做成
 * 注入参数后，用假 fetch 就能确定性覆盖：可重试状态码、不可重试状态码、网络异常、
 * 中止信号、退避上限。
 *
 * 三条边界（有意为之）：
 *   ① 只重试**可重试**的：网络异常、408、429、5xx。401/403/400 这类立刻失败
 *      （重试只会浪费用户时间，还可能触发风控）；
 *   ② `Retry-After` 优先（服务端明确要求等多久），但夹在上限内 —— 否则一个
 *      `Retry-After: 3600` 会把界面吊住一小时；
 *   ③ 调用方传进来的 `signal` 一旦中止就**立刻停**（那是整体超时/用户取消），
 *      不做无谓重试。
 *
 * N13 起它还接管「单次尝试的超时」（`opts.timeoutMs`）：LLM 之外的四条出网点
 * （封面/表情/朋友圈视频/whisper 下载）各自原本只超时一次、失败就整件事失败。
 * 超时必须**由重试层逐次武装**，不能由调用方塞一个 `AbortSignal.timeout()` —— 见
 * {@link makeAttemptTimeout}。
 */

/** 可重试的 HTTP 状态：408 超时、429 限流、5xx 服务端问题。 */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/** 默认最大尝试次数（含首次）。 */
const DEFAULT_MAX_ATTEMPTS = 3;
/** 退避基数：500ms → 1500ms（×3 递增）。 */
const BASE_DELAY_MS = 500;
/** 单次等待上限：避免 Retry-After 把界面吊住。 */
const MAX_DELAY_MS = 5000;

/** 单次尝试超时耗尽时抛出的错误名（调用方据此区分「对端一直超时」与「用户取消」）。 */
const TIMEOUT_ERROR_NAME = 'TimeoutError';

/**
 * 该状态码是否值得重试。
 * @param {number} status - HTTP 状态码。
 * @returns {boolean} 是否可重试。
 */
function isRetryableStatus(status) {
  return RETRYABLE_STATUS.has(Number(status));
}

/**
 * 解析 `Retry-After` 响应头（秒数或 HTTP-date），夹到 [0, MAX_DELAY_MS]。
 * @param {unknown} headerValue - 响应头原始值。
 * @param {number} now - 当前时间（毫秒，便于测试注入）。
 * @returns {number | null} 建议等待毫秒数；无法解析时返回 null。
 */
function parseRetryAfterMs(headerValue, now = Date.now()) {
  if (headerValue === null || headerValue === undefined) return null;
  const raw = String(headerValue).trim();
  if (raw === '') return null;
  if (/^\d+$/.test(raw)) return Math.min(MAX_DELAY_MS, Number(raw) * 1000);
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;
  return Math.min(MAX_DELAY_MS, Math.max(0, at - now));
}

/**
 * 超时错误：`name` 刻意**不是** `AbortError` —— 调用方要能把「对端一直超时」与
 * 「用户取消 / 整体超时」分开报错（前者可以说「请重试」，后者不该说）。
 * @param {number} timeoutMs - 触发的超时值。
 * @returns {Error} 名称为 {@link TIMEOUT_ERROR_NAME} 的错误。
 */
function timeoutError(timeoutMs) {
  const shown = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`;
  const err = new Error(`请求超时（${shown}）`);
  err.name = TIMEOUT_ERROR_NAME;
  err.timeoutMs = timeoutMs;
  return err;
}

/**
 * 武装**本次尝试**的超时信号。
 *
 * 为什么不能由调用方传一个 `AbortSignal.timeout(...)`：那个信号是整段重试共用的，
 * 第一次超时就把它永久置为 aborted，而重试层每次发请求前都会检查中止（边界③），
 * 于是「对端一直超时」这个最需要重试的场景反而不重试了。放进重试层就能逐次重新计时。
 * @param {number} timeoutMs - 单次尝试的超时。
 * @param {boolean} headersOnly - 是否只对「收到响应头之前」计时。流式下载必须用它：
 *   多 GB 的模型不能被连接超时在传到一半时掐断（旧实现在拿到响应头后 clearTimeout）。
 * @returns {{ signal: AbortSignal, disarm: () => void, fired: () => boolean }} 本次尝试的超时控制器。
 */
function makeAttemptTimeout(timeoutMs, headersOnly) {
  if (headersOnly) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => { ctrl.abort() }, timeoutMs);
    return { signal: ctrl.signal, disarm: () => clearTimeout(timer), fired: () => ctrl.signal.aborted };
  }
  // AbortSignal.timeout 的计时器是 unref 的：不会拖住进程退出。
  const signal = AbortSignal.timeout(timeoutMs);
  return { signal, disarm: () => {}, fired: () => signal.aborted };
}

/**
 * 第 `attempt` 次失败后要等多久（attempt 从 1 开始）。
 * @param {number} attempt - 已失败的尝试序号。
 * @param {() => number} random - 随机源（注入以便测试确定化）。
 * @returns {number} 等待毫秒数。
 */
function backoffDelayMs(attempt, random = Math.random) {
  const exp = BASE_DELAY_MS * Math.pow(3, Math.max(0, attempt - 1));
  // 加最多 20% 抖动：避免多个请求同时退避后再次同时打过去（惊群）。
  return Math.min(MAX_DELAY_MS, Math.round(exp * (1 + 0.2 * random())));
}

/**
 * 带重试的 fetch。返回**最后一个**响应（可能是非 2xx，由调用方决定怎么报错），
 * 网络异常重试耗尽后抛出最后一个异常。
 * @param {(url: string, init: object) => Promise<any>} doFetch - 实际发请求的函数（注入）。
 * @param {string} url - 请求地址。
 * @param {object} init - fetch 的第二个参数（含 signal）。
 * @param {{ maxAttempts?: number, onRetry?: (info: { attempt: number, delayMs: number, reason: string }) => void, sleep?: (ms: number) => Promise<void>, random?: () => number, timeoutMs?: number, timeoutScope?: 'request' | 'headers' }} [opts]
 *   `timeoutMs` 是**单次尝试**的超时（每次都重新计时，见 {@link makeAttemptTimeout}）；
 *   `timeoutScope: 'headers'` 表示只对拿到响应头之前计时（流式下载用）。
 * @returns {Promise<any>} 最后一个响应。
 */
async function fetchWithRetry(doFetch, url, init, opts = {}) {
  const maxAttempts = Math.max(1, Number(opts.maxAttempts) || DEFAULT_MAX_ATTEMPTS);
  const sleep = opts.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const random = opts.random || Math.random;
  const onRetry = opts.onRetry;
  const signal = init && init.signal;
  const timeoutMs = Math.max(0, Number(opts.timeoutMs) || 0);
  const headersOnly = opts.timeoutScope === 'headers';

  let lastError = null;
  let lastResponse = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    // 已经中止（整体超时 / 用户取消）→ **不再发新请求**：手上若有响应就返回它，
    // 否则抛出上一次的异常。这个检查必须在 doFetch **之前** —— 若只在等待前检查，
    // 在 `sleep` 期间被中止时下一轮仍会真打一次网络（测试实测：调用次数 2 而非 1）。
    if (signal && signal.aborted) {
      if (lastResponse) return lastResponse;
      if (lastError instanceof Error) throw lastError;
      // 用 AbortError 的 name：调用方要能把「取消/超时」与「真实网络错误」区分开。
      const aborted = new Error('请求已中止（已取消或整体超时）');
      aborted.name = 'AbortError';
      throw aborted;
    }
    const isLast = attempt === maxAttempts;
    const armed = timeoutMs > 0 ? makeAttemptTimeout(timeoutMs, headersOnly) : null;
    const attemptInit = armed
      ? { ...init, signal: signal ? AbortSignal.any([signal, armed.signal]) : armed.signal }
      : init;
    try {
      const res = await doFetch(url, attemptInit);
      // 响应头已到：headers 档的计时到此为止（body 还要流很久）。
      if (armed) armed.disarm();
      lastResponse = res;
      if (res && res.ok) return res;
      const status = res ? res.status : 0;
      if (isLast || !isRetryableStatus(status)) return res;
      const fromHeader = res && res.headers && typeof res.headers.get === 'function'
        ? parseRetryAfterMs(res.headers.get('retry-after'))
        : null;
      const delayMs = fromHeader === null ? backoffDelayMs(attempt, random) : fromHeader;
      if (onRetry) onRetry({ attempt, delayMs, reason: 'HTTP ' + status });
      await sleep(delayMs);
    } catch (e) {
      // 是不是**本次尝试自己的**超时？是的话它只是「这个连接不好」，值得重试；
      // 而 AbortError 本身（调用方取消 / 整体超时）仍然立刻抛。
      const ownTimeout = Boolean(armed && armed.fired() && !(signal && signal.aborted));
      if (armed) armed.disarm();
      // 中止（整体超时/用户取消）→ 立刻停，重试没有意义
      if (signal && signal.aborted) throw e;
      if (!ownTimeout && e && (e.name === 'AbortError' || e.code === 'ABORT_ERR')) throw e;
      const failure = ownTimeout ? timeoutError(timeoutMs) : e;
      lastError = failure;
      if (isLast) break;
      const delayMs = backoffDelayMs(attempt, random);
      if (onRetry) onRetry({ attempt, delayMs, reason: (failure && failure.message) || String(failure) });
      await sleep(delayMs);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('fetchWithRetry: 请求失败');
}

module.exports = {
  BASE_DELAY_MS,
  DEFAULT_MAX_ATTEMPTS,
  MAX_DELAY_MS,
  RETRYABLE_STATUS,
  TIMEOUT_ERROR_NAME,
  backoffDelayMs,
  fetchWithRetry,
  isRetryableStatus,
  parseRetryAfterMs,
};
