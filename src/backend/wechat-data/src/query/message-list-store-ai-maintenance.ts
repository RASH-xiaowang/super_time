/**
 * AI 回复预约的桌面端维护面：重新生成前的记录重开与专用整组清理。
 *
 * 这两个入口都只允许桌面端调用：重新生成会再花一次模型钱，专用清理会整组
 * 销毁消息列表台账。守卫刻意与自动运行路径分离，避免把「用户明确操作」的
 * 宽松语义带进无人值守扫描。
 */
import { withWritableDb } from './db-open.ts'
import type { DatabaseSync } from './db-open.ts'
import { storeExists, taskDbPath } from './task-db.ts'
import type { MessageListRecordResult } from '../types.ts'
import { parseChatAiReplySourceRef } from './ai-reply/segments.ts'
import { readChatAiReplyRunWindowOnDb } from './ai-reply/run-window.ts'
import { ensureChatAiReplySchema } from './ai-reply/config-store.ts'
import { isUnfinishedStage } from './ai-reply/runner-recovery.ts'
import {
  SOURCE_REF_MAX,
  TEXT_MAX,
  errorText,
  numOf,
  positiveId,
  textOf,
} from './message-list-store-shared.ts'
import {
  enrichMessageListResult,
  ensureMessageListSchema,
  rowToMessageListRecord,
} from './message-list-store-schema.ts'

export const AI_REPLY_REOPEN_NOTE = 'AI 回复 · 重新生成'
/** 只有从未真正调用/已按设计取消的空白失败记录才允许再花一次模型钱。 */
const REOPENABLE_FAILURE_KINDS = new Set(['superseded', 'generation_failed', 'config_changed'])
/** 清理接口单次最多处理的记录数；与 Remote 参数 schema 的上限保持一致。 */
const AI_REPLY_CLEANUP_MAX = 100

/** 读取一个 AI 回复分组：基础记录、所有分段，以及历史遗留的 `:segment:` 幂等键。 */
function readAiReplyGroupRows(
  db: DatabaseSync,
  baseSourceRef: string,
): Array<Record<string, unknown>> {
  return db.prepare(`SELECT * FROM message_list_records
    WHERE source = 'ai_reply'
      AND (source_ref = ? OR segment_group_ref = ? OR instr(source_ref, ?) = 1)`)
    .all(baseSourceRef, baseSourceRef, baseSourceRef + ':segment:') as Array<Record<string, unknown>>
}

/** 空附件在库里的合法形状只有空串与 `[]`；解析失败的历史值也按「有内容」保守处理。 */
function imagesAreEmpty(raw: unknown): boolean {
  const value = typeof raw === 'string' ? raw : ''
  return value === '' || value === '[]'
}

/**
 * 重新生成的整组守卫：任何一段已有正文、附件、异步任务或发送尝试都拒绝。
 *
 * 状态只允许 pending/failed；queued/running/dispatching/success/sent_unconfirmed
 * 都说明这一组已经有投递事实，不能再改回空白重跑。
 */
function reopenGuardViolation(rows: Array<Record<string, unknown>>): string | undefined {
  for (const row of rows) {
    const status = textOf(row['status'], 32)
    if (status !== 'pending' && status !== 'failed') {
      return 'AI 回复分组已有发送或受理事实，不能重新生成'
    }
    if (textOf(row['text'], TEXT_MAX).trim() !== '') {
      return 'AI 回复分组已有生成正文，不能重新生成'
    }
    if (!imagesAreEmpty(row['images'])) {
      return 'AI 回复分组包含图片，不能重新生成'
    }
    if (textOf(row['job_id'], 128) !== '' || textOf(row['job_state'], 80) !== '') {
      return 'AI 回复分组存在异步发送任务，不能重新生成'
    }
    if (Math.max(0, numOf(row['attempts'])) !== 0
      || (row['last_attempt_at'] !== null && row['last_attempt_at'] !== undefined)) {
      return 'AI 回复分组已有发送尝试，不能重新生成'
    }
    if (textOf(row['webhook_url'], 2048) !== ''
      || textOf(row['dispatch_owner'], 200) !== '') {
      return 'AI 回复分组已有投递事实，不能重新生成'
    }
  }
  return undefined
}

/**
 * 专用清理守卫：比重新生成多查投递地址/认领进程，少了 failureKind 限制。
 *
 * 只放宽状态到 failed；正文、图片、job、尝试次数与任何投递事实都不放宽。
 */
function cleanupGuardViolation(rows: Array<Record<string, unknown>>): string | undefined {
  for (const row of rows) {
    const status = textOf(row['status'], 32)
    if (status !== 'pending' && status !== 'failed') {
      return 'AI 回复分组已有发送或受理事实，不能清理'
    }
    if (textOf(row['text'], TEXT_MAX).trim() !== '') {
      return 'AI 回复分组已有正文，不能清理'
    }
    if (!imagesAreEmpty(row['images'])) {
      return 'AI 回复分组包含图片，不能清理'
    }
    if (textOf(row['job_id'], 128) !== '' || textOf(row['job_state'], 80) !== '') {
      return 'AI 回复分组存在异步发送任务，不能清理'
    }
    if (Math.max(0, numOf(row['attempts'])) !== 0
      || (row['last_attempt_at'] !== null && row['last_attempt_at'] !== undefined)) {
      return 'AI 回复分组已有发送尝试，不能清理'
    }
    if (textOf(row['webhook_url'], 2048) !== '') {
      return 'AI 回复分组已绑定发送地址，不能清理'
    }
    if (textOf(row['dispatch_owner'], 200) !== '') {
      return 'AI 回复分组正在投递，不能清理'
    }
  }
  return undefined
}

/**
 * 把一条**空白失败**的 AI 回复记录 CAS 重置为 pending，供桌面端重新生成。
 *
 * 守卫与 `dropAiReplyMessageListRecord` 同等严格：整组只允许 pending/failed、
 * 正文全空、无图片、无 job、无发送尝试。整组多余的空白分段会先删除，再对基础
 * 记录做一次 UPDATE；任一步不满足都回滚，记录保持失败原状。
 */
export function reopenAiReplyMessageListRecord(
  decryptedDir: string,
  id: number,
  sourceRef: string,
): MessageListRecordResult {
  const recordId = positiveId(id)
  const expected = textOf(sourceRef, SOURCE_REF_MAX)
  const expectedParsed = parseChatAiReplySourceRef(expected)
  if (recordId <= 0) return { ok: false, error: 'AI 回复记录 id 无效' }
  if (expectedParsed === null) return { ok: false, error: 'AI 回复 sourceRef 无效' }
  if (!storeExists(decryptedDir)) return { ok: false, error: 'AI 回复记录不存在' }
  try {
    return enrichMessageListResult(decryptedDir, withWritableDb(taskDbPath(decryptedDir), (db) => {
      ensureMessageListSchema(db)
      db.exec('BEGIN IMMEDIATE')
      try {
        const targetRow = db.prepare('SELECT * FROM message_list_records WHERE id = ?')
          .get(recordId) as Record<string, unknown> | undefined
        if (targetRow === undefined) throw new Error('AI 回复记录不存在')
        const target = rowToMessageListRecord(targetRow)
        const parsed = parseChatAiReplySourceRef(target.sourceRef)
        if (target.source !== 'ai_reply') throw new Error('目标记录不是 AI 回复来源')
        if (parsed === null || parsed.baseSourceRef !== expectedParsed.baseSourceRef) {
          throw new Error('AI 回复记录的 sourceRef 与请求不一致，拒绝重新生成')
        }
        if (target.status !== 'failed') throw new Error('只有生成失败的空白记录可以重新生成')
        if (target.text.trim() !== '') throw new Error('AI 回复记录已有正文，不能重新生成')
        if (target.images.length > 0) throw new Error('AI 回复记录包含图片，不能重新生成')
        if ((target.jobId ?? '') !== '') throw new Error('AI 回复记录存在异步发送任务，不能重新生成')
        if (target.attempts !== 0) throw new Error('AI 回复记录已有发送尝试，不能重新生成')
        if (target.failureKind === undefined || !REOPENABLE_FAILURE_KINDS.has(target.failureKind)) {
          throw new Error('AI 回复记录的失败分类不允许重新生成')
        }
        const base = parsed.baseSourceRef
        const groupRows = readAiReplyGroupRows(db, base)
        const violation = reopenGuardViolation(groupRows)
        if (violation !== undefined) throw new Error(violation)
        // 同组多余空白分段没有任何内容；保留它们会让重新生成后的分段结构错位。
        db.prepare(`DELETE FROM message_list_records
          WHERE id <> ? AND source = 'ai_reply'
            AND status IN ('pending', 'failed')
            AND text = '' AND COALESCE(job_id, '') = '' AND attempts = 0
            AND (source_ref = ? OR segment_group_ref = ? OR instr(source_ref, ?) = 1)`).run(
          recordId,
          base,
          base,
          base + ':segment:',
        )
        // created_at 一并刷新：重新生成是一条新的预约，界面按 createdAt 判断
        // 「生成中 / 生成停滞」；沿用旧时间会让刚点下的重跑立刻显示成停滞。
        const now = Date.now()
        const info = db.prepare(`UPDATE message_list_records SET
          status = 'pending', text = '', images = '[]', note = ?,
          error = '', failure_kind = '', job_id = '', job_state = '',
          job_checked_at = NULL, response_summary = '', dispatch_owner = '',
          webhook_url = '', segment_group_ref = '', segment_index = 0,
          segment_count = 0, attempts = 0, last_attempt_at = NULL,
          created_at = ?, updated_at = ?
          WHERE id = ? AND source = 'ai_reply' AND status = 'failed'
            AND text = '' AND COALESCE(job_id, '') = '' AND attempts = 0
            AND images IN ('', '[]')`).run(AI_REPLY_REOPEN_NOTE, now, now, recordId)
        if (Number(info.changes) !== 1) {
          throw new Error('AI 回复记录状态已变化，拒绝重新生成')
        }
        const row = db.prepare('SELECT * FROM message_list_records WHERE id = ?')
          .get(recordId) as Record<string, unknown> | undefined
        if (row === undefined) throw new Error('AI 回复记录重新打开后无法回读')
        db.exec('COMMIT')
        return { ok: true, id: recordId, record: rowToMessageListRecord(row), created: false }
      } catch (e) {
        try {
          db.exec('ROLLBACK')
        } catch {
          // 原始错误更有用。
        }
        throw e
      }
    }))
  } catch (e) {
    return { ok: false, id: recordId, error: 'AI 回复重新生成失败：' + errorText(e) }
  }
}

/** 桌面端专用清理的返回：removed/skipped 按**调用方的 id**计数，items 给出逐条原因。 */
export interface AiReplyReservationCleanupResult {
  ok: boolean
  removed: number
  skipped: number
  items: Array<{
    id: number
    status: 'removed' | 'skipped'
    error?: string
  }>
  error?: string
}

/**
 * 桌面端专用：删除一组**从未生成正文、从未投递**的 AI 预约/失败记录。
 *
 * 与 `dropAiReplyMessageListRecord` 的区别只有「允许 failed 状态」；正文、图片、
 * job、发送尝试、投递地址与认领进程等守卫保持同样严格。删除按 sourceRef/
 * segment_group_ref 整组进行，避免只删掉基础记录却留下分段。记录不存在算 skipped，
 * 因此重复清理幂等。
 */
export function deleteAiReplyMessageListRecordsForCleanup(
  decryptedDir: string,
  rawIds: readonly number[],
): AiReplyReservationCleanupResult {
  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    return { ok: false, removed: 0, skipped: 0, items: [], error: '请至少选择一条 AI 回复预约' }
  }
  if (rawIds.length > AI_REPLY_CLEANUP_MAX) {
    return {
      ok: false,
      removed: 0,
      skipped: 0,
      items: [],
      error: '单次最多清理 ' + String(AI_REPLY_CLEANUP_MAX) + ' 条 AI 回复预约',
    }
  }
  if (rawIds.some((id) => typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0)) {
    return { ok: false, removed: 0, skipped: 0, items: [], error: 'AI 回复预约 id 必须是正整数' }
  }
  const ids = [...new Set(rawIds)]
  if (!storeExists(decryptedDir)) {
    return {
      ok: true,
      removed: 0,
      skipped: ids.length,
      items: ids.map((id) => ({
        id,
        status: 'skipped' as const,
        error: 'AI 回复预约不存在',
      })),
    }
  }
  try {
    return withWritableDb(taskDbPath(decryptedDir), (db) => {
      ensureMessageListSchema(db)
      db.exec('BEGIN IMMEDIATE')
      try {
        // 运行窗口与台账在同一个任务库里；schema 只在这里探测一次。
        ensureChatAiReplySchema(db)
        const seenGroups = new Set<string>()
        const removedIds = new Set<number>()
        const items: AiReplyReservationCleanupResult['items'] = []
        let removed = 0
        let skipped = 0
        const skip = (id: number, error: string): void => {
          skipped += 1
          items.push({ id, status: 'skipped', error })
        }
        for (const id of ids) {
          // 同组的前一条记录已经把整组删掉时，后一条不该再报「不存在」。
          if (removedIds.has(id)) {
            skip(id, '同一分组已在本次清理中处理')
            continue
          }
          const row = db.prepare('SELECT * FROM message_list_records WHERE id = ?')
            .get(id) as Record<string, unknown> | undefined
          if (row === undefined) {
            skip(id, 'AI 回复预约不存在')
            continue
          }
          const record = rowToMessageListRecord(row)
          if (record.source !== 'ai_reply') {
            skip(id, '不是 AI 回复记录，不能按预约清理')
            continue
          }
          const parsed = parseChatAiReplySourceRef(record.sourceRef)
          if (parsed === null) {
            skip(id, 'AI 回复预约的 sourceRef 无效')
            continue
          }
          if (seenGroups.has(parsed.baseSourceRef)) {
            skip(id, '同一分组已在本次清理中处理')
            continue
          }
          const groupRows = readAiReplyGroupRows(db, parsed.baseSourceRef)
          const violation = cleanupGuardViolation(groupRows)
          if (violation !== undefined) {
            skip(id, violation)
            continue
          }
          // 删除一条正在生成的空白 pending 并不等于取消生成：runner 仍会拿到模型
          // 结果，并按同一 sourceRef 重新预约/复用结果后投递。清理必须在同一事务里
          // 读运行窗口，看到未完成阶段就拒绝，改由「等这轮收口或停滞后再清理」。
          const runWindow = readChatAiReplyRunWindowOnDb(
            db,
            decryptedDir,
            parsed.accountKey,
            parsed.chatUsername,
          )
          if (!runWindow.ok) {
            skip(id, 'AI 回复运行状态暂时不可读，不能清理')
            continue
          }
          // 只要会话还挂着这个分组的 pending 锚点，它就是「下一拍可恢复」的任务：
          // `deferChatAiReplyRun` 会把 stage 写成 failed 但保留 pendingSourceRef，
          // 扫描随后重试/复用结果。此时删行会让下一拍重新建记录并投递，所以无论
          // stage 是什么都必须拒绝，直到扫描真正收口并清掉锚点。
          if (runWindow.window.pendingSourceRef === parsed.baseSourceRef) {
            skip(id, 'AI 回复还有待恢复的任务，下一轮扫描会继续，暂不能清理')
            continue
          }
          const groupIds = new Set<number>()
          for (const groupRow of groupRows) {
            const groupId = positiveId(groupRow['id'])
            if (groupId > 0) groupIds.add(groupId)
          }
          if (runWindow.window.recordId !== undefined
            && groupIds.has(runWindow.window.recordId)
            && isUnfinishedStage(runWindow.window.stage)) {
            skip(id, 'AI 回复正在生成或投递中，完成或停滞后再清理')
            continue
          }
          seenGroups.add(parsed.baseSourceRef)
          const info = db.prepare(`DELETE FROM message_list_records
            WHERE source = 'ai_reply'
              AND (source_ref = ? OR segment_group_ref = ? OR instr(source_ref, ?) = 1)`).run(
            parsed.baseSourceRef,
            parsed.baseSourceRef,
            parsed.baseSourceRef + ':segment:',
          )
          if (Number(info.changes) > 0) {
            removed += 1
            for (const groupRow of groupRows) {
              const groupId = positiveId(groupRow['id'])
              if (groupId > 0) removedIds.add(groupId)
            }
            items.push({ id, status: 'removed' })
          } else {
            skip(id, 'AI 回复预约不存在')
          }
        }
        db.exec('COMMIT')
        return { ok: true, removed, skipped, items }
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
    return {
      ok: false,
      removed: 0,
      skipped: 0,
      items: [],
      error: 'AI 回复预约清理失败：' + errorText(e),
    }
  }
}

