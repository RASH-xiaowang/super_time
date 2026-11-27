/**
 * AI 回复的过程留痕（本机诊断）。
 *
 * 消息列表记录只保存「结果」（正文、状态、错误），排查「模型为什么这么答」
 * 需要看到本轮实际送进模型的上下文、知识库命中、提示词与各阶段耗时。
 * 这些内容放在独立表 `chat_ai_reply_traces`，主键是消息列表记录 id：
 *
 *  · 列表查询仍然 `SELECT * FROM message_list_records`，不会因留痕变胖；
 *  · 记录被清理时同事务删除对应留痕，不会留下孤儿正文；
 *  · 所有写入都吞异常 —— 留痕是增强，写不进去也绝不能影响回复本身。
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { withWritableDb } from '../db-open.ts'
import type { DatabaseSync } from '../db-open.ts'
import { storeExists, taskDbPath } from '../task-db.ts'
import type {
  ChatAiReplyTrace,
  ChatAiReplyTracePatch,
  ChatAiReplyTraceStage,
  ChatAiReplyTraceTool,
} from './types.ts'

/** 单字段上限：留痕是为了看清过程，不是无限备份聊天记录。 */
const CONTEXT_MAX = 40_000
const PROMPT_MAX = 20_000
const OUTPUT_MAX = 20_000
const KB_MAX = 8_000
const ERROR_MAX = 2_000
const MODEL_MAX = 200
const STAGES_MAX = 60

function textOf(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

function numOf(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isSafeInteger(n) && n > 0 ? n : 0
}

/** 建表；所有读写连接都调用，因此必须可重复执行。 */
export function ensureChatAiReplyTraceSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS chat_ai_reply_traces (
    record_id INTEGER PRIMARY KEY,
    source_ref TEXT NOT NULL DEFAULT '',
    account_key TEXT NOT NULL DEFAULT '',
    chat_username TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    started_at INTEGER NOT NULL DEFAULT 0,
    finished_at INTEGER NOT NULL DEFAULT 0,
    context TEXT NOT NULL DEFAULT '',
    kb TEXT NOT NULL DEFAULT '',
    system_prompt TEXT NOT NULL DEFAULT '',
    user_prompt TEXT NOT NULL DEFAULT '',
    image_count INTEGER NOT NULL DEFAULT 0,
    voice_count INTEGER NOT NULL DEFAULT 0,
    output TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    redacted INTEGER NOT NULL DEFAULT 0,
    stages TEXT NOT NULL DEFAULT '[]',
    tools TEXT NOT NULL DEFAULT '[]',
    updated_at INTEGER NOT NULL
  )`)
  /*
   * 老库补列（2026-11-24）：`CREATE TABLE IF NOT EXISTS` 不会给已存在的表加列，
   * 而「详情里看不到工具调用」正是缺这一列的直接后果 —— 不补的话旧库永远读不到。
   */
  const columns = new Set(
    (db.prepare('PRAGMA table_info(chat_ai_reply_traces)').all() as Array<Record<string, unknown>>)
      .map((row) => String(row['name'] ?? '')),
  )
  if (!columns.has('tools')) {
    try {
      db.exec("ALTER TABLE chat_ai_reply_traces ADD COLUMN tools TEXT NOT NULL DEFAULT '[]'")
    } catch { /* 另一个连接刚补完同一列：以 PRAGMA 的事实为准，不把重复列当故障 */ }
  }
}

/** 工具调用数组的解析（坏项丢弃；只保留有名字的条目）。 */
function toolsOf(raw: unknown): ChatAiReplyTraceTool[] {
  if (typeof raw !== 'string' || raw === '') return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const out: ChatAiReplyTraceTool[] = []
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) continue
      const row = item as Record<string, unknown>
      const name = typeof row['name'] === 'string' ? row['name'].trim() : ''
      if (name === '') continue
      out.push({
        name: name.slice(0, 60),
        ok: row['ok'] === true,
        ...(typeof row['code'] === 'string' && row['code'] !== '' ? { code: row['code'].slice(0, 80) } : {}),
        elapsedMs: numOf(row['elapsedMs']),
      })
    }
    return out.slice(-24)
  } catch {
    return []
  }
}

function stagesOf(raw: unknown): ChatAiReplyTraceStage[] {
  if (typeof raw !== 'string' || raw === '') return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const out: ChatAiReplyTraceStage[] = []
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) continue
      const row = item as Record<string, unknown>
      const name = typeof row['name'] === 'string' ? row['name'] : ''
      if (name === '') continue
      out.push({
        name: name as ChatAiReplyTraceStage['name'],
        at: numOf(row['at']),
        ...(typeof row['detail'] === 'string' && row['detail'] !== ''
          ? { detail: row['detail'].slice(0, ERROR_MAX) }
          : {}),
      })
    }
    return out
  } catch {
    return []
  }
}

/**
 * 写入一条留痕补丁（不存在则建行，存在则只覆盖给出的字段）。
 * @param decryptedDir - 解密数据根。
 * @param patch - 增量字段；`recordId` 非法时直接忽略。
 */
export function writeChatAiReplyTrace(
  decryptedDir: string,
  patch: ChatAiReplyTracePatch,
): void {
  const recordId = Number(patch.recordId)
  if (!Number.isSafeInteger(recordId) || recordId <= 0) return
  try {
    mkdirSync(dirname(taskDbPath(decryptedDir)), { recursive: true })
    withWritableDb(taskDbPath(decryptedDir), (db) => {
      ensureChatAiReplyTraceSchema(db)
      const now = Date.now()
      db.exec('BEGIN IMMEDIATE')
      try {
        db.prepare(`INSERT OR IGNORE INTO chat_ai_reply_traces
          (record_id, started_at, updated_at) VALUES (?, ?, ?)`)
          .run(recordId, patch.startedAt ?? now, now)
        const sets: string[] = []
        const values: Array<string | number> = []
        const put = (column: string, value: string | number): void => {
          sets.push(column + ' = ?')
          values.push(value)
        }
        if (patch.sourceRef !== undefined) put('source_ref', textOf(patch.sourceRef, 400))
        if (patch.accountKey !== undefined) put('account_key', textOf(patch.accountKey, 255))
        if (patch.chatUsername !== undefined) put('chat_username', textOf(patch.chatUsername, 255))
        if (patch.model !== undefined) put('model', textOf(patch.model, MODEL_MAX))
        if (patch.startedAt !== undefined) put('started_at', patch.startedAt)
        if (patch.finishedAt !== undefined) put('finished_at', patch.finishedAt)
        if (patch.context !== undefined) put('context', textOf(patch.context, CONTEXT_MAX))
        if (patch.kb !== undefined) put('kb', textOf(patch.kb, KB_MAX))
        if (patch.systemPrompt !== undefined) put('system_prompt', textOf(patch.systemPrompt, PROMPT_MAX))
        if (patch.userPrompt !== undefined) put('user_prompt', textOf(patch.userPrompt, PROMPT_MAX))
        if (patch.imageCount !== undefined) put('image_count', numOf(patch.imageCount))
        if (patch.voiceCount !== undefined) put('voice_count', numOf(patch.voiceCount))
        if (patch.output !== undefined) put('output', textOf(patch.output, OUTPUT_MAX))
        if (patch.error !== undefined) put('error', textOf(patch.error, ERROR_MAX))
        if (patch.tools !== undefined) put('tools', JSON.stringify(toolsOf(JSON.stringify(patch.tools))))
        if (patch.redacted !== undefined) put('redacted', patch.redacted ? 1 : 0)
        if (patch.stage !== undefined) {
          const row = db.prepare('SELECT stages FROM chat_ai_reply_traces WHERE record_id = ?')
            .get(recordId) as { stages?: unknown } | undefined
          put('stages', JSON.stringify(
            [...stagesOf(row?.stages), patch.stage].slice(-STAGES_MAX),
          ))
        }
        put('updated_at', now)
        db.prepare(`UPDATE chat_ai_reply_traces SET ${sets.join(', ')} WHERE record_id = ?`)
          .run(...values, recordId)
        db.exec('COMMIT')
      } catch (e) {
        try {
          db.exec('ROLLBACK')
        } catch {
          // 回滚失败只会留下本次补丁，不影响已经落库的事实。
        }
        throw e
      }
    })
  } catch {
    // 留痕写失败不能影响回复：这里刻意不再往上抛。
  }
}

/**
 * 删除单条记录的留痕（重新生成前清掉上一次的上下文/输出）。
 * @param db - 调用方已经持有的写连接。
 * @param recordId - 消息列表记录 id。
 * @returns 删除条数；表不存在或 id 非法时为 0。
 */
export function deleteChatAiReplyTraceOnDb(db: DatabaseSync, recordId: number): number {
  const id = Number(recordId)
  if (!Number.isSafeInteger(id) || id <= 0) return 0
  try {
    ensureChatAiReplyTraceSchema(db)
    const info = db.prepare('DELETE FROM chat_ai_reply_traces WHERE record_id = ?').run(id)
    return Number(info.changes) || 0
  } catch {
    return 0
  }
}

/**
 * 清理孤儿留痕：记录被删除后，其过程留痕不能继续留在库里。
 *
 * 用「不在 records 里」的集合条件，而不是让调用方逐个收集 id ——
 * 整组删除时一个 id 可能带走多个分段，逐 id 收集容易漏。
 * @param db - 调用方已经持有的写连接（通常已在事务内）。
 * @returns 本次删除的留痕条数；表不存在时静默返回 0。
 */
export function pruneOrphanChatAiReplyTraces(db: DatabaseSync): number {
  try {
    ensureChatAiReplyTraceSchema(db)
    const info = db.prepare(`DELETE FROM chat_ai_reply_traces
      WHERE record_id NOT IN (SELECT id FROM message_list_records)`).run()
    return Number(info.changes) || 0
  } catch {
    return 0
  }
}

export type ChatAiReplyTraceReadResult =
  | { ok: true; trace: ChatAiReplyTrace }
  | { ok: false; error: string }

/**
 * 读取一条记录的过程留痕。
 * @param decryptedDir - 解密数据根。
 * @param recordId - 消息列表记录 id。
 * @returns 找不到时 `ok:false`（旧记录本来就没有留痕）。
 */
export function readChatAiReplyTrace(
  decryptedDir: string,
  recordId: number,
): ChatAiReplyTraceReadResult {
  const id = Number(recordId)
  if (!Number.isSafeInteger(id) || id <= 0) return { ok: false, error: '记录 id 无效' }
  if (!storeExists(decryptedDir)) return { ok: false, error: '这条记录没有过程留痕' }
  try {
    const row = withWritableDb(taskDbPath(decryptedDir), (db) => {
      ensureChatAiReplyTraceSchema(db)
      return db.prepare('SELECT * FROM chat_ai_reply_traces WHERE record_id = ?')
        .get(id) as Record<string, unknown> | undefined
    })
    if (row === undefined) return { ok: false, error: '这条记录没有过程留痕' }
    return {
      ok: true,
      trace: {
        recordId: id,
        sourceRef: textOf(row['source_ref'], 400),
        accountKey: textOf(row['account_key'], 255),
        chatUsername: textOf(row['chat_username'], 255),
        model: textOf(row['model'], MODEL_MAX),
        startedAt: numOf(row['started_at']),
        finishedAt: numOf(row['finished_at']),
        context: textOf(row['context'], CONTEXT_MAX),
        kb: textOf(row['kb'], KB_MAX),
        systemPrompt: textOf(row['system_prompt'], PROMPT_MAX),
        userPrompt: textOf(row['user_prompt'], PROMPT_MAX),
        imageCount: numOf(row['image_count']),
        voiceCount: numOf(row['voice_count']),
        output: textOf(row['output'], OUTPUT_MAX),
        error: textOf(row['error'], ERROR_MAX),
        redacted: numOf(row['redacted']) === 1,
        stages: stagesOf(row['stages']),
        tools: toolsOf(row['tools']),
        updatedAt: numOf(row['updated_at']),
      },
    }
  } catch (e) {
    const message = (e as { message?: unknown } | null | undefined)?.message
    return { ok: false, error: '过程留痕读取失败：' + String(typeof message === 'string' ? message : e) }
  }
}
