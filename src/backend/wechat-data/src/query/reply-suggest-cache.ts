/**
 * 「推荐回复」的结果缓存（`<数据根>/reply_suggest_cache.db`）。
 *
 * ## 为什么需要
 *
 * 推荐回复是一次真实的模型调用，而它是**被反复打开**的：关掉面板再打开、
 * 切到别的会话再切回来、点开详情再返回 —— 每一次都会重新生成一遍候选。
 * 用户体感就是「每次都要等」，成本也是每次一份。
 *
 * ## 失效条件必须精确
 *
 * 缓存键包含「上下文指纹」：把实际送进提示词的那些行一起哈希。这样
 *   · 对方/我发了新消息 → 最后几行变了 → 指纹变 → 缓存自然不命中；
 *   · 切回一个没变化的会话 → 指纹一致 → 秒开；
 * 而不是靠时间窗猜「多久算过期」。知识库、模型、提示词版本一并进键：
 * 换库/换模型/改提示词都会得到新的键，旧结果不会被误用。
 *
 * 库形态与 `message_analysis.db` 一致：独立兄弟文件、惰性建表、失败不影响主流程。
 *
 * @module query/reply-suggest-cache
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from '../query/db-open.ts'
import type { ReplyTrace } from '../types-analysis.ts'
import { replyDate } from './reply-tools/local.ts'

/**
 * 提示词版本：改了 `buildReplyPrompt` 的措辞或输出格式时**必须**递增，
 * 否则旧候选会以新界面呈现，表现为「明明改了却看不到差别」。
 */
export const REPLY_SUGGEST_PROMPT_VERSION = 3

/** 缓存库路径：`decrypted` 的兄弟文件。 */
export function replySuggestCachePath(decryptedDir: string): string {
  return join(dirname(decryptedDir), 'reply_suggest_cache.db')
}

function openStore(decryptedDir: string): DatabaseSync {
  const db = new DatabaseSync(replySuggestCachePath(decryptedDir))
  db.exec(`CREATE TABLE IF NOT EXISTS reply_suggest (
    cache_key TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    replies_json TEXT NOT NULL,
    trace_json TEXT NOT NULL DEFAULT ''
  )`)
  return db
}

/**
 * 组装缓存键。
 * @param input - 会话、目标消息、知识库、模型与上下文行。
 * @returns 稳定键（长度可控，便于当主键）。
 */
export function replySuggestCacheKey(input: {
  /** `talker` 是 `WechatSession.username` 的别名。 */
  talker: string
  targetLocalId: number | undefined
  kbId: number
  model: string
  want: number
  lines: readonly string[]
}): string {
  const fingerprint = createHash('sha1')
    .update(input.lines.join('\u0000'))
    .digest('hex')
    .slice(0, 20)
  return [
    'v' + String(REPLY_SUGGEST_PROMPT_VERSION),
    input.model,
    String(input.kbId),
    String(input.want),
    String(input.targetLocalId ?? 0),
    input.talker,
    fingerprint,
  ].join('|')
}

/** 缓存命中项。 */
export interface CachedReplySuggest {
  replies: string[]
  trace?: ReplyTrace
}

/**
 * 读缓存。
 * @returns 未命中或数据坏掉时 undefined。
 */
export function readReplySuggestCache(
  decryptedDir: string,
  cacheKey: string,
): CachedReplySuggest | undefined {
  if (!existsSync(replySuggestCachePath(decryptedDir))) return undefined
  let db: DatabaseSync | null = null
  try {
    db = openStore(decryptedDir)
    const row = db.prepare(
      'SELECT replies_json, trace_json, created_at FROM reply_suggest WHERE cache_key = ?',
    ).get(cacheKey) as { replies_json: string; trace_json: string; created_at: number } | undefined
    if (row === undefined) return undefined
    // Reply-capable tool results may contain realtime data, including date boundaries.
    if (Date.now() / 1000 - Number(row.created_at) > 300 || Number(row.created_at) > Date.now() / 1000 + 5) return undefined
    const replies = JSON.parse(row.replies_json) as unknown
    if (!Array.isArray(replies) || replies.length === 0) return undefined
    const out: string[] = []
    for (const item of replies) {
      if (typeof item === 'string' && item.trim() !== '') out.push(item)
    }
    if (out.length === 0) return undefined
    let trace: ReplyTrace | undefined
    if (row.trace_json !== '') {
      try {
        const parsed = JSON.parse(row.trace_json) as ReplyTrace
        if (typeof parsed === 'object' && parsed !== null) trace = parsed
      } catch { /* 留痕坏掉不影响候选 */ }
    }
    if (trace?.toolSources?.some(source => {
      if (!source.timezone) return false
      try { return replyDate(new Date(source.fetchedAt), source.timezone) !== replyDate(new Date(), source.timezone) } catch { return true }
    })) return undefined
    return { replies: out, ...(trace === undefined ? {} : { trace }) }
  } catch {
    return undefined
  } finally {
    try { db?.close() } catch { /* ignore */ }
  }
}

/** 写缓存；失败不抛。 */
export function writeReplySuggestCache(
  decryptedDir: string,
  cacheKey: string,
  row: CachedReplySuggest,
): void {
  if (row.replies.length === 0) return
  let db: DatabaseSync | null = null
  try {
    // 首次写入时 `<数据根>/data/` 可能还不存在（分析/推荐都可能先于其它功能跑起来）。
    mkdirSync(dirname(replySuggestCachePath(decryptedDir)), { recursive: true })
    db = openStore(decryptedDir)
    db.prepare(
      'INSERT INTO reply_suggest (cache_key, created_at, replies_json, trace_json)'
      + ' VALUES (?, ?, ?, ?)'
      + ' ON CONFLICT(cache_key) DO UPDATE SET'
      + ' created_at = excluded.created_at, replies_json = excluded.replies_json,'
      + ' trace_json = excluded.trace_json',
    ).run(
      cacheKey,
      Math.floor(Date.now() / 1000),
      JSON.stringify(row.replies),
      row.trace === undefined ? '' : JSON.stringify(row.trace),
    )
  } catch {
    /* 缓存写不进不算错误 */
  } finally {
    try { db?.close() } catch { /* ignore */ }
  }
}
