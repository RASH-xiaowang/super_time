/**
 * AI 回复记录的预约、补全、失败收口与孤儿扫描。
 */
import { withWritableDb } from './db-open.ts'
import type { DatabaseSync } from './db-open.ts'
import { storeExists, taskDbPath } from './task-db.ts'
import type {
  AiReplyMessageListCompleteInput,
  AiReplyMessageListInput,
  AiReplyMessageListReserveInput,
  MessageListRecordResult,
} from '../types.ts'
import type {
  ChatAiReplySegmentSnapshot,
  ChatAiReplySegmentsResult,
} from './ai-reply/types.ts'
import {
  CHAT_AI_REPLY_MAX_SEGMENTS,
  chatAiReplySegmentSourceRef,
  parseChatAiReplySourceRef,
} from './ai-reply/segments.ts'
import {
  ERROR_MAX,
  FEATHER_MESSAGE_MAX_UTF16,
  NAME_MAX,
  NOTE_MAX,
  SOURCE_REF_MAX,
  TEXT_MAX,
  USERNAME_MAX,
  ensureParentDir,
  errorText,
  failureKindOf,
  generateReplyId,
  numOf,
  positiveId,
  textOf,
} from './message-list-store-shared.ts'
import {
  canonicalizeMessageListRecord,
  enrichMessageListResult,
  ensureMessageListSchema,
  rowToMessageListRecord,
} from './message-list-store-schema.ts'
import { matchMessageListRuleAt } from './message-list-store-rules.ts'
import { insertRecordAt } from './message-list-store-records.ts'
import {
  featherRecordCapacityError,
  featherTextCapacityError,
} from './ai-reply/provider.ts'
import { pruneOrphanChatAiReplyTraces } from './ai-reply/trace-store.ts'
import { canonicalChatReference } from './message-identity.ts'

function aiReplyRuleScope(decryptedDir: string, sourceRef: string | undefined): {
  accountKey: string
  chatUsername: string
} {
  const parsed = parseChatAiReplySourceRef(sourceRef)
  return parsed === null
    ? { accountKey: '', chatUsername: '' }
    : {
      accountKey: parsed.accountKey,
      chatUsername: canonicalChatReference(
        decryptedDir,
        parsed.chatUsername,
        'AI 回复会话',
      ).username,
    }
}

interface SegmentRowSnapshot {
  segment: ChatAiReplySegmentSnapshot
  groupRef: string
  declaredCount: number
}

function segmentRowSnapshotOf(row: Record<string, unknown>): SegmentRowSnapshot | undefined {
  const record = rowToMessageListRecord(row)
  const parsed = parseChatAiReplySourceRef(record.sourceRef)
  if (record.source !== 'ai_reply' || parsed === null) return undefined
  const index = record.segmentIndex ?? parsed.segmentIndex
  const count = record.segmentCount ?? 1
  if (index <= 0 || count < index) return undefined
  return {
    segment: {
      id: record.id,
      segmentIndex: index,
      segmentCount: count,
      status: record.status,
      text: record.text,
      sourceRef: record.sourceRef ?? '',
      ...(record.error === '' ? {} : { error: record.error }),
      imageCount: record.images.length,
      ...(record.jobId === undefined ? {} : { jobId: record.jobId }),
      attempts: record.attempts,
      ...(record.failureKind === undefined ? {} : { failureKind: record.failureKind }),
    },
    groupRef: record.segmentGroupRef ?? '',
    declaredCount: record.segmentCount ?? 0,
  }
}

function readSegmentRowsAt(
  db: DatabaseSync,
  baseSourceRef: string,
): SegmentRowSnapshot[] {
  const prefix = baseSourceRef + ':segment:'
  const rows = db.prepare(`SELECT * FROM message_list_records
    WHERE source = 'ai_reply'
      AND (source_ref = ? OR segment_group_ref = ? OR instr(source_ref, ?) = 1)
    ORDER BY id ASC`).all(
    baseSourceRef,
    baseSourceRef,
    prefix,
  ) as Array<Record<string, unknown>>
  return rows.flatMap((row) => {
    const snapshot = segmentRowSnapshotOf(row)
    return snapshot === undefined ? [] : [snapshot]
  }).sort((a, b) => a.segment.segmentIndex - b.segment.segmentIndex)
}

function readSegmentsAt(
  db: DatabaseSync,
  baseSourceRef: string,
): ChatAiReplySegmentSnapshot[] {
  return readSegmentRowsAt(db, baseSourceRef).map((row) => row.segment)
}

/**
 * 写入一条 AI 回复。来源固定为 ai_reply，幂等键由调用方提供。
 * 该函数只负责落库；投递必须由消息列表 dispatch 完成。
 */
export function insertAiReplyMessageListRecord(
  decryptedDir: string,
  input: AiReplyMessageListInput,
): MessageListRecordResult {
  const targetName = textOf(input?.targetName, NAME_MAX)
  const text = textOf(input?.text, TEXT_MAX)
  const sourceRef = textOf(input?.sourceRef, SOURCE_REF_MAX)
  if (targetName === '') return { ok: false, error: '缺少发送目标' }
  if (text === '') return { ok: false, error: 'AI 回复为空，未写入消息列表' }
  if (sourceRef === '') return { ok: false, error: '缺少 AI 回复幂等键' }
  const textCapacityError = featherTextCapacityError(text, 'message 正文', 'message')
  if (textCapacityError !== undefined) return { ok: false, error: textCapacityError }
  const chatName = textOf(input?.chatName, NAME_MAX)
  ensureParentDir(decryptedDir)
  try {
    return enrichMessageListResult(decryptedDir, withWritableDb(taskDbPath(decryptedDir), (db) => {
      const rule = matchMessageListRuleAt(db, chatName, targetName)
      return insertRecordAt(decryptedDir, db, {
        replyId: generateReplyId(),
        chatName,
        targetName,
        text,
        images: [],
        triggeredAt: Math.max(0, numOf(input?.triggeredAt, Date.now())) || Date.now(),
        source: 'ai_reply',
        note: textOf(input?.note, NOTE_MAX),
        chatUsername: textOf(input?.chatUsername, USERNAME_MAX),
        targetUsername: textOf(input?.targetUsername, USERNAME_MAX),
        webhookUrl: rule?.webhookUrl ?? '',
        sourceRef,
      })
    }))
  } catch (e) {
    const raw = errorText(e)
    if (/UNIQUE constraint failed/i.test(raw)) {
      try {
        const existing = withWritableDb(taskDbPath(decryptedDir), (db) => {
          ensureMessageListSchema(db)
          const row = db.prepare('SELECT * FROM message_list_records WHERE source_ref = ?')
            .get(sourceRef) as Record<string, unknown> | undefined
          return row === undefined ? undefined : rowToMessageListRecord(row)
        })
        if (existing !== undefined) return { ok: true, id: existing.id, record: existing, created: false }
      } catch {
        // 下面返回原始写入错误。
      }
    }
    return { ok: false, error: 'AI 回复写入消息列表失败：' + raw }
  }
}

/**
 * 为一次 AI 回复先建立 pending 预约记录。
 *
 * 预约正文为空且不保存 Webhook 地址，因此不会被 `pendingMessageListRecordIds`
 * 自动领取。生成成功后必须再调用 `completeAiReplyMessageListRecord`。
 */
export function reserveAiReplyMessageListRecord(
  decryptedDir: string,
  input: AiReplyMessageListReserveInput,
): MessageListRecordResult {
  const targetName = textOf(input?.targetName, NAME_MAX)
  const sourceRef = textOf(input?.sourceRef, SOURCE_REF_MAX)
  if (targetName === '') return { ok: false, error: '缺少 AI 回复发送目标' }
  if (sourceRef === '') return { ok: false, error: '缺少 AI 回复幂等键' }
  ensureParentDir(decryptedDir)
  try {
    return enrichMessageListResult(decryptedDir, withWritableDb(taskDbPath(decryptedDir), (db) => (
      insertRecordAt(decryptedDir, db, {
        replyId: generateReplyId(),
        chatName: textOf(input?.chatName, NAME_MAX),
        targetName,
        text: '',
        images: [],
        triggeredAt: Math.max(0, numOf(input?.triggeredAt, Date.now())) || Date.now(),
        source: 'ai_reply',
        note: textOf(input?.note, NOTE_MAX) || 'AI 回复 · 生成中',
        chatUsername: textOf(input?.chatUsername, USERNAME_MAX),
        targetUsername: textOf(input?.targetUsername, USERNAME_MAX),
        webhookUrl: '',
        sourceRef,
      })
    )))
  } catch (e) {
    const raw = errorText(e)
    if (/UNIQUE constraint failed/i.test(raw)) {
      try {
        const existing = withWritableDb(taskDbPath(decryptedDir), (db) => {
          ensureMessageListSchema(db)
          const row = db.prepare('SELECT * FROM message_list_records WHERE source_ref = ?')
            .get(sourceRef) as Record<string, unknown> | undefined
          return row === undefined ? undefined : rowToMessageListRecord(row)
        })
        if (existing !== undefined) {
          return enrichMessageListResult(decryptedDir, {
            ok: true,
            id: existing.id,
            record: existing,
            created: false,
          })
        }
      } catch {
        // 下面返回原始写入错误。
      }
    }
    return { ok: false, error: 'AI 回复预约写入消息列表失败：' + raw }
  }
}

/**
 * 生成成功后补全预约记录。只有空正文的 pending AI 预约可以被完成，
 * 防止迟到任务覆盖已经生成或已经投递的记录。Webhook 地址仍由投递入口在
 * 原子认领时写入，避免 pending 记录提前被后台批次选中。
 */
export function completeAiReplyMessageListRecord(
  decryptedDir: string,
  id: number,
  input: AiReplyMessageListCompleteInput,
): MessageListRecordResult {
  const recordId = positiveId(id)
  const text = textOf(input?.text, TEXT_MAX)
  if (recordId <= 0) return { ok: false, error: 'AI 回复记录 id 无效' }
  if (text === '') return { ok: false, error: 'AI 回复为空，未写入消息列表' }
  const textCapacityError = featherTextCapacityError(text, 'message 正文', 'message')
  if (textCapacityError !== undefined) return { ok: false, error: textCapacityError }
  if (!storeExists(decryptedDir)) return { ok: false, error: 'AI 回复预约记录不存在' }
  try {
    return enrichMessageListResult(decryptedDir, withWritableDb(taskDbPath(decryptedDir), (db) => {
      ensureMessageListSchema(db)
      const row = db.prepare('SELECT * FROM message_list_records WHERE id = ?')
        .get(recordId) as Record<string, unknown> | undefined
      if (row === undefined) return { ok: false, error: 'AI 回复预约记录不存在' }
      const current = rowToMessageListRecord(row)
      canonicalizeMessageListRecord(decryptedDir, current)
      if (current.source !== 'ai_reply') {
        return { ok: false, id: recordId, record: current, error: '目标记录不是 AI 回复来源' }
      }
      if (current.status !== 'pending' || current.text !== '') {
        return { ok: false, id: recordId, record: current, error: 'AI 回复记录状态已变化，拒绝覆盖' }
      }
      const webhookUrl = current.webhookUrl
        || matchMessageListRuleAt(
          db,
          current.chatName,
          current.targetName,
          aiReplyRuleScope(decryptedDir, current.sourceRef),
        )?.webhookUrl
        || ''
      const recordCapacityError = featherRecordCapacityError({ ...current, text }, webhookUrl)
      if (recordCapacityError !== undefined) {
        return { ok: false, id: recordId, record: current, error: recordCapacityError }
      }
      const now = Date.now()
      const info = db.prepare(`UPDATE message_list_records SET
        text = ?, note = ?, error = '', updated_at = ?
        WHERE id = ? AND source = 'ai_reply' AND status = 'pending' AND text = ''`).run(
        text,
        textOf(input?.note, NOTE_MAX) || 'AI 回复 · 自动生成',
        now,
        recordId,
      )
      const updated = db.prepare('SELECT * FROM message_list_records WHERE id = ?')
        .get(recordId) as Record<string, unknown> | undefined
      if (Number(info.changes) <= 0 || updated === undefined) {
        return {
          ok: false,
          id: recordId,
          ...(updated === undefined ? {} : { record: rowToMessageListRecord(updated) }),
          error: 'AI 回复记录状态已变化，拒绝覆盖',
        }
      }
      return {
        ok: true,
        id: recordId,
        record: rowToMessageListRecord(updated),
        created: false,
      }
    }))
  } catch (e) {
    return { ok: false, id: recordId, error: 'AI 回复补全消息列表失败：' + errorText(e) }
  }
}

/**
 * 原子补全一个 AI 回复分组。
 *
 * 第一段复用预约记录，后续段在同一事务中插入；任一段写入失败都会回滚，
 * 不会留下“后半段凭空多出来”的半成品。重复调用按 sourceRef/段序号幂等。
 */
export function completeAiReplyMessageListRecordSegments(
  decryptedDir: string,
  id: number,
  input: {
    segments: string[]
    note?: string
  },
): ChatAiReplySegmentsResult {
  const recordId = positiveId(id)
  if (recordId <= 0) return { ok: false, error: 'AI 回复记录 id 无效' }
  if (!Array.isArray(input?.segments) || input.segments.length === 0) {
    return { ok: false, error: 'AI 回复分段为空' }
  }
  if (input.segments.length > CHAT_AI_REPLY_MAX_SEGMENTS) {
    return {
      ok: false,
      error: 'AI 回复超过 ' + String(CHAT_AI_REPLY_MAX_SEGMENTS) + ' 段，已拒绝写入',
    }
  }
  if (input.segments.some((segment) =>
    typeof segment !== 'string' || segment.length > FEATHER_MESSAGE_MAX_UTF16)) {
    return {
      ok: false,
      error: 'AI 回复包含超长分段，已拒绝写入；每段最多 '
        + String(FEATHER_MESSAGE_MAX_UTF16) + ' 个 UTF-16 单元',
    }
  }
  const segments = input.segments.map((segment) => textOf(segment, FEATHER_MESSAGE_MAX_UTF16))
  if (segments.some((segment) => segment === '')) {
    return { ok: false, error: 'AI 回复包含空分段，未写入消息列表' }
  }
  if (!storeExists(decryptedDir)) return { ok: false, error: 'AI 回复预约记录不存在' }
  const note = textOf(input?.note, NOTE_MAX) || 'AI 回复 · 自动生成'

  try {
    return withWritableDb(taskDbPath(decryptedDir), (db) => {
      ensureMessageListSchema(db)
      db.exec('BEGIN IMMEDIATE')
      try {
        const row = db.prepare('SELECT * FROM message_list_records WHERE id = ?')
          .get(recordId) as Record<string, unknown> | undefined
        if (row === undefined) throw new Error('AI 回复预约记录不存在')
        const current = rowToMessageListRecord(row)
        canonicalizeMessageListRecord(decryptedDir, current)
        if (current.source !== 'ai_reply') throw new Error('目标记录不是 AI 回复来源')
        const parsed = parseChatAiReplySourceRef(current.sourceRef)
        if (parsed === null || parsed.segmentIndex !== 1) {
          throw new Error('AI 回复预约的 sourceRef 无效')
        }
        const baseSourceRef = parsed.baseSourceRef
        const existingRows = readSegmentRowsAt(db, baseSourceRef)
        const byIndex = new Map<number, SegmentRowSnapshot>()
        for (const row of existingRows) {
          const index = row.segment.segmentIndex
          if (index > segments.length) {
            throw new Error('AI 回复分组已存在更多分段，拒绝覆盖')
          }
          if (row.groupRef !== '' && row.groupRef !== baseSourceRef) {
            throw new Error('AI 回复分段不属于当前分组，拒绝覆盖')
          }
          if (row.groupRef !== ''
            && row.declaredCount > 0
            && row.declaredCount !== segments.length) {
            throw new Error('AI 回复分组已存在且段数不一致，拒绝覆盖')
          }
          const expected = segments[index - 1]
          if (row.segment.text !== '' && row.segment.text !== expected) {
            throw new Error('AI 回复第 ' + String(index) + ' 段已存在不同正文')
          }
          byIndex.set(index, row)
        }
        const complete = segments.every((text, index) =>
          byIndex.get(index + 1)?.segment.text === text)
        if (complete) {
          const existingSegments = readSegmentsAt(db, baseSourceRef)
          db.exec('COMMIT')
          return { ok: true, segments: existingSegments }
        }
        if (current.status !== 'pending') {
          throw new Error('AI 回复记录状态已变化，拒绝补写分段')
        }

        const now = Date.now()
        const firstText = segments[0]
        if (firstText === undefined) throw new Error('AI 回复缺少首段正文')
        const firstNote = segments.length > 1 ? note + ' · 1/' + String(segments.length) : note
        const updated = db.prepare(`UPDATE message_list_records SET
          text = ?, note = ?, error = '', updated_at = ?,
          segment_group_ref = ?, segment_index = 1, segment_count = ?
          WHERE id = ? AND source = 'ai_reply'`).run(
          firstText,
          firstNote,
          now,
          baseSourceRef,
          segments.length,
          recordId,
        )
        if (Number(updated.changes) <= 0) throw new Error('AI 回复首段写入失败')

        for (let index = 2; index <= segments.length; index += 1) {
          const segmentText = segments[index - 1]
          if (segmentText === undefined) throw new Error('AI 回复缺少第 ' + String(index) + ' 段正文')
          const sourceRef = chatAiReplySegmentSourceRef(baseSourceRef, index)
          const currentSegment = db.prepare('SELECT * FROM message_list_records WHERE source_ref = ?')
            .get(sourceRef) as Record<string, unknown> | undefined
          const segmentNote = note + ' · ' + String(index) + '/' + String(segments.length)
          if (currentSegment !== undefined) {
            const existingSegment = rowToMessageListRecord(currentSegment)
            if (existingSegment.source !== 'ai_reply') {
              throw new Error('分段 sourceRef 已被非 AI 回复记录占用')
            }
            if (existingSegment.status !== 'pending') {
              throw new Error('AI 回复第 ' + String(index) + ' 段状态已变化，拒绝补写')
            }
            if (existingSegment.text !== '' && existingSegment.text !== segmentText) {
              throw new Error('AI 回复第 ' + String(index) + ' 段已存在不同正文')
            }
            db.prepare(`UPDATE message_list_records SET
              text = ?, note = ?, error = '', updated_at = ?,
              segment_group_ref = ?, segment_index = ?, segment_count = ?
              WHERE id = ? AND source = 'ai_reply'`).run(
              segmentText,
              segmentNote,
              now,
              baseSourceRef,
              index,
              segments.length,
              existingSegment.id,
            )
            continue
          }
          const inserted = insertRecordAt(decryptedDir, db, {
            replyId: generateReplyId(),
            chatName: current.chatName,
            targetName: current.targetName,
            text: segmentText,
            images: [],
            triggeredAt: Math.max(0, current.triggeredAt) + index - 1,
            source: 'ai_reply',
            note: segmentNote,
            chatUsername: current.chatUsername,
            targetUsername: current.targetUsername,
            webhookUrl: '',
            sourceRef,
            segmentGroupRef: baseSourceRef,
            segmentIndex: index,
            segmentCount: segments.length,
          }, now)
          if (!inserted.ok) throw new Error(inserted.error ?? 'AI 回复分段写入失败')
        }

        const finalRows = readSegmentRowsAt(db, baseSourceRef)
        const finalSegments = finalRows.map((row) => row.segment)
        if (finalSegments.length !== segments.length
          || finalSegments.some((segment, index) =>
            segment.segmentIndex !== index + 1 || segment.text !== segments[index])) {
          throw new Error('AI 回复分组写入后段数不完整')
        }
        db.exec('COMMIT')
        return { ok: true, segments: finalSegments }
      } catch (e) {
        try { db.exec('ROLLBACK') } catch { /* 保留原始错误 */ }
        throw e
      }
    })
  } catch (e) {
    return { ok: false, error: 'AI 回复分段写入消息列表失败：' + errorText(e) }
  }
}

/** 按基础 sourceRef 读取完整分段组；普通单条记录返回一段。 */
export function listAiReplyMessageListSegments(
  decryptedDir: string,
  sourceRef: string,
): ChatAiReplySegmentSnapshot[] {
  const parsed = parseChatAiReplySourceRef(sourceRef)
  if (parsed === null || !storeExists(decryptedDir)) return []
  try {
    return withWritableDb(taskDbPath(decryptedDir), (db) => {
      ensureMessageListSchema(db)
      return readSegmentsAt(db, parsed.baseSourceRef)
    })
  } catch {
    return []
  }
}

/**
 * 某段投递失败后，把后续尚未发送的 pending 段标成失败。
 * 已成功/已受理的段保持不变，后续不会因为前序失败而乱序补发。
 */
export function failAiReplyMessageListSegmentsAfter(
  decryptedDir: string,
  sourceRef: string,
  afterSegmentIndex: number,
  error: string,
  failureKind?: string,
): { ok: boolean; error?: string } {
  const parsed = parseChatAiReplySourceRef(sourceRef)
  const index = Math.max(1, numOf(afterSegmentIndex))
  if (parsed === null) return { ok: false, error: 'AI 回复 sourceRef 无效' }
  if (!storeExists(decryptedDir)) return { ok: false, error: 'AI 回复分段记录不存在' }
  const detail = textOf(error, ERROR_MAX) || '前序分段投递失败，本段未发送'
  const kind = failureKindOf(failureKind)
  try {
    return withWritableDb(taskDbPath(decryptedDir), (db) => {
      ensureMessageListSchema(db)
      const info = db.prepare(`UPDATE message_list_records SET
        status = 'failed', error = ?, note = 'AI 回复 · 分段未发送',
        failure_kind = ?, updated_at = ?
        WHERE source = 'ai_reply' AND status = 'pending'
          AND (segment_group_ref = ? OR source_ref LIKE ?)
          AND (
            segment_index > ?
            OR (segment_index = 0 AND source_ref LIKE ?)
          )`).run(
        detail,
        kind,
        Date.now(),
        parsed.baseSourceRef,
        parsed.baseSourceRef + ':segment:%',
        index,
        parsed.baseSourceRef + ':segment:%',
      )
      return { ok: Number(info.changes) >= 0 }
    })
  } catch (e) {
    return { ok: false, error: textOf(e instanceof Error ? e.message : String(e), ERROR_MAX) }
  }
}

/**
 * 将尚未完成的 AI 预约标记为失败，保留在消息列表里供用户排查。
 * 已完成或已进入投递态的记录不会被失败回写覆盖。
 */
export function failAiReplyMessageListRecord(
  decryptedDir: string,
  id: number,
  error: string,
  failureKind?: string,
): MessageListRecordResult {
  const recordId = positiveId(id)
  const detail = textOf(error, ERROR_MAX) || 'AI 回复生成失败'
  const kind = failureKindOf(failureKind)
  if (recordId <= 0) return { ok: false, error: 'AI 回复记录 id 无效' }
  if (!storeExists(decryptedDir)) return { ok: false, error: 'AI 回复预约记录不存在' }
  try {
    return enrichMessageListResult(decryptedDir, withWritableDb(taskDbPath(decryptedDir), (db) => {
      ensureMessageListSchema(db)
      const now = Date.now()
      const targetRow = db.prepare('SELECT * FROM message_list_records WHERE id = ?')
        .get(recordId) as Record<string, unknown> | undefined
      if (targetRow === undefined) return { ok: false, error: 'AI 回复预约记录不存在' }
      const target = rowToMessageListRecord(targetRow)
      const parsed = parseChatAiReplySourceRef(target.sourceRef)
      const baseSourceRef = parsed?.baseSourceRef ?? ''
      // 同一分组里所有仍为 pending 的段按调用方给的分类一起收口。
      const info = db.prepare(`UPDATE message_list_records SET
        status = 'failed', error = ?, note = 'AI 回复 · 生成失败',
        failure_kind = ?, updated_at = ?
        WHERE source = 'ai_reply' AND status = 'pending'
          AND (
            id = ?
            OR (? <> '' AND (source_ref = ? OR source_ref LIKE ?))
          )`).run(
        detail,
        kind,
        now,
        recordId,
        baseSourceRef,
        baseSourceRef,
        baseSourceRef === '' ? '' : baseSourceRef + ':segment:%',
      )
      const row = db.prepare('SELECT * FROM message_list_records WHERE id = ?')
        .get(recordId) as Record<string, unknown> | undefined
      if (row === undefined) return { ok: false, error: 'AI 回复预约记录不存在' }
      const record = rowToMessageListRecord(row)
      return Number(info.changes) > 0
        ? { ok: true, id: recordId, record, created: false }
        : { ok: false, id: recordId, record, error: 'AI 回复记录状态已变化，未覆盖失败原因' }
    }))
  } catch (e) {
    return { ok: false, id: recordId, error: 'AI 回复失败状态写入消息列表失败：' + errorText(e) }
  }
}

/**
 * 删除一组**从未发送**的 AI 回复预约。
 *
 * 被同一轮更新消息取代的预约没有任何发送价值；把它标成失败只会在「任务信息」
 * 里堆出一条条无意义的失败记录（真机实测：4 分钟 40+ 条「会话已有更新的消息」）。
 * 只有整组都还是 pending（没有任何分段进过 dispatching/queued/running/success）
 * 才允许删除；一旦有分段进过投递，事实必须保留给人工核对。
 *
 * 幂等：记录已经不存在时返回 ok=true、removed=0。
 */
export function dropAiReplyMessageListRecord(
  decryptedDir: string,
  id: number,
  sourceRef?: string,
): { ok: boolean; removed: number; error?: string } {
  const recordId = positiveId(id)
  if (recordId <= 0) return { ok: false, removed: 0, error: 'AI 回复记录 id 无效' }
  if (!storeExists(decryptedDir)) return { ok: false, removed: 0, error: 'AI 回复预约记录不存在' }
  try {
    return withWritableDb(taskDbPath(decryptedDir), (db) => {
      ensureMessageListSchema(db)
      db.exec('BEGIN IMMEDIATE')
      try {
        const targetRow = db.prepare('SELECT * FROM message_list_records WHERE id = ?')
          .get(recordId) as Record<string, unknown> | undefined
        if (targetRow === undefined) {
          db.exec('COMMIT')
          return { ok: true, removed: 0 }
        }
        const target = rowToMessageListRecord(targetRow)
        if (target.source !== 'ai_reply') throw new Error('目标记录不是 AI 回复来源')
        const parsed = parseChatAiReplySourceRef(target.sourceRef)
        if (parsed === null) throw new Error('AI 回复预约的 sourceRef 无效')
        const base = parsed.baseSourceRef
        // 调用方传了 sourceRef 就必须与记录一致，避免幂等键漂移后误删别的分组。
        const expected = textOf(sourceRef ?? '', SOURCE_REF_MAX)
        if (expected !== ''
          && parseChatAiReplySourceRef(expected)?.baseSourceRef !== base) {
          throw new Error('AI 回复预约的 sourceRef 与记录不一致，拒绝删除')
        }
        const groupRows = db.prepare(`SELECT status, text FROM message_list_records
          WHERE source = 'ai_reply'
            AND (source_ref = ? OR segment_group_ref = ? OR instr(source_ref, ?) = 1)`)
          .all(base, base, base + ':segment:') as Array<{ status?: unknown; text?: unknown }>
        if (groupRows.some((row) => textOf(row.status, 32) !== 'pending')) {
          throw new Error('AI 回复分组已有投递事实，不能删除')
        }
        // 已经生成过正文的预约只在等配置/等投递，删掉等于丢模型结果。
        if (groupRows.some((row) => textOf(row.text, TEXT_MAX) !== '')) {
          throw new Error('AI 回复分组已有生成正文，不能删除')
        }
        const info = db.prepare(`DELETE FROM message_list_records
          WHERE source = 'ai_reply'
            AND (source_ref = ? OR segment_group_ref = ? OR instr(source_ref, ?) = 1)`)
          .run(base, base, base + ':segment:')
        // 记录整组删掉后留痕也要走：不能把聊天上下文留在任务库里。
        pruneOrphanChatAiReplyTraces(db)
        db.exec('COMMIT')
        return { ok: true, removed: Number(info.changes) }
      } catch (e) {
        try {
          db.exec('ROLLBACK')
        } catch {
          // 原始错误更有用。
        }
        throw e
      }
    })
  } catch (e) {
    return { ok: false, removed: 0, error: 'AI 回复预约删除失败：' + errorText(e) }
  }
}

/** 桌面端「重新生成」写入的备注：与自动生成的备注区分，便于用户识别这次是手动重跑。 */
/** AI 回复恢复器的只读孤儿预约快照；不暴露完整消息正文给扫描器。 */
export interface PendingAiReplyMessageListRecord {
  id: number
  sourceRef: string
  chatUsername: string
  targetUsername: string
}

/**
 * 列出所有仍处于 pending 的 AI 回复预约。
 *
 * 设置行可能已被删除、关闭或迁移失败；调用方必须用 sourceRef 中的账号/会话
 * 身份判断是否真的没有 enabled 设置，再决定是否安全收口。这里不按是否有
 * Webhook 地址过滤，因为预约阶段地址故意为空。
 */
export function listPendingAiReplyMessageListRecords(
  decryptedDir: string,
  limit = 100,
): PendingAiReplyMessageListRecord[] {
  if (!storeExists(decryptedDir)) return []
  const cap = Math.min(500, Math.max(1, numOf(limit, 100)))
  try {
    return withWritableDb(taskDbPath(decryptedDir), (db) => {
      ensureMessageListSchema(db)
      const rows = db.prepare(`SELECT id, source_ref, chat_username, target_username
        FROM message_list_records
        WHERE source = 'ai_reply' AND status = 'pending'
        ORDER BY id ASC LIMIT ?`).all(cap) as Array<Record<string, unknown>>
      return rows.map((row) => ({
        id: positiveId(row['id']),
        sourceRef: textOf(row['source_ref'], SOURCE_REF_MAX),
        chatUsername: textOf(row['chat_username'], USERNAME_MAX),
        targetUsername: textOf(row['target_username'], USERNAME_MAX),
      })).filter((row) => row.id > 0)
    })
  } catch {
    return []
  }
}
