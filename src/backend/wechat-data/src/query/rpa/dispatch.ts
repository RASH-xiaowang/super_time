/**
 * 多厂商触发的**统一派发管道**（2026-10-21）——本域**唯一出网函数**在这里。
 *
 * 流程（与厂商无关，核心不认识任何具体厂商）：
 *   ① 组装请求：厂商 `buildRequest` 钩子优先（Webhook 带图片等），否则按描述符模板渲染；
 *   ② 主机校验：`governance.hosts` 白名单（exact/suffix）；内置 Webhook 特例允许任意 http(s)；
 *      私有化自定义 baseUrl 仅当 host 与配置一致且不是本机/私网字面量时放行；
 *   ③ 鉴权：`applyAuth`（bearer/header/token-exchange/custom）；
 *   ④ 出网：`sendRequest` 是**唯一 `fetchWithRetry` 调用点**（出网台账 `dispatch.ts#sendRequest`），
 *      单次 15s、尝试次数取 `descriptor.retry.maxAttempts`；
 *   ⑤ 解析：厂商 `parseResponse` 钩子优先，否则通用规则（HTTP 状态 + okPath/okValue + externalTaskIdPath）。
 *
 * v1 不做完成状态轮询/入站回调：`externalTaskId` 由 callback 层落库，供后续能力使用。
 * 失败（网络/超时/非 2xx/业务码失败/主机越界）一律返回 `{status:'failed', error}`，
 * 错误文案不含凭据原文。
 */
import { fetchWithRetry } from '../../net/fetch-retry.ts'
import type { RetryFetch } from '../../net/fetch-retry.ts'
import type { RpaResponseSpec, RpaRetrySpec, RpaVendorDescriptor } from '../../types-rpa.ts'
import { applyAuth } from './auth.ts'
import type { RpaAuthDeps } from './auth.ts'
import { readJsonPath, renderRequest } from './template.ts'
import type {
  RpaBuildDeps,
  RpaDispatchDeps,
  RpaDispatchOutcome,
  RpaHttpRequest,
  RpaHttpResponse,
  RpaInvocationContext,
  RpaSendResult,
  RpaVendorAdapter,
} from './types.ts'

/** 单次出网尝试的超时（与旧 Webhook/八爪鱼口径一致）。 */
const SEND_TIMEOUT_MS = 15_000
/** 尝试次数夹取：描述符写错也不能无限重试。 */
const MAX_ATTEMPTS_LIMIT = 5
/** 落库错误文案上限（与 `task_triggers.callback_error` 口径一致）。 */
const ERROR_TEXT_MAX = 500
/** 本机 / 私网 IPv4 字面量（私有化地址只在这条边界之外放行）。 */
const PRIVATE_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|0(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|169\.254(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|::1|\[::1\])$/i

/** 可注入 `fetchImpl` 的传输依赖。 */
export type RpaTransportDeps = RpaDispatchDeps

/**
 * 本域唯一出网函数：读响应体文本后交给解析层（业务成功与否由描述符判定）。
 *
 * **`fetchWithRetry` 全仓只允许出现在这里**（出网台账按 `dispatch.ts#sendRequest` 登记）。
 * @param req - 已鉴权请求。
 * @param deps - 传输依赖（测试注入 fetch）。
 * @param retry - 描述符的重试策略。
 * @returns 状态码 + 响应文本。
 */
async function sendRequest(
  req: RpaHttpRequest,
  deps: RpaTransportDeps,
  retry: RpaRetrySpec,
): Promise<RpaHttpResponse> {
  const doFetch: RetryFetch = deps.fetchImpl ?? fetch
  const headers: Record<string, string> = { ...req.headers }
  if (!hasHeader(headers, 'content-type') && req.body !== '') headers['content-type'] = req.contentType
  const maxAttempts = Math.min(MAX_ATTEMPTS_LIMIT, Math.max(1, Math.trunc(retry.maxAttempts)))
  const method: string = req.method
  const init: RequestInit = { method, headers }
  // 换 token 可能是 GET：undici 的 fetch 对 GET/HEAD 带 body（哪怕空串）会直接抛
  // `TypeError: Request with GET/HEAD method cannot have body`，所以只在有 body 的非 GET/HEAD 上带。
  if (method !== 'GET' && method !== 'HEAD' && req.body !== '') init.body = req.body
  const res = await fetchWithRetry(doFetch, req.url, init, { maxAttempts, timeoutMs: SEND_TIMEOUT_MS })
  const bodyText = await res.text()
  return { status: res.status, bodyText }
}

/** header 是否已存在（大小写不敏感）。 */
function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase()
  return Object.keys(headers).some((key) => key.toLowerCase() === lower)
}

/**
 * 派发一条触发记录到某个厂商。
 * @param input.adapter - 厂商适配器。
 * @param input.ctx - 投递上下文（text 已过隐私闸）。
 * @param input.deps - 传输依赖（生产 = 全局 fetch）。
 * @param input.buildDeps - 厂商构建钩子的解码依赖（仅 Webhook 用）。
 * @returns `sent`（含外部任务 id）/ `failed`（可读原因）。
 */
export async function dispatchRpaRecord(input: {
  adapter: RpaVendorAdapter
  ctx: RpaInvocationContext
  deps: RpaDispatchDeps
  buildDeps: RpaBuildDeps
}): Promise<RpaDispatchOutcome> {
  const { adapter, ctx, deps, buildDeps } = input
  const descriptor = adapter.descriptor
  try {
    const built = typeof adapter.buildRequest === 'function'
      ? await adapter.buildRequest(ctx, buildDeps)
      : renderRequest(descriptor, ctx)
    assertHostAllowed(descriptor, ctx.config, built.url)
    const authDeps: RpaAuthDeps = { send: (tokenReq) => sendRequest(tokenReq, deps, descriptor.retry) }
    const authed = await applyAuth(adapter, withContentType(built), ctx, authDeps)
    const response = await sendRequest(authed, deps, descriptor.retry)
    return outcomeOf(parseResponse(adapter, response, ctx))
  } catch (e) {
    return { status: 'failed', error: errorText(e) }
  }
}

/** 把厂商解析结果包成管道结果。 */
function outcomeOf(result: RpaSendResult): RpaDispatchOutcome {
  if (!result.ok) return { status: 'failed', error: trimError(result.message ?? '厂商返回失败') }
  if (result.externalTaskId !== undefined && result.externalTaskId !== '') {
    return { status: 'sent', externalTaskId: result.externalTaskId }
  }
  return { status: 'sent' }
}

/** 请求头里没有 content-type 时按 `contentType` 补上（签名钩子要看得到它）。 */
function withContentType(req: RpaHttpRequest): RpaHttpRequest {
  if (hasHeader(req.headers, 'content-type')) return req
  return { ...req, headers: { ...req.headers, 'content-type': req.contentType } }
}

/** 解析响应：厂商钩子优先，否则走通用规则。 */
function parseResponse(
  adapter: RpaVendorAdapter,
  response: RpaHttpResponse,
  ctx: RpaInvocationContext,
): RpaSendResult {
  if (typeof adapter.parseResponse === 'function') return adapter.parseResponse(response, ctx)
  return parseGenericResponse(adapter.descriptor.response, response)
}

/**
 * 通用响应解析：HTTP 状态在白名单内 + `okPath` 业务码等于 `okValue` 才算成功。
 * @param spec - 描述符的 `response` 声明。
 * @param response - 实际响应。
 * @returns 成功/失败 + 外部任务 id。
 */
function parseGenericResponse(spec: RpaResponseSpec, response: RpaHttpResponse): RpaSendResult {
  const json = parseJsonOrUndefined(response.bodyText)
  const message = spec.messagePath !== undefined ? messageOf(json, spec.messagePath) : ''
  const httpOk = spec.okHttpStatus.includes(response.status)
  if (!httpOk) {
    return { ok: false, retryable: false, message: message !== '' ? message : 'HTTP ' + String(response.status) }
  }
  if (spec.okPath !== undefined) {
    const actual = readJsonPath(json, spec.okPath)
    if (!matchesOkValue(actual, spec.okValue)) {
      return { ok: false, retryable: false, message: message !== '' ? message : '业务码 ' + String(actual) }
    }
  }
  const externalTaskId = spec.externalTaskIdPath !== undefined
    ? idTextOf(readJsonPath(json, spec.externalTaskIdPath))
    : ''
  return externalTaskId === ''
    ? { ok: true, retryable: false }
    : { ok: true, retryable: false, externalTaskId }
}

/** 解析 JSON 文本（空/坏 JSON 返回 undefined，由调用方按"无业务码"处理）。 */
function parseJsonOrUndefined(text: string): unknown {
  if (text.trim() === '') return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** 取错误消息（只接受字符串/数字，避免把整段响应打给用户）。 */
function messageOf(json: unknown, path: string): string {
  const value = readJsonPath(json, path)
  if (typeof value === 'string') return value.slice(0, 200)
  if (typeof value === 'number') return String(value)
  return ''
}

/** 业务码比较：统一按字符串比（数字 200 与字符串 "200" 视为同值）。 */
function matchesOkValue(actual: unknown, expected: unknown): boolean {
  if (expected === undefined) return actual !== undefined && actual !== null
  if (actual === undefined) return false
  return String(actual) === String(expected)
}

/** 外部任务 id → 字符串（空/非法类型返回空串）。 */
function idTextOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/**
 * 主机放行判定（按描述符 `governance`）。
 *
 * - URL 必须是 http/https 绝对地址；
 * - `hosts` 为空 = 内置 Webhook：地址完全由用户填写，允许任意 http(s)（保持旧行为，含本机/内网）；
 * - 否则 host 必须命中 exact/suffix 清单；
 * - `allowCustomBaseUrl` 的私有化实例：仅当 host 等于配置的 `baseUrl` host，且不是本机/私网
 *   字面量时放行。
 * @param descriptor - 厂商描述符。
 * @param config - 任务配置。
 * @param rawUrl - 组装好的请求 URL。
 * @throws 不合规时抛可读错误（只含主机名）。
 */
function assertHostAllowed(
  descriptor: RpaVendorDescriptor,
  config: RpaInvocationContext['config'],
  rawUrl: string,
): void {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error('请求地址不是合法的 http/https 地址')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('请求地址必须是 http/https 地址')
  }
  const host = url.hostname.toLowerCase()
  const governance = descriptor.governance
  if (governance.hosts.length === 0) return
  if (governance.hosts.some((rule) => hostMatches(host, rule.kind, rule.value))) return
  if (governance.allowCustomBaseUrl === true) {
    const baseHost = configuredHost(config['baseUrl'])
    if (baseHost !== '' && baseHost === host && !PRIVATE_HOST.test(host)) return
  }
  throw new Error('出网主机不在允许清单内：' + host)
}

/** host 与规则匹配（exact 全等；suffix 支持厂商子域）。 */
function hostMatches(host: string, kind: 'exact' | 'suffix', value: string): boolean {
  const rule = value.trim().toLowerCase()
  if (rule === '') return false
  if (kind === 'exact') return host === rule
  return host === rule || host.endsWith('.' + rule)
}

/** 配置里的 baseUrl → host（非法/缺失返回空串）。 */
function configuredHost(baseUrl: unknown): string {
  if (typeof baseUrl !== 'string' || baseUrl.trim() === '') return ''
  try {
    return new URL(baseUrl.trim()).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** 错误文本（Error.message 优先，截断到落库上限；不含凭据）。 */
function errorText(e: unknown): string {
  const message = (e as { message?: unknown } | null | undefined)?.message
  const text = typeof message === 'string' && message !== '' ? message : String(e)
  return trimError(text)
}

/** 统一截断错误文案。 */
function trimError(text: string): string {
  return text.length > ERROR_TEXT_MAX ? text.slice(0, ERROR_TEXT_MAX) : text
}
