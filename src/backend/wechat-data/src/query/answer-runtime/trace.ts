/**
 * 工具调用 trace 的脱敏与稳定键。
 *
 * trace 会进入操作日志、数据库与界面。参数里可能有整段聊天正文、文件名、
 * token 或本地路径，因此这里只输出短摘要；缓存键则必须保留完整参数值，
 * 否则「两个不同查询被当成同一次调用」会静默返回错误结果。
 *
 * @module query/answer-runtime/trace
 */
import type { ToolCallTrace } from './types.ts'

const MAX_SUMMARY_VALUE_CHARS = 48
const MAX_SUMMARY_FIELDS = 8
const MAX_ERROR_MESSAGE_CHARS = 300
const SENSITIVE_KEY_RE =
  /(?:password|passwd|secret|token|api[_-]?key|authorization|cookie|credential|private[_-]?key)/i
const SENSITIVE_ASSIGNMENT_RE =
  /((?:password|passwd|secret|token|api[_-]?key|authorization|cookie|credential|private[_-]?key)\s*["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clip(value: string, max = MAX_SUMMARY_VALUE_CHARS): string {
  const chars = Array.from(value)
  return chars.length <= max ? value : `${chars.slice(0, Math.max(0, max - 1)).join('')}…`
}

/**
 * 失败正文只保留诊断所需的一小段。
 *
 * 工具错误可能夹带供应商回显、鉴权头或整段用户输入；trace 会落库并进入界面，
 * 因此先去掉常见凭据形式，再做定长截断。
 */
export function sanitizeToolErrorMessage(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  if (compact === '') return ''
  const redacted = compact
    .replace(BEARER_RE, 'Bearer [redacted]')
    .replace(SENSITIVE_ASSIGNMENT_RE, '$1[redacted]')
  return clip(redacted, MAX_ERROR_MESSAGE_CHARS)
}

function summarizeValue(key: string, value: unknown): unknown {
  if (SENSITIVE_KEY_RE.test(key)) return '[redacted]'
  if (typeof value === 'string') return clip(value.replace(/\s+/g, ' ').trim())
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value)) return `[${String(value.length)} items]`
  if (isRecord(value)) {
    const keys = Object.keys(value).sort().slice(0, 4)
    return `{${keys.join(',')}${Object.keys(value).length > keys.length ? ',…' : ''}}`
  }
  return typeof value
}

/**
 * 生成人类可读的参数摘要。
 * @param args - 已修复或原始参数。
 * @returns 形如 `{"limit":8,"query":"合同"}` 的短摘要。
 */
export function summarizeToolArguments(args: Record<string, unknown>): string {
  const keys = Object.keys(args).sort()
  const picked = keys.slice(0, MAX_SUMMARY_FIELDS)
  const entries = picked.map(key => `${JSON.stringify(key)}:${JSON.stringify(summarizeValue(key, args[key]))}`)
  if (keys.length > picked.length) entries.push(`"…":"${String(keys.length - picked.length)} more"`)
  return `{${entries.join(',')}}`
}

/**
 * 缓存键用的稳定序列化（保留完整值，只排序键）。
 *
 * 不走 `JSON.stringify` 的默认键序：同一组参数因对象插入顺序不同会产生不同键，
 * 去重会失效。数组顺序保留（它可能影响结果）。
 * @param value - 任意 JSON 值。
 * @returns 稳定字符串。
 */
export function stableArgumentStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined'
  if (Array.isArray(value)) return `[${value.map(stableArgumentStringify).join(',')}]`
  const record = value as Record<string, unknown>
  const body = Object.keys(record)
    .sort()
    .map(key => `${JSON.stringify(key)}:${stableArgumentStringify(record[key])}`)
    .join(',')
  return `{${body}}`
}

/** 工具名 + 规范化参数的缓存键。 */
export function toolCallCacheKey(name: string, args: Record<string, unknown>): string {
  return `${name}:${stableArgumentStringify(args)}`
}

/** `createToolCallTrace` 的输入。 */
export interface ToolCallTraceInput {
  index: number
  round: number
  callId: string
  name: string
  args?: Record<string, unknown>
  argumentsSummary?: string
  ok: boolean
  deduplicated?: boolean
  attempts?: number
  elapsedMs?: number
  errorClass?: ToolCallTrace['errorClass']
  errorCode?: string
  errorMessage?: string
  hits?: number
  facts?: number
  deadlineExceeded?: boolean
  skipped?: boolean
  note?: string
}

/**
 * 构造一条 trace；统一把 attempts/retries 口径写在这里。
 * @param input - trace 字段。
 * @returns 可直接落库的 trace。
 */
export function createToolCallTrace(input: ToolCallTraceInput): ToolCallTrace {
  const attempts = Math.max(0, Math.trunc(input.attempts ?? 0))
  const summary = input.argumentsSummary
    ?? (input.args ? summarizeToolArguments(input.args) : '{}')
  const errorMessage = input.errorMessage
    ? sanitizeToolErrorMessage(input.errorMessage)
    : ''
  return {
    index: input.index,
    round: input.round,
    callId: input.callId,
    name: input.name,
    argumentsSummary: summary,
    ok: input.ok,
    deduplicated: input.deduplicated === true,
    attempts,
    retries: Math.max(0, attempts - 1),
    elapsedMs: Math.max(0, Math.trunc(input.elapsedMs ?? 0)),
    ...(input.errorClass === undefined ? {} : { errorClass: input.errorClass }),
    ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
    ...(errorMessage === '' ? {} : { errorMessage }),
    hits: Math.max(0, Math.trunc(input.hits ?? 0)),
    facts: Math.max(0, Math.trunc(input.facts ?? 0)),
    ...(input.deadlineExceeded === true ? { deadlineExceeded: true } : {}),
    ...(input.skipped === true ? { skipped: true } : {}),
    ...(input.note === undefined || input.note === '' ? {} : { note: input.note }),
  }
}
