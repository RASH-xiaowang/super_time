'use strict';

/**
 * LLM 出网传输的唯一实现源。
 *
 * 聊天/向量/精排（`llm-bridge.js`）、模型列表（`ipc-wechat.js`）、连接测试与
 * 余额查询（`llm-balance.js`）都从这里发请求。以前三处各自手写 fetch/超时/错误
 * 翻译，导致重试、超时和错误形状逐渐漂移；这里只保留：
 *   - 地址归一化与主机卫生（拒绝非 http(s)、URL 凭据、query/hash）
 *   - 统一的 JSON 请求头与 Bearer 凭据
 *   - 唯一的 `fetchWithRetry` 调用点
 *
 * 重试策略仍由各调用方显式传 `maxAttempts`：内容型 LLM 请求沿用 M7 的三次有界重试，
 * 交互式探针/余额/模型列表默认一次尝试、快速失败。策略可以不同，但实现不再分叉。
 *
 * `fetchWithRetry` 的实现仍只住在 `wechat-data/src/net/fetch-retry.ts`。构建流程
 * 会从同一份源码另产出约 3KB 的独立 bundle（`lib/net/fetch-retry.js`），宿主层
 * 优先加载它，而不是为一个小工具冷加载整个网关 bundle。未构建过时回退到完整的
 * `lib/index.js`，保证 `npm test` 也能在只检出仓库后直接跑。
 */

let retryModule = null;

function loadRetryModule() {
  if (!retryModule) {
    retryModule = import('./wechat-data/lib/net/fetch-retry.js')
      .catch((error) => {
        // 源码未构建（例如 release 流程先跑 npm test）时仍可回退；其它错误照常抛出，
        // 不把一个损坏的独立产物伪装成“正常加载了完整网关”。
        if (error && (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'MODULE_NOT_FOUND')) {
          return import('./wechat-data/lib/index.js');
        }
        throw error;
      })
      .then((mod) => {
        if (typeof mod.fetchWithRetry !== 'function') {
          throw new Error('wechat-data bundle 未导出 fetchWithRetry');
        }
        return mod.fetchWithRetry;
      });
  }
  return retryModule;
}

async function fetchWithRetry(...args) {
  const fn = await loadRetryModule();
  return fn(...args);
}

/** 交互式探针等不重试请求的默认尝试次数。 */
const DEFAULT_MAX_ATTEMPTS = 1;

/** 未显式给超时的请求默认 20 秒（与既有连接测试口径一致）。 */
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * 解析用户配置的 LLM base URL，并顺手做主机卫生。
 *
 * 保留 http(s) 是因为文档明确支持用户指向自建/内网模型端点；这里收掉的是会改变
 * 请求语义或泄露凭据的写法，而不是禁止内网。
 *
 * @param {unknown} input - 用户填写的地址。
 * @returns {{ raw: string, base: string, host: string, origin: string }}
 */
function parseLlmBaseUrl(input) {
  const raw = String(input ?? '').trim();
  if (!/^https?:\/\//i.test(raw)) {
    throw new Error('API 地址需以 http:// 或 https:// 开头');
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('API 地址格式无效');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('API 地址需以 http:// 或 https:// 开头');
  }
  if (url.username || url.password) {
    throw new Error('API 地址不能包含用户名或密码');
  }
  if (url.search || url.hash) {
    throw new Error('API 地址不能包含查询参数或片段');
  }
  return {
    raw,
    base: url.toString().replace(/\/+$/, ''),
    host: url.host,
    origin: url.origin,
  };
}

/**
 * 组装 LLM 请求头。apiKey 为空时绝不写 Authorization，避免把空凭据送出去。
 *
 * @param {string} apiKey - Bearer 凭据。
 * @param {Record<string, string>} [extra] - 调用方补充的头。
 * @returns {Record<string, string>}
 */
function headersFor(apiKey = '', extra = {}) {
  const headers = { ...extra };
  if (!Object.prototype.hasOwnProperty.call(headers, 'accept')) {
    headers.accept = 'application/json';
  }
  const key = String(apiKey || '');
  if (key) headers.authorization = `Bearer ${key}`;
  return headers;
}

/**
 * 发一次 LLM HTTP 请求。
 *
 * @param {string} url - 已拼好的目标地址。
 * @param {object} [options] - method/apiKey/headers/body/timeoutMs/maxAttempts/signal
 *   /onRetry/sleep/random/fetchImpl。
 * @returns {Promise<Response>} fetch 响应；非 2xx 由调用方自己决定如何解释。
 */
async function llmRequest(url, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const headers = headersFor(options.apiKey, options.headers || {});
  const init = {
    method,
    headers,
  };
  if (options.signal) init.signal = options.signal;
  if (options.body !== undefined) {
    init.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    if (!Object.prototype.hasOwnProperty.call(headers, 'content-type')) {
      headers['content-type'] = 'application/json';
    }
  }

  const timeoutMs = Math.max(0, Number(options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const maxAttempts = Math.max(1, Number(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
  const doFetch = options.fetchImpl || fetch;

  return fetchWithRetry(doFetch, String(url), init, {
    maxAttempts,
    timeoutMs,
    ...(options.timeoutScope ? { timeoutScope: options.timeoutScope } : {}),
    ...(options.onRetry ? { onRetry: options.onRetry } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.random ? { random: options.random } : {}),
  });
}

module.exports = {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_TIMEOUT_MS,
  parseLlmBaseUrl,
  headersFor,
  llmRequest,
};
