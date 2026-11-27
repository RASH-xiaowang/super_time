/**
 * 消息记录查询、通用落库、Webhook 入站、任务问候与批量删除。
 */
import { createHash } from 'node:crypto'
import { withWritableDb } from './db-open.ts'
import type { DatabaseSync } from './db-open.ts'
import { storeExists, taskDbPath } from './task-db.ts'
import {
  cleanupStagedAttachments,
  validateMessageListImages,
} from './message-list-attachments.ts'
import type {
  MessageListBatchDeleteResult,
  MessageListImage,
  MessageListQuery,
  MessageListRecord,
  MessageListRecordInput,
  MessageListRecordResult,
  MessageListSnapshot,
  MessageListSource,
  MessageListWebhookPayload,
} from '../types.ts'
import {
  CURSOR_VERSION,
  ERROR_MAX,
  MESSAGE_LIST_QUERY_MAX,
  NAME_MAX,
  NOTE_MAX,
  QUERY_DEFAULT,
  SOURCE_REF_MAX,
  TEXT_MAX,
  USERNAME_MAX,
  WEBHOOK_MAX,
  ensureParentDir,
  errorText,
  generateReplyId,
  numOf,
  positiveId,
  statusOf,
  textOf,
} from './message-list-store-shared.ts'
import {
  canonicalizeMessageListRecord,
  enrichMessageListRecords,
  enrichMessageListResult,
  ensureMessageListSchema,
  parseImages,
  rowToMessageListRecord,
} from './message-list-store-schema.ts'
import { matchMessageListRuleAt } from './message-list-store-rules.ts'
import { featherRecordCapacityError } from './ai-reply/provider.ts'
import { canonicalChatReference, isMessageTableHash } from './message-identity.ts'

export interface MessageListRecordCursor {
  triggeredAt: number
  id: number
}

/** 复合游标使用不透明字符串，前端只原样回传，不拼时间/id。 */
export function encodeMessageListCursor(cursor: MessageListRecordCursor): string {
  const triggeredAt = Math.max(0, Math.trunc(cursor.triggeredAt))
  const id = Math.max(0, Math.trunc(cursor.id))
  return Buffer.from(CURSOR_VERSION + ':' + String(triggeredAt) + ':' + String(id), 'utf8')
    .toString('base64url')
}

/** 解析续页游标；非法游标必须返回错误，不能静默退回第一页造成重复。 */
export function decodeMessageListCursor(raw: unknown): MessageListRecordCursor | undefined {
  if (typeof raw !== 'string' || raw === '' || raw.length > 128) return undefined
  try {
    const text = Buffer.from(raw, 'base64url').toString('utf8')
    const match = new RegExp('^' + CURSOR_VERSION + ':(\\d{1,16}):(\\d{1,16})$').exec(text)
    if (match === null) return undefined
    const triggeredAt = Number(match[1])
    const id = Number(match[2])
    if (!Number.isSafeInteger(triggeredAt) || triggeredAt < 0) return undefined
    if (!Number.isSafeInteger(id) || id <= 0) return undefined
    return { triggeredAt, id }
  } catch {
    return undefined
  }
}

function whereRecords(
  query: MessageListQuery,
  cursor?: MessageListRecordCursor,
  ids?: readonly number[],
): { sql: string; params: Array<string | number> } {
  const clauses: string[] = []
  const params: Array<string | number> = []
  const status = statusOf(query.status)
  if (query.status === 'success' || query.status === 'failed' || query.status === 'pending'
    || query.status === 'dispatching' || query.status === 'queued' || query.status === 'running'
    || query.status === 'sent_unconfirmed') {
    clauses.push('status = ?')
    params.push(status)
  }
  if (query.source === 'first_trigger' || query.source === 'webhook' || query.source === 'manual' || query.source === 'ai_reply') {
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
  if (ids !== undefined) {
    clauses.push('id IN (' + ids.map(() => '?').join(',') + ')')
    params.push(...ids)
  }
  if (cursor !== undefined) {
    // 行值比较与原来的 OR 等价，但 SQLite 能把它变成顺序索引上的范围 seek，
    // 十万级数据以下每次翻页不再从最新记录开始扫描整段。
    clauses.push('(triggered_at, id) < (?, ?)')
    params.push(cursor.triggeredAt, cursor.id)
  }
  return { sql: clauses.length > 0 ? ' WHERE ' + clauses.join(' AND ') : '', params }
}

/** 消息记录快照（默认 200 条，最新在前；超出单页上限时显式标记 truncated）。 */
export function listMessageListRecords(
  decryptedDir: string,
  query: MessageListQuery = {},
): MessageListSnapshot {
  const empty = { items: [], total: 0, hasMore: false, truncated: false }
  if (!storeExists(decryptedDir)) return empty
  const idsMode = query.ids !== undefined
  let ids: number[] = []
  if (idsMode) {
    if (!Array.isArray(query.ids)) {
      return { ...empty, readError: '消息列表记录 id 必须是数组' }
    }
    if (query.ids.length > MESSAGE_LIST_QUERY_MAX) {
      return {
        ...empty,
        readError: '消息列表单次最多刷新 ' + String(MESSAGE_LIST_QUERY_MAX) + ' 条记录',
      }
    }
    if (query.ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
      return { ...empty, readError: '消息列表记录 id 必须是正整数' }
    }
    ids = [...new Set(query.ids)]
    if (ids.length === 0) return empty
  }
  const requestedLimit = numOf(query.limit, QUERY_DEFAULT)
  const limit = idsMode
    ? ids.length
    : Math.min(MESSAGE_LIST_QUERY_MAX, Math.max(1, requestedLimit))
  const truncated = !idsMode && requestedLimit > MESSAGE_LIST_QUERY_MAX
  const cursorText = typeof query.cursor === 'string' ? query.cursor.trim() : ''
  if (idsMode && cursorText !== '') {
    return { ...empty, readError: '消息列表指定 id 刷新不支持分页游标' }
  }
  const cursor = cursorText === '' ? undefined : decodeMessageListCursor(cursorText)
  if (cursorText !== '' && cursor === undefined) {
    return {
      ...empty,
      truncated,
      readError: '消息列表分页游标无效，请刷新后重试',
    }
  }
  const baseWhere = whereRecords(query)
  const pageWhere = whereRecords(query, cursor, idsMode ? ids : undefined)
  try {
    return withWritableDb(taskDbPath(decryptedDir), (db) => {
      ensureMessageListSchema(db)
      const totalRow = db.prepare('SELECT COUNT(*) AS n FROM message_list_records' + baseWhere.sql)
        .get(...baseWhere.params) as { n?: unknown } | undefined
      const rows = db.prepare(
        'SELECT * FROM message_list_records' + pageWhere.sql
          + ' ORDER BY triggered_at DESC, id DESC LIMIT ?',
      ).all(...pageWhere.params, limit + 1) as Array<Record<string, unknown>>
      const hasMore = rows.length > limit
      const items = rows.slice(0, limit).map(rowToMessageListRecord)
      enrichMessageListRecords(decryptedDir, items)
      const last = items[items.length - 1]
      const nextCursor = hasMore && last !== undefined
        ? encodeMessageListCursor({ triggeredAt: last.triggeredAt, id: last.id })
        : undefined
      return {
        items,
        total: numOf(totalRow?.n),
        hasMore,
        truncated,
        ...(nextCursor === undefined ? {} : { nextCursor }),
      }
    })
  } catch (e) {
    return {
      ...empty,
      truncated,
      readError: '消息列表读取失败：' + errorText(e),
    }
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

/** 当前消息记录仍引用的本机暂存附件 id，用于安全清理 spool。 */
export function referencedStagedAttachmentIds(decryptedDir: string): Set<string> | undefined {
  const out = new Set<string>()
  if (!storeExists(decryptedDir)) return out
  try {
    return withWritableDb(taskDbPath(decryptedDir), (db) => {
      ensureMessageListSchema(db)
      const rows = db.prepare("SELECT images FROM message_list_records WHERE images LIKE '%stagedId%'").all() as Array<{ images?: unknown }>
      for (const row of rows) {
        for (const image of parseImages(row.images)) {
          if (image.stagedId !== undefined) out.add(image.stagedId)
        }
      }
      return out
    })
  } catch {
    // 读不到引用时不得清理；undefined 与“确实没有引用”必须区分。
    return undefined
  }
}

/**
 * 清理本机附件 spool。默认调用必须由本机桌面端触发；不带记录引用的
 * 40 位文件名超过 7 天后才会被删除。
 */
export async function cleanupMessageListAttachmentSpool(
  decryptedDir: string,
  now = Date.now(),
): Promise<{ removed: number; failed: number }> {
  const referenced = referencedStagedAttachmentIds(decryptedDir)
  if (referenced === undefined) return { removed: 0, failed: 1 }
  return cleanupStagedAttachments(decryptedDir, referenced, now)
}

export interface InsertRecordFields {
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
  segmentGroupRef?: string
  segmentIndex?: number
  segmentCount?: number
}

export function insertRecordAt(
  decryptedDir: string,
  db: DatabaseSync,
  fields: InsertRecordFields,
  now = Date.now(),
): MessageListRecordResult {
  ensureMessageListSchema(db)
  const recordOfRow = (row: Record<string, unknown>): MessageListRecord => {
    const record = rowToMessageListRecord(row)
    canonicalizeMessageListRecord(decryptedDir, record)
    return record
  }
  const chat = canonicalChatReference(decryptedDir, fields.chatUsername, '会话')
  if (chat.error !== undefined) return { ok: false, error: chat.error }
  const target = canonicalChatReference(decryptedDir, fields.targetUsername, '触发对象')
  if (target.error !== undefined) return { ok: false, error: target.error }
  const normalizedFields: InsertRecordFields = {
    ...fields,
    chatUsername: chat.username,
    targetUsername: target.username,
    chatName: fields.chatName === '' || isMessageTableHash(fields.chatName)
      ? chat.displayName
      : fields.chatName,
  }
  if (fields.sourceRef !== undefined && fields.sourceRef !== '') {
    const existing = db.prepare('SELECT * FROM message_list_records WHERE source_ref = ?')
      .get(fields.sourceRef) as Record<string, unknown> | undefined
    if (existing !== undefined) {
      return { ok: true, id: numOf(existing['id']), record: recordOfRow(existing), created: false }
    }
  }
  const capacityError = featherRecordCapacityError(normalizedFields, normalizedFields.webhookUrl)
  if (capacityError !== undefined) return { ok: false, error: capacityError }
  const at = Number.isFinite(now) ? Math.trunc(now) : Date.now()
  let info
  try {
    info = db.prepare(`INSERT INTO message_list_records
      (reply_id, chat_name, target_name, text, images, triggered_at, source, status, note,
       chat_username, target_username, webhook_url, error, attempts, response_summary,
       task_id, trigger_id, source_ref, segment_group_ref, segment_index, segment_count,
       created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, '', 0, '', ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      normalizedFields.replyId,
      normalizedFields.chatName,
      normalizedFields.targetName,
      normalizedFields.text,
      JSON.stringify(normalizedFields.images),
      normalizedFields.triggeredAt,
      normalizedFields.source,
      normalizedFields.note,
      normalizedFields.chatUsername,
      normalizedFields.targetUsername,
      normalizedFields.webhookUrl,
      normalizedFields.taskId ?? null,
      normalizedFields.triggerId ?? null,
      normalizedFields.sourceRef ?? null,
      normalizedFields.segmentGroupRef ?? '',
      normalizedFields.segmentIndex ?? 0,
      normalizedFields.segmentCount ?? 0,
      at,
      at,
    )
  } catch (e) {
    if (fields.sourceRef !== undefined && fields.sourceRef !== '' && /UNIQUE constraint failed/i.test(errorText(e))) {
      const existing = db.prepare('SELECT * FROM message_list_records WHERE source_ref = ?')
        .get(fields.sourceRef) as Record<string, unknown> | undefined
      if (existing !== undefined) {
        return { ok: true, id: numOf(existing['id']), record: recordOfRow(existing), created: false }
      }
    }
    throw e
  }
  const id = numOf(info.lastInsertRowid)
  const row = db.prepare('SELECT * FROM message_list_records WHERE id = ?')
    .get(id) as Record<string, unknown> | undefined
  return row === undefined
    ? { ok: false, error: '消息记录写入后无法回读' }
    : { ok: true, id, record: recordOfRow(row), created: true }
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
  const validatedImages = validateMessageListImages(input?.images, { mode: 'local' })
  if (!validatedImages.ok) return { ok: false, error: validatedImages.error }
  const images = validatedImages.images
  if (text === '' && images.length === 0) return { ok: false, error: '触发文本和图片至少填写一项' }
  const chatName = textOf(input?.chatName, NAME_MAX)
  const chatUsername = textOf(input?.chatUsername, USERNAME_MAX)
  const targetUsername = textOf(input?.targetUsername, USERNAME_MAX)
  const triggeredAt = Math.max(0, numOf(input?.triggeredAt, Date.now())) || Date.now()
  ensureParentDir(decryptedDir)
  try {
    return enrichMessageListResult(decryptedDir, withWritableDb(taskDbPath(decryptedDir), (db) => {
      const rule = matchMessageListRuleAt(db, chatName, targetName)
      return insertRecordAt(decryptedDir, db, {
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
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, error: 'Webhook 请求体必须是 JSON 对象' }
  }
  const rawTarget = textOf(payload?.target, NAME_MAX)
  const mention = textOf(payload?.mention, NAME_MAX)
  const explicitChatName = textOf(payload?.chatName ?? payload?.conversationName ?? payload?.chat, NAME_MAX)
  // 兼容两种调用口径：
  // ① 本系统：chatName + target(触发对象)
  // ② 轻羽：target(群名) + mention(群成员)
  const targetName = textOf(payload?.targetName, NAME_MAX) || mention || rawTarget
  if (targetName === '') return { ok: false, error: '缺少 target（触发对象）' }
  const text = textOf(payload?.text ?? payload?.message ?? payload?.content, TEXT_MAX)
  const hasImages = Object.prototype.hasOwnProperty.call(payload, 'images')
  const hasAttachments = Object.prototype.hasOwnProperty.call(payload, 'attachments')
  if (hasImages && hasAttachments) {
    return { ok: false, error: 'images 与 attachments 只能提供一个' }
  }
  // 入站请求只能传远端 URL 或图片 data URL。localId 会读取本机微信数据，
  // stagedId 会读取本机 spool，两者都不能由局域网调用方指定。
  const validatedImages = validateMessageListImages(
    hasImages ? payload.images : payload.attachments,
    { mode: 'webhook' },
  )
  if (!validatedImages.ok) return { ok: false, error: validatedImages.error }
  const images = validatedImages.images
  if (text === '' && images.length === 0) return { ok: false, error: 'message 与 attachments 至少提供一项' }
  const chatName = explicitChatName || (mention !== '' ? rawTarget : '')
  const clientReplyId = textOf(payload?.replyId, 160)
  const clientIdempotencyKey = textOf(payload?.idempotencyKey ?? payload?.sourceRef, 200)
  const replayKey = clientReplyId || clientIdempotencyKey
  const suppliedTriggeredAt = numOf(payload?.triggeredAt, 0)
  const triggeredAt = suppliedTriggeredAt > 0 ? suppliedTriggeredAt : Date.now()
  const clientSourceRef = replayKey === ''
    ? undefined
    : 'webhook:' + createHash('sha256')
      .update(chatName + '\u0000' + targetName + '\u0000' + replayKey, 'utf8')
      .digest('hex')
      .slice(0, 32)
  // 仅在调用方显式给出正数 triggeredAt 时启用内容回退键。时间戳是正常同文消息的
  // 区分边界；未提供时保持历史行为，避免把旧客户端连续发送的相同正文误合并。
  const fallbackSourceRef = replayKey === '' && suppliedTriggeredAt > 0
    ? 'webhook-payload:' + createHash('sha256')
      .update(JSON.stringify({
        chatName,
        targetName,
        text,
        images,
        triggeredAt,
      }), 'utf8')
      .digest('hex')
      .slice(0, 32)
    : undefined
  const sourceRef = clientSourceRef ?? fallbackSourceRef
  ensureParentDir(decryptedDir)
  try {
    return enrichMessageListResult(decryptedDir, withWritableDb(taskDbPath(decryptedDir), (db) => {
      const rule = matchMessageListRuleAt(db, chatName, targetName)
      return insertRecordAt(decryptedDir, db, {
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
        ...(sourceRef === undefined ? {} : { sourceRef }),
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
  images: MessageListImage[]
  triggeredAt: number
  /** 任务上配置的问候语。空串不写入。 */
  greetingText: string
}

/**
 * 任务触发成功后，在同一个任务库连接里插入一条问候。
 * `sourceRef` 保证同一任务触发记录最多一条问候。
 */
export function insertTaskTriggerGreeting(
  decryptedDir: string,
  db: DatabaseSync,
  input: TaskGreetingInput,
): MessageListRecordResult {
  const triggerId = positiveId(input.triggerId)
  const taskId = positiveId(input.taskId)
  if (triggerId <= 0 || taskId <= 0) return { ok: false, error: '任务触发记录无效' }
  const greetingText = textOf(input.greetingText, TEXT_MAX)
  if (greetingText === '') return { ok: false, error: '未配置问候语' }
  const targetName = textOf(input.targetName, NAME_MAX)
  const rule = matchMessageListRuleAt(db, input.chatName, targetName)
  const validatedImages = validateMessageListImages(input.images, { mode: 'local' })
  if (!validatedImages.ok) return { ok: false, error: validatedImages.error }
  return insertRecordAt(decryptedDir, db, {
    replyId: generateReplyId(),
    chatName: textOf(input.chatName, NAME_MAX),
    targetName,
    text: greetingText,
    images: validatedImages.images,
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

/**
 * 按 id 批量删除消息记录。
 *
 * 整个批次在同一事务内完成；`dispatching` 记录会被跳过，避免删除后投递线程
 * 仍继续出网。ID 会先去重，返回结果保持调用方给出的顺序。
 */
export function deleteMessageListRecords(
  decryptedDir: string,
  rawIds: readonly number[],
): MessageListBatchDeleteResult {
  const invalid = !Array.isArray(rawIds)
    || rawIds.some((id) => !Number.isSafeInteger(Number(id)) || Number(id) <= 0)
  if (invalid) {
    return {
      ok: false,
      requested: 0,
      removed: 0,
      skipped: 0,
      items: [],
      error: '批量删除的记录 id 无效',
    }
  }
  const ids = [...new Set(rawIds.map((id) => Number(id)))]
  if (ids.length === 0) {
    return {
      ok: false,
      requested: 0,
      removed: 0,
      skipped: 0,
      items: [],
      error: '请至少选择一条记录',
    }
  }

  const result: MessageListBatchDeleteResult = {
    ok: true,
    requested: ids.length,
    removed: 0,
    skipped: 0,
    items: [],
  }
  if (!storeExists(decryptedDir)) {
    result.skipped = ids.length
    result.items = ids.map((id) => ({ id, status: 'skipped', error: '消息记录不存在' }))
    return result
  }

  try {
    return withWritableDb(taskDbPath(decryptedDir), (db) => {
      ensureMessageListSchema(db)
      db.exec('BEGIN IMMEDIATE')
      try {
        // AI 回复记录不走通用批删：空白预约可能正在生成，有正文的记录是已付费
        // 模型产出。它们只能通过 AI 专用删除/清理入口处理，避免误删已付费结果。
        const remove = db.prepare(`DELETE FROM message_list_records
          WHERE id = ? AND source <> 'ai_reply'
            AND status NOT IN ('dispatching', 'queued', 'running')`)
        const status = db.prepare('SELECT status, source FROM message_list_records WHERE id = ?')
        for (const id of ids) {
          const info = remove.run(id)
          if (Number(info.changes) > 0) {
            result.removed += 1
            result.items.push({ id, status: 'removed' })
            continue
          }
          const row = status.get(id) as { status?: unknown; source?: unknown } | undefined
          result.skipped += 1
          result.items.push({
            id,
            status: 'skipped',
            error: row === undefined
              ? '消息记录不存在'
              : row.source === 'ai_reply'
                ? 'AI 回复记录请使用 AI 专用删除/清理'
                : row.status === 'dispatching'
                  ? '记录正在投递，不能删除'
                  : row.status === 'queued' || row.status === 'running'
                    ? '下游异步任务尚未结束，不能删除'
                    : '记录状态不允许删除',
          })
        }
        db.exec('COMMIT')
        return result
      } catch (e) {
        try {
          db.exec('ROLLBACK')
        } catch {
          // 原始错误更有用；回滚失败时仍交给外层统一报错。
        }
        throw e
      }
    })
  } catch (e) {
    return {
      ok: false,
      requested: ids.length,
      removed: 0,
      skipped: 0,
      items: [],
      error: '消息记录删除失败：' + errorText(e),
    }
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
          AND COALESCE(source_ref, '') NOT LIKE 'clawbot:%'
          AND NOT (source = 'ai_reply' AND segment_group_ref <> '')
          AND (trim(text) <> '' OR (images <> '[]' AND images <> ''))
        ORDER BY triggered_at ASC, id ASC LIMIT ?`).all(cap) as Array<{ id?: unknown }>
      return rows.map((row) => numOf(row.id)).filter((id) => id > 0)
    })
  } catch {
    return []
  }
}
