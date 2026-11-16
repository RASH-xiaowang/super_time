/**
 * 消息投递结果回写、原子认领、崩溃恢复与下游任务状态。
 */
import { withWritableDb } from './db-open.ts'
import { processIsAlive as isProcessAlive } from './process-liveness.ts'
import { storeExists, taskDbPath } from './task-db.ts'
import type { MessageListRecord, MessageListStatus } from '../types.ts'
import {
  ERROR_MAX,
  INTERRUPTED_DISPATCH_STALE_MS,
  JOB_ID_MAX,
  JOB_STATE_MAX,
  RESPONSE_MAX,
  httpUrl,
  failureKindOf,
  messageListJobPhase,
  messageListStatusForJobPhase,
  numOf,
  positiveId,
  statusOf,
  textOf,
} from './message-list-store-shared.ts'
import {
  enrichMessageListRecords,
  ensureMessageListSchema,
  rowToMessageListRecord,
} from './message-list-store-schema.ts'

/** 投递结果回写（状态、错误、尝试次数、下游返回的任务 id）。 */
export function saveMessageListDispatchResult(
  decryptedDir: string,
  id: number,
  outcome: {
    status: MessageListStatus
    error: string
    responseSummary: string
    /** 下游返回的回复 id；与 Feather 的异步任务 id 分开保存。 */
    replyId?: string
    jobId?: string
    jobState?: string
    webhookUrl?: string
    /** 失败原因分类；成功/待执行回写传空串以清掉旧分类。 */
    failureKind?: string
    /** 只有真正发出 HTTP 请求时才累加尝试次数。 */
    countAttempt?: boolean
  },
): MessageListRecord | undefined {
  const recordId = positiveId(id)
  if (recordId <= 0 || !storeExists(decryptedDir)) return undefined
  const now = Date.now()
  const failureKind = failureKindOf(outcome.failureKind)
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
      const jobId = textOf(outcome.jobId, JOB_ID_MAX)
      if (jobId !== '') {
        db.prepare('UPDATE message_list_records SET job_id = ? WHERE id = ?').run(jobId, recordId)
      }
      const jobState = textOf(outcome.jobState, JOB_STATE_MAX)
      if (jobState !== '') {
        db.prepare('UPDATE message_list_records SET job_state = ? WHERE id = ?').run(jobState, recordId)
      }
      const webhookUrl = httpUrl(outcome.webhookUrl)
      if (webhookUrl !== '') {
        db.prepare('UPDATE message_list_records SET webhook_url = ? WHERE id = ?').run(webhookUrl, recordId)
      }
      db.prepare(`UPDATE message_list_records SET
        status = ?, error = ?, attempts = ?, last_attempt_at = ?,
        response_summary = ?, failure_kind = ?, updated_at = ? WHERE id = ?`).run(
        statusOf(outcome.status),
        textOf(outcome.error, ERROR_MAX),
        Math.max(0, numOf(current.attempts)) + (outcome.countAttempt === false ? 0 : 1),
        outcome.countAttempt === false
          ? (current.last_attempt_at === null || current.last_attempt_at === undefined
              ? null
              : numOf(current.last_attempt_at))
          : now,
        textOf(outcome.responseSummary, RESPONSE_MAX),
        failureKind,
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

/**
 * 投递归属意图。
 *
 * - automatic：后台批次、新建后立即投递、AI 即时投递，只允许 pending；
 * - manual_single：用户明确重发单条，可重试 success/failed/sent_unconfirmed；
 * - manual_batch：用户批量勾选，只允许 pending/failed，避免批量误发已成功或待核对记录。
 */
export type MessageListDispatchIntent = 'automatic' | 'manual_single' | 'manual_batch'

const CLAIMABLE_STATUSES_BY_INTENT: Readonly<
  Record<MessageListDispatchIntent, ReadonlySet<MessageListStatus>>
> = {
  automatic: new Set<MessageListStatus>(['pending']),
  manual_single: new Set<MessageListStatus>([
    'pending',
    'success',
    'failed',
    'sent_unconfirmed',
  ]),
  manual_batch: new Set<MessageListStatus>(['pending', 'failed']),
}

/** 某条记录当前状态是否允许由该意图认领；用于认领前的快速、只读判定。 */
export function messageListRecordCanBeClaimed(
  status: MessageListStatus,
  intent: MessageListDispatchIntent,
): boolean {
  return CLAIMABLE_STATUSES_BY_INTENT[intent].has(status)
}

/**
 * 出网前的数据库原子认领。
 *
 * 自动/AI 路径只接受 pending；只有用户明确单条重发时才接受 success、failed 与
 * sent_unconfirmed。批量入口在 SQL 层收紧为 pending/failed，不能借人工路径绕过。
 * 成功后立刻写成 dispatching，既阻止第二个进程重复选中，也不会在「HTTP 已经发出、
 * 回写却失败」时退回 pending。dispatching 不自动回收；sent_unconfirmed 只允许人工
 * 核对后单条重发，绝不进入自动批量，避免重复发微信。
 */
export function claimMessageListRecordForDispatch(
  decryptedDir: string,
  id: number,
  webhookUrl = '',
  intent: MessageListDispatchIntent = 'automatic',
): MessageListRecord | undefined {
  const recordId = positiveId(id)
  const claimedWebhook = httpUrl(webhookUrl)
  const claimableStatuses = [...CLAIMABLE_STATUSES_BY_INTENT[intent]]
  const statusPlaceholders = claimableStatuses.map(() => '?').join(', ')
  if (recordId <= 0 || !storeExists(decryptedDir)) return undefined
  try {
    return withWritableDb(taskDbPath(decryptedDir), (db) => {
      ensureMessageListSchema(db)
      const now = Date.now()
      const info = db.prepare(`UPDATE message_list_records SET
        status = 'dispatching',
        dispatch_owner = ?,
        webhook_url = CASE WHEN ? = '' THEN webhook_url ELSE ? END,
        updated_at = ?
        WHERE id = ? AND status IN (${statusPlaceholders})`)
        .run(String(process.pid), claimedWebhook, claimedWebhook, now, recordId, ...claimableStatuses)
      if (Number(info.changes) <= 0) return undefined
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

/**
 * 把上一进程遗留的 dispatching 记录收口为 sent_unconfirmed。
 *
 * 认领发生在 HTTP 请求之前，因此无法从库中判断请求是否真正发出。依据“宁可不自动
 * 重发，也不重复发微信”的边界，这里只允许人工核对后单条重发或删除，绝不放回 pending。
 * 收口条件有两条：认领进程已经不存在，或认领已超过投递超时窗口。存活进程在窗口内
 * 继续等待（大附件上传可能接近 5 分钟），超窗仍按中断收口，避免永久卡住。
 */
export function recoverInterruptedMessageListDispatches(
  decryptedDir: string,
  staleAfterMs = INTERRUPTED_DISPATCH_STALE_MS,
  now = Date.now(),
): number {
  if (!storeExists(decryptedDir)) return 0
  const staleWindow = Number.isFinite(staleAfterMs)
    ? Math.max(0, Math.trunc(staleAfterMs))
    : INTERRUPTED_DISPATCH_STALE_MS
  const cutoff = now - staleWindow
  try {
    return withWritableDb(taskDbPath(decryptedDir), (db) => {
      ensureMessageListSchema(db)
      // 两条收口依据：超过投递超时窗口，或认领进程已经不存在（不可能还在发
      // 请求）。后者让快速重启后的记录不必在「投递中」白等 5 分钟；进程仍
      // 存活时即使超过窗口也继续等待，避免误伤正在上传附件的老进程。
      const rows = db.prepare(`SELECT id, dispatch_owner, updated_at
        FROM message_list_records WHERE status = 'dispatching'`).all() as Array<Record<string, unknown>>
      const targets: number[] = []
      for (const row of rows) {
        const id = numOf(row['id'])
        if (id <= 0) continue
        const ownerPid = Number(textOf(row['dispatch_owner'], 40))
        const ownerDead = Number.isSafeInteger(ownerPid) && ownerPid > 0 && !isProcessAlive(ownerPid)
        if (ownerDead || numOf(row['updated_at']) <= cutoff) targets.push(id)
      }
      if (targets.length === 0) return 0
      const placeholders = targets.map(() => '?').join(', ')
      const info = db.prepare(`UPDATE message_list_records SET
        status = 'sent_unconfirmed',
        failure_kind = 'unconfirmed',
        error = CASE
          WHEN error = '' THEN '进程在投递期间中断，无法确认是否已发出；请核对后单条重发或删除'
          ELSE error || '；进程在投递期间中断，请核对后再处理'
        END,
        updated_at = ?
        WHERE status = 'dispatching' AND id IN (${placeholders})`).run(now, ...targets)
      return Math.max(0, Number(info.changes))
    })
  } catch {
    return 0
  }
}

/**
 * 保存下游异步任务查询结果。
 *
 * queued/running/succeeded/failed 是下游任务的明确状态，必须同步到本地
 * 投递台账；否则 202 排队记录会永远停在“已成功”，或失败后仍可被误认为成功。
 * 未知状态只更新 job_state，不猜测投递结果。终态不回退，running 也不会回退到 queued。
 */
export function saveMessageListJobResult(
  decryptedDir: string,
  id: number,
  input: { jobId: string; jobState: string; error?: string },
): MessageListRecord | undefined {
  const recordId = positiveId(id)
  const jobId = textOf(input.jobId, JOB_ID_MAX)
  if (recordId <= 0 || jobId === '' || !storeExists(decryptedDir)) return undefined
  try {
    return withWritableDb(taskDbPath(decryptedDir), (db) => {
      ensureMessageListSchema(db)
      const now = Date.now()
      const current = db.prepare('SELECT status FROM message_list_records WHERE id = ?')
        .get(recordId) as { status?: unknown } | undefined
      if (current === undefined) return undefined
      const currentStatus = statusOf(current.status)
      let nextStatus = messageListStatusForJobPhase(messageListJobPhase(input.jobState))
      if (
        nextStatus !== undefined
        && (
          currentStatus === 'success'
          || currentStatus === 'failed'
          || currentStatus === 'running' && nextStatus === 'queued'
        )
      ) {
        nextStatus = undefined
      }
      const jobError = nextStatus === 'failed'
        ? textOf(
            input.error === undefined || input.error.trim() === ''
              ? '下游任务执行失败（' + textOf(input.jobState, JOB_STATE_MAX) + '）'
              : '下游任务执行失败：' + input.error,
            ERROR_MAX,
          )
        : ''
      const info = db.prepare(`UPDATE message_list_records SET
        job_id = ?, job_state = ?, job_checked_at = ?, updated_at = ?,
        status = COALESCE(?, status),
        error = CASE WHEN ? = 'failed' THEN ? ELSE error END,
        failure_kind = CASE WHEN ? = 'failed' THEN 'send_failed' ELSE failure_kind END
        WHERE id = ?`).run(
        jobId,
        textOf(input.jobState, JOB_STATE_MAX),
        now,
        now,
        nextStatus ?? null,
        nextStatus ?? '',
        jobError,
        nextStatus ?? '',
        recordId,
      )
      if (Number(info.changes) <= 0) return undefined
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
