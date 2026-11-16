/**
 * 消息列表 schema、字段迁移、行映射与展示身份补全。
 */
import type { DatabaseSync } from './db-open.ts'
import { contactMeta } from './meta.ts'
import { canonicalChatReference, isMessageTableHash } from './message-identity.ts'
import { validateMessageListImages } from './message-list-attachments.ts'
import type { MessageListAttachmentValidationOptions } from './message-list-attachments.ts'
import type {
  MessageListImage,
  MessageListRecord,
  MessageListRecordResult,
  MessageListRule,
} from '../types.ts'
import {
  ERROR_MAX,
  JOB_ID_MAX,
  JOB_STATE_MAX,
  NAME_MAX,
  NOTE_MAX,
  RESPONSE_MAX,
  SOURCE_REF_MAX,
  TEXT_MAX,
  USERNAME_MAX,
  WEBHOOK_MAX,
  numOf,
  positiveId,
  sourceOf,
  statusOf,
  textOf,
} from './message-list-store-shared.ts'

/** 建表；所有写连接都调用，因此可重复执行。 */
export function ensureMessageListSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS message_list_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reply_id TEXT NOT NULL,
    chat_name TEXT NOT NULL DEFAULT '',
    target_name TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL DEFAULT '',
    images TEXT NOT NULL DEFAULT '[]',
    triggered_at INTEGER NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual',
    status TEXT NOT NULL DEFAULT 'pending',
    note TEXT NOT NULL DEFAULT '',
    chat_username TEXT NOT NULL DEFAULT '',
    target_username TEXT NOT NULL DEFAULT '',
    webhook_url TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    attempts INTEGER NOT NULL DEFAULT 0,
    last_attempt_at INTEGER,
    response_summary TEXT NOT NULL DEFAULT '',
    job_id TEXT NOT NULL DEFAULT '',
    job_state TEXT NOT NULL DEFAULT '',
    job_checked_at INTEGER,
    task_id INTEGER,
    trigger_id INTEGER,
    source_ref TEXT,
    segment_group_ref TEXT NOT NULL DEFAULT '',
    segment_index INTEGER NOT NULL DEFAULT 0,
    segment_count INTEGER NOT NULL DEFAULT 0,
    failure_kind TEXT NOT NULL DEFAULT '',
    dispatch_owner TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS message_list_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_key TEXT NOT NULL DEFAULT '',
    chat_username TEXT NOT NULL DEFAULT '',
    chat_name TEXT NOT NULL DEFAULT '',
    target_name TEXT NOT NULL DEFAULT '',
    webhook_url TEXT NOT NULL,
    greeting_text TEXT NOT NULL DEFAULT '你好',
    note TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    managed_by TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`)
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_message_list_source_ref
    ON message_list_records(source_ref) WHERE source_ref IS NOT NULL AND source_ref <> ''`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_message_list_records_order
    ON message_list_records(triggered_at DESC, id DESC)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_message_list_records_status
    ON message_list_records(status, triggered_at ASC, id ASC)`)
  // 列表筛选和复合游标保持同一顺序，避免 source/status 条件退化为临时排序。
  db.exec(`CREATE INDEX IF NOT EXISTS idx_message_list_records_source_order
    ON message_list_records(source, triggered_at DESC, id DESC)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_message_list_records_status_order
    ON message_list_records(status, triggered_at DESC, id DESC)`)
  // SQLite 不支持 ADD COLUMN IF NOT EXISTS；老库必须逐列探测后补列。
  const columns = new Set(
    (db.prepare('PRAGMA table_info(message_list_records)').all() as Array<Record<string, unknown>>)
      .map((row) => textOf(row['name'], 80)),
  )
  if (!columns.has('job_id')) {
    db.exec("ALTER TABLE message_list_records ADD COLUMN job_id TEXT NOT NULL DEFAULT ''")
  }
  if (!columns.has('job_state')) {
    db.exec("ALTER TABLE message_list_records ADD COLUMN job_state TEXT NOT NULL DEFAULT ''")
  }
  if (!columns.has('segment_group_ref')) {
    db.exec("ALTER TABLE message_list_records ADD COLUMN segment_group_ref TEXT NOT NULL DEFAULT ''")
  }
  if (!columns.has('segment_index')) {
    db.exec('ALTER TABLE message_list_records ADD COLUMN segment_index INTEGER NOT NULL DEFAULT 0')
  }
  if (!columns.has('segment_count')) {
    db.exec('ALTER TABLE message_list_records ADD COLUMN segment_count INTEGER NOT NULL DEFAULT 0')
  }
  // 失败原因分类：让界面能区分「按设计过期」「没生成正文」「发送失败」，
  // 而不是把所有失败都压成一条机器长句；空串表示未分类（旧行）。
  if (!columns.has('failure_kind')) {
    db.exec("ALTER TABLE message_list_records ADD COLUMN failure_kind TEXT NOT NULL DEFAULT ''")
  }
  // 投递认领进程：进程已死的 dispatching 可立即收口为「已发送·未确认」，
  // 不必等满 5 分钟；空串表示旧行，仍走原超时路径。
  if (!columns.has('dispatch_owner')) {
    db.exec("ALTER TABLE message_list_records ADD COLUMN dispatch_owner TEXT NOT NULL DEFAULT ''")
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_message_list_segment_group
    ON message_list_records(segment_group_ref, segment_index)
    WHERE segment_group_ref <> ''`)
  // 旧版把「会话已有更新的消息」写成普通 failed 行；一次性归入按设计过期，
  // 避免界面把它计入真正的发送/生成失败。条件只命中未分类行，可重复执行。
  db.exec(`UPDATE message_list_records SET failure_kind = 'superseded'
    WHERE failure_kind = '' AND source = 'ai_reply' AND status = 'failed'
      AND error LIKE '%会话已有更新的消息%'`)
  // 旧版 AI 预约沿用了原消息时间，可能在按触发时间倒序的首屏 200 条之外。
  // 只迁移仍为空正文的 pending 预约，避免污染已完成记录或重复改变展示顺序。
  db.exec(`UPDATE message_list_records
    SET triggered_at = updated_at
    WHERE source = 'ai_reply' AND status = 'pending' AND text = ''
      AND triggered_at < updated_at`)
  if (!columns.has('job_checked_at')) {
    db.exec('ALTER TABLE message_list_records ADD COLUMN job_checked_at INTEGER')
  }
  const ruleColumns = new Set(
    (db.prepare('PRAGMA table_info(message_list_rules)').all() as Array<Record<string, unknown>>)
      .map((row) => textOf(row['name'], 80)),
  )
  if (!ruleColumns.has('account_key')) {
    db.exec("ALTER TABLE message_list_rules ADD COLUMN account_key TEXT NOT NULL DEFAULT ''")
  }
  if (!ruleColumns.has('chat_username')) {
    db.exec("ALTER TABLE message_list_rules ADD COLUMN chat_username TEXT NOT NULL DEFAULT ''")
  }
  if (!ruleColumns.has('managed_by')) {
    db.exec("ALTER TABLE message_list_rules ADD COLUMN managed_by TEXT NOT NULL DEFAULT ''")
  }
  // 老库的唯一索引只有「会话名 + 触发对象」；默认 AI 规则必须再带账号和
  // 会话 username，否则两个账号下的同名联系人会互相覆盖。
  const ruleIndexColumns = new Set(
    (db.prepare(`PRAGMA index_info('idx_message_list_rule_pair')`).all() as Array<Record<string, unknown>>)
      .map((row) => textOf(row['name'], 80)),
  )
  if (!ruleIndexColumns.has('account_key') || !ruleIndexColumns.has('chat_username')) {
    db.exec('DROP INDEX IF EXISTS idx_message_list_rule_pair')
    db.exec(`CREATE UNIQUE INDEX idx_message_list_rule_pair
      ON message_list_rules(account_key, chat_username, chat_name, target_name)`)
  }
}

/** 兼容旧的只读调用；落库与入站入口必须直接使用严格校验。 */
export function sanitizeMessageListImages(
  raw: unknown,
  options: MessageListAttachmentValidationOptions = {},
): MessageListImage[] {
  const result = validateMessageListImages(raw, options)
  return result.ok ? result.images : []
}

export function parseImages(raw: unknown): MessageListImage[] {
  return parsedImagesOf(raw).images
}

const imageParseErrors = new WeakMap<MessageListRecord, string>()

function parsedImagesOf(raw: unknown): { images: MessageListImage[]; error?: string } {
  const text = typeof raw === 'string' ? raw : ''
  if (text === '') return { images: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    return { images: [], error: '历史附件 JSON 无法解析，已阻止投递' }
  }
  const result = validateMessageListImages(parsed, { mode: 'stored' })
  return result.ok
    ? { images: result.images }
    : { images: [], error: '历史附件校验失败，已阻止投递：' + result.error }
}

/** 附件解析错误只挂在当前记录对象上，不改变对外记录结构。 */
export function messageListImagesError(record: MessageListRecord): string | undefined {
  return imageParseErrors.get(record)
}

/** `message_list_records` 行 → 契约对象。 */
export function rowToMessageListRecord(row: Record<string, unknown>): MessageListRecord {
  const images = parsedImagesOf(row['images'])
  const record: MessageListRecord = {
    id: numOf(row['id']),
    replyId: textOf(row['reply_id'], 200),
    chatName: textOf(row['chat_name'], NAME_MAX),
    targetName: textOf(row['target_name'], NAME_MAX),
    text: textOf(row['text'], TEXT_MAX),
    images: images.images,
    triggeredAt: numOf(row['triggered_at']),
    source: sourceOf(row['source']),
    status: statusOf(row['status']),
    note: textOf(row['note'], NOTE_MAX),
    chatUsername: textOf(row['chat_username'], USERNAME_MAX),
    targetUsername: textOf(row['target_username'], USERNAME_MAX),
    webhookUrl: textOf(row['webhook_url'], WEBHOOK_MAX),
    error: textOf(row['error'], ERROR_MAX),
    attempts: Math.max(0, numOf(row['attempts'])),
    createdAt: numOf(row['created_at']),
    updatedAt: numOf(row['updated_at']),
  }
  if (row['last_attempt_at'] !== null && row['last_attempt_at'] !== undefined) {
    record.lastAttemptAt = numOf(row['last_attempt_at'])
  }
  const responseSummary = textOf(row['response_summary'], RESPONSE_MAX)
  if (responseSummary !== '') record.responseSummary = responseSummary
  const jobId = textOf(row['job_id'], JOB_ID_MAX)
  if (jobId !== '') record.jobId = jobId
  const jobState = textOf(row['job_state'], JOB_STATE_MAX)
  if (jobState !== '') record.jobState = jobState
  const jobCheckedAt = positiveId(row['job_checked_at'])
  if (jobCheckedAt > 0) record.jobCheckedAt = jobCheckedAt
  const taskId = positiveId(row['task_id'])
  if (taskId > 0) record.taskId = taskId
  const triggerId = positiveId(row['trigger_id'])
  if (triggerId > 0) record.triggerId = triggerId
  const sourceRef = textOf(row['source_ref'], SOURCE_REF_MAX)
  if (sourceRef !== '') record.sourceRef = sourceRef
  const segmentGroupRef = textOf(row['segment_group_ref'], SOURCE_REF_MAX)
  if (segmentGroupRef !== '') record.segmentGroupRef = segmentGroupRef
  const segmentIndex = positiveId(row['segment_index'])
  if (segmentIndex > 0) record.segmentIndex = segmentIndex
  const segmentCount = positiveId(row['segment_count'])
  if (segmentCount > 0) record.segmentCount = segmentCount
  const failureKind = textOf(row['failure_kind'], 40)
  if (failureKind !== '') record.failureKind = failureKind
  if (images.error !== undefined) imageParseErrors.set(record, images.error)
  return record
}

/**
 * Canonicalize persisted chat/target ids and hide unresolved legacy hashes.
 *
 * This is intentionally applied on reads as well as writes: databases from
 * older builds may already contain a message-table hash. Reads must never keep
 * that physical key in UI state, navigation, or a subsequent cache write.
 * @param decryptedDir - decrypted data root.
 * @param record - mutable record returned from a row mapping.
 */
export function canonicalizeMessageListRecord(
  decryptedDir: string,
  record: MessageListRecord,
): void {
  if (record.chatUsername !== '') {
    const chat = canonicalChatReference(decryptedDir, record.chatUsername, '会话')
    record.chatUsername = chat.error === undefined ? chat.username : ''
    if (chat.error === undefined && (record.chatName === '' || isMessageTableHash(record.chatName))) {
      record.chatName = chat.displayName
    }
  }
  if (record.targetUsername !== '') {
    const target = canonicalChatReference(decryptedDir, record.targetUsername, '触发对象')
    record.targetUsername = target.error === undefined ? target.username : ''
  }
  if (isMessageTableHash(record.chatName)) record.chatName = '未命名会话'
}

/** 给记录补只用于展示的企业名称；规则/投递仍使用原始 chatName/targetName。 */
export function enrichMessageListRecords(decryptedDir: string, records: MessageListRecord[]): void {
  if (records.length === 0) return
  const enterpriseNames = contactMeta(decryptedDir).enterpriseNames
  for (const record of records) {
    canonicalizeMessageListRecord(decryptedDir, record)
    const chatEnterpriseName = enterpriseNames.get(record.chatUsername)?.trim()
    const targetEnterpriseName = enterpriseNames.get(record.targetUsername)?.trim()
    if (chatEnterpriseName) record.chatEnterpriseName = chatEnterpriseName
    if (targetEnterpriseName) record.targetEnterpriseName = targetEnterpriseName
  }
}

/** Return an inserted/updated record with the same display-only identity fields as list reads. */
export function enrichMessageListResult(
  decryptedDir: string,
  result: MessageListRecordResult,
): MessageListRecordResult {
  if (result.record !== undefined) enrichMessageListRecords(decryptedDir, [result.record])
  return result
}

/** `message_list_rules` 行 → 契约对象。 */
export function rowToMessageListRule(row: Record<string, unknown>): MessageListRule {
  return {
    id: numOf(row['id']),
    chatName: textOf(row['chat_name'], NAME_MAX),
    targetName: textOf(row['target_name'], NAME_MAX),
    webhookUrl: textOf(row['webhook_url'], WEBHOOK_MAX),
    greetingText: textOf(row['greeting_text'], TEXT_MAX),
    note: textOf(row['note'], NOTE_MAX),
    enabled: numOf(row['enabled']) === 1,
    createdAt: numOf(row['created_at']),
    updatedAt: numOf(row['updated_at']),
  }
}
