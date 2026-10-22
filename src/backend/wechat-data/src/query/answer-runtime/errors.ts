/**
 * 检索工具错误的统一分类与重试策略。
 *
 * 工具失败不等于「再试一次就会好」：
 *   · 参数错、找不到、越权、范围越界 —— 重试必然还是同一个结果；
 *   · 超时、限流、瞬时网络/数据库错误 —— 可以在有界次数内重试；
 *   · 有副作用的工具 —— 即使错误看起来可重试，也不能自动重放。
 *
 * 本模块只做纯分类，不真正 sleep / 重试，便于 runtime 与测试复用。
 *
 * @module query/answer-runtime/errors
 */
import type { ToolResult } from '../tools/types.ts'

/** 工具错误分类（主运行时约定名）。 */
export type ToolErrorClass =
  | 'invalid_arguments'
  | 'not_found'
  | 'timeout'
  | 'rate_limited'
  | 'unauthorized'
  | 'scope_blocked'
  | 'transient'
  | 'internal'

/** 分类的兼容别名。 */
export type ToolErrorCategory = ToolErrorClass

/** 错误分类选项。 */
export interface ToolErrorClassificationOptions {
  tool?: string
  /** 工具是否有副作用；true 时任何自动重试都被禁止。 */
  sideEffect?: boolean
  /** 调用方已确定是范围越界（优先级高于普通错误文本）。 */
  scopeBlocked?: boolean
  httpStatus?: number
  code?: string
  retryAfterMs?: number
  category?: ToolErrorCategory
}

/** 主运行时直接使用的分类结果。 */
export interface ClassifiedToolError {
  cls: ToolErrorClass
  retryable: boolean
  message: string
  /** 总尝试次数（首次 + 允许的重试）。 */
  maxAttempts: number
}

/** 带诊断字段的完整分类结果。 */
export interface DetailedToolErrorClassification extends ClassifiedToolError {
  category: ToolErrorClass
  /** 除首次执行外，安全允许的自动重试次数。 */
  maxRetries: number
  /** 服务端要求的等待时间（若有）。 */
  retryAfterMs?: number
  reason: string
  tool?: string
}

const RETRY_LIMITS: Readonly<Record<ToolErrorClass, number>> = {
  invalid_arguments: 0,
  not_found: 0,
  timeout: 1,
  rate_limited: 1,
  unauthorized: 0,
  scope_blocked: 0,
  transient: 2,
  internal: 0,
}

const CATEGORY_REASONS: Readonly<Record<ToolErrorClass, string>> = {
  invalid_arguments: '参数无效，需要先修复参数',
  not_found: '目标不存在或数据源缺失',
  timeout: '执行超时',
  rate_limited: '触发限流',
  unauthorized: '未授权',
  scope_blocked: '超出允许的数据范围',
  transient: '瞬时故障',
  internal: '内部错误',
}

const VALID_CATEGORIES = new Set<ToolErrorClass>([
  'invalid_arguments',
  'not_found',
  'timeout',
  'rate_limited',
  'unauthorized',
  'scope_blocked',
  'transient',
  'internal',
])

function safeRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function stringField(value: unknown, key: string): string | undefined {
  const record = safeRecord(value)
  const field = record?.[key]
  return typeof field === 'string' ? field : undefined
}

function numberField(value: unknown, key: string): number | undefined {
  const record = safeRecord(value)
  const field = record?.[key]
  return typeof field === 'number' && Number.isFinite(field) ? field : undefined
}

function messageOf(error: unknown): string {
  if (typeof error === 'string') return error
  const record = safeRecord(error)
  const message = record?.['message']
  if (typeof message === 'string') return message
  if (error instanceof Error) return error.message
  try {
    return String(error)
  } catch {
    return ''
  }
}

function categoryOf(error: unknown): ToolErrorClass | undefined {
  const raw = safeRecord(error)?.['category']
  return typeof raw === 'string' && VALID_CATEGORIES.has(raw as ToolErrorClass)
    ? raw as ToolErrorClass
    : undefined
}

function retryAfterOf(error: unknown, options: ToolErrorClassificationOptions): number | undefined {
  const direct = options.retryAfterMs ?? numberField(error, 'retryAfterMs') ?? numberField(error, 'retry_after_ms')
  const seconds = numberField(error, 'retryAfterSec') ?? numberField(error, 'retry_after_sec')
  const value = direct ?? (seconds === undefined ? undefined : seconds * 1000)
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined
}

function byStatus(status: number | undefined): ToolErrorClass | undefined {
  if (status === undefined) return undefined
  if (status === 400 || status === 422) return 'invalid_arguments'
  if (status === 401 || status === 403) return 'unauthorized'
  if (status === 404) return 'not_found'
  if (status === 408 || status === 504) return 'timeout'
  if (status === 429) return 'rate_limited'
  if (status >= 500 && status <= 599) return 'transient'
  return undefined
}

function byCode(code: string | undefined): ToolErrorClass | undefined {
  if (!code) return undefined
  const normalized = code.trim().toUpperCase()
  if (normalized === 'ETIMEDOUT' || normalized === 'TIMEOUT' || normalized === 'DEADLINE_EXCEEDED') return 'timeout'
  if (normalized === 'ECONNRESET' || normalized === 'ECONNREFUSED' || normalized === 'EPIPE' || normalized === 'EAI_AGAIN') return 'transient'
  if (normalized.includes('RATE_LIMIT') || normalized === 'ERATELIMIT' || normalized === 'TOO_MANY_REQUESTS') return 'rate_limited'
  if (normalized.includes('SCOPE_BLOCKED') || normalized.includes('OUT_OF_SCOPE')) return 'scope_blocked'
  if (normalized === 'UNSUPPORTED_SCOPE') return 'scope_blocked'
  if (normalized.includes('UNAUTHORIZED') || normalized.includes('FORBIDDEN')) return 'unauthorized'
  if (normalized.includes('INVALID_ARGUMENT') || normalized.includes('INVALID_ARGUMENTS')) return 'invalid_arguments'
  if (normalized.includes('NOT_FOUND') || normalized === 'ENOENT') return 'not_found'
  if (normalized.includes('SQLITE_BUSY') || normalized.includes('SQLITE_LOCKED') || normalized.includes('TRANSIENT')) return 'transient'
  return undefined
}

function byMessage(message: string): ToolErrorClass | undefined {
  const text = message.trim()
  if (text === '') return undefined

  if (/(?:kb[-_ ]?only|仅知识库|范围外|超出.*(?:允许|授权)?范围|越权|不支持按.*过滤|无法应用.*范围|scope[_ -]?blocked|out[_ -]?of[_ -]?scope|unsupported[_ -]?scope|禁止访问|不允许访问|隐私闸门|数据面.*(?:禁止|不允许))/i.test(text)) {
    return 'scope_blocked'
  }
  if (/(?:未授权|无权限|权限不足|unauthorized|forbidden|authentication|authorization)/i.test(text)) {
    return 'unauthorized'
  }
  if (/(?:429|rate[_ -]?limit|too many requests|限流|请求过多|频率限制)/i.test(text)) {
    return 'rate_limited'
  }
  if (/(?:timeout|timed out|ETIMEDOUT|deadline exceeded|超时)/i.test(text)) {
    return 'timeout'
  }
  if (/(?:缺少|参数|形状不对|格式.*(?:不对|错误)|invalid[_ -]?arguments?|required|must be|not a number|schema)/i.test(text)) {
    return 'invalid_arguments'
  }
  if (/(?:not[_ -]?found|no such|ENOENT|不存在|找不到|没找到|没有这个人|没有(?:该|这个)|没有选中|未找到)/i.test(text)) {
    return 'not_found'
  }
  if (/(?:ECONNRESET|ECONNREFUSED|EPIPE|EAI_AGAIN|network|socket hang up|temporarily|unavailable|database is locked|SQLITE_BUSY|SQLITE_LOCKED|索引未就绪|服务暂不可用)/i.test(text)) {
    return 'transient'
  }
  return undefined
}

/**
 * 将一个未知错误分类，并给出安全重试策略（含诊断字段）。
 *
 * @param error - 错误对象、字符串或结构化错误。
 * @param options - 调用方掌握的状态码、错误码、副作用等附加信息。
 * @returns 分类结果。
 */
export function classifyToolErrorDetailed(
  error: unknown,
  options: ToolErrorClassificationOptions = {},
): DetailedToolErrorClassification {
  const message = messageOf(error)
  const status = options.httpStatus
    ?? numberField(error, 'httpStatus')
    ?? numberField(error, 'status')
    ?? numberField(error, 'statusCode')
  const code = options.code
    ?? stringField(error, 'code')
    ?? stringField(error, 'errorCode')

  let category: ToolErrorClass | undefined = options.category
    ?? (options.scopeBlocked ? 'scope_blocked' : categoryOf(error))
  if (!category) category = byCode(code)
  if (!category) category = byStatus(status)
  if (!category) category = byMessage(message)
  if (!category) category = 'internal'

  const baseRetries = RETRY_LIMITS[category]
  const retryable = !options.sideEffect && baseRetries > 0
  const retryAfterMs = retryAfterOf(error, options)
  const maxRetries = retryable ? baseRetries : 0
  return {
    cls: category,
    category,
    retryable,
    message,
    maxAttempts: maxRetries + 1,
    maxRetries,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    reason: CATEGORY_REASONS[category],
    ...(options.tool === undefined ? {} : { tool: options.tool }),
  }
}

/**
 * 主运行时入口：分类一个工具错误。
 *
 * 第二参数兼容两种写法：
 *   · 工具名（`classifyToolError(error, 'search_messages')`）；
 *   · 完整选项（状态码、副作用、显式 scopeBlocked 等）。
 *
 * @param error - 错误对象、字符串或结构化错误。
 * @param toolOrOptions - 工具名或分类选项。
 * @returns 含 `cls` / `retryable` / `message` / `maxAttempts` 的结果。
 */
export function classifyToolError(
  error: unknown,
  toolOrOptions: string | ToolErrorClassificationOptions = {},
): ClassifiedToolError {
  const options: ToolErrorClassificationOptions = typeof toolOrOptions === 'string'
    ? { tool: toolOrOptions }
    : toolOrOptions
  const detailed = classifyToolErrorDetailed(error, options)
  return {
    cls: detailed.cls,
    retryable: detailed.retryable,
    message: detailed.message,
    maxAttempts: detailed.maxAttempts,
  }
}

/**
 * 分类一个 `ToolResult` 的失败信息。
 * @param result - 工具结果。
 * @param options - 附加分类信息。
 * @returns 分类结果。
 */
export function classifyToolResultError(
  result: Pick<ToolResult, 'tool' | 'ok' | 'error'>,
  options: ToolErrorClassificationOptions = {},
): ClassifiedToolError {
  return classifyToolError(result.error ?? '', { ...options, tool: options.tool ?? String(result.tool) })
}

/** 是否允许自动重试。 */
export function isRetryableToolError(
  error: unknown,
  options: ToolErrorClassificationOptions = {},
): boolean {
  return classifyToolErrorDetailed(error, options).retryable
}
