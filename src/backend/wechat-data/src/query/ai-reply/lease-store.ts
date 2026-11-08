/**
 * AI 回复跨进程租约。
 *
 * 会话设置行同时承担任务控制面：`(lease_owner, lease_fence)` 绑定一次执行权，
 * `lease_until` 只决定何时允许接管。所有接管都在 `BEGIN IMMEDIATE` 内完成并
 * 递增 fence，因此旧 owner 即使晚到，也无法再用旧租约回写状态或模型结果。
 */
import { withWritableDb } from '../db-open.ts'
import type { DatabaseSync } from '../db-open.ts'
import { storeExists, taskDbPath } from '../task-db.ts'
import { ensureChatAiReplySchema } from './config-store.ts'
import type { ChatAiReplyState } from './types.ts'

export const CHAT_AI_REPLY_LEASE_MS = 60_000

const OWNER_MAX = 200

export interface ChatAiReplyLease {
  owner: string
  fence: number
  until: number
}

export interface ClaimChatAiReplyRunInput {
  owner: string
  /** 扫描时看到的快照；任一控制字段变化都放弃本次 claim。 */
  expected: Pick<
    ChatAiReplyState,
    'enabled' | 'revision' | 'stage' | 'cursor' | 'pendingCursor' | 'pendingSourceRef' | 'recordId'
  >
  now?: number
  leaseMs?: number
}

function timestamp(value: number | undefined): number {
  return value === undefined ? Date.now() : Math.max(0, Math.trunc(value))
}

function ownerOf(value: string): string {
  const owner = typeof value === 'string' ? value.trim().slice(0, OWNER_MAX) : ''
  if (owner === '') throw new Error('AI 回复租约 owner 不能为空')
  return owner
}

function positiveLease(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const lease = Math.trunc(value)
  if (!Number.isSafeInteger(lease) || lease <= 0) {
    throw new Error('AI 回复 leaseMs 必须是正整数')
  }
  return lease
}

function writeTx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 保留原始异常 */ }
    throw e
  }
}

function keyOf(accountKey: string, chatUsername: string): [string, string] {
  return [accountKey.trim().slice(0, 255), chatUsername.trim().slice(0, 255)]
}

/**
 * 原子抢占一个会话的执行权。
 *
 * expected 必须与扫描时看到的控制面完全一致；这比只比较 revision 更强，
 * 可以阻止另一个 runner 完成上一拍后，延迟 scan 拿旧 anchor 再执行一次。
 */
export function claimChatAiReplyRun(
  decryptedDir: string,
  accountKey: string,
  chatUsername: string,
  input: ClaimChatAiReplyRunInput,
): ChatAiReplyLease | null {
  if (!input.expected.enabled || !storeExists(decryptedDir)) return null
  const [account, chat] = keyOf(accountKey, chatUsername)
  if (account === '' || chat === '') return null
  const owner = ownerOf(input.owner)
  const now = timestamp(input.now)
  const until = now + positiveLease(input.leaseMs, CHAT_AI_REPLY_LEASE_MS)
  const expected = input.expected
  return withWritableDb(taskDbPath(decryptedDir), (db) => {
    ensureChatAiReplySchema(db)
    return writeTx(db, () => {
      const before = db.prepare(`SELECT lease_fence FROM chat_ai_reply_settings
        WHERE account_key = ? AND chat_username = ? LIMIT 1`).get(account, chat) as
        { lease_fence?: unknown } | undefined
      if (before === undefined) return null
      const fence = Math.max(0, Number(before.lease_fence ?? 0)) + 1
      const claimed = db.prepare(`UPDATE chat_ai_reply_settings SET
        lease_owner = ?,
        lease_until = ?,
        lease_fence = ?
        WHERE account_key = ? AND chat_username = ?
          AND enabled = 1
          AND revision = ?
          AND stage = ?
          AND cursor = ?
          AND pending_cursor = ?
          AND pending_source_ref = ?
          AND COALESCE(record_id, 0) = ?
          AND lease_until <= ?`).run(
        owner,
        until,
        fence,
        account,
        chat,
        Math.max(0, Math.trunc(expected.revision)),
        expected.stage,
        expected.cursor,
        expected.pendingCursor ?? '',
        expected.pendingSourceRef ?? '',
        Math.max(0, Math.trunc(expected.recordId ?? 0)),
        now,
      )
      return Number(claimed.changes) === 1 ? { owner, fence, until } : null
    })
  })
}

/** 心跳续租；owner/fence 或 revision 已变化时返回 null。 */
export function renewChatAiReplyRunClaim(
  decryptedDir: string,
  accountKey: string,
  chatUsername: string,
  revision: number,
  lease: ChatAiReplyLease,
  options: { now?: number; leaseMs?: number } = {},
): ChatAiReplyLease | null {
  if (!storeExists(decryptedDir)) return null
  const [account, chat] = keyOf(accountKey, chatUsername)
  if (account === '' || chat === '') return null
  const owner = ownerOf(lease.owner)
  const now = timestamp(options.now)
  const until = now + positiveLease(options.leaseMs, CHAT_AI_REPLY_LEASE_MS)
  return withWritableDb(taskDbPath(decryptedDir), (db) => {
    ensureChatAiReplySchema(db)
    const renewed = db.prepare(`UPDATE chat_ai_reply_settings SET
      lease_until = ?
      WHERE account_key = ? AND chat_username = ?
        AND enabled = 1
        AND revision = ?
        AND lease_owner = ?
        AND lease_fence = ?`).run(
      until,
      account,
      chat,
      Math.max(0, Math.trunc(revision)),
      owner,
      Math.max(0, Math.trunc(lease.fence)),
    )
    return Number(renewed.changes) === 1
      ? { owner, fence: Math.max(0, Math.trunc(lease.fence)), until }
      : null
  })
}

/** 主动释放；只清 until/owner，保留 fence 以维持单调性。 */
export function releaseChatAiReplyRunClaim(
  decryptedDir: string,
  accountKey: string,
  chatUsername: string,
  revision: number,
  lease: ChatAiReplyLease,
): boolean {
  if (!storeExists(decryptedDir)) return false
  const [account, chat] = keyOf(accountKey, chatUsername)
  if (account === '' || chat === '') return false
  try {
    return withWritableDb(taskDbPath(decryptedDir), (db) => {
      ensureChatAiReplySchema(db)
      const released = db.prepare(`UPDATE chat_ai_reply_settings SET
        lease_owner = NULL,
        lease_until = 0
        WHERE account_key = ? AND chat_username = ?
          AND revision = ?
          AND lease_owner = ?
          AND lease_fence = ?`).run(
        account,
        chat,
        Math.max(0, Math.trunc(revision)),
        lease.owner.trim().slice(0, OWNER_MAX),
        Math.max(0, Math.trunc(lease.fence)),
      )
      return Number(released.changes) === 1
    })
  } catch {
    return false
  }
}
