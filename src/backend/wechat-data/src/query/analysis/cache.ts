/**
 * 消息分析结果的**本地缓存**（`<数据根>/message_analysis.db`）。
 *
 * 为什么落库而不是只放内存：面板是「选中即分析」，切会话再切回来、点另一条再点回来
 * 都会重挂组件；而一次 LLM 调用要 1–3 秒、还要花钱。缓存让「同一条消息、同一个模型、
 * 同一版提示词」在本次安装里只算一次。
 *
 * 键是 `(session_id, local_id, prompt_key)`：
 *  `prompt_key` = 模型名 + 提示词版本 + 会话类型，换模型或改提示词后旧结果自动不再命中，
 *  不需要手工清库。
 *
 * 库形态与 `query/edit.ts` 的 `message_edits.db` 一致：独立兄弟文件、惰性建表、
 * `DatabaseSync` 同步 API。**写失败一律不影响主流程**。
 *
 * @module query/analysis/cache
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from '../db-open.ts'
import type { MessageAnalysis, MessageAnalysisScope, ReplyTrace } from '../../types-analysis.ts'

/**
 * 提示词版本：改提示词或输出结构时**必须**递增。
 * 否则旧缓存会把上一版字段喂给新界面，表现为「明明改了却看不到变化」。
 */
export const ANALYSIS_PROMPT_VERSION = 1

/** 缓存库路径：`decrypted` 的兄弟文件（与 `message_edits.db` 同款）。 */
export function analysisCachePath(decryptedDir: string): string {
  return join(dirname(decryptedDir), 'message_analysis.db')
}

function openStore(decryptedDir: string): DatabaseSync {
  const db = new DatabaseSync(analysisCachePath(decryptedDir))
  db.exec(`CREATE TABLE IF NOT EXISTS message_analysis (
    session_id TEXT NOT NULL,
    local_id INTEGER NOT NULL,
    prompt_key TEXT NOT NULL,
    analyzed_at INTEGER NOT NULL,
    source_text TEXT NOT NULL,
    from_voice INTEGER NOT NULL,
    analysis_json TEXT NOT NULL,
    trace_json TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (session_id, local_id, prompt_key)
  )`)
  // 老库补列：留痕是后来加的，没有它时详情视图只能显示「无留痕」。
  const columns = new Set(
    (db.prepare('PRAGMA table_info(message_analysis)').all() as Array<{ name?: unknown }>)
      .map((row) => String(row.name ?? '')),
  )
  if (!columns.has('trace_json')) {
    db.exec("ALTER TABLE message_analysis ADD COLUMN trace_json TEXT NOT NULL DEFAULT ''")
  }
  return db
}

/**
 * 缓存键：模型 + 提示词版本 + 会话类型。
 * @param model - 实际使用的模型标识（`provider/model`）；空串表示未知。
 * @param scope - 单聊/群聊，两套提示词不能共用缓存。
 */
export function analysisPromptKey(model: string, scope: MessageAnalysisScope): string {
  return 'v' + String(ANALYSIS_PROMPT_VERSION) + '|' + scope + '|' + model
}

/** 缓存命中项。 */
export interface CachedMessageAnalysis {
  sourceText: string
  fromVoice: boolean
  analysis: MessageAnalysis
  analyzedAt: number
  /** 当初那次调用的过程留痕；老缓存的这一列为空，读出来就是 undefined。 */
  trace?: ReplyTrace
}

/** 解析一行里的 trace JSON；坏数据当作没有留痕。 */
function traceOf(raw: unknown): ReplyTrace | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined
  try {
    const parsed = JSON.parse(raw) as ReplyTrace
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * 读一条缓存。
 * @returns 未命中、库不存在或 JSON 坏掉时返回 undefined（当作未命中）。
 */
export function readMessageAnalysisCache(
  decryptedDir: string,
  sessionId: string,
  localId: number,
  promptKey: string,
): CachedMessageAnalysis | undefined {
  if (!existsSync(analysisCachePath(decryptedDir))) return undefined
  let db: DatabaseSync | null = null
  try {
    db = openStore(decryptedDir)
    const row = db.prepare(
      'SELECT analyzed_at, source_text, from_voice, analysis_json, trace_json FROM message_analysis'
      + ' WHERE session_id = ? AND local_id = ? AND prompt_key = ?',
    ).get(sessionId, localId, promptKey) as {
      analyzed_at: number
      source_text: string
      from_voice: number
      analysis_json: string
      trace_json: string
    } | undefined
    if (row === undefined) return undefined
    const analysis = JSON.parse(row.analysis_json) as MessageAnalysis
    if (typeof analysis !== 'object' || analysis === null) return undefined
    const trace = traceOf(row.trace_json)
    return {
      sourceText: String(row.source_text ?? ''),
      fromVoice: Number(row.from_voice) === 1,
      analysis,
      analyzedAt: Number(row.analyzed_at) || 0,
      ...(trace === undefined ? {} : { trace }),
    }
  } catch {
    return undefined
  } finally {
    try { db?.close() } catch { /* ignore */ }
  }
}

/** 写一条缓存。失败不抛。 */
export function writeMessageAnalysisCache(
  decryptedDir: string,
  sessionId: string,
  localId: number,
  promptKey: string,
  row: { sourceText: string; fromVoice: boolean; analysis: MessageAnalysis; trace?: ReplyTrace },
): void {
  let db: DatabaseSync | null = null
  try {
    db = openStore(decryptedDir)
    db.prepare(
      'INSERT INTO message_analysis (session_id, local_id, prompt_key, analyzed_at, source_text, from_voice, analysis_json, trace_json)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      + ' ON CONFLICT(session_id, local_id, prompt_key) DO UPDATE SET'
      + ' analyzed_at = excluded.analyzed_at, source_text = excluded.source_text,'
      + ' from_voice = excluded.from_voice, analysis_json = excluded.analysis_json,'
      + ' trace_json = excluded.trace_json',
    ).run(
      sessionId,
      localId,
      promptKey,
      Math.floor(Date.now() / 1000),
      row.sourceText,
      row.fromVoice ? 1 : 0,
      JSON.stringify(row.analysis),
      row.trace === undefined ? '' : JSON.stringify(row.trace),
    )
  } catch {
    /* 缓存写不进不算错误 */
  } finally {
    try { db?.close() } catch { /* ignore */ }
  }
}
