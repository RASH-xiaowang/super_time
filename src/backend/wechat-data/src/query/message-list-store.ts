/**
 * 「消息列表 / 回复投递规则」的持久化层。
 *
 * 记录与规则共用 `wechat_task_center.db`，但表和领域独立于 `task_triggers`：
 *  · `message_list_records` 是一条已经产生、等待/已经发往下游的回复；
 *  · `message_list_rules` 按「会话名 + 触发对象」选择下游 Webhook。
 *
 * 记录落库时保存地址快照，后续改规则不会悄悄改道；重发只有在快照为空时才重新匹配。
 * 图片只接受微信本地引用、http(s) URL 或安全 data:image；不接受任意本机路径。
 *
 * @module query/message-list-store
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { withWritableDb } from './db-open.ts'
import type { DatabaseSync } from './db-open.ts'
import { storeExists, taskDbPath } from './task-db.ts'
import { contactMeta } from './meta.ts'
import type {
  MessageListImage,
  MessageListMutationResult,
  MessageListQuery,
  MessageListRecord,
  MessageListRecordInput,
  MessageListRecordResult,
  MessageListRule,
  MessageListRuleInput,
  MessageListRuleSnapshot,
  MessageListSnapshot,
  MessageListSource,
  MessageListStatus,
  MessageListWebhookPayload,
} from '../types.ts'
import type { TaskTriggerImage } from '../types-taskcenter.ts'

const NAME_MAX = 200
const USERNAME_MAX = 255
const TEXT_MAX = 4000
const NOTE_MAX = 500
const WEBHOOK_MAX = 2048
const ERROR_MAX = 500
const RESPONSE_MAX = 500
const SOURCE_REF_MAX = 200
const IMAGE_MAX = 9
const IMAGE_URL_MAX = 4096
const IMAGE_DATA_MAX = 3_500_000
const QUERY_DEFAULT = 200
const QUERY_MAX = 500

const DATA_IMAGE_RE = /^data:image\/(?:png|jpe?g|gif|webp|bmp);base64,/i

function textOf(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, max)
}

function numOf(value: unknown, fallback = 0): number {
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

function positiveId(value: unknown): number {
  const id = numOf(value)
  return id > 0 ? id : 0
}

function errorText(e: unknown): string {
  const msg = (e as { message?: unknown } | null | undefined)?.message
  return typeof msg === 'string' && msg !== '' ? msg : String(e)
}

function ensureParentDir(decryptedDir: string): void {
  try {
    mkdirSync(dirname(taskDbPath(decryptedDir)), { recursive: true })
  } catch {
    // 后续 SQLite 会给出真正原因，这里不提前吞掉错误语义。
  }
}

function httpUrl(value: unknown, max = WEBHOOK_MAX): string {
  const raw = textOf(value, max)
  if (raw === '') return ''
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:' ? raw : ''
  } catch {
    return ''
  }
}

function sourceOf(value: unknown): MessageListSource {
  return value === 'first_trigger' || value === 'webhook' || value === 'manual' ? value : 'manual'
}

function statusOf(value: unknown): MessageListStatus {
  return value === 'success' || value === 'failed' || value === 'pending' ? value : 'pending'
}

function generateReplyId(): string {
  return 'ml-' + String(Date.now()) + '-' + randomUUID().slice(0, 8)
}

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
    task_id INTEGER,
    trigger_id INTEGER,
    source_ref TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS message_list_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_name TEXT NOT NULL DEFAULT '',
    target_name TEXT NOT NULL DEFAULT '',
    webhook_url TEXT NOT NULL,
    greeting_text TEXT NOT NULL DEFAULT '你好',
    note TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`)
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_message_list_source_ref
    ON message_list_records(source_ref) WHERE source_ref IS NOT NULL AND source_ref <> ''`)
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_message_list_rule_pair
    ON message_list_rules(chat_name, target_name)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_message_list_records_order
    ON message_list_records(triggered_at DESC, id DESC)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_message_list_records_status
    ON message_list_records(status, triggered_at ASC, id ASC)`)
}

/**
 * 清洗图片列表。坏项丢弃，不把任意本机路径带进库或下游。
 * @param raw - 入参图片/附件（运行时不可信）。
 * @returns 最多 9 项且总 data URL 字符数受限的安全图片引用。
 */
export function sanitizeMessageListImages(raw: unknown): MessageListImage[] {
  const list = Array.isArray(raw) ? raw : []
  const out: MessageListImage[] = []
  let dataChars = 0
  for (const candidate of list) {
    if (out.length >= IMAGE_MAX) break
    if (typeof candidate === 'string') {
      const url = httpUrl(candidate, IMAGE_URL_MAX)
      if (url !== '') {
        out.push({ url })
        continue
      }
      if (DATA_IMAGE_RE.test(candidate) && candidate.length <= IMAGE_DATA_MAX && dataChars + candidate.length <= IMAGE_DATA_MAX) {
        out.push({ dataUrl: candidate })
        dataChars += candidate.length
      }
      continue
    }
    if (typeof candidate !== 'object' || candidate === null) continue
    const row = candidate as Record<string, unknown>
    const localId = positiveId(row['localId'])
    if (localId > 0) {
      const image: MessageListImage = {
        localId,
        createTime: Math.max(0, numOf(row['createTime'])),
        sender: textOf(row['sender'], NAME_MAX),
      }
      const md5 = textOf(row['md5'], 64)
      if (md5 !== '') image.md5 = md5
      out.push(image)
      continue
    }
    const url = httpUrl(row['url'], IMAGE_URL_MAX)
    if (url !== '') {
      const image: MessageListImage = { url }
      const name = textOf(row['name'], NAME_MAX)
      if (name !== '') image.name = name
      out.push(image)
      continue
    }
    const dataUrl = typeof row['dataUrl'] === 'string' ? row['dataUrl'] : ''
    if (
      DATA_IMAGE_RE.test(dataUrl)
      && dataUrl.length <= IMAGE_DATA_MAX
      && dataChars + dataUrl.length <= IMAGE_DATA_MAX
    ) {
      const image: MessageListImage = { dataUrl }
      const name = textOf(row['name'], NAME_MAX)
      if (name !== '') image.name = name
      out.push(image)
      dataChars += dataUrl.length
    }
  }
  return out
}

function parseImages(raw: unknown): MessageListImage[] {
  const text = typeof raw === 'string' ? raw : ''
  if (text === '') return []
  try {
    return sanitizeMessageListImages(JSON.parse(text) as unknown)
  } catch {
    return []
  }
}

/** `message_list_records` 行 → 契约对象。 */
export function rowToMessageListRecord(row: Record<string, unknown>): MessageListRecord {
  const record: MessageListRecord = {
    id: numOf(row['id']),
    replyId: textOf(row['reply_id'], 200),
    chatName: textOf(row['chat_name'], NAME_MAX),
    targetName: textOf(row['target_name'], NAME_MAX),
    text: textOf(row['text'], TEXT_MAX),
    images: parseImages(row['images']),
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
  const taskId = positiveId(row['task_id'])
  if (taskId > 0) record.taskId = taskId
  const triggerId = positiveId(row['trigger_id'])
  if (triggerId > 0) record.triggerId = triggerId
  const sourceRef = textOf(row['source_ref'], SOURCE_REF_MAX)
  if (sourceRef !== '') record.sourceRef = sourceRef
  return record
}

/** 给记录补只用于展示的企业名称；规则/投递仍使用原始 chatName/targetName。 */
function enrichMessageListRecords(decryptedDir: string, records: MessageListRecord[]): void {
  if (records.length === 0) return
  const enterpriseNames = contactMeta(decryptedDir).enterpriseNames
  for (const record of records) {
    const chatEnterpriseName = enterpriseNames.get(record.chatUsername)?.trim()
    const targetEnterpriseName = enterpriseNames.get(record.targetUsername)?.trim()
    if (chatEnterpriseName) record.chatEnterpriseName = chatEnterpriseName
    if (targetEnterpriseName) record.targetEnterpriseName = targetEnterpriseName
  }
}

/** Return an inserted/updated record with the same display-only identity fields as list reads. */
function enrichMessageListResult(
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

/** 规则匹配：精确对 > 同会话通配对象 > 任意会话指定对象 > 全局通配。 */
export function matchMessageListRuleAt(
  db: DatabaseSync,
  chatName: string,
  targetName: string,
): MessageListRule | undefined {
  ensureMessageListSchema(db)
  const chat = textOf(chatName, NAME_MAX)
  const target = textOf(targetName, NAME_MAX)
  const row = db.prepare(`SELECT * FROM message_list_rules
    WHERE enabled = 1 AND (
      (chat_name = ? AND target_name = ?)
      OR (chat_name = ? AND target_name = '')
      OR (chat_name = '' AND target_name = ?)
      OR (chat_name = '' AND target_name = '')
    )
    ORDER BY CASE
      WHEN chat_name = ? AND target_name = ? THEN 0
      WHEN chat_name = ? AND target_name = '' THEN 1
      WHEN chat_name = '' AND target_name = ? THEN 2
      ELSE 3
    END, updated_at DESC, id DESC
    LIMIT 1`).get(chat, target, chat, target, chat, target, chat, target) as Record<string, unknown> | undefined
  return row === undefined ? undefined : rowToMessageListRule(row)
}

/** 按当前规则表匹配一条规则；库不存在/读失败时返回 undefined。 */
export function matchMessageListRule(
  decryptedDir: string,
  chatName: string,
  targetName: string,
): MessageListRule | undefined {
  if (!storeExists(decryptedDir)) return undefined
  try {
    return withWritableDb(taskDbPath(decryptedDir), (db) => matchMessageListRuleAt(db, chatName, targetName))
  } catch {
    return undefined
  }
}

function whereRecords(query: MessageListQuery): { sql: string; params: Array<string | number> } {
  const clauses: string[] = []
  const params: Array<string | number> = []
  const status = statusOf(query.status)
  if (query.status === 'success' || query.status === 'failed' || query.status === 'pending') {
    clauses.push('status = ?')
    params.push(status)
  }
  if (query.source === 'first_trigger' || query.source === 'webhook' || query.source === 'manual') {
    clauses.push('source = ?')
    params.push(query.source)
  }
  const search = textOf(query.search, 100)
  if (search !== '') {
    const like = '%' + search.replace(/[\\%_]/g, (m) => '\\' + m) + '%'
    clauses.push(`(reply_id LIKE ? ESCAPE '\\' OR chat_name LIKE ? ESCAPE '\\'
      OR target_name LIKE ? ESCAPE '\\' OR text LIKE ? ESCAPE '\\'
      OR note LIKE ? ESCAPE '\\' OR error LIKE ? ESCAPE '\\')`)
    params.push(like, like, like, like, like, like)
  }
  return { sql: clauses.length > 0 ? ' WHERE ' + clauses.join(' AND ') : '', params }
}

/** 消息记录快照（默认 200 条，最新在前）。 */
export function listMessageListRecords(
  decryptedDir: string,
  query: MessageListQuery = {},
): MessageListSnapshot {
  if (!storeExists(decryptedDir)) return { items: [], total: 0 }
  const limit = Math.min(QUERY_MAX, Math.max(1, numOf(query.limit, QUERY_DEFAULT)))
  const where = whereRecords(query)
  try {
    return withWritableDb(taskDbPath(decryptedDir), (db) => {
      ensureMessageListSchema(db)
      const totalRow = db.prepare('SELECT COUNT(*) AS n FROM message_list_records' + where.sql)
        .get(...where.params) as { n?: unknown } | undefined
      const rows = db.prepare(
        'SELECT * FROM message_list_records' + where.sql + ' ORDER BY triggered_at DESC, id DESC LIMIT ?',
      ).all(...where.params, limit) as Array<Record<string, unknown>>
      const items = rows.map(rowToMessageListRecord)
      enrichMessageListRecords(decryptedDir, items)
      return { items, total: numOf(totalRow?.n) }
    })
  } catch (e) {
    return { items: [], total: 0, readError: '消息列表读取失败：' + errorText(e) }
  }
}

/** 规则列表（最新更新在前）。 */
export function listMessageListRules(decryptedDir: string): MessageListRuleSnapshot {
  if (!storeExists(decryptedDir)) return { items: [], total: 0 }
  try {
    return withWritableDb(taskDbPath(decryptedDir), (db) => {
      ensureMessageListSchema(db)
      const rows = db.prepare('SELECT * FROM message_list_rules ORDER BY updated_at DESC, id DESC')
        .all() as Array<Record<string, unknown>>
      return { items: rows.map(rowToMessageListRule), total: rows.length }
    })
  } catch (e) {
    return { items: [], total: 0, readError: '规则读取失败：' + errorText(e) }
  }
}

/** 按 id 读一条记录。 */
export function getMessageListRecord(decryptedDir: string, id: number): MessageListRecord | undefined {
  const recordId = positiveId(id)
  if (recordId <= 0 || !storeExists(decryptedDir)) return undefined
  try {
    return withWritableDb(taskDbPath(decryptedDir), (db) => {
      ensureMessageListSchema(db)
      const row = db.prepare('SELECT * FROM message_list_records WHERE id = ?')
        .get(recordId) as Record<string, unknown> | undefined
      if (row === undefined) return undefined
      const record = rowToMessageListRecord(row)
      enrichMessageListRecords(decryptedDir, [record])
      return record
    })
  } catch {
    return undefined
  }
}

interface InsertRecordFields {
  replyId: string
  chatName: string
  targetName: string
  text: string
  images: MessageListImage[]
  triggeredAt: number
  source: MessageListSource
  note: string
  chatUsername: string
  targetUsername: string
  webhookUrl: string
  taskId?: number
  triggerId?: number
  sourceRef?: string
}

function insertRecordAt(db: DatabaseSync, fields: InsertRecordFields): MessageListRecordResult {
  ensureMessageListSchema(db)
  if (fields.sourceRef !== undefined && fields.sourceRef !== '') {
    const existing = db.prepare('SELECT * FROM message_list_records WHERE source_ref = ?')
      .get(fields.sourceRef) as Record<string, unknown> | undefined
    if (existing !== undefined) {
      return { ok: true, id: numOf(existing['id']), record: rowToMessageListRecord(existing) }
    }
  }
  const now = Date.now()
  const info = db.prepare(`INSERT INTO message_list_records
    (reply_id, chat_name, target_name, text, images, triggered_at, source, status, note,
     chat_username, target_username, webhook_url, error, attempts, response_summary,
     task_id, trigger_id, source_ref, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, '', 0, '', ?, ?, ?, ?, ?)`).run(
    fields.replyId,
    fields.chatName,
    fields.targetName,
    fields.text,
    JSON.stringify(fields.images),
    fields.triggeredAt,
    fields.source,
    fields.note,
    fields.chatUsername,
    fields.targetUsername,
    fields.webhookUrl,
    fields.taskId ?? null,
    fields.triggerId ?? null,
    fields.sourceRef ?? null,
    now,
    now,
  )
  const id = numOf(info.lastInsertRowid)
  const row = db.prepare('SELECT * FROM message_list_records WHERE id = ?')
    .get(id) as Record<string, unknown> | undefined
  return row === undefined
    ? { ok: false, error: '消息记录写入后无法回读' }
    : { ok: true, id, record: rowToMessageListRecord(row) }
}

/**
 * 插入一条手动消息（写入时按当前规则保存 Webhook 快照）。
 * @param decryptedDir - 解密数据根。
 * @param input - 用户输入。
 * @returns 新记录；无匹配规则时仍成功落库，状态 pending。
 */
export function insertMessageListRecord(
  decryptedDir: string,
  input: MessageListRecordInput,
): MessageListRecordResult {
  const targetName = textOf(input?.targetName, NAME_MAX)
  if (targetName === '') return { ok: false, error: '请填写触发对象' }
  const text = textOf(input?.text, TEXT_MAX)
  const images = sanitizeMessageListImages(input?.images)
  if (text === '' && images.length === 0) return { ok: false, error: '触发文本和图片至少填写一项' }
  const chatName = textOf(input?.chatName, NAME_MAX)
  const chatUsername = textOf(input?.chatUsername, USERNAME_MAX)
  const targetUsername = textOf(input?.targetUsername, USERNAME_MAX)
  const triggeredAt = Math.max(0, numOf(input?.triggeredAt, Date.now())) || Date.now()
  ensureParentDir(decryptedDir)
  try {
    return enrichMessageListResult(decryptedDir, withWritableDb(taskDbPath(decryptedDir), (db) => {
      const rule = matchMessageListRuleAt(db, chatName, targetName)
      return insertRecordAt(db, {
        replyId: textOf(input?.replyId, 200) || generateReplyId(),
        chatName,
        targetName,
        text,
        images,
        triggeredAt,
        source: 'manual',
        note: textOf(input?.note, NOTE_MAX),
        chatUsername,
        targetUsername,
        webhookUrl: rule?.webhookUrl ?? '',
      })
    }))
  } catch (e) {
    return { ok: false, error: '消息记录写入失败：' + errorText(e) }
  }
}

/**
 * 清洗并插入局域网 Webhook 入站记录；来源由服务端强制为 `webhook`。
 * @param decryptedDir - 解密数据根。
 * @param payload - 入站 JSON（兼容 target/message/attachments 别名）。
 * @returns 新记录或可读校验错误。
 */
export function ingestMessageListWebhook(
  decryptedDir: string,
  payload: MessageListWebhookPayload,
): MessageListRecordResult {
  const rawTarget = textOf(payload?.target, NAME_MAX)
  const mention = textOf(payload?.mention, NAME_MAX)
  const explicitChatName = textOf(payload?.chatName ?? payload?.conversationName ?? payload?.chat, NAME_MAX)
  // 兼容两种调用口径：
  // ① 本系统：chatName + target(触发对象)
  // ② 轻羽：target(群名) + mention(群成员)
  const targetName = textOf(payload?.targetName, NAME_MAX) || mention || rawTarget
  if (targetName === '') return { ok: false, error: '缺少 target（触发对象）' }
  const text = textOf(payload?.text ?? payload?.message ?? payload?.content, TEXT_MAX)
  const images = sanitizeMessageListImages(payload?.images ?? payload?.attachments)
  if (text === '' && images.length === 0) return { ok: false, error: 'message 与 attachments 至少提供一项' }
  const chatName = explicitChatName || (mention !== '' ? rawTarget : '')
  const triggeredAt = Math.max(0, numOf(payload?.triggeredAt, Date.now())) || Date.now()
  ensureParentDir(decryptedDir)
  try {
    return enrichMessageListResult(decryptedDir, withWritableDb(taskDbPath(decryptedDir), (db) => {
      const rule = matchMessageListRuleAt(db, chatName, targetName)
      return insertRecordAt(db, {
        replyId: textOf(payload?.replyId, 200) || generateReplyId(),
        chatName,
        targetName,
        text,
        images,
        triggeredAt,
        source: 'webhook',
        note: textOf(payload?.note, NOTE_MAX),
        chatUsername: textOf(payload?.chatUsername, USERNAME_MAX),
        targetUsername: textOf(payload?.targetUsername, USERNAME_MAX),
        webhookUrl: rule?.webhookUrl ?? '',
      })
    }))
  } catch (e) {
    return { ok: false, error: 'Webhook 记录写入失败：' + errorText(e) }
  }
}

export interface TaskGreetingInput {
  taskId: number
  triggerId: number
  taskName: string
  chatName: string
  chatUsername: string
  targetName: string
  targetUsername: string
  images: TaskTriggerImage[]
  triggeredAt: number
}

/**
 * 任务触发成功后，在同一个任务库连接里插入一条问候。
 * `sourceRef` 保证同一任务触发记录最多一条问候。
 */
export function insertTaskTriggerGreeting(
  db: DatabaseSync,
  input: TaskGreetingInput,
): MessageListRecordResult {
  const triggerId = positiveId(input.triggerId)
  const taskId = positiveId(input.taskId)
  if (triggerId <= 0 || taskId <= 0) return { ok: false, error: '任务触发记录无效' }
  const targetName = textOf(input.targetName, NAME_MAX)
  const rule = matchMessageListRuleAt(db, input.chatName, targetName)
  return insertRecordAt(db, {
    replyId: generateReplyId(),
    chatName: textOf(input.chatName, NAME_MAX),
    targetName,
    text: textOf(rule?.greetingText, TEXT_MAX) || '你好',
    images: sanitizeMessageListImages(input.images),
    triggeredAt: Math.max(0, numOf(input.triggeredAt, Date.now())) || Date.now(),
    source: 'first_trigger',
    note: textOf('任务：' + input.taskName, NOTE_MAX),
    chatUsername: textOf(input.chatUsername, USERNAME_MAX),
    targetUsername: textOf(input.targetUsername, USERNAME_MAX),
    webhookUrl: rule?.webhookUrl ?? '',
    taskId,
    triggerId,
    sourceRef: 'task-trigger:' + String(triggerId),
  })
}

/** 删除一条规则；已有记录的地址快照不受影响。 */
export function deleteMessageListRule(decryptedDir: string, id: number): MessageListMutationResult {
  const ruleId = positiveId(id)
  if (ruleId <= 0) return { ok: false, error: '规则不存在' }
  if (!storeExists(decryptedDir)) return { ok: false, error: '规则不存在' }
  try {
    return withWritableDb(taskDbPath(decryptedDir), (db) => {
      ensureMessageListSchema(db)
      const info = db.prepare('DELETE FROM message_list_rules WHERE id = ?').run(ruleId)
      return Number(info.changes) > 0 ? { ok: true, id: ruleId } : { ok: false, error: '规则不存在' }
    })
  } catch (e) {
    return { ok: false, error: '规则删除失败：' + errorText(e) }
  }
}

/**
 * 新建 / 更新规则，并为尚无地址快照的同类 pending 记录补上地址。
 * @param decryptedDir - 解密数据根。
 * @param input - 规则入参；`id` 缺省 = 新建。
 */
export function saveMessageListRule(
  decryptedDir: string,
  input: MessageListRuleInput,
): MessageListMutationResult {
  const webhookUrl = httpUrl(input?.webhookUrl)
  if (webhookUrl === '') return { ok: false, error: 'Webhook 地址必须是合法的 http/https 地址' }
  const chatName = textOf(input?.chatName, NAME_MAX)
  const targetName = textOf(input?.targetName, NAME_MAX)
  const greetingText = textOf(input?.greetingText, TEXT_MAX) || '你好'
  const note = textOf(input?.note, NOTE_MAX)
  const id = positiveId(input?.id)
  ensureParentDir(decryptedDir)
  const now = Date.now()
  try {
    return withWritableDb(taskDbPath(decryptedDir), (db) => {
      ensureMessageListSchema(db)
      let ruleId = id
      if (id > 0) {
        const current = db.prepare('SELECT enabled FROM message_list_rules WHERE id = ?')
          .get(id) as { enabled?: unknown } | undefined
        if (current === undefined) return { ok: false, error: '规则不存在' }
        const enabled = input?.enabled === undefined ? numOf(current.enabled) === 1 : input.enabled !== false
        db.prepare(`UPDATE message_list_rules SET
          chat_name = ?, target_name = ?, webhook_url = ?, greeting_text = ?, note = ?, enabled = ?, updated_at = ?
          WHERE id = ?`).run(chatName, targetName, webhookUrl, greetingText, note, enabled ? 1 : 0, now, id)
      } else {
        const enabled = input?.enabled !== false
        const info = db.prepare(`INSERT INTO message_list_rules
          (chat_name, target_name, webhook_url, greeting_text, note, enabled, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
          chatName, targetName, webhookUrl, greetingText, note, enabled ? 1 : 0, now, now,
        )
        ruleId = numOf(info.lastInsertRowid)
      }
      if (ruleId <= 0) return { ok: false, error: '规则保存后无法确定 id' }
      if (input?.enabled !== false) {
        db.prepare(`UPDATE message_list_records SET webhook_url = ?, updated_at = ?
          WHERE status = 'pending' AND webhook_url = '' AND chat_name = ? AND target_name = ?`)
          .run(webhookUrl, now, chatName, targetName)
      }
      return { ok: true, id: ruleId }
    })
  } catch (e) {
    const raw = errorText(e)
    if (/UNIQUE constraint failed/i.test(raw)) {
      return { ok: false, error: '同一「会话名 + 触发对象」已存在规则，请直接编辑那一条' }
    }
    return { ok: false, error: '规则保存失败：' + raw }
  }
}

/** 投递结果回写（状态、错误、尝试次数、下游返回的回复 id）。 */
export function saveMessageListDispatchResult(
  decryptedDir: string,
  id: number,
  outcome: {
    status: MessageListStatus
    error: string
    responseSummary: string
    replyId?: string
    webhookUrl?: string
    /** 只有真正发出 HTTP 请求时才累加尝试次数。 */
    countAttempt?: boolean
  },
): MessageListRecord | undefined {
  const recordId = positiveId(id)
  if (recordId <= 0 || !storeExists(decryptedDir)) return undefined
  const now = Date.now()
  try {
    return withWritableDb(taskDbPath(decryptedDir), (db) => {
      ensureMessageListSchema(db)
      const current = db.prepare('SELECT attempts, webhook_url, last_attempt_at FROM message_list_records WHERE id = ?')
        .get(recordId) as { attempts?: unknown; webhook_url?: unknown; last_attempt_at?: unknown } | undefined
      if (current === undefined) return undefined
      const replyId = textOf(outcome.replyId, 200)
      if (replyId !== '') {
        db.prepare('UPDATE message_list_records SET reply_id = ? WHERE id = ?').run(replyId, recordId)
      }
      const webhookUrl = httpUrl(outcome.webhookUrl)
      if (webhookUrl !== '') {
        db.prepare('UPDATE message_list_records SET webhook_url = ? WHERE id = ?').run(webhookUrl, recordId)
      }
      db.prepare(`UPDATE message_list_records SET
        status = ?, error = ?, attempts = ?, last_attempt_at = ?,
        response_summary = ?, updated_at = ? WHERE id = ?`).run(
        statusOf(outcome.status),
        textOf(outcome.error, ERROR_MAX),
        Math.max(0, numOf(current.attempts)) + (outcome.countAttempt === false ? 0 : 1),
        outcome.countAttempt === false
          ? (current.last_attempt_at === null || current.last_attempt_at === undefined
              ? null
              : numOf(current.last_attempt_at))
          : now,
        textOf(outcome.responseSummary, RESPONSE_MAX),
        now,
        recordId,
      )
      const row = db.prepare('SELECT * FROM message_list_records WHERE id = ?')
        .get(recordId) as Record<string, unknown> | undefined
      if (row === undefined) return undefined
      const record = rowToMessageListRecord(row)
      enrichMessageListRecords(decryptedDir, [record])
      return record
    })
  } catch {
    return undefined
  }
}

/** 取一批有地址快照的待投递记录 id。 */
export function pendingMessageListRecordIds(decryptedDir: string, limit: number): number[] {
  if (!storeExists(decryptedDir)) return []
  const cap = Math.min(100, Math.max(1, numOf(limit, 20)))
  try {
    return withWritableDb(taskDbPath(decryptedDir), (db) => {
      ensureMessageListSchema(db)
      const rows = db.prepare(`SELECT id FROM message_list_records
        WHERE status = 'pending' AND webhook_url <> ''
        ORDER BY triggered_at ASC, id ASC LIMIT ?`).all(cap) as Array<{ id?: unknown }>
      return rows.map((row) => numOf(row.id)).filter((id) => id > 0)
    })
  } catch {
    return []
  }
}
