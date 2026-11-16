/**
 * 消息列表持久化层共享的字段上限、标量清洗和派生 id。
 *
 * 该模块不打开数据库，避免 schema、记录、规则和投递模块互相反向依赖。
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { taskDbPath } from './task-db.ts'
import type { MessageListSource, MessageListStatus } from '../types.ts'

export const NAME_MAX = 200
export const USERNAME_MAX = 255
export const TEXT_MAX = 4000
export const NOTE_MAX = 500
export const WEBHOOK_MAX = 2048
/**
 * 大肥鱼发送程序的真实请求契约。
 *
 * `api_server.cpp` 使用 `wchar_t target[128]` / `message[512]`，容量包含结尾
 * `\0`；UTF-8 body 上限为 8192 字节。这里按 Windows UTF-16 code unit 计数，
 * 不能用 Unicode code point 数替代。
 */
export const FEATHER_TARGET_MAX_UTF16 = 127
export const FEATHER_MESSAGE_MAX_UTF16 = 511
export const FEATHER_REQUEST_MAX_BYTES = 8192
export const ERROR_MAX = 500
export const RESPONSE_MAX = 500
export const SOURCE_REF_MAX = 200
export const JOB_ID_MAX = 128
export const JOB_STATE_MAX = 80
export const INTERRUPTED_DISPATCH_STALE_MS = 5 * 60_000
export const QUERY_DEFAULT = 200
export const MESSAGE_LIST_QUERY_MAX = 500
export const CURSOR_VERSION = 'ml1'

export function textOf(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, max)
}

/**
 * 按 UTF-16 code unit 截断，但不把代理对拆成半个 emoji。
 *
 * 返回长度不会超过 `maxUnits`；追加后缀时，后缀本身也计入预算。
 */
export function truncateUtf16(value: string, maxUnits: number, suffix = ''): string {
  const limit = Math.max(0, Math.trunc(maxUnits))
  if (value.length <= limit) return value
  const suffixText = suffix.length <= limit ? suffix : suffix.slice(0, limit)
  let end = limit - suffixText.length
  if (
    end > 0
    && end < value.length
    && isHighSurrogate(value.charCodeAt(end - 1))
    && isLowSurrogate(value.charCodeAt(end))
  ) {
    end -= 1
  }
  return value.slice(0, end) + suffixText
}

/** Node 实际发送的 JSON UTF-8 字节数，用于对齐发送程序的 Content-Length 上限。 */
export function jsonUtf8Bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

export function numOf(value: unknown, fallback = 0): number {
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

export function positiveId(value: unknown): number {
  const id = numOf(value)
  return id > 0 ? id : 0
}

export function errorText(e: unknown): string {
  const msg = (e as { message?: unknown } | null | undefined)?.message
  return typeof msg === 'string' && msg !== '' ? msg : String(e)
}

export function ensureParentDir(decryptedDir: string): void {
  try {
    mkdirSync(dirname(taskDbPath(decryptedDir)), { recursive: true })
  } catch {
    // 后续 SQLite 会给出真正原因，这里不提前吞掉错误语义。
  }
}

export function httpUrl(value: unknown, max = WEBHOOK_MAX): string {
  const raw = textOf(value, max)
  if (raw === '') return ''
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:' ? raw : ''
  } catch {
    return ''
  }
}

export function sourceOf(value: unknown): MessageListSource {
  return value === 'first_trigger' || value === 'webhook' || value === 'manual' || value === 'ai_reply'
    ? value
    : 'manual'
}

export function statusOf(value: unknown): MessageListStatus {
  return value === 'success' || value === 'failed' || value === 'pending'
    || value === 'dispatching' || value === 'queued' || value === 'running'
    || value === 'sent_unconfirmed'
    ? value
    : 'pending'
}

/** 失败原因分类的稳定枚举；空串表示未分类（旧行）。 */
const MESSAGE_LIST_FAILURE_KINDS: ReadonlySet<string> = new Set([
  'superseded',
  'no_webhook',
  'generation_failed',
  'send_failed',
  'unconfirmed',
  'config_changed',
])

/** 只接受稳定枚举里的失败分类，拒绝调用方写入自由文本。 */
export function failureKindOf(value: unknown): string {
  const kind = textOf(value, 40)
  return MESSAGE_LIST_FAILURE_KINDS.has(kind) ? kind : ''
}

/** 下游任务状态是外部协议值，只在明确可证明时映射到本地投递状态。 */
export type MessageListJobPhase = 'queued' | 'running' | 'succeeded' | 'failed' | 'unknown'

export function messageListJobPhase(value: unknown): MessageListJobPhase {
  const state = textOf(value, JOB_STATE_MAX).toLowerCase().replace(/[\s-]+/g, '_')
  if (state === 'queued' || state === 'pending' || state === 'accepted' || state === 'submitted') {
    return 'queued'
  }
  if (state === 'running' || state === 'processing' || state === 'in_progress' || state === 'executing') {
    return 'running'
  }
  if (state === 'succeeded' || state === 'success' || state === 'done'
    || state === 'completed' || state === 'complete') {
    return 'succeeded'
  }
  if (state === 'failed' || state === 'failure' || state === 'error'
    || state === 'cancelled' || state === 'canceled' || state === 'expired') {
    return 'failed'
  }
  return 'unknown'
}

/** 任务状态对应的本地投递状态；未知状态返回 undefined，避免猜测成功/失败。 */
export function messageListStatusForJobPhase(phase: MessageListJobPhase): MessageListStatus | undefined {
  if (phase === 'queued') return 'queued'
  if (phase === 'running') return 'running'
  if (phase === 'succeeded') return 'success'
  if (phase === 'failed') return 'failed'
  return undefined
}

export function generateReplyId(): string {
  return 'ml-' + String(Date.now()) + '-' + randomUUID().slice(0, 8)
}
