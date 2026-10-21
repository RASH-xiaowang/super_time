/**
 * 多厂商触发的**鉴权层**（2026-10-21）。
 *
 * 描述符声明 `auth.modes`，本文件统一执行四种策略（核心不认识具体厂商）：
 *  · `bearer`         —— 取该模式第一个凭据字段作为 token；
 *  · `header`         —— 该模式的凭据字段以 `field.key` 作为请求头名注入；
 *  · `token-exchange` —— 先按声明换 token（带缓存），再注入 `Authorization`；
 *  · `custom`         —— 交给厂商适配器的 `signRequest(req, ctx)` 钩子（如阿里云 RPC 签名）。
 *
 * 三条安全边界：
 *  ① 凭据值只进请求头/签名，永远不会出现在错误文案里（错误只报字段名/HTTP 状态）；
 *  ② 换 token 的请求也走 `deps.send`（由 `dispatch.ts` 注入），**出网点仍只有一个**；
 *  ③ token 缓存按「厂商 + baseUrl + 凭据指纹」隔离，换凭据/换实例不会误用旧 token。
 */
import { createHash } from 'node:crypto'
import type { RpaAuthMode, RpaTokenExchange, RpaTriggerConfig, RpaVendorDescriptor } from '../../types-rpa.ts'
import type { RpaHttpRequest, RpaHttpResponse, RpaInvocationContext, RpaVendorAdapter } from './types.ts'
import { readJsonPath, renderTemplate } from './template.ts'

/** 换 token 请求的发送函数（由 dispatch.ts 注入它自己的出网函数）。 */
export interface RpaAuthDeps {
  send: (req: RpaHttpRequest) => Promise<RpaHttpResponse>
}

/** token 缓存项。 */
interface TokenCacheEntry {
  token: string
  expiresAt: number
}

/** 进程内 token 缓存（按厂商 + baseUrl + 凭据指纹隔离）。 */
const TOKEN_CACHE = new Map<string, TokenCacheEntry>()
/** 换 token 响应没有 expiresIn 时的默认有效期（与设计文档一致：1 小时）。 */
const DEFAULT_TOKEN_TTL_SECONDS = 3600
/** 有效期余量：提前 60s 过期，最短 30s（避免临界点拿到刚过期的 token）。 */
const TOKEN_EXPIRY_MARGIN_SECONDS = 60
const TOKEN_MIN_TTL_SECONDS = 30

/** 清空 token 缓存（测试用：不同用例之间的 mock 响应不能互相污染）。 */
export function clearTokenCache(): void {
  TOKEN_CACHE.clear()
}

/**
 * 对已渲染的请求执行描述符声明的鉴权。
 * @param adapter - 厂商适配器。
 * @param req - 已渲染（未鉴权）的请求。
 * @param ctx - 投递上下文（含 config/secrets）。
 * @param deps - 发送函数（换 token 请求用）。
 * @param cache - token 缓存（测试可注入独立 Map）。
 * @returns 鉴权后的请求（不改入参）。
 * @throws 鉴权模式不匹配 / 凭据缺失 / 换 token 失败时抛可读错误。
 */
export async function applyAuth(
  adapter: RpaVendorAdapter,
  req: RpaHttpRequest,
  ctx: RpaInvocationContext,
  deps: RpaAuthDeps,
  cache: Map<string, TokenCacheEntry> = TOKEN_CACHE,
): Promise<RpaHttpRequest> {
  const modes = adapter.descriptor.auth.modes
  if (modes.length === 0) return req
  const mode = selectAuthMode(modes, ctx.config)
  const name = adapter.descriptor.name
  if (mode === undefined) {
    throw new Error('未匹配到 ' + name + ' 的鉴权模式，请检查触发方式配置')
  }
  if (mode.strategy === 'custom') return applyCustom(adapter, req, ctx)
  if (mode.strategy === 'header') return applyHeaderSecrets(req, mode, ctx, name)
  if (mode.strategy === 'token-exchange') {
    const token = await resolveToken(adapter, mode, ctx, deps, cache)
    return withToken(req, token, mode.exchange?.headerPrefix ?? 'Bearer ')
  }
  return withToken(req, bearerToken(mode, ctx, name), 'Bearer ')
}

/** 按 `when.field/equals` 选第一个匹配的鉴权模式（无 when = 默认，永远匹配）。 */
function selectAuthMode(modes: RpaAuthMode[], config: RpaTriggerConfig): RpaAuthMode | undefined {
  for (const mode of modes) {
    if (mode.when === undefined) return mode
    const current = configText(config[mode.when.field])
    if (mode.when.equals.includes(current)) return mode
  }
  return undefined
}

/** 普通字符串配置值（非字符串按空串处理）。 */
function configText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** `custom` 策略：只调厂商钩子，不自动附加任何头（签名完全由厂商文件负责）。 */
function applyCustom(
  adapter: RpaVendorAdapter,
  req: RpaHttpRequest,
  ctx: RpaInvocationContext,
): RpaHttpRequest {
  if (typeof adapter.signRequest !== 'function') {
    throw new Error(adapter.descriptor.name + ' 声明了自定义签名，但适配器没有实现 signRequest')
  }
  const out: RpaHttpRequest = { ...req, headers: { ...req.headers } }
  adapter.signRequest(out, ctx)
  return out
}

/** `header` 策略：凭据字段 key 即请求头名。 */
function applyHeaderSecrets(
  req: RpaHttpRequest,
  mode: RpaAuthMode,
  ctx: RpaInvocationContext,
  vendorName: string,
): RpaHttpRequest {
  const headers: Record<string, string> = { ...req.headers }
  for (const field of mode.fields) {
    const value = ctx.secrets[field.key] ?? ''
    if (value === '') throw new Error('缺少凭据：' + vendorName + ' 的 ' + field.label)
    headers[field.key] = value
  }
  return { ...req, headers }
}

/** `bearer` 策略：取该模式第一个凭据字段作为 token。 */
function bearerToken(mode: RpaAuthMode, ctx: RpaInvocationContext, vendorName: string): string {
  const field = mode.fields[0]
  if (field === undefined) throw new Error(vendorName + ' 的 bearer 鉴权没有声明凭据字段')
  const token = ctx.secrets[field.key] ?? ''
  if (token === '') throw new Error('缺少凭据：' + vendorName + ' 的 ' + field.label)
  return token
}

/**
 * 把 token 写进请求：先替换模板里的 `${auth.token}`（**替换成裸 token**，前缀由模板作者
 * 自己写，如 `Bearer ${auth.token}`）；模板没有占位符时补 `Authorization: <prefix><token>`。
 */
function withToken(req: RpaHttpRequest, token: string, prefix: string): RpaHttpRequest {
  const headers: Record<string, string> = {}
  let replaced = false
  for (const [key, value] of Object.entries(req.headers)) {
    if (value.includes('${auth.token}')) {
      headers[key] = value.split('${auth.token}').join(token)
      replaced = true
    } else {
      headers[key] = value
    }
  }
  if (!replaced) headers['Authorization'] = prefix + token
  return { ...req, headers }
}

/**
 * `token-exchange`：命中缓存直接返回；否则按声明发一次换 token 请求并缓存。
 * @param adapter - 厂商适配器。
 * @param mode - 命中的鉴权模式。
 * @param ctx - 投递上下文。
 * @param deps - 发送函数。
 * @param cache - token 缓存。
 * @returns 访问 token。
 * @throws 换 token 网络/HTTP/解析失败时抛可读错误（不含任何凭据）。
 */
async function resolveToken(
  adapter: RpaVendorAdapter,
  mode: RpaAuthMode,
  ctx: RpaInvocationContext,
  deps: RpaAuthDeps,
  cache: Map<string, TokenCacheEntry>,
): Promise<string> {
  const exchange = mode.exchange
  const name = adapter.descriptor.name
  if (exchange === undefined) throw new Error(name + ' 缺少换 token 请求声明')
  const cacheKey = tokenCacheKey(adapter.descriptor, ctx)
  const cached = cache.get(cacheKey)
  if (cached !== undefined && cached.expiresAt > Date.now()) return cached.token
  const response = await deps.send(buildExchangeRequest(name, exchange, ctx))
  const token = parseTokenResponse(name, exchange, response)
  cache.set(cacheKey, {
    token: token.token,
    expiresAt: Date.now() + token.ttlSeconds * 1000,
  })
  return token.token
}

/** token 缓存键：厂商 + baseUrl + 凭据指纹（不存凭据原文，只存哈希）。 */
function tokenCacheKey(descriptor: RpaVendorDescriptor, ctx: RpaInvocationContext): string {
  const parts = Object.keys(ctx.secrets).sort().map((key) => key + '=' + (ctx.secrets[key] ?? ''))
  const fingerprint = createHash('sha256').update(parts.join('\n'), 'utf8').digest('hex').slice(0, 16)
  return descriptor.id + '|' + configText(ctx.config['baseUrl']) + '|' + fingerprint
}

/** 按声明组装换 token 请求（url / query / body 都过同一套占位符渲染）。 */
function buildExchangeRequest(
  vendorName: string,
  exchange: RpaTokenExchange,
  ctx: RpaInvocationContext,
): RpaHttpRequest {
  const roots: Record<string, unknown> = {
    config: ctx.config,
    secret: ctx.secrets,
    record: ctx.record,
    invocation: { taskId: ctx.taskId, recordId: ctx.recordId, idempotencyKey: ctx.idempotencyKey },
  }
  const renderedUrl = renderTemplate(exchange.url, roots)
  if (typeof renderedUrl !== 'string' || renderedUrl.trim() === '') {
    throw new Error(vendorName + ' 的换 token 地址模板为空')
  }
  let url: URL
  try {
    url = new URL(renderedUrl)
  } catch {
    throw new Error(vendorName + ' 的换 token 地址不是合法 URL')
  }
  for (const [key, value] of Object.entries(exchange.query ?? {})) {
    url.searchParams.set(key, String(renderTemplate(value, roots)))
  }
  const headers: Record<string, string> = {}
  const contentType = exchange.contentType ?? 'application/json'
  let body = ''
  if (exchange.body !== undefined) {
    body = encodeExchangeBody(renderTemplate(exchange.body, roots), contentType)
    headers['content-type'] = contentType
  }
  // 换 token 可能是 GET（影刀/UiPath 的 token/create 等）；`RpaHttpRequest.method`
  // 已声明 GET/POST/PUT，`sendRequest` 对 GET/HEAD 不传 body。
  return { method: exchange.method, url: url.toString(), headers, body, contentType }
}

/**
 * 编码换 token 请求体：对象 body 按 `contentType` 选 JSON 或 form-urlencoded。
 *
 * UiPath OAuth 的 token 端点要求 `application/x-www-form-urlencoded`
 * （`grant_type=...&client_id=...`）；旧实现一律 JSON.stringify 会以 form 头发 JSON，
 * 真实端点会 400/415。字符串 body 原样发送（由描述符作者自己拼好）。
 * @param rendered - 已渲染的 body（对象/数组/字符串）。
 * @param contentType - 描述符声明的 Content-Type。
 * @returns 实际发送的 body 字符串。
 */
function encodeExchangeBody(rendered: unknown, contentType: string): string {
  if (typeof rendered === 'string') return rendered
  if (/application\/x-www-form-urlencoded/i.test(contentType) && isRecord(rendered)) {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(rendered)) params.set(key, value === null || value === undefined ? '' : String(value))
    return params.toString()
  }
  return JSON.stringify(rendered)
}

/** 是否为普通对象（排除 null 与数组）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 解析换 token 响应：2xx + JSON + tokenPath；expiresIn 缺失按 1 小时。 */
function parseTokenResponse(
  vendorName: string,
  exchange: RpaTokenExchange,
  response: RpaHttpResponse,
): { token: string; ttlSeconds: number } {
  if (response.status < 200 || response.status >= 300) {
    throw new Error('换取 ' + vendorName + ' 访问令牌失败：HTTP ' + String(response.status))
  }
  let json: unknown
  try {
    json = response.bodyText === '' ? undefined : JSON.parse(response.bodyText) as unknown
  } catch {
    throw new Error('换取 ' + vendorName + ' 访问令牌失败：响应不是合法 JSON')
  }
  const token = readJsonPath(json, exchange.tokenPath)
  if (typeof token !== 'string' || token === '') {
    throw new Error('换取 ' + vendorName + ' 访问令牌失败：响应缺少 token（' + exchange.tokenPath + '）')
  }
  let expiresIn = DEFAULT_TOKEN_TTL_SECONDS
  if (exchange.expiresInPath !== undefined) {
    const raw = Number(readJsonPath(json, exchange.expiresInPath))
    if (Number.isFinite(raw) && raw > 0) expiresIn = raw
  }
  const ttlSeconds = Math.max(TOKEN_MIN_TTL_SECONDS, expiresIn - TOKEN_EXPIRY_MARGIN_SECONDS)
  return { token, ttlSeconds }
}
