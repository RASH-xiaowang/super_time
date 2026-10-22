/**
 * 工具结果回放与错误详情白名单。
 *
 * 工具结果会进入下一轮模型上下文，必须压缩后再回放；失败详情只保留可用于
 * 纠正参数的标量字段，正文、密钥与任意嵌套对象一律丢弃。
 *
 * @module query/answer-runtime/tool-replay
 */
import type { ToolResult } from '../tools/types.ts'

const MAX_REPLAY_HITS = 12
const MAX_REPLAY_SNIPPET = 400
const MAX_REPLAY_FACTS = 4
const MAX_REPLAY_TEXT = 16_000
const MAX_ERROR_DETAIL_FIELDS = 12
const MAX_ERROR_DETAIL_TEXT = 240
const MAX_ERROR_DETAIL_ITEMS = 8

/** 只允许回放可用于纠正参数的字段；正文、密钥与任意对象一律不进下一轮。 */
const ERROR_DETAIL_KEYS = new Set([
  'field',
  'argument',
  'allowed',
  'requested',
  'value',
  'mode',
  'domain',
  'code',
  'scope',
  'from',
  'to',
  'profile',
  'tool',
  'locked',
  'retryAfterMs',
  'retry_after_ms',
  'retryAfterSec',
  'retry_after_sec',
])

/** 按字符截断，避免把代理对切成半个字符。 */
export function clip(value: string, max: number): string {
  const chars = Array.from(value)
  return chars.length <= max ? value : `${chars.slice(0, Math.max(0, max - 1)).join('')}…`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function replayText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 把工具结果压缩成可安全回放的 JSON 文本。 */
export function serializeResult(result: ToolResult): string {
  /*
   * 工具结果是不可信的跨模块输入：类型声明保证不了运行时形状。缺 snippet
   * 的一条命中曾让回放序列化抛错，进而把整轮工具循环误判成 failed，连证据层
   * 的畸形统计都来不及产生。这里逐字段降级，让坏条目进入证据层被拒绝。
   */
  const rawHits: unknown[] = Array.isArray(result.hits) ? result.hits : []
  const hits = rawHits.slice(0, MAX_REPLAY_HITS).map((hit) => {
    const record = isRecord(hit) ? hit : {}
    const sender = replayText(record['sender'])
    const source = replayText(record['source'])
    return {
      key: replayText(record['key']),
      name: replayText(record['name']),
      time: replayText(record['time']),
      ...(sender === '' ? {} : { sender }),
      ...(source === '' ? {} : { source }),
      snippet: clip(replayText(record['snippet']), MAX_REPLAY_SNIPPET),
    }
  })
  const rawFacts: unknown[] = Array.isArray(result.facts) ? result.facts : []
  const facts = rawFacts.slice(0, MAX_REPLAY_FACTS).map((fact) => {
    const record = isRecord(fact) ? fact : {}
    return {
      title: replayText(record['title']),
      body: clip(replayText(record['body']), MAX_REPLAY_SNIPPET),
    }
  })
  const error = replayText(result.error)
  const errorCode = replayText(result.errorCode)
  const note = replayText(result.note)
  const errorDetails = serializeErrorDetails(result.errorDetails)
  const payload = {
    tool: replayText(result.tool) || 'unknown',
    ok: result.ok === true,
    ...(error ? { error: clip(error, 500) } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(errorDetails !== undefined ? { errorDetails } : {}),
    hits,
    ...(facts.length > 0 ? { facts } : {}),
    ...(note ? { note: clip(note, 300) } : {}),
    ...(rawHits.length > hits.length ? { hitsOmitted: rawHits.length - hits.length } : {}),
  }
  try {
    return clip(JSON.stringify(payload), MAX_REPLAY_TEXT)
  } catch {
    return clip(JSON.stringify({
      tool: replayText(result.tool) || 'unknown',
      ok: result.ok === true,
      error: clip(error || '工具结果无法序列化', 500),
      hits: rawHits.length,
      facts: rawFacts.length,
    }), MAX_REPLAY_TEXT)
  }
}

/**
 * 失败结果回给模型时只带「下一轮怎么改参数」的白名单字段。
 *
 * 工具失败文本本身已经可能含路径/片段，不能整包回放；这里进一步把
 * `errorDetails` 限成标量与短数组，既能让模型纠正 `field`/`allowed`，
 * 也不会把正文、密钥或嵌套对象带进下一轮上下文。
 */
export function serializeErrorDetails(
  details: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!details) return undefined
  const entries = Object.entries(details)
    .filter(([key]) => ERROR_DETAIL_KEYS.has(key))
    .slice(0, MAX_ERROR_DETAIL_FIELDS)
  if (entries.length === 0) return undefined
  const out: Record<string, unknown> = {}
  for (const [key, value] of entries) {
    const safe = safeErrorDetailValue(value)
    if (safe !== undefined) out[key] = safe
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function safeErrorDetailValue(value: unknown): unknown {
  if (typeof value === 'string') return clip(value, MAX_ERROR_DETAIL_TEXT)
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'boolean') return value
  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_ERROR_DETAIL_ITEMS)
      .map(item => safeErrorDetailScalar(item))
      .filter(item => item !== undefined)
    return items.length > 0 ? items : undefined
  }
  return safeErrorDetailScalar(value)
}

function safeErrorDetailScalar(value: unknown): string | number | boolean | undefined {
  if (typeof value === 'string') return clip(value, MAX_ERROR_DETAIL_TEXT)
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'boolean') return value
  return undefined
}
