/**
 * 会话级 AI 回复的表结构与列迁移。
 *
 * 从 `config-store.ts` 拆出（M21 单文件 1000 行棘轮）：本模块只关心
 * 「这个库长什么样、缺哪列补哪列」，不涉及读写语义。读写仍全部在
 * `config-store.ts`，两边通过 `ensureChatAiReplySchema` 单点衔接。
 *
 * @module query/ai-reply/config-schema
 */
import type { DatabaseSync } from '../db-open.ts'

/**
 * pending 锚点的 revision 可信标记。
 *
 * 旧行没有标记 —— 宁可让 runner fail-closed，也不能把它们当成「revision 合法」，
 * 否则一次错误恢复就可能补发过期答案。
 */
export const PENDING_REVISION_VALID = 'valid'
export const PENDING_REVISION_LEGACY = 'legacy'

function columnNameOf(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 80) : ''
}

function isDuplicateColumnError(e: unknown): boolean {
  const message = (e as { message?: unknown } | null | undefined)?.message
  return /duplicate column name/i.test(typeof message === 'string' ? message : String(e))
}

function tableHasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>
  return rows.some((row) => columnNameOf(row.name) === column)
}

/**
 * 老库并发启动时，两个连接可能都先看到缺列；后到的 ALTER 会报 duplicate column。
 * 这里把“列已经存在”当作迁移成功，避免一次正常竞态阻断后台 runner。
 * @param db - 已打开的写连接。
 * @param column - 期望存在的列名。
 * @param ddl - 缺列时执行的 ALTER 语句。
 * @returns 本次是否真的新增了该列。
 */
function addColumnIfMissing(db: DatabaseSync, column: string, ddl: string): boolean {
  if (tableHasColumn(db, 'chat_ai_reply_settings', column)) return false
  try {
    db.exec(ddl)
    return true
  } catch (e) {
    if (isDuplicateColumnError(e) && tableHasColumn(db, 'chat_ai_reply_settings', column)) {
      return false
    }
    throw e
  }
}

/**
 * 建表 + 补列；与消息列表同库，可重复调用。
 * @param db - 已打开的写连接。
 */
export function ensureChatAiReplySchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS chat_ai_reply_settings (
    account_key TEXT NOT NULL,
    chat_username TEXT NOT NULL,
    chat_name TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 0,
    provider TEXT NOT NULL DEFAULT 'dsh-wechat-bridge',
    split_reply INTEGER NOT NULL DEFAULT 1,
    persona_name TEXT NOT NULL DEFAULT '',
    persona_prompt TEXT NOT NULL DEFAULT '',
    kb_enabled INTEGER NOT NULL DEFAULT 0,
    kb_id INTEGER NOT NULL DEFAULT 0,
    context_window_hours INTEGER NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL DEFAULT 0,
    cursor TEXT NOT NULL DEFAULT '',
    pending_cursor TEXT NOT NULL DEFAULT '',
    pending_source_ref TEXT NOT NULL DEFAULT '',
    pending_revision INTEGER NOT NULL DEFAULT 0,
    pending_revision_marker TEXT NOT NULL DEFAULT '',
    generation_state TEXT NOT NULL DEFAULT '',
    generation_source_ref TEXT NOT NULL DEFAULT '',
    generation_text TEXT NOT NULL DEFAULT '',
    generation_revision INTEGER NOT NULL DEFAULT 0,
    lease_owner TEXT,
    lease_until INTEGER NOT NULL DEFAULT 0,
    lease_fence INTEGER NOT NULL DEFAULT 0,
    stage TEXT NOT NULL DEFAULT 'idle',
    last_run_at INTEGER,
    record_id INTEGER,
    error TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (account_key, chat_username)
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_ai_reply_enabled
    ON chat_ai_reply_settings(enabled, updated_at DESC)`)
  addColumnIfMissing(
    db,
    'split_reply',
    'ALTER TABLE chat_ai_reply_settings ADD COLUMN split_reply INTEGER NOT NULL DEFAULT 1',
  )
  addColumnIfMissing(
    db,
    'persona_name',
    "ALTER TABLE chat_ai_reply_settings ADD COLUMN persona_name TEXT NOT NULL DEFAULT ''",
  )
  addColumnIfMissing(
    db,
    'persona_prompt',
    "ALTER TABLE chat_ai_reply_settings ADD COLUMN persona_prompt TEXT NOT NULL DEFAULT ''",
  )
  addColumnIfMissing(
    db,
    'kb_enabled',
    'ALTER TABLE chat_ai_reply_settings ADD COLUMN kb_enabled INTEGER NOT NULL DEFAULT 0',
  )
  addColumnIfMissing(
    db,
    'kb_id',
    'ALTER TABLE chat_ai_reply_settings ADD COLUMN kb_id INTEGER NOT NULL DEFAULT 0',
  )
  // 0 表示不限（沿用「最近 60 条」）；正数表示只把最近 N 小时的消息当上下文。
  addColumnIfMissing(
    db,
    'context_window_hours',
    'ALTER TABLE chat_ai_reply_settings ADD COLUMN context_window_hours INTEGER NOT NULL DEFAULT 0',
  )
  addColumnIfMissing(
    db,
    'safety_handoff',
    "ALTER TABLE chat_ai_reply_settings ADD COLUMN safety_handoff TEXT NOT NULL DEFAULT ''",
  )
  addColumnIfMissing(
    db,
    'safety_blocked',
    "ALTER TABLE chat_ai_reply_settings ADD COLUMN safety_blocked TEXT NOT NULL DEFAULT ''",
  )
  addColumnIfMissing(
    db,
    'pending_cursor',
    "ALTER TABLE chat_ai_reply_settings ADD COLUMN pending_cursor TEXT NOT NULL DEFAULT ''",
  )
  addColumnIfMissing(
    db,
    'pending_source_ref',
    "ALTER TABLE chat_ai_reply_settings ADD COLUMN pending_source_ref TEXT NOT NULL DEFAULT ''",
  )
  addColumnIfMissing(
    db,
    'pending_revision',
    'ALTER TABLE chat_ai_reply_settings ADD COLUMN pending_revision INTEGER NOT NULL DEFAULT 0',
  )
  if (addColumnIfMissing(
    db,
    'pending_revision_marker',
    "ALTER TABLE chat_ai_reply_settings ADD COLUMN pending_revision_marker TEXT NOT NULL DEFAULT ''",
  )) {
    // Existing pending rows predate the marker. They are deliberately marked
    // as legacy rather than backfilled from the current revision.
    db.exec(`UPDATE chat_ai_reply_settings SET pending_revision_marker = '${PENDING_REVISION_LEGACY}'
      WHERE pending_cursor <> '' OR pending_source_ref <> ''
        OR record_id IS NOT NULL
        OR stage IN ('generating', 'saving', 'dispatching')`)
  }
  addColumnIfMissing(
    db,
    'generation_state',
    "ALTER TABLE chat_ai_reply_settings ADD COLUMN generation_state TEXT NOT NULL DEFAULT ''",
  )
  addColumnIfMissing(
    db,
    'generation_source_ref',
    "ALTER TABLE chat_ai_reply_settings ADD COLUMN generation_source_ref TEXT NOT NULL DEFAULT ''",
  )
  addColumnIfMissing(
    db,
    'generation_text',
    "ALTER TABLE chat_ai_reply_settings ADD COLUMN generation_text TEXT NOT NULL DEFAULT ''",
  )
  addColumnIfMissing(
    db,
    'generation_revision',
    'ALTER TABLE chat_ai_reply_settings ADD COLUMN generation_revision INTEGER NOT NULL DEFAULT 0',
  )
  addColumnIfMissing(
    db,
    'lease_owner',
    'ALTER TABLE chat_ai_reply_settings ADD COLUMN lease_owner TEXT',
  )
  addColumnIfMissing(
    db,
    'lease_until',
    'ALTER TABLE chat_ai_reply_settings ADD COLUMN lease_until INTEGER NOT NULL DEFAULT 0',
  )
  addColumnIfMissing(
    db,
    'lease_fence',
    'ALTER TABLE chat_ai_reply_settings ADD COLUMN lease_fence INTEGER NOT NULL DEFAULT 0',
  )
}
