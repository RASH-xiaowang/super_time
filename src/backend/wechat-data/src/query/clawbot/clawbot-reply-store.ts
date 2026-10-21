/**
 * ClawBot 自动回复的持久化 run / outbox。
 *
 * ## 为什么不用内存队列
 *
 * 自动回复横跨生成与发送两个阶段，任一步都可能遇到进程重启、上游超时或发送结果
 * 不确定。run 行保存业务状态与下一次可处理时间，outbox 行保存每个分段以及首次
 * 生成的稳定 `client_id`。恢复器可以在重启后继续同一条 run，发送重试也必须复用
 * 原 `client_id`，避免「服务端已收到但本地没落状态」时重复发一条。
 *
 * ## 连接与事务
 *
 * 所有连接只走 `withDb` / `withWritableDb`；所有状态变更都在 `BEGIN IMMEDIATE`
 * 事务里完成。`(run_id, part_index)` 唯一约束保证重复生成同一个 run 不会重复写入
 * outbox，`(slot, target_message_id)` 唯一约束保证同一入站消息只入队一次。
 *
 * ## 多 worker lease / fencing
 *
 * run 与 outbox 各自保存 `(lease_owner, lease_until, lease_fence)`。claim 在同一
 * `BEGIN IMMEDIATE` 内检查租约并递增 attempts/fence；接管会换 owner 与 fence。
 * 回填必须携带原 claim 的 owner/fence，晚到的旧 owner 只能得到 `null`，不能
 * 覆盖新 owner。原有 `mark*` / `save*` 函数保留给单进程路径。
 *
 * @module query/clawbot/clawbot-reply-store
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from '../db-open.ts'
import { withDb, withWritableDb } from '../db-open.ts'
import { clawbotDbExists, clawbotDbPath, ensureClawbotSchema } from './clawbot-db.ts'

/** 连续入站消息的默认合并窗口。 */
export const DEFAULT_REPLY_DEBOUNCE_MS = 1_000
/** 生成阶段租约：进程崩溃后超过该时间仍停在 generating，恢复器可重新处理。 */
export const REPLY_GENERATING_LEASE_MS = 60_000
/** 发送阶段租约：给发送请求留出足够时间，避免另一个 worker 立刻重复发送。 */
export const REPLY_SENDING_LEASE_MS = 30_000
/** `listRecoverableReplyRuns` 默认单次上限。 */
export const DEFAULT_REPLY_RECOVERABLE_LIMIT = 100
/** `listRecoverableReplyRuns` 单次硬上限。 */
export const MAX_REPLY_RECOVERABLE_LIMIT = 1_000

export type ClawbotReplyRunStatus =
  | 'debouncing'
  | 'queued'
  | 'generating'
  | 'ready'
  | 'sending'
  | 'done'
  | 'failed'
  | 'skipped'

export type ClawbotReplyPartStatus = 'pending' | 'sending' | 'sent' | 'failed'

export interface ClawbotReplyRun {
  id: number
  slot: number
  targetMessageId: number
  question: string
  status: ClawbotReplyRunStatus
  attempts: number
  lastError: string | null
  nextAttemptAt: number
  createdAt: number
  updatedAt: number
}

export interface ClawbotReplyPart {
  id: number
  runId: number
  partIndex: number
  slot: number
  text: string
  clientId: string
  status: ClawbotReplyPartStatus
  attempts: number
  sentMessageId: number | null
  lastError: string | null
  createdAt: number
  updatedAt: number
}

export interface ClawbotReplyRunSnapshot {
  run: ClawbotReplyRun
  parts: ClawbotReplyPart[]
}

/**
 * 一条带 owner 与单调 fence 的租约。
 *
 * `until` 只用于判断接管窗口；真正防止旧 worker 晚到覆盖的是
 * `(owner, fence)` 成对比较。接管时两者一起变化，旧回填即使晚于租约也不会命中。
 */
export interface ClawbotReplyLease {
  owner: string
  fence: number
  until: number
}

export interface ClawbotReplyGenerationClaim {
  run: ClawbotReplyRun
  lease: ClawbotReplyLease
}

export interface ClawbotReplySendClaim {
  part: ClawbotReplyPart
  /** outbox 行上的租约。 */
  lease: ClawbotReplyLease
  /** run 行上的串行化租约，保证同一 run 的多段不被多个 worker 并行发送。 */
  runLease: ClawbotReplyLease
}

export interface ClawbotReplyFailedClaimResult {
  part: ClawbotReplyPart
  run: ClawbotReplyRun
}

export interface ClaimReplyRunGenerationInput {
  runId: number
  owner: string
  now?: number
  leaseMs?: number
}

export interface ClaimReplyPartSendingInput {
  partId: number
  owner: string
  now?: number
  leaseMs?: number
}

export interface EnqueueReplyRunInput {
  slot: number
  targetMessageId: number
  question: string
  debounceMs?: number
  /** 该 slot 允许的非终态 run 上限；缺省/非正数 = 不额外限制。 */
  maxPending?: number
  now?: number
}

/** 分段输入：允许直接传字符串，也允许传带 text 的对象，便于上层保留自己的结构。 */
export type ClawbotReplyPartInput = string | { text: string }

export interface ClearClawbotReplyStateResult {
  removedRuns: number
  removedParts: number
}

const RUN_COLS = 'id, slot, target_message_id, question, status, attempts, last_error, next_attempt_at, created_at, updated_at'
const PART_COLS = 'id, run_id, slot, part_index, text, client_id, status, attempts, sent_message_id, last_error, created_at, updated_at'

const RUN_STATUSES = new Set<ClawbotReplyRunStatus>([
  'debouncing', 'queued', 'generating', 'ready', 'sending', 'done', 'failed', 'skipped',
])
const PART_STATUSES = new Set<ClawbotReplyPartStatus>(['pending', 'sending', 'sent', 'failed'])
const TERMINAL_RUN_STATUSES = new Set<ClawbotReplyRunStatus>(['done', 'failed', 'skipped'])

function positiveInt(value: number, label: string): number {
  const n = Math.floor(value)
  if (!Number.isFinite(n) || n < 1) throw new Error(`${label} 必须是正整数`)
  return n
}

function timestamp(value: number | undefined): number {
  return Number.isFinite(value) ? Math.floor(value as number) : Date.now()
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function claimOwner(value: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('owner 不能为空')
  return value.trim()
}

function leaseDuration(value: number | undefined, fallback: number): number {
  return value === undefined ? fallback : positiveInt(value, 'leaseMs')
}

interface LeaseState {
  owner: string | null
  until: number
  fence: number
}

function leaseState(row: Record<string, unknown>): LeaseState {
  return {
    owner: textOrNull(row['lease_owner']),
    until: Number(row['lease_until'] ?? 0),
    fence: Number(row['lease_fence'] ?? 0),
  }
}

function sameLease(actual: LeaseState, expected: ClawbotReplyLease): boolean {
  return actual.owner === expected.owner && actual.fence === expected.fence
}

function toRun(row: Record<string, unknown>): ClawbotReplyRun {
  const rawStatus = row['status']
  const status = typeof rawStatus === 'string' && RUN_STATUSES.has(rawStatus as ClawbotReplyRunStatus)
    ? rawStatus as ClawbotReplyRunStatus
    : 'queued'
  return {
    id: Number(row['id'] ?? 0),
    slot: Number(row['slot'] ?? 1),
    targetMessageId: Number(row['target_message_id'] ?? 0),
    question: typeof row['question'] === 'string' ? row['question'] : '',
    status,
    attempts: Number(row['attempts'] ?? 0),
    lastError: textOrNull(row['last_error']),
    nextAttemptAt: Number(row['next_attempt_at'] ?? 0),
    createdAt: Number(row['created_at'] ?? 0),
    updatedAt: Number(row['updated_at'] ?? 0),
  }
}

function toPart(row: Record<string, unknown>): ClawbotReplyPart {
  const rawStatus = row['status']
  const status = typeof rawStatus === 'string' && PART_STATUSES.has(rawStatus as ClawbotReplyPartStatus)
    ? rawStatus as ClawbotReplyPartStatus
    : 'pending'
  const sentMessageId = Number(row['sent_message_id'] ?? 0)
  return {
    id: Number(row['id'] ?? 0),
    runId: Number(row['run_id'] ?? 0),
    partIndex: Number(row['part_index'] ?? 0),
    slot: Number(row['slot'] ?? 1),
    text: typeof row['text'] === 'string' ? row['text'] : '',
    clientId: typeof row['client_id'] === 'string' ? row['client_id'] : '',
    status,
    attempts: Number(row['attempts'] ?? 0),
    sentMessageId: Number.isFinite(sentMessageId) && sentMessageId > 0 ? sentMessageId : null,
    lastError: textOrNull(row['last_error']),
    createdAt: Number(row['created_at'] ?? 0),
    updatedAt: Number(row['updated_at'] ?? 0),
  }
}

function readRunOn(db: DatabaseSync, runId: number): ClawbotReplyRun | null {
  const row = db.prepare(`SELECT ${RUN_COLS} FROM clawbot_reply_run WHERE id = ? LIMIT 1`)
    .get(runId) as Record<string, unknown> | undefined
  return row === undefined ? null : toRun(row)
}

function readPartsOn(db: DatabaseSync, runId: number): ClawbotReplyPart[] {
  const rows = db.prepare(`SELECT ${PART_COLS} FROM clawbot_reply_outbox WHERE run_id = ? ORDER BY part_index ASC`)
    .all(runId) as Array<Record<string, unknown>>
  return rows.map(toPart)
}

function readPartOn(db: DatabaseSync, partId: number): ClawbotReplyPart | null {
  const row = db.prepare(`SELECT ${PART_COLS} FROM clawbot_reply_outbox WHERE id = ? LIMIT 1`)
    .get(partId) as Record<string, unknown> | undefined
  return row === undefined ? null : toPart(row)
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(name) !== undefined
}

function writeTx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 回滚失败时保留原始异常 */ }
    throw e
  }
}

function requireRun(db: DatabaseSync, runId: number): ClawbotReplyRun {
  const run = readRunOn(db, runId)
  if (run === null) throw new Error(`回复 run ${runId} 不存在`)
  return run
}

function withRunMutation(
  dir: string,
  runId: number,
  now: number,
  mutate: (db: DatabaseSync, id: number, at: number) => void,
): ClawbotReplyRun {
  const id = positiveInt(runId, 'runId')
  const at = timestamp(now)
  return withWritableDb(clawbotDbPath(dir), (db) => {
    ensureClawbotSchema(db)
    return writeTx(db, () => {
      requireRun(db, id)
      mutate(db, id, at)
      return requireRun(db, id)
    })
  })
}

function withPartMutation(
  dir: string,
  partId: number,
  now: number,
  mutate: (db: DatabaseSync, id: number, at: number, part: ClawbotReplyPart) => void,
): ClawbotReplyPart {
  const id = positiveInt(partId, 'partId')
  const at = timestamp(now)
  return withWritableDb(clawbotDbPath(dir), (db) => {
    ensureClawbotSchema(db)
    return writeTx(db, () => {
      const part = readPartOn(db, id)
      if (part === null) throw new Error(`回复分段 ${id} 不存在`)
      mutate(db, id, at, part)
      const after = readPartOn(db, id)
      /* v8 ignore next -- 上面的 UPDATE 若成功，同一事务内必然还能读到该行。 */
      if (after === null) throw new Error(`回复分段 ${id} 更新后消失`)
      return after
    })
  })
}

function partText(input: ClawbotReplyPartInput): string {
  return typeof input === 'string' ? input : input.text
}

/**
 * 入队或在 debounce 窗口内合并。
 *
 * 同一 `(slot, targetMessageId)` 永远返回已有 run（包括已终态的 run）；否则若本实例
 * 存在尚未到期的 `debouncing` run，就把 target/question/nextAttemptAt 更新为最新触发。
 * 更早消息仍可从 `clawbot_message` 的历史上下文读取。
 */
export function enqueueOrMergeReplyRun(dir: string, input: EnqueueReplyRunInput): ClawbotReplyRun {
  return withWritableDb(clawbotDbPath(dir), (db) => {
    ensureClawbotSchema(db)
    return writeTx(db, () => enqueueOrMergeReplyRunOn(db, input))
  })
}

/**
 * 在调用方已打开的写事务里入队/合并。
 *
 * 接收通道用它在「消息批量落库」的同一事务里创建 run，消除「消息已提交、回复任务
 * 尚未创建」的窗口。调用方负责事先执行 `ensureClawbotSchema` 并提交/回滚事务。
 */
export function enqueueOrMergeReplyRunOn(db: DatabaseSync, input: EnqueueReplyRunInput): ClawbotReplyRun {
  const slot = positiveInt(input.slot, 'slot')
  const targetMessageId = positiveInt(input.targetMessageId, 'targetMessageId')
  const at = timestamp(input.now)
  const debounceMs = Number.isFinite(input.debounceMs)
    ? Math.max(Math.floor(input.debounceMs as number), 0)
    : DEFAULT_REPLY_DEBOUNCE_MS
  const nextAttemptAt = at + debounceMs
  const duplicate = db.prepare('SELECT id FROM clawbot_reply_run WHERE slot = ? AND target_message_id = ? LIMIT 1')
    .get(slot, targetMessageId) as { id?: number } | undefined
  if (duplicate !== undefined) return requireRun(db, Number(duplicate.id))

  const merging = db.prepare(`SELECT id FROM clawbot_reply_run
    WHERE slot = ? AND status = 'debouncing' AND next_attempt_at > ?
    ORDER BY id DESC LIMIT 1`).get(slot, at) as { id?: number } | undefined
  if (merging !== undefined) {
    const id = Number(merging.id)
    db.prepare(`UPDATE clawbot_reply_run
      SET target_message_id = ?, question = ?, next_attempt_at = ?, updated_at = ?
      WHERE id = ?`).run(targetMessageId, input.question, nextAttemptAt, at, id)
    return requireRun(db, id)
  }

  const maxPending = Number.isFinite(input.maxPending) ? Math.floor(input.maxPending as number) : 0
  if (maxPending > 0) {
    const pending = Number((db.prepare(`SELECT COUNT(*) AS n FROM clawbot_reply_run
      WHERE slot = ? AND status IN ('debouncing', 'queued', 'generating', 'ready', 'sending')`)
      .get(slot) as { n?: number } | undefined)?.n ?? 0)
    if (pending >= maxPending) throw new Error(`回复待处理已积压 ${String(maxPending)} 条`)
  }

  const inserted = db.prepare(`INSERT INTO clawbot_reply_run(
    slot, target_message_id, question, status, attempts, last_error, next_attempt_at, created_at, updated_at
  ) VALUES (?, ?, ?, 'debouncing', 0, NULL, ?, ?, ?)`)
    .run(slot, targetMessageId, input.question, nextAttemptAt, at, at)
  return requireRun(db, Number(inserted.lastInsertRowid))
}

/** 读一条 run 及其全部分段；库/表不存在或 run 不存在时返回 null。 */
export function readReplyRun(dir: string, runId: number): ClawbotReplyRunSnapshot | null {
  if (!clawbotDbExists(dir)) return null
  const id = positiveInt(runId, 'runId')
  return withDb(clawbotDbPath(dir), (db) => {
    if (!hasTable(db, 'clawbot_reply_run') || !hasTable(db, 'clawbot_reply_outbox')) return null
    const run = readRunOn(db, id)
    return run === null ? null : { run, parts: readPartsOn(db, id) }
  })
}

/**
 * 列出所有非终态 run。
 *
 * 未来才到期的 run 也会返回：调用方按 `nextAttemptAt` 调度，而不是在 debounce
 * 窗口内重启后把 pending 行漏掉。已到期的行优先，其次按 nextAttemptAt / id 排序。
 */
export function listRecoverableReplyRuns(
  dir: string,
  now: number = Date.now(),
  limit: number = DEFAULT_REPLY_RECOVERABLE_LIMIT,
): ClawbotReplyRun[] {
  if (!clawbotDbExists(dir)) return []
  const at = timestamp(now)
  const max = Math.min(Math.max(Math.floor(limit), 1), MAX_REPLY_RECOVERABLE_LIMIT)
  return withDb(clawbotDbPath(dir), (db) => {
    if (!hasTable(db, 'clawbot_reply_run')) return []
    const rows = db.prepare(`SELECT ${RUN_COLS} FROM clawbot_reply_run
      WHERE status IN ('debouncing', 'queued', 'generating', 'ready', 'sending')
      ORDER BY CASE WHEN next_attempt_at <= ? THEN 0 ELSE 1 END,
               next_attempt_at ASC, id ASC
      LIMIT ?`).all(at, max) as Array<Record<string, unknown>>
    return rows.map(toRun)
  })
}

/**
 * 按单调 id 游标分页读取全部非终态 run。
 *
 * 恢复器需要吸收超过单页上限的积压，不能按 next_attempt_at 做游标：同一时间窗口内
 * run 可能被更新或新增，非单调排序会造成漏行。此函数只按自增 id 前进，并保留旧版
 * `listRecoverableReplyRuns` 的默认行为不变。
 */
export function listRecoverableReplyRunsAfterId(
  dir: string,
  afterId: number = 0,
  limit: number = DEFAULT_REPLY_RECOVERABLE_LIMIT,
): ClawbotReplyRun[] {
  if (!clawbotDbExists(dir)) return []
  const cursor = Number.isFinite(afterId) ? Math.max(Math.floor(afterId), 0) : 0
  const max = Math.min(Math.max(Math.floor(limit), 1), MAX_REPLY_RECOVERABLE_LIMIT)
  return withDb(clawbotDbPath(dir), (db) => {
    if (!hasTable(db, 'clawbot_reply_run')) return []
    const rows = db.prepare(`SELECT ${RUN_COLS} FROM clawbot_reply_run
      WHERE status IN ('debouncing', 'queued', 'generating', 'ready', 'sending')
        AND id > ?
      ORDER BY id ASC
      LIMIT ?`).all(cursor, max) as Array<Record<string, unknown>>
    return rows.map(toRun)
  })
}

/**
 * 原子 claim 一次生成权。
 *
 * 候选必须满足：状态可生成、已到 nextAttemptAt、当前租约已过期、尚无 outbox。
 * 所有判断与 `attempts + 1 / owner / until / fence` 更新都在同一个
 * `BEGIN IMMEDIATE` 事务里完成；未抢到或 lease 仍有效时返回 null。
 */
export function claimReplyRunGeneration(
  dir: string,
  input: ClaimReplyRunGenerationInput,
): ClawbotReplyGenerationClaim | null {
  const id = positiveInt(input.runId, 'runId')
  const owner = claimOwner(input.owner)
  const at = timestamp(input.now)
  const leaseMs = leaseDuration(input.leaseMs, REPLY_GENERATING_LEASE_MS)
  const until = at + leaseMs
  return withWritableDb(clawbotDbPath(dir), (db) => {
    ensureClawbotSchema(db)
    return writeTx(db, () => {
      const before = db.prepare('SELECT lease_fence FROM clawbot_reply_run WHERE id = ? LIMIT 1')
        .get(id) as { lease_fence?: number } | undefined
      if (before === undefined) return null
      const updated = db.prepare(`UPDATE clawbot_reply_run
        SET status = 'generating',
            attempts = attempts + 1,
            lease_owner = ?,
            lease_until = ?,
            lease_fence = lease_fence + 1,
            updated_at = ?
        WHERE id = ?
          AND status IN ('debouncing', 'queued', 'generating')
          AND next_attempt_at <= ?
          AND lease_until <= ?
          AND NOT EXISTS (SELECT 1 FROM clawbot_reply_outbox WHERE run_id = ?)`)
        .run(owner, until, at, id, at, at, id)
      if (Number(updated.changes) !== 1) return null
      return {
        run: requireRun(db, id),
        lease: { owner, fence: Number(before.lease_fence ?? 0) + 1, until },
      }
    })
  })
}

/**
 * 原子 claim 一条 outbox 发送权。
 *
 * 同时占用 part 与 run 两层租约：part 防同一段重复发送，run 防同一回复的多段被
 * 多个 worker 并行乱序发送。两层都过期后才能被另一个 owner 接管。
 */
export function claimReplyPartSending(
  dir: string,
  input: ClaimReplyPartSendingInput,
): ClawbotReplySendClaim | null {
  const id = positiveInt(input.partId, 'partId')
  const owner = claimOwner(input.owner)
  const at = timestamp(input.now)
  const leaseMs = leaseDuration(input.leaseMs, REPLY_SENDING_LEASE_MS)
  const until = at + leaseMs
  return withWritableDb(clawbotDbPath(dir), (db) => {
    ensureClawbotSchema(db)
    return writeTx(db, () => {
      const before = db.prepare(`SELECT p.run_id, p.status AS part_status,
          p.lease_until AS part_lease_until, p.lease_fence AS part_fence,
          r.status AS run_status, r.next_attempt_at AS run_next_attempt_at,
          r.lease_until AS run_lease_until, r.lease_fence AS run_fence
        FROM clawbot_reply_outbox p
        JOIN clawbot_reply_run r ON r.id = p.run_id
        WHERE p.id = ? LIMIT 1`).get(id) as {
          run_id?: number
          part_status?: string
          part_lease_until?: number
          part_fence?: number
          run_status?: string
          run_next_attempt_at?: number
          run_lease_until?: number
          run_fence?: number
        } | undefined
      if (before === undefined) return null
      const runId = Number(before.run_id ?? 0)
      if (TERMINAL_RUN_STATUSES.has(before.run_status as ClawbotReplyRunStatus)) return null
      if (before.part_status !== 'pending' && before.part_status !== 'sending') return null
      if (Number(before.part_lease_until ?? 0) > at) return null
      if (Number(before.run_lease_until ?? 0) > at) return null
      if (Number(before.run_next_attempt_at ?? 0) > at) return null
      const partUpdated = db.prepare(`UPDATE clawbot_reply_outbox
        SET status = 'sending',
            attempts = attempts + 1,
            lease_owner = ?,
            lease_until = ?,
            lease_fence = lease_fence + 1,
            updated_at = ?
        WHERE id = ?
          AND status IN ('pending', 'sending')
          AND lease_until <= ?`)
        .run(owner, until, at, id, at)
      if (Number(partUpdated.changes) !== 1) return null
      const runUpdated = db.prepare(`UPDATE clawbot_reply_run
        SET status = 'sending',
            lease_owner = ?,
            lease_until = ?,
            lease_fence = lease_fence + 1,
            updated_at = ?
        WHERE id = ?
          AND status NOT IN ('done', 'failed', 'skipped')
          AND next_attempt_at <= ?
          AND lease_until <= ?`)
        .run(owner, until, at, runId, at, at)
      if (Number(runUpdated.changes) !== 1) throw new Error(`回复 run ${runId} 状态已变化，发送 claim 已回滚`)
      const part = readPartOn(db, id)
      /* v8 ignore next -- 同一事务内刚更新过的 outbox 行必然可读。 */
      if (part === null) throw new Error(`回复分段 ${id} claim 后消失`)
      return {
        part,
        lease: { owner, fence: Number(before.part_fence ?? 0) + 1, until },
        runLease: { owner, fence: Number(before.run_fence ?? 0) + 1, until },
      }
    })
  })
}

/**
 * 续租生成 claim。
 *
 * 续租只在 owner/fence 仍匹配时成功；进程崩溃或已被接管后返回 null。
 * 续租不改变 fence，避免把同一 owner 的正常长任务误判为竞争者。
 */
export function renewReplyRunGenerationClaim(
  dir: string,
  claim: ClawbotReplyGenerationClaim,
  leaseMs: number = REPLY_GENERATING_LEASE_MS,
  now: number = Date.now(),
): ClawbotReplyGenerationClaim | null {
  const id = positiveInt(claim.run.id, 'runId')
  const ms = leaseDuration(leaseMs, REPLY_GENERATING_LEASE_MS)
  const at = timestamp(now)
  const until = at + ms
  return withWritableDb(clawbotDbPath(dir), (db) => {
    ensureClawbotSchema(db)
    return writeTx(db, () => {
      const row = db.prepare(`SELECT status, lease_owner, lease_until, lease_fence
        FROM clawbot_reply_run WHERE id = ? LIMIT 1`).get(id) as Record<string, unknown> | undefined
      if (row === undefined || row['status'] !== 'generating') return null
      if (!sameLease(leaseState(row), claim.lease)) return null
      const updated = db.prepare(`UPDATE clawbot_reply_run
        SET lease_until = ?, updated_at = ?
        WHERE id = ? AND status = 'generating'
          AND lease_owner = ? AND lease_fence = ?`)
        .run(until, at, id, claim.lease.owner, claim.lease.fence)
      if (Number(updated.changes) !== 1) return null
      return {
        run: requireRun(db, id),
        lease: { ...claim.lease, until },
      }
    })
  })
}

/**
 * 续租发送 claim（part + run 两层）。
 *
 * 只有当前 owner/fence 仍持有两层租约时才续租；任一层被接管都返回 null。
 */
export function renewReplyPartSendingClaim(
  dir: string,
  claim: ClawbotReplySendClaim,
  leaseMs: number = REPLY_SENDING_LEASE_MS,
  now: number = Date.now(),
): ClawbotReplySendClaim | null {
  const id = positiveInt(claim.part.id, 'partId')
  const ms = leaseDuration(leaseMs, REPLY_SENDING_LEASE_MS)
  const at = timestamp(now)
  const until = at + ms
  return withWritableDb(clawbotDbPath(dir), (db) => {
    ensureClawbotSchema(db)
    return writeTx(db, () => {
      const partRow = db.prepare(`SELECT run_id, status, lease_owner, lease_until, lease_fence
        FROM clawbot_reply_outbox WHERE id = ? LIMIT 1`).get(id) as Record<string, unknown> | undefined
      if (partRow === undefined || partRow['status'] !== 'sending') return null
      if (!sameLease(leaseState(partRow), claim.lease)) return null
      const runId = Number(partRow['run_id'] ?? 0)
      const runRow = db.prepare(`SELECT status, lease_owner, lease_until, lease_fence
        FROM clawbot_reply_run WHERE id = ? LIMIT 1`).get(runId) as Record<string, unknown> | undefined
      if (runRow === undefined || runRow['status'] !== 'sending') return null
      if (!sameLease(leaseState(runRow), claim.runLease)) return null

      const partUpdated = db.prepare(`UPDATE clawbot_reply_outbox
        SET lease_until = ?, updated_at = ?
        WHERE id = ? AND status = 'sending'
          AND lease_owner = ? AND lease_fence = ?`)
        .run(until, at, id, claim.lease.owner, claim.lease.fence)
      if (Number(partUpdated.changes) !== 1) return null
      const runUpdated = db.prepare(`UPDATE clawbot_reply_run
        SET lease_until = ?, updated_at = ?
        WHERE id = ? AND status = 'sending'
          AND lease_owner = ? AND lease_fence = ?`)
        .run(until, at, runId, claim.runLease.owner, claim.runLease.fence)
      if (Number(runUpdated.changes) !== 1) {
        throw new Error(`回复 run ${runId} 发送续租已回滚`)
      }
      const part = readPartOn(db, id)
      /* v8 ignore next -- 同一事务内刚续租成功的 outbox 行必然可读。 */
      if (part === null) throw new Error(`回复分段 ${id} 续租后消失`)
      return {
        part,
        lease: { ...claim.lease, until },
        runLease: { ...claim.runLease, until },
      }
    })
  })
}

/**
 * 在生成 claim 的 fencing 保护下写入分段。
 *
 * 旧 owner 在租约过期、另一 worker 接管后调用会返回 null 且不写任何行。
 * 同一 claim 重复提交是幂等的：run 已 ready 时直接返回现有分段。
 */
export function saveReplyPartsClaimed(
  dir: string,
  claim: ClawbotReplyGenerationClaim,
  parts: readonly ClawbotReplyPartInput[],
  now: number = Date.now(),
): ClawbotReplyPart[] | null {
  const id = positiveInt(claim.run.id, 'runId')
  const at = timestamp(now)
  return withWritableDb(clawbotDbPath(dir), (db) => {
    ensureClawbotSchema(db)
    return writeTx(db, () => {
      const row = db.prepare(`SELECT status, lease_owner, lease_until, lease_fence
        FROM clawbot_reply_run WHERE id = ? LIMIT 1`).get(id) as Record<string, unknown> | undefined
      if (row === undefined) return null
      const lease = leaseState(row)
      if (!sameLease(lease, claim.lease)) return null
      const status = row['status']
      if (status === 'ready') return readPartsOn(db, id)
      if (status !== 'generating') return null
      const run = requireRun(db, id)
      const saved = saveReplyPartsOn(db, run, parts, at)
      const updated = db.prepare(`UPDATE clawbot_reply_run
        SET status = 'ready', next_attempt_at = ?, lease_until = 0, updated_at = ?
        WHERE id = ? AND status = 'generating'
          AND lease_owner = ? AND lease_fence = ?`)
        .run(at, at, id, claim.lease.owner, claim.lease.fence)
      if (Number(updated.changes) !== 1) throw new Error(`回复 run ${id} 生成 claim 已变化，分段写入已回滚`)
      return saved
    })
  })
}

/** fenced 生成失败回退；旧 owner 返回 null，不覆盖接管者。 */
export function markReplyRunRetryClaimed(
  dir: string,
  claim: ClawbotReplyGenerationClaim,
  error: string | null = null,
  nextAttemptAt?: number,
  now: number = Date.now(),
): ClawbotReplyRun | null {
  const id = positiveInt(claim.run.id, 'runId')
  const at = timestamp(now)
  const next = timestamp(nextAttemptAt ?? at)
  return withWritableDb(clawbotDbPath(dir), (db) => {
    ensureClawbotSchema(db)
    return writeTx(db, () => {
      const row = db.prepare(`SELECT status, lease_owner, lease_until, lease_fence
        FROM clawbot_reply_run WHERE id = ? LIMIT 1`).get(id) as Record<string, unknown> | undefined
      if (row === undefined) return null
      const lease = leaseState(row)
      if (!sameLease(lease, claim.lease)) return null
      if (row['status'] === 'queued') return requireRun(db, id)
      if (row['status'] !== 'generating') return null
      const updated = db.prepare(`UPDATE clawbot_reply_run
        SET status = 'queued', last_error = ?, next_attempt_at = ?, lease_until = 0, updated_at = ?
        WHERE id = ? AND status = 'generating'
          AND lease_owner = ? AND lease_fence = ?`)
        .run(error, next, at, id, claim.lease.owner, claim.lease.fence)
      if (Number(updated.changes) !== 1) return null
      return requireRun(db, id)
    })
  })
}

/** fenced 生成永久失败；旧 owner 返回 null。 */
export function markReplyRunFailedClaimed(
  dir: string,
  claim: ClawbotReplyGenerationClaim,
  error: string | null = null,
  now: number = Date.now(),
): ClawbotReplyRun | null {
  const id = positiveInt(claim.run.id, 'runId')
  const at = timestamp(now)
  return withWritableDb(clawbotDbPath(dir), (db) => {
    ensureClawbotSchema(db)
    return writeTx(db, () => {
      const row = db.prepare(`SELECT status, lease_owner, lease_until, lease_fence
        FROM clawbot_reply_run WHERE id = ? LIMIT 1`).get(id) as Record<string, unknown> | undefined
      if (row === undefined) return null
      const lease = leaseState(row)
      if (!sameLease(lease, claim.lease)) return null
      if (row['status'] === 'failed') return requireRun(db, id)
      if (row['status'] !== 'generating') return null
      const updated = db.prepare(`UPDATE clawbot_reply_run
        SET status = 'failed', last_error = ?, next_attempt_at = ?, lease_until = 0, updated_at = ?
        WHERE id = ? AND status = 'generating'
          AND lease_owner = ? AND lease_fence = ?`)
        .run(error, at, at, id, claim.lease.owner, claim.lease.fence)
      if (Number(updated.changes) !== 1) return null
      return requireRun(db, id)
    })
  })
}

/** fenced 策略跳过；旧 owner 返回 null，不覆盖接管者。 */
export function markReplyRunSkippedClaimed(
  dir: string,
  claim: ClawbotReplyGenerationClaim,
  reason: string | null = null,
  now: number = Date.now(),
): ClawbotReplyRun | null {
  const id = positiveInt(claim.run.id, 'runId')
  const at = timestamp(now)
  return withWritableDb(clawbotDbPath(dir), (db) => {
    ensureClawbotSchema(db)
    return writeTx(db, () => {
      const row = db.prepare(`SELECT status, lease_owner, lease_until, lease_fence
        FROM clawbot_reply_run WHERE id = ? LIMIT 1`).get(id) as Record<string, unknown> | undefined
      if (row === undefined) return null
      if (!sameLease(leaseState(row), claim.lease)) return null
      if (row['status'] === 'skipped') return requireRun(db, id)
      if (TERMINAL_RUN_STATUSES.has(row['status'] as ClawbotReplyRunStatus)) return null
      if (row['status'] !== 'generating') return null
      const updated = db.prepare(`UPDATE clawbot_reply_run
        SET status = 'skipped', last_error = ?, next_attempt_at = ?, lease_until = 0, updated_at = ?
        WHERE id = ? AND status = 'generating'
          AND lease_owner = ? AND lease_fence = ?`)
        .run(reason, at, at, id, claim.lease.owner, claim.lease.fence)
      if (Number(updated.changes) !== 1) return null
      return requireRun(db, id)
    })
  })
}

/**
 * 在发送 claim 的 fencing 保护下标记 success。
 *
 * 旧 owner 在 lease 过期并被接管后调用会返回 null；新 owner 的 sent 状态不会被覆盖。
 * 成功后只释放 `lease_until`，保留 owner/fence 供随后的 run done/failed 做二次校验。
 */
export function markReplyPartSentClaimed(
  dir: string,
  claim: ClawbotReplySendClaim,
  sentMessageId: number | null = null,
  now: number = Date.now(),
): ClawbotReplyPart | null {
  const id = positiveInt(claim.part.id, 'partId')
  const at = timestamp(now)
  const sent = sentMessageId !== null && Number.isFinite(sentMessageId) && sentMessageId > 0
    ? Math.floor(sentMessageId)
    : null
  return withWritableDb(clawbotDbPath(dir), (db) => {
    ensureClawbotSchema(db)
    return writeTx(db, () => {
      const partRow = db.prepare(`SELECT run_id, status, lease_owner, lease_until, lease_fence
        FROM clawbot_reply_outbox WHERE id = ? LIMIT 1`).get(id) as Record<string, unknown> | undefined
      if (partRow === undefined) return null
      const partLease = leaseState(partRow)
      if (!sameLease(partLease, claim.lease)) return null
      if (partRow['status'] === 'sent') return readPartOn(db, id)
      if (partRow['status'] !== 'sending') return null

      const runId = Number(partRow['run_id'] ?? 0)
      const runRow = db.prepare(`SELECT status, lease_owner, lease_until, lease_fence
        FROM clawbot_reply_run WHERE id = ? LIMIT 1`).get(runId) as Record<string, unknown> | undefined
      if (runRow === undefined) return null
      const runLease = leaseState(runRow)
      if (!sameLease(runLease, claim.runLease)) return null
      if (TERMINAL_RUN_STATUSES.has(runRow['status'] as ClawbotReplyRunStatus)) return null

      const partUpdated = db.prepare(`UPDATE clawbot_reply_outbox
        SET status = 'sent',
            sent_message_id = COALESCE(sent_message_id, ?),
            last_error = NULL,
            lease_until = 0,
            updated_at = ?
        WHERE id = ? AND status = 'sending'
          AND lease_owner = ? AND lease_fence = ?`)
        .run(sent, at, id, claim.lease.owner, claim.lease.fence)
      if (Number(partUpdated.changes) !== 1) return null
      const runUpdated = db.prepare(`UPDATE clawbot_reply_run
        SET next_attempt_at = ?, lease_until = 0, updated_at = ?
        WHERE id = ? AND lease_owner = ? AND lease_fence = ?
          AND status NOT IN ('done', 'failed', 'skipped')`)
        .run(at, at, runId, claim.runLease.owner, claim.runLease.fence)
      if (Number(runUpdated.changes) !== 1) throw new Error(`回复 run ${runId} 发送 claim 已变化，sent 回填已回滚`)
      return readPartOn(db, id)
    })
  })
}

/** fenced 发送可重试失败；旧 owner 返回 null，不覆盖接管者。 */
export function markReplyPartRetryClaimed(
  dir: string,
  claim: ClawbotReplySendClaim,
  error: string | null = null,
  nextAttemptAt?: number,
  now: number = Date.now(),
): ClawbotReplyPart | null {
  const id = positiveInt(claim.part.id, 'partId')
  const at = timestamp(now)
  const next = timestamp(nextAttemptAt ?? at)
  return withWritableDb(clawbotDbPath(dir), (db) => {
    ensureClawbotSchema(db)
    return writeTx(db, () => {
      const partRow = db.prepare(`SELECT run_id, status, lease_owner, lease_until, lease_fence
        FROM clawbot_reply_outbox WHERE id = ? LIMIT 1`).get(id) as Record<string, unknown> | undefined
      if (partRow === undefined) return null
      const partLease = leaseState(partRow)
      if (!sameLease(partLease, claim.lease)) return null
      if (partRow['status'] === 'pending') return readPartOn(db, id)
      if (partRow['status'] !== 'sending') return null

      const runId = Number(partRow['run_id'] ?? 0)
      const runRow = db.prepare(`SELECT status, lease_owner, lease_until, lease_fence
        FROM clawbot_reply_run WHERE id = ? LIMIT 1`).get(runId) as Record<string, unknown> | undefined
      if (runRow === undefined) return null
      const runLease = leaseState(runRow)
      if (!sameLease(runLease, claim.runLease)) return null
      if (TERMINAL_RUN_STATUSES.has(runRow['status'] as ClawbotReplyRunStatus)) return null

      const partUpdated = db.prepare(`UPDATE clawbot_reply_outbox
        SET status = 'pending', last_error = ?, lease_until = 0, updated_at = ?
        WHERE id = ? AND status = 'sending'
          AND lease_owner = ? AND lease_fence = ?`)
        .run(error, at, id, claim.lease.owner, claim.lease.fence)
      if (Number(partUpdated.changes) !== 1) return null
      const runUpdated = db.prepare(`UPDATE clawbot_reply_run
        SET status = 'ready', last_error = ?, next_attempt_at = ?, lease_until = 0, updated_at = ?
        WHERE id = ? AND lease_owner = ? AND lease_fence = ?
          AND status NOT IN ('done', 'failed', 'skipped')`)
        .run(error, next, at, runId, claim.runLease.owner, claim.runLease.fence)
      if (Number(runUpdated.changes) !== 1) throw new Error(`回复 run ${runId} 发送 claim 已变化，retry 回填已回滚`)
      return readPartOn(db, id)
    })
  })
}

/** fenced 发送永久失败；旧 owner 返回 null。 */
export function markReplyPartFailedClaimed(
  dir: string,
  claim: ClawbotReplySendClaim,
  error: string | null = null,
  now: number = Date.now(),
): ClawbotReplyPart | null {
  const id = positiveInt(claim.part.id, 'partId')
  const at = timestamp(now)
  return withWritableDb(clawbotDbPath(dir), (db) => {
    ensureClawbotSchema(db)
    return writeTx(db, () => {
      const partRow = db.prepare(`SELECT run_id, status, lease_owner, lease_until, lease_fence
        FROM clawbot_reply_outbox WHERE id = ? LIMIT 1`).get(id) as Record<string, unknown> | undefined
      if (partRow === undefined) return null
      const partLease = leaseState(partRow)
      if (!sameLease(partLease, claim.lease)) return null
      if (partRow['status'] === 'failed') return readPartOn(db, id)
      if (partRow['status'] !== 'sending') return null

      const runId = Number(partRow['run_id'] ?? 0)
      const runRow = db.prepare(`SELECT status, lease_owner, lease_until, lease_fence
        FROM clawbot_reply_run WHERE id = ? LIMIT 1`).get(runId) as Record<string, unknown> | undefined
      if (runRow === undefined) return null
      const runLease = leaseState(runRow)
      if (!sameLease(runLease, claim.runLease)) return null
      if (TERMINAL_RUN_STATUSES.has(runRow['status'] as ClawbotReplyRunStatus)) return null

      const partUpdated = db.prepare(`UPDATE clawbot_reply_outbox
        SET status = 'failed', last_error = ?, lease_until = 0, updated_at = ?
        WHERE id = ? AND status = 'sending'
          AND lease_owner = ? AND lease_fence = ?`)
        .run(error, at, id, claim.lease.owner, claim.lease.fence)
      if (Number(partUpdated.changes) !== 1) return null
      const runUpdated = db.prepare(`UPDATE clawbot_reply_run
        SET next_attempt_at = ?, lease_until = 0, updated_at = ?
        WHERE id = ? AND lease_owner = ? AND lease_fence = ?
          AND status NOT IN ('done', 'failed', 'skipped')`)
        .run(at, at, runId, claim.runLease.owner, claim.runLease.fence)
      if (Number(runUpdated.changes) !== 1) throw new Error(`回复 run ${runId} 发送 claim 已变化，failed 回填已回滚`)
      return readPartOn(db, id)
    })
  })
}

/**
 * 同一事务内终结失败分段与其 run，消除“part 已 failed、run 仍 sending”的崩溃窗口。
 *
 * 任一层 owner/fence 不匹配都会整体返回 null；不会出现只写一半的状态。
 */
export function failReplyPartAndRunClaimed(
  dir: string,
  claim: ClawbotReplySendClaim,
  error: string | null = null,
  now: number = Date.now(),
): ClawbotReplyFailedClaimResult | null {
  const id = positiveInt(claim.part.id, 'partId')
  const at = timestamp(now)
  return withWritableDb(clawbotDbPath(dir), (db) => {
    ensureClawbotSchema(db)
    return writeTx(db, () => {
      const partRow = db.prepare(`SELECT run_id, status, lease_owner, lease_until, lease_fence
        FROM clawbot_reply_outbox WHERE id = ? LIMIT 1`).get(id) as Record<string, unknown> | undefined
      if (partRow === undefined) return null
      const partLease = leaseState(partRow)
      if (!sameLease(partLease, claim.lease)) return null
      const runId = Number(partRow['run_id'] ?? 0)
      const runRow = db.prepare(`SELECT status, lease_owner, lease_until, lease_fence
        FROM clawbot_reply_run WHERE id = ? LIMIT 1`).get(runId) as Record<string, unknown> | undefined
      if (runRow === undefined) return null
      if (!sameLease(leaseState(runRow), claim.runLease)) return null

      if (partRow['status'] === 'failed' && runRow['status'] === 'failed') {
        return { part: readPartOn(db, id) as ClawbotReplyPart, run: requireRun(db, runId) }
      }
      if (partRow['status'] !== 'sending') return null
      if (TERMINAL_RUN_STATUSES.has(runRow['status'] as ClawbotReplyRunStatus)) return null

      const partUpdated = db.prepare(`UPDATE clawbot_reply_outbox
        SET status = 'failed', last_error = ?, lease_until = 0, updated_at = ?
        WHERE id = ? AND status = 'sending'
          AND lease_owner = ? AND lease_fence = ?`)
        .run(error, at, id, claim.lease.owner, claim.lease.fence)
      if (Number(partUpdated.changes) !== 1) return null
      const runUpdated = db.prepare(`UPDATE clawbot_reply_run
        SET status = 'failed', last_error = ?, next_attempt_at = ?,
            lease_until = 0, updated_at = ?
        WHERE id = ? AND status NOT IN ('done', 'failed', 'skipped')
          AND lease_owner = ? AND lease_fence = ?`)
        .run(error, at, at, runId, claim.runLease.owner, claim.runLease.fence)
      if (Number(runUpdated.changes) !== 1) {
        throw new Error(`回复 run ${runId} 发送 claim 已变化，失败回填已回滚`)
      }
      const part = readPartOn(db, id)
      /* v8 ignore next -- 同一事务内刚更新过的 outbox 行必然可读。 */
      if (part === null) throw new Error(`回复分段 ${id} failed 后消失`)
      return { part, run: requireRun(db, runId) }
    })
  })
}

function markReplyRunTerminalClaimed(
  dir: string,
  claim: ClawbotReplySendClaim,
  status: 'done' | 'failed',
  error: string | null,
  now: number,
): ClawbotReplyRun | null {
  const runId = positiveInt(claim.part.runId, 'runId')
  const at = timestamp(now)
  return withWritableDb(clawbotDbPath(dir), (db) => {
    ensureClawbotSchema(db)
    return writeTx(db, () => {
      const row = db.prepare(`SELECT status, lease_owner, lease_until, lease_fence
        FROM clawbot_reply_run WHERE id = ? LIMIT 1`).get(runId) as Record<string, unknown> | undefined
      if (row === undefined) return null
      if (!sameLease(leaseState(row), claim.runLease)) return null
      if (row['status'] === status) return requireRun(db, runId)
      if (TERMINAL_RUN_STATUSES.has(row['status'] as ClawbotReplyRunStatus)) return null
      if (status === 'done') {
        const unsent = Number((db.prepare(`SELECT COUNT(*) AS n FROM clawbot_reply_outbox
          WHERE run_id = ? AND status <> 'sent'`).get(runId) as { n?: number } | undefined)?.n ?? 0)
        if (unsent > 0) return null
      }
      db.prepare(`UPDATE clawbot_reply_run
        SET status = ?, last_error = ?, next_attempt_at = ?, lease_until = 0, updated_at = ?
        WHERE id = ? AND lease_owner = ? AND lease_fence = ?`)
        .run(status, error, at, at, runId, claim.runLease.owner, claim.runLease.fence)
      return requireRun(db, runId)
    })
  })
}

/**
 * 全部 outbox 已 sent 后结束 run。
 *
 * 这里不要求 lease 尚未过期：sent/failed 回填会保留 owner/fence 并把 until 归零，
 * 后续收尾仍由同一 claim 完成；一旦别的 worker 接管，owner/fence 已变，本函数返回 null。
 */
export function markReplyRunDoneClaimed(
  dir: string,
  claim: ClawbotReplySendClaim,
  now: number = Date.now(),
): ClawbotReplyRun | null {
  return markReplyRunTerminalClaimed(dir, claim, 'done', null, now)
}

/** 发送阶段整条 run 永久失败；同样受最后一次 send claim 的 owner/fence 保护。 */
export function markReplyRunFailedAfterSendClaimed(
  dir: string,
  claim: ClawbotReplySendClaim,
  error: string | null = null,
  now: number = Date.now(),
): ClawbotReplyRun | null {
  return markReplyRunTerminalClaimed(dir, claim, 'failed', error, now)
}

/** 开始一次生成尝试；attempts 加一，并设置生成租约。 */
export function markReplyRunGenerating(dir: string, runId: number, now: number = Date.now()): ClawbotReplyRun {
  return withRunMutation(dir, runId, now, (db, id, at) => {
    db.prepare(`UPDATE clawbot_reply_run
      SET status = 'generating', attempts = attempts + 1, next_attempt_at = ?,
          lease_owner = NULL, lease_until = ?, updated_at = ?
      WHERE id = ?`).run(at + REPLY_GENERATING_LEASE_MS, at + REPLY_GENERATING_LEASE_MS, at, id)
  })
}

/** 生成失败后回到 queued，并记录下一次尝试时间。 */
export function markReplyRunRetry(
  dir: string,
  runId: number,
  error: string | null = null,
  nextAttemptAt?: number,
  now: number = Date.now(),
): ClawbotReplyRun {
  return withRunMutation(dir, runId, now, (db, id, at) => {
    const next = timestamp(nextAttemptAt ?? at)
    db.prepare(`UPDATE clawbot_reply_run
      SET status = 'queued', last_error = ?, next_attempt_at = ?,
          lease_owner = NULL, lease_until = 0, updated_at = ?
      WHERE id = ?`).run(error, next, at, id)
  })
}

/** run 完成。 */
export function markReplyRunDone(dir: string, runId: number, now: number = Date.now()): ClawbotReplyRun {
  return withRunMutation(dir, runId, now, (db, id, at) => {
    db.prepare(`UPDATE clawbot_reply_run
      SET status = 'done', last_error = NULL, next_attempt_at = ?,
          lease_owner = NULL, lease_until = 0, updated_at = ?
      WHERE id = ?`).run(at, at, id)
  })
}

/** run 永久失败。 */
export function markReplyRunFailed(
  dir: string,
  runId: number,
  error: string | null = null,
  now: number = Date.now(),
): ClawbotReplyRun {
  return withRunMutation(dir, runId, now, (db, id, at) => {
    db.prepare(`UPDATE clawbot_reply_run
      SET status = 'failed', last_error = ?, next_attempt_at = ?,
          lease_owner = NULL, lease_until = 0, updated_at = ?
      WHERE id = ?`).run(error, at, at, id)
  })
}

/** run 被策略跳过。 */
export function markReplyRunSkipped(
  dir: string,
  runId: number,
  reason: string | null = null,
  now: number = Date.now(),
): ClawbotReplyRun {
  return withRunMutation(dir, runId, now, (db, id, at) => {
    db.prepare(`UPDATE clawbot_reply_run
      SET status = 'skipped', last_error = ?, next_attempt_at = ?,
          lease_owner = NULL, lease_until = 0, updated_at = ?
      WHERE id = ?`).run(reason, at, at, id)
  })
}

/**
 * 无 claim 的收尾路径：只在 run 与全部 outbox 都没有活动租约时落终态。
 *
 * worker B 看到“配置已关闭 / 分段已失败 / 全部已发送”时，worker A 可能仍在发送。
 * 此时不能无 fencing 地覆盖 owner/fence；返回 null 让调用方稍后重试。
 */
function markReplyRunTerminalIfIdle(
  dir: string,
  runId: number,
  status: 'done' | 'failed' | 'skipped',
  error: string | null,
  now: number,
): ClawbotReplyRun | null {
  const id = positiveInt(runId, 'runId')
  const at = timestamp(now)
  return withWritableDb(clawbotDbPath(dir), (db) => {
    ensureClawbotSchema(db)
    return writeTx(db, () => {
      const row = db.prepare(`SELECT status, lease_until FROM clawbot_reply_run
        WHERE id = ? LIMIT 1`).get(id) as { status?: string, lease_until?: number } | undefined
      if (row === undefined) return null
      if (TERMINAL_RUN_STATUSES.has(row.status as ClawbotReplyRunStatus)) {
        return row.status === status ? requireRun(db, id) : null
      }
      if (Number(row.lease_until ?? 0) > at) return null
      const activeParts = Number((db.prepare(`SELECT COUNT(*) AS n FROM clawbot_reply_outbox
        WHERE run_id = ? AND lease_until > ?`).get(id, at) as { n?: number } | undefined)?.n ?? 0)
      if (activeParts > 0) return null
      const counts = db.prepare(`SELECT
          SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
          SUM(CASE WHEN status IN ('pending', 'sending') THEN 1 ELSE 0 END) AS pending
        FROM clawbot_reply_outbox WHERE run_id = ?`).get(id) as {
          sent?: number
          failed?: number
          pending?: number
        } | undefined
      const sent = Number(counts?.sent ?? 0)
      const failed = Number(counts?.failed ?? 0)
      const pending = Number(counts?.pending ?? 0)
      if (status === 'done') {
        if (pending > 0 || failed > 0) return null
      }
      if (status === 'failed') {
        if (failed === 0) return null
      }
      if (status === 'skipped') {
        if (failed > 0 || pending === 0) return null
      }
      const updated = db.prepare(`UPDATE clawbot_reply_run
        SET status = ?, last_error = ?, next_attempt_at = ?,
            lease_owner = NULL, lease_until = 0, updated_at = ?
        WHERE id = ?
          AND status NOT IN ('done', 'failed', 'skipped')
          AND lease_until <= ?
          AND NOT EXISTS (
            SELECT 1 FROM clawbot_reply_outbox
            WHERE run_id = ? AND lease_until > ?
          )`).run(status, error, at, at, id, at, id, at)
      if (Number(updated.changes) !== 1) return null
      return requireRun(db, id)
    })
  })
}

/** 全部 outbox 已 sent 且无人持租约时完成 run。 */
export function markReplyRunDoneIfIdle(
  dir: string,
  runId: number,
  now: number = Date.now(),
): ClawbotReplyRun | null {
  return markReplyRunTerminalIfIdle(dir, runId, 'done', null, now)
}

/** 无活动 claim 时把 run 标记为永久失败。 */
export function markReplyRunFailedIfIdle(
  dir: string,
  runId: number,
  error: string | null = null,
  now: number = Date.now(),
): ClawbotReplyRun | null {
  return markReplyRunTerminalIfIdle(dir, runId, 'failed', error, now)
}

/** 无活动 claim 时按策略跳过 run。 */
export function markReplyRunSkippedIfIdle(
  dir: string,
  runId: number,
  reason: string | null = null,
  now: number = Date.now(),
): ClawbotReplyRun | null {
  return markReplyRunTerminalIfIdle(dir, runId, 'skipped', reason, now)
}

/**
 * 幂等写入一个 run 的全部分段，并把 run 置为 ready。
 *
 * 已存在的 `(run_id, part_index)` 原样保留：不重新生成 client_id，也不覆盖已发送状态。
 * 新分段在同一事务内生成一次 client_id 并落库。
 */
function saveReplyPartsOn(
  db: DatabaseSync,
  run: ClawbotReplyRun,
  parts: readonly ClawbotReplyPartInput[],
  at: number,
): ClawbotReplyPart[] {
  const existing = new Set(
    (db.prepare('SELECT part_index FROM clawbot_reply_outbox WHERE run_id = ?').all(run.id) as Array<{ part_index?: number }>)
      .map(row => Number(row.part_index ?? 0)),
  )
  const insert = db.prepare(`INSERT INTO clawbot_reply_outbox(
    run_id, slot, part_index, text, client_id, status, attempts, sent_message_id, last_error, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, ?, ?)`)
  for (let index = 0; index < parts.length; index += 1) {
    if (existing.has(index)) continue
    insert.run(run.id, run.slot, index, partText(parts[index] as ClawbotReplyPartInput), randomUUID(), at, at)
  }
  return readPartsOn(db, run.id)
}

export function saveReplyParts(
  dir: string,
  runId: number,
  parts: readonly ClawbotReplyPartInput[],
  now: number = Date.now(),
): ClawbotReplyPart[] {
  const id = positiveInt(runId, 'runId')
  const at = timestamp(now)
  return withWritableDb(clawbotDbPath(dir), (db) => {
    ensureClawbotSchema(db)
    return writeTx(db, () => {
      const run = requireRun(db, id)
      if (TERMINAL_RUN_STATUSES.has(run.status)) throw new Error(`回复 run ${id} 已处于终态 ${run.status}`)
      const saved = saveReplyPartsOn(db, run, parts, at)
      db.prepare(`UPDATE clawbot_reply_run
        SET status = 'ready', next_attempt_at = ?,
            lease_owner = NULL, lease_until = 0, updated_at = ?
        WHERE id = ? AND status IN ('debouncing', 'queued', 'generating', 'ready')`).run(at, at, id)
      return saved
    })
  })
}

/**
 * 标记一次实际发送尝试。
 *
 * `attempts` 在每次 claim 时递增（包括恢复后重新 claim 仍停在 sending 的行），
 * 这样连续崩溃/超时不能绕过发送上限。已 sent 或已永久 failed 的分段不会被重新打开。
 * 发送租约只写 `lease_until`；`next_attempt_at` 仅由 debounce/retry 更新。
 */
export function markReplyPartSending(dir: string, partId: number, now: number = Date.now()): ClawbotReplyPart {
  return withPartMutation(dir, partId, now, (db, id, at, part) => {
    if (part.status === 'sent' || part.status === 'failed') return
    db.prepare(`UPDATE clawbot_reply_outbox
      SET status = 'sending', attempts = attempts + 1,
          lease_owner = NULL, lease_until = ?, updated_at = ?
      WHERE id = ?`).run(at + REPLY_SENDING_LEASE_MS, at, id)
    db.prepare(`UPDATE clawbot_reply_run
      SET status = 'sending',
          lease_owner = NULL, lease_until = ?, updated_at = ?
      WHERE id = ? AND status NOT IN ('done', 'failed', 'skipped')`)
      .run(at + REPLY_SENDING_LEASE_MS, at, part.runId)
  })
}

/**
 * 标记分段发送成功。
 *
 * 幂等：重复调用不增加 attempts，`sent_message_id` 只保留第一次非空值。
 * 成功回填在同一事务内释放 part/run 租约，但不改写 `next_attempt_at`。
 */
export function markReplyPartSent(
  dir: string,
  partId: number,
  sentMessageId: number | null = null,
  now: number = Date.now(),
): ClawbotReplyPart {
  return withPartMutation(dir, partId, now, (db, id, at, part) => {
    const sent = sentMessageId !== null && Number.isFinite(sentMessageId) && sentMessageId > 0
      ? Math.floor(sentMessageId)
      : null
    db.prepare(`UPDATE clawbot_reply_outbox
      SET status = 'sent',
          sent_message_id = COALESCE(sent_message_id, ?),
          last_error = NULL,
          lease_owner = NULL,
          lease_until = 0,
          updated_at = CASE WHEN status = 'sent' THEN updated_at ELSE ? END
      WHERE id = ?`).run(sent, at, id)
    db.prepare(`UPDATE clawbot_reply_run
      SET lease_owner = NULL,
          lease_until = 0,
          updated_at = ?
      WHERE id = ? AND lease_owner IS NULL
        AND status NOT IN ('done', 'failed', 'skipped')`)
      .run(at, part.runId)
  })
}

/** 分段发送失败但可重试：回到 pending，并让 run 重新进入可调度状态。 */
export function markReplyPartRetry(
  dir: string,
  partId: number,
  error: string | null = null,
  nextAttemptAt?: number,
  now: number = Date.now(),
): ClawbotReplyPart {
  return withPartMutation(dir, partId, now, (db, id, at, part) => {
    if (part.status === 'sent') return
    const next = timestamp(nextAttemptAt ?? at)
    db.prepare(`UPDATE clawbot_reply_outbox
      SET status = 'pending', last_error = ?, lease_owner = NULL,
          lease_until = 0, updated_at = ? WHERE id = ?`).run(error, at, id)
    db.prepare(`UPDATE clawbot_reply_run
      SET status = 'ready', last_error = ?, next_attempt_at = ?,
          lease_owner = NULL, lease_until = 0, updated_at = ?
      WHERE id = ? AND status NOT IN ('done', 'failed', 'skipped')`)
      .run(error, next, at, part.runId)
  })
}

/** 分段永久失败。run 的终态由调用方按整批结果决定。 */
export function markReplyPartFailed(
  dir: string,
  partId: number,
  error: string | null = null,
  now: number = Date.now(),
): ClawbotReplyPart {
  return withPartMutation(dir, partId, now, (db, id, at, part) => {
    if (part.status === 'sent') return
    db.prepare(`UPDATE clawbot_reply_outbox
      SET status = 'failed', last_error = ?, lease_owner = NULL,
          lease_until = 0, updated_at = ? WHERE id = ?`).run(error, at, id)
  })
}

/** 清理某实例的 run 与 outbox（同一事务，先删子表再删 run）。 */
export function clearClawbotReplyState(
  dir: string,
  slot: number,
): ClearClawbotReplyStateResult {
  const s = positiveInt(slot, 'slot')
  if (!clawbotDbExists(dir)) return { removedRuns: 0, removedParts: 0 }
  return withWritableDb(clawbotDbPath(dir), (db) => {
    ensureClawbotSchema(db)
    return writeTx(db, () => {
      const removedParts = Number((db.prepare('SELECT COUNT(*) AS n FROM clawbot_reply_outbox WHERE slot = ?')
        .get(s) as { n?: number } | undefined)?.n ?? 0)
      const removedRuns = Number((db.prepare('SELECT COUNT(*) AS n FROM clawbot_reply_run WHERE slot = ?')
        .get(s) as { n?: number } | undefined)?.n ?? 0)
      db.prepare('DELETE FROM clawbot_reply_outbox WHERE slot = ?').run(s)
      db.prepare('DELETE FROM clawbot_reply_run WHERE slot = ?').run(s)
      return { removedRuns, removedParts }
    })
  })
}
