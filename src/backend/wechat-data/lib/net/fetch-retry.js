// src/backend/wechat-data/src/net/fetch-retry.ts
var RETRYABLE_STATUS = /* @__PURE__ */ new Set([408, 429, 500, 502, 503, 504]);
var DEFAULT_MAX_ATTEMPTS = 3;
var BASE_DELAY_MS = 500;
var MAX_DELAY_MS = 5e3;
var TIMEOUT_ERROR_NAME = "TimeoutError";
function isRetryableStatus(status) {
  return RETRYABLE_STATUS.has(Number(status));
}
function parseRetryAfterMs(headerValue, now = Date.now()) {
  if (headerValue === null || headerValue === void 0) return null;
  const raw = String(headerValue).trim();
  if (raw === "") return null;
  if (/^\d+$/.test(raw)) return Math.min(MAX_DELAY_MS, Number(raw) * 1e3);
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;
  return Math.min(MAX_DELAY_MS, Math.max(0, at - now));
}
function timeoutError(timeoutMs) {
  const shown = timeoutMs >= 1e3 ? `${Math.round(timeoutMs / 1e3)}s` : `${timeoutMs}ms`;
  const err = new Error(`\u8BF7\u6C42\u8D85\u65F6\uFF08${shown}\uFF09`);
  err.name = TIMEOUT_ERROR_NAME;
  err.timeoutMs = timeoutMs;
  return err;
}
function makeAttemptTimeout(timeoutMs, headersOnly) {
  if (headersOnly) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      ctrl.abort();
    }, timeoutMs);
    return { signal: ctrl.signal, disarm: () => clearTimeout(timer), fired: () => ctrl.signal.aborted };
  }
  const signal = AbortSignal.timeout(timeoutMs);
  return { signal, disarm: () => {
  }, fired: () => signal.aborted };
}
function withAttemptSignal(init, armed) {
  const signal = init?.signal;
  if (!signal) return { ...init, signal: armed.signal };
  return { ...init, signal: AbortSignal.any([signal, armed.signal]) };
}
function backoffDelayMs(attempt, random = Math.random) {
  const exp = BASE_DELAY_MS * Math.pow(3, Math.max(0, attempt - 1));
  return Math.min(MAX_DELAY_MS, Math.round(exp * (1 + 0.2 * random())));
}
async function fetchWithRetry(doFetch, url, init, opts = {}) {
  const maxAttempts = Math.max(1, Number(opts.maxAttempts) || DEFAULT_MAX_ATTEMPTS);
  const sleep = opts.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const random = opts.random || Math.random;
  const onRetry = opts.onRetry;
  const signal = init?.signal;
  const timeoutMs = Math.max(0, Number(opts.timeoutMs) || 0);
  const headersOnly = opts.timeoutScope === "headers";
  let lastError = null;
  let lastResponse = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (signal?.aborted) {
      if (lastResponse) return lastResponse;
      if (lastError) throw lastError;
      const aborted = new Error("\u8BF7\u6C42\u5DF2\u4E2D\u6B62\uFF08\u5DF2\u53D6\u6D88\u6216\u6574\u4F53\u8D85\u65F6\uFF09");
      aborted.name = "AbortError";
      throw aborted;
    }
    const isLast = attempt === maxAttempts;
    const armed = timeoutMs > 0 ? makeAttemptTimeout(timeoutMs, headersOnly) : null;
    const attemptInit = armed ? withAttemptSignal(init, armed) : init;
    try {
      const res = await doFetch(url, attemptInit);
      armed?.disarm();
      lastResponse = res;
      if (res?.ok) return res;
      const status = res ? res.status : 0;
      if (isLast || !isRetryableStatus(status)) return res;
      const fromHeader = res?.headers && typeof res.headers.get === "function" ? parseRetryAfterMs(res.headers.get("retry-after")) : null;
      const delayMs = fromHeader === null ? backoffDelayMs(attempt, random) : fromHeader;
      onRetry?.({ attempt, delayMs, reason: "HTTP " + status });
      await sleep(delayMs);
    } catch (e) {
      const failure = e instanceof Error ? e : new Error(String(e));
      const ownTimeout = Boolean(armed?.fired() && !signal?.aborted);
      armed?.disarm();
      if (signal?.aborted) throw failure;
      if (!ownTimeout && (failure.name === "AbortError" || failure.code === "ABORT_ERR")) {
        throw failure;
      }
      const retryError = ownTimeout ? timeoutError(timeoutMs) : failure;
      lastError = retryError;
      if (isLast) break;
      const delayMs = backoffDelayMs(attempt, random);
      onRetry?.({ attempt, delayMs, reason: retryError.message || String(retryError) });
      await sleep(delayMs);
    }
  }
  throw lastError ?? new Error("fetchWithRetry: \u8BF7\u6C42\u5931\u8D25");
}
export {
  BASE_DELAY_MS,
  DEFAULT_MAX_ATTEMPTS,
  MAX_DELAY_MS,
  RETRYABLE_STATUS,
  TIMEOUT_ERROR_NAME,
  backoffDelayMs,
  fetchWithRetry,
  isRetryableStatus,
  parseRetryAfterMs
};
