/**
 * 「任务投递」入口（多厂商版，2026-10-21）。
 *
 * 从 `task-center.ts` 拆出来（M21 单文件 1000 行上限）：这里只做**入口编排**——
 * 读记录/任务/凭据原文 → 隐私闸 → 交给 `rpa/dispatch.ts` 的统一管道 → 把结果写回记录。
 * 厂商差异（请求模板/鉴权/响应解析）全部在 `rpa/vendors/*` 的描述符与钩子里，本文件
 * 不认识任何具体厂商；**本文件不再直接出网**（唯一出网点在 `rpa/dispatch.ts#sendRequest`）。
 *
 * 语义要点：
 *  · 隐私闸 feature 仍是 `task_callback`（多厂商同一口径、审计不按厂商拆分）；
 *  · 凭据原文只在内存里出现（从 `trigger_secret` 读，兼容回退旧 `bazhuayu_api_key`），
 *    写回记录时只落 `external_task_id` 等非敏感结果；
 *  · 失败原因 ≤500 字落 `task_triggers.callback_error`，不含任何凭据。
 */
import { randomUUID } from 'node:crypto'
import { withWritableDb } from './db-open.ts'
import type { DatabaseSync } from './db-open.ts'
import { findVendor } from './rpa/registry.ts'
import {
  missingReadyFields,
  migrateLegacySecrets,
  normalizeTriggerMethod,
  parseSecretJson,
} from './rpa/template.ts'
import { dispatchRpaRecord } from './rpa/dispatch.ts'
import { buildRpaImageLinks, usesImageParamSources } from './rpa/media-links.ts'
import {
  clampTaskInt,
  ensureTaskSchema,
  rowToTask,
  rowToTrigger,
  storeExists,
  taskCellNum,
  taskCellStr,
  taskDbPath,
  taskErrorText,
} from './task-center.ts'
import type { RetryFetch } from '../net/fetch-retry.ts'
import type { RpaDispatchOutcome, RpaImageLink, RpaInvocationContext, RpaRecordContext } from './rpa/types.ts'
import type { RpaMediaLinkFactory } from './rpa/media-links.ts'
import type {
  TaskCallbackDispatchResult,
  TaskInfo,
  TaskTriggerCallbackStatus,
  TaskTriggerRecord,
  TaskTriggerText,
} from '../types.ts'

/** 投递失败原因落库上限。 */
const CALLBACK_ERROR_MAX = 500
/** 一批待投递记录的上限（定时器每拍先捞这么多）。 */
const PENDING_DISPATCH_LIMIT = 10
/** 同一批里同时在途的投递数。网络等待重叠，认领失败仍由各条自己的租约挡住。 */
const DISPATCH_CONCURRENCY = 4
/** 成功写满一批就立刻再捞，避免突发命中要等下一拍扫描才继续投。 */
const DISPATCH_DRAIN_ROUNDS = 4
/**
 * 单条投递租约。租约由心跳持续续期，因此它只需要覆盖“一次续期失败到下一个 owner
 * 可接管”的窗口，而不是覆盖整个网络请求。
 */
const CALLBACK_LEASE_MS = 120_000
/** 默认心跳周期；必须显著小于租约，连续一次续期失败就中止在途请求。 */
const CALLBACK_HEARTBEAT_MS = 20_000
/** SQLite 是同步 API：撞锁不用 busy_timeout 冻住 worker，而是让出事件循环后重试。 */
const BUSY_RETRY_ATTEMPTS = 4
const BUSY_RETRY_BASE_MS = 25

/** 投递依赖：图片解码、隐私闸与 fetch 都由调用方注入（query 层不 import gateway 侧）。 */
export interface TaskDispatchDeps {
  /**
   * 解码一张图片（`username` + `localId`）。返回 `url`（data URL）或 `file`
   * （相对 `decodedDir` 的路径）之一；两者都没有 = 这张解不出来。
   * Webhook 适配器解码字节；RPA 厂商只在图片类参数来源需要时用它取得可签直链的文件路径。
   */
  decodeImage: (
    username: string,
    localId: number,
    options?: { fileOnly?: boolean },
  ) => Promise<{ url?: string; file?: string }>
  /**
   * 图片直链工厂（`imagesJson` / `imageCount` / `firstImageUrl` 三种值来源用）。
   *
   * 按**触发记录 id** 构造：令牌载荷里要带 `recordId`（见 `net/rpa-media.ts`）。
   * 由装配层按当前配置现取（`api_token` 派生密钥 + 可达基址）；缺省时那三种来源会
   * 如实写「未打开局域网访问」，而不是发一个取不到的地址。
   */
  mediaLinks?: (recordId: number) => RpaMediaLinkFactory | undefined
  /** 隐私闸（脱敏 + 审计）；返回可直接发出去的文本。 */
  gate: (feature: string, stats: { sessions: number; messages: number }, texts: string[]) => string[]
  /** 测试注入用；生产省略 = 全局 `fetch`。 */
  fetchImpl?: RetryFetch
}

/** 一批待投递记录的处理结果（扫描器把它并进 `TaskTriggerScanResult`）。 */
export interface PendingDispatchResult {
  dispatched: number
  failed: number
  errors?: string[]
}

/** 自动批投只接管 pending；人工重投允许 pending（尚未发出）和 failed。 */
type DispatchClaimMode = 'automatic' | 'manual'

/** 测试可注入时钟/owner/租期；生产调用不传。 */
export interface TaskDispatchOptions {
  now?: number
  leaseMs?: number
  /** 心跳周期；0 = 关闭（只用于模拟进程已死亡/测试过期接管）。 */
  heartbeatMs?: number
  owner?: string
}

interface InternalDispatchOptions extends TaskDispatchOptions {
  mode?: DispatchClaimMode
}

interface DispatchClaim {
  id: number
  owner: string
  until: number
  fence: number
  status: TaskTriggerCallbackStatus
}

type DispatchClaimAttempt =
  | { ok: true; claim: DispatchClaim }
  | {
    ok: false
    reason: 'missing' | 'busy' | 'not-eligible'
    status: TaskTriggerCallbackStatus
  }

interface InternalDispatchResult {
  /** false = 本次没有可处理的记录（不存在或已被其它 worker 推进到终态）。 */
  handled: boolean
  result: TaskCallbackDispatchResult
}

/** 一次投递要读齐的三样东西：记录 / 所属任务 / 凭据原文。 */
interface DispatchTarget {
  record?: TaskTriggerRecord
  task?: TaskInfo
  /** 凭据原文（只在本次投递内存里出现，绝不写回/返回）。 */
  secrets?: Record<string, string>
}

/**
 * 读取投递需要的「记录 + 所属任务 + 凭据原文」；任一缺失都不抛错（调用方给可读结果）。
 *
 * 读也走 `withWritableDb`：这是**我们自己的写库**，异常退出后可能残留 `-wal/-shm`，
 * 只读连接会因此报错；`withDb` 留给微信解密库那种只读快照。
 * @param file - 任务库路径（已由调用方确认存在）。
 * @param triggerId - 触发记录 id。
 * @returns 记录 / 所属任务 / 凭据原文；找不到的部分缺省。
 */
/** 把签好的局域网地址写回触发记录，源码模式才能看到 images.url。失败不影响投递。 */
function rememberImageUrls(
  file: string,
  triggerId: number,
  images: TaskTriggerRecord['images'],
  links: RpaImageLink[],
): void {
  let changed = false
  const next = images.map((image, index) => {
    const url = links[index]?.url
    if (typeof url !== 'string' || url === '' || image.url === url) return image
    changed = true
    return { ...image, url }
  })
  if (!changed) return
  try {
    withWritableDb(file, (db) => {
      db.prepare('UPDATE task_triggers SET images = ? WHERE id = ?').run(JSON.stringify(next), triggerId)
    })
  } catch {
    // 地址没写进记录不影响这次出网；下次打开源码仍会按落盘文件现签。
  }
}

function readDispatchTarget(file: string, triggerId: number, decryptedDir: string): DispatchTarget {
  return withWritableDb(file, (db) => {
    const triggerRow = db.prepare('SELECT * FROM task_triggers WHERE id = ?').get(triggerId) as Record<string, unknown> | undefined
    if (triggerRow === undefined) return {}
    const record = rowToTrigger(triggerRow, decryptedDir)
    const taskRow = db.prepare('SELECT * FROM task_info WHERE id = ?').get(record.taskId) as Record<string, unknown> | undefined
    if (taskRow === undefined) return { record }
    const task = rowToTask(taskRow, decryptedDir)
    return { record, task, secrets: secretsOfRow(taskRow, task.triggerMethod) }
  })
}

/**
 * 任务行的凭据原文：通用列优先；为空时回退旧 `bazhuayu_api_key`（迁移窗口内的老库）。
 * @param row - `task_info` 行。
 * @param method - 已归一的触发方式。
 * @returns 凭据键值（非空）。
 */
function secretsOfRow(row: Record<string, unknown>, method: string): Record<string, string> {
  const stored = parseSecretJson(row['trigger_secret'])
  if (Object.keys(stored).length > 0) return stored
  return migrateLegacySecrets(method, taskCellStr(row['bazhuayu_api_key']))
}

function normalizeCallbackStatus(raw: unknown): TaskTriggerCallbackStatus {
  return raw === 'sent' || raw === 'failed' || raw === 'skipped' || raw === 'sent_unconfirmed'
    ? raw
    : 'pending'
}

function isBusyDatabaseError(error: unknown): boolean {
  const row = error as { code?: unknown; errcode?: unknown; message?: unknown } | null | undefined
  const errcode = Number(row?.errcode)
  if (errcode === 5 || errcode === 6) return true
  const text = String(row?.code ?? '') + '\n' + String(row?.message ?? error ?? '')
  return /SQLITE_BUSY|SQLITE_LOCKED|database(?: table)? is locked/i.test(text)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/** 对短小的同步 SQLite 写入做有界异步重试；等待时让出事件循环，不冻住 worker。 */
async function withBusyRetry<T>(fn: () => T): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= BUSY_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return fn()
    } catch (e) {
      lastError = e
      if (!isBusyDatabaseError(e) || attempt >= BUSY_RETRY_ATTEMPTS) throw e
      await sleep(BUSY_RETRY_BASE_MS * attempt)
    }
  }
  throw lastError
}

function resolveLeaseMs(value: unknown): number {
  return Number.isFinite(value) ? Math.max(1, Math.trunc(value as number)) : CALLBACK_LEASE_MS
}

function resolveHeartbeatMs(leaseMs: number, value: unknown): number {
  if (value !== undefined && Number.isFinite(value)) {
    return Math.max(0, Math.trunc(value as number))
  }
  return Math.min(CALLBACK_HEARTBEAT_MS, Math.max(1, Math.floor(leaseMs / 3)))
}

function writeTx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const value = fn()
    db.exec('COMMIT')
    return value
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* Keep the original database error. */ }
    throw e
  }
}

/**
 * 原子抢占一条记录的出网权。
 *
 * 状态仍保留 pending/failed，新增字段只做内部租约：这样旧 UI/契约无需新增
 * `dispatching` 状态。`BEGIN IMMEDIATE` 内的读-判-写保证后台批投、人工重投与
 * 多进程扫描最多只有一个 owner 能进入 HTTP 阶段。
 */
function claimTaskTriggerDispatch(
  file: string,
  triggerId: number,
  options: InternalDispatchOptions = {},
): DispatchClaimAttempt {
  const mode = options.mode ?? 'manual'
  const now = Number.isFinite(options.now) ? Math.trunc(options.now as number) : Date.now()
  const leaseMs = resolveLeaseMs(options.leaseMs)
  const owner = typeof options.owner === 'string' && options.owner.trim() !== ''
    ? options.owner.trim()
    : randomUUID()
  const until = now + leaseMs
  return withWritableDb(file, (db) => {
    ensureTaskSchema(db)
    return writeTx(db, (): DispatchClaimAttempt => {
      const row = db.prepare(`SELECT callback_status, callback_lease_until, callback_lease_fence
        FROM task_triggers WHERE id = ? LIMIT 1`).get(triggerId) as Record<string, unknown> | undefined
      if (row === undefined) {
        return { ok: false, reason: 'missing', status: 'skipped' }
      }
      const status = normalizeCallbackStatus(row['callback_status'])
      const activeUntil = taskCellNum(row['callback_lease_until'])
      if (activeUntil > now) {
        return { ok: false, reason: 'busy', status }
      }
      const eligible = mode === 'automatic'
        ? status === 'pending'
        : status === 'pending' || status === 'failed' || status === 'sent_unconfirmed'
      if (!eligible) {
        return { ok: false, reason: 'not-eligible', status }
      }
      const updated = db.prepare(`UPDATE task_triggers SET
        callback_lease_owner = ?,
        callback_lease_until = ?,
        callback_lease_fence = callback_lease_fence + 1
        WHERE id = ?
          AND callback_status = ?
          AND callback_lease_until <= ?`).run(owner, until, triggerId, status, now)
      if (Number(updated.changes) !== 1) {
        return { ok: false, reason: 'busy', status }
      }
      return {
        ok: true,
        claim: {
          id: triggerId,
          owner,
          until,
          fence: taskCellNum(row['callback_lease_fence']) + 1,
          status,
        },
      }
    })
  })
}

/** 原子续租；owner/fence 任一不匹配都表示本 owner 已失去出网权。 */
function renewDispatchClaim(file: string, claim: DispatchClaim, leaseMs: number): boolean {
  const until = Date.now() + leaseMs
  return withWritableDb(file, (db) => {
    ensureTaskSchema(db)
    const updated = db.prepare(`UPDATE task_triggers SET callback_lease_until = ?
      WHERE id = ?
        AND callback_lease_owner = ?
        AND callback_lease_fence = ?`).run(until, claim.id, claim.owner, claim.fence)
    return Number(updated.changes) === 1
  })
}

/**
 * 首次出网前把记录持久化为 `sent_unconfirmed`。
 *
 * 这是崩溃安全的写前标记：进程在请求发出前后崩溃，后台批投都不会再自动认领它；
 * 用户核对厂商控制台后，仍可走人工重投。
 */
function markDispatchAttemptStarted(file: string, claim: DispatchClaim): boolean {
  return withWritableDb(file, (db) => {
    ensureTaskSchema(db)
    const updated = db.prepare(`UPDATE task_triggers SET
      callback_status = 'sent_unconfirmed',
      callback_at = NULL,
      callback_error = ''
      WHERE id = ?
        AND callback_lease_owner = ?
        AND callback_lease_fence = ?
        AND callback_status = ?`).run(claim.id, claim.owner, claim.fence, claim.status)
    return Number(updated.changes) === 1
  })
}

type SaveDispatchOutcome = 'saved' | 'stale'

/** 预检失败没有出网：人工重投只释放租约，不把记录改成 skipped。 */
function releaseDispatchClaim(file: string, claim: DispatchClaim): SaveDispatchOutcome {
  return withWritableDb(file, (db) => {
    ensureTaskSchema(db)
    const updated = db.prepare(`UPDATE task_triggers SET
      callback_lease_owner = '',
      callback_lease_until = 0
      WHERE id = ?
        AND callback_lease_owner = ?
        AND callback_lease_fence = ?`).run(claim.id, claim.owner, claim.fence)
    return Number(updated.changes) === 1 ? 'saved' : 'stale'
  })
}

interface DispatchLeaseGuard {
  signal: AbortSignal
  stop: () => void
  outboundStarted: () => boolean
  markOutboundStarted: () => Promise<boolean>
}

/**
 * 启动租约心跳。心跳不重试：一次续租失败就撤销 AbortController，让在途 fetch
 * 立即停止。这样“仍然活着但租约已被接管”的旧 worker 不会继续制造远端副作用。
 */
function startDispatchLeaseGuard(
  file: string,
  claim: DispatchClaim,
  leaseMs: number,
  heartbeatMs: number,
): DispatchLeaseGuard {
  const controller = new AbortController()
  let stopped = false
  let lost = false
  let outbound = false
  const loseLease = (): void => {
    if (stopped || lost) return
    lost = true
    controller.abort()
  }
  const timer = heartbeatMs > 0
    ? setInterval(() => {
      try {
        if (!renewDispatchClaim(file, claim, leaseMs)) loseLease()
      } catch {
        loseLease()
      }
    }, heartbeatMs)
    : null
  timer?.unref?.()

  return {
    signal: controller.signal,
    stop(): void {
      if (stopped) return
      stopped = true
      if (timer !== null) clearInterval(timer)
    },
    outboundStarted(): boolean {
      return outbound
    },
    async markOutboundStarted(): Promise<boolean> {
      if (outbound) return true
      if (lost) return false
      try {
        const marked = await withBusyRetry(() => markDispatchAttemptStarted(file, claim))
        if (!marked) {
          loseLease()
          return false
        }
        outbound = true
        return true
      } catch {
        loseLease()
        return false
      }
    },
  }
}

/** 只有仍持有同一 owner/fence 的调用才能写终态，旧 owner 的晚到结果会被拒绝。 */
function saveDispatchResultClaimed(
  file: string,
  claim: DispatchClaim,
  status: TaskTriggerCallbackStatus,
  error: string,
  externalTaskId: string,
): SaveDispatchOutcome {
  return withWritableDb(file, (db) => {
    ensureTaskSchema(db)
    const updated = db.prepare(`UPDATE task_triggers SET
      callback_status = ?,
      callback_at = ?,
      callback_error = ?,
      external_task_id = ?,
      callback_lease_owner = '',
      callback_lease_until = 0
      WHERE id = ?
        AND callback_lease_owner = ?
        AND callback_lease_fence = ?`).run(
      status,
      Date.now(),
      error,
      externalTaskId,
      claim.id,
      claim.owner,
      claim.fence,
    )
    return Number(updated.changes) === 1 ? 'saved' : 'stale'
  })
}

function currentCallbackStatus(file: string, triggerId: number): TaskTriggerCallbackStatus {
  try {
    return withWritableDb(file, (db) => {
      ensureTaskSchema(db)
      const row = db.prepare('SELECT callback_status FROM task_triggers WHERE id = ? LIMIT 1')
        .get(triggerId) as Record<string, unknown> | undefined
      return row === undefined ? 'skipped' : normalizeCallbackStatus(row['callback_status'])
    })
  } catch {
    return 'pending'
  }
}

function unconfirmedResult(
  result: TaskCallbackDispatchResult,
  detail: string,
): TaskCallbackDispatchResult {
  const out: TaskCallbackDispatchResult = {
    ok: false,
    status: 'sent_unconfirmed',
    error: '远端可能已受理，但本地结果未确认；不会自动重投，请核对后手动处理'
      + (detail === '' ? '' : '（' + detail + '）'),
  }
  if (result.externalTaskId !== undefined && result.externalTaskId !== '') {
    out.externalTaskId = result.externalTaskId
  }
  return out
}

async function persistClaimedResult(
  file: string,
  claim: DispatchClaim,
  result: TaskCallbackDispatchResult,
  error: string,
  outboundStarted: boolean,
): Promise<TaskCallbackDispatchResult> {
  let saved: SaveDispatchOutcome
  try {
    saved = await withBusyRetry(() => saveDispatchResultClaimed(
      file,
      claim,
      result.status,
      error.slice(0, CALLBACK_ERROR_MAX),
      result.externalTaskId ?? '',
    ))
  } catch (e) {
    if (outboundStarted || result.ok) return unconfirmedResult(result, taskErrorText(e))
    const suffix = '（结果保存失败：' + taskErrorText(e) + '）'
    return { ...result, error: (result.error ?? error) + suffix }
  }
  if (saved === 'saved') return result
  const current = currentCallbackStatus(file, claim.id)
  if (outboundStarted && current !== 'sent' && current !== 'failed' && current !== 'skipped') {
    return unconfirmedResult(result, '投递租约已失效')
  }
  return {
    ok: false,
    status: current,
    error: '投递租约已失效，本次结果未覆盖新状态；请刷新后核对',
  }
}

/**
 * 构造触发记录的只读快照（Webhook 与图片直链共用同一份）。
 *
 * `chatType` 取任务配置（触发记录只存会话用户名/显示名，没存类型）；
 * `text` 已过隐私闸；`images` 原样带上（Webhook 按需解码，RPA 厂商只发链接）。
 * @param task - 任务配置。
 * @param record - 触发记录。
 * @param text - 已过隐私闸的触发文本。
 * @returns 记录快照。
 */
function buildRecordContext(
  task: TaskInfo,
  record: TaskTriggerRecord,
  text: string,
  texts: readonly TaskTriggerText[] = record.texts ?? [],
): RpaRecordContext {
  return {
    username: record.chatUsername,
    chatName: record.chatName,
    chatType: task.chatType,
    targetName: record.targetName,
    targetUsername: record.targetUsername,
    text,
    keyword: record.keyword,
    triggeredAt: record.triggeredAt,
    images: record.images,
    texts: [...texts],
  }
}

/**
 * 组装一次投递的上下文（模板占位符的顶层根）。
 * @param task - 任务配置。
 * @param record - 触发记录。
 * @param secrets - 凭据原文。
 * @param recordContext - {@link buildRecordContext} 的结果。
 * @param imageLinks - 投递前算好的图片直链（与 `record.images` 等长、同序）。
 * @returns 投递上下文。
 */
function buildInvocationContext(
  task: TaskInfo,
  record: TaskTriggerRecord,
  secrets: Record<string, string>,
  recordContext: RpaRecordContext,
  imageLinks: RpaImageLink[],
): RpaInvocationContext {
  return {
    taskId: task.id,
    recordId: record.id,
    idempotencyKey: String(task.id) + ':' + String(record.id),
    taskName: task.name,
    record: recordContext,
    imageLinks,
    config: task.triggerConfig,
    secrets,
  }
}

/** 跳过原因（预检失败，不写库、不出网）。 */
function skipped(error: string): TaskCallbackDispatchResult {
  return { ok: false, status: 'skipped', error }
}

/** 把管道结果转成对外结果 + 落库错误文案。 */
function outcomeResult(outcome: RpaDispatchOutcome): { result: TaskCallbackDispatchResult; error: string } {
  if (outcome.status === 'sent') {
    const result: TaskCallbackDispatchResult = { ok: true, status: 'sent' }
    if (outcome.externalTaskId !== undefined && outcome.externalTaskId !== '') {
      result.externalTaskId = outcome.externalTaskId
    }
    return { result, error: '' }
  }
  const error = (outcome.error ?? (outcome.status === 'skipped' ? '已跳过' : '投递失败')).slice(0, CALLBACK_ERROR_MAX)
  return { result: { ok: false, status: outcome.status, error }, error }
}

/**
 * 手动 / 扫描后投递一条触发记录（按任务的触发方式走注册表）。
 *
 * 前置：任务已完善 + 厂商已注册 + 描述符必填项齐全，否则 skipped + 可读原因。
 * 文本先过**同一个**隐私闸（feature 仍是 `task_callback`）。图片按厂商分流：
 * Webhook 由适配器按需解码字节；RPA 厂商只在参数用到 `imagesJson` / `imageCount` /
 * `firstImageUrl` 时预先算好**短时签名直链**（`rpa/media-links.ts`）。
 * 失败不抛异常：`{ok:false, status:'failed', error}` 并落进记录，供前端重试。
 * @param decryptedDir - 解密数据根。
 * @param decodedDir - 图片解码缓存根（仅 Webhook 方式使用）。
 * @param triggerId - 触发记录 id。
 * @param deps - 解码 / 隐私闸 / fetch 注入。
 * @returns 投递结果（含 skipped 的几种可读原因）。
 */
function claimFailureResult(attempt: Extract<DispatchClaimAttempt, { ok: false }>): InternalDispatchResult {
  if (attempt.reason === 'missing') {
    return { handled: false, result: skipped('触发记录不存在') }
  }
  if (attempt.reason === 'busy') {
    return {
      // 批投的 SELECT 与 claim 之间可能有另一 worker 先抢到租约。这里不能当成
      // “本拍没事发生”静默吞掉，否则扫描日志和失败计数会掩盖真实争用。
      handled: true,
      result: {
        ok: false,
        status: attempt.status,
        error: '该记录正在投递中，请稍后刷新后再试',
      },
    }
  }
  const error = attempt.status === 'sent'
    ? '记录已投递，不能重复投递'
    : attempt.status === 'skipped'
      ? '记录已跳过，不能重复投递'
      : attempt.status === 'sent_unconfirmed'
        ? '记录投递结果未确认，请先核对后再人工重投'
        : '记录当前状态不可投递：' + attempt.status
  return { handled: false, result: { ok: false, status: attempt.status, error } }
}

async function dispatchTaskCallbackInternal(
  decryptedDir: string,
  decodedDir: string,
  triggerId: number,
  deps: TaskDispatchDeps,
  options: InternalDispatchOptions = {},
): Promise<InternalDispatchResult> {
  const id = taskCellNum(triggerId)
  if (id <= 0 || !storeExists(decryptedDir)) {
    return { handled: false, result: skipped('触发记录不存在') }
  }
  const file = taskDbPath(decryptedDir)
  const leaseMs = resolveLeaseMs(options.leaseMs)
  const heartbeatMs = resolveHeartbeatMs(leaseMs, options.heartbeatMs)
  let claimAttempt: DispatchClaimAttempt
  try {
    claimAttempt = await withBusyRetry(() => claimTaskTriggerDispatch(file, id, options))
  } catch (e) {
    return {
      handled: true,
      result: {
        ok: false,
        status: 'pending',
        error: '读取/认领触发记录失败：' + taskErrorText(e),
      },
    }
  }
  if (!claimAttempt.ok) return claimFailureResult(claimAttempt)
  const claim = claimAttempt.claim
  const guard = startDispatchLeaseGuard(file, claim, leaseMs, heartbeatMs)

  const finishSkipped = async (error: string): Promise<InternalDispatchResult> => {
    guard.stop()
    if (options.mode === 'automatic') {
      return {
        handled: true,
        result: await persistClaimedResult(file, claim, skipped(error), error, guard.outboundStarted()),
      }
    }
    try {
      const released = await withBusyRetry(() => releaseDispatchClaim(file, claim))
      return {
        handled: true,
        result: released === 'saved'
          ? skipped(error)
          : skipped(error + '（投递租约已失效）'),
      }
    } catch (e) {
      return {
        handled: true,
        result: skipped(error + '（释放投递租约失败：' + taskErrorText(e) + '）'),
      }
    }
  }

  let target: DispatchTarget
  try {
    target = readDispatchTarget(file, id, decryptedDir)
  } catch (e) {
    return finishSkipped('读取触发记录失败：' + taskErrorText(e))
  }
  const { record, task } = target
  if (record === undefined) return finishSkipped('触发记录不存在')
  if (task === undefined) return finishSkipped('任务不存在或已删除')
  if (task.status !== 'ready') return finishSkipped('任务未完善')
  const adapter = findVendor(task.triggerMethod)
  if (adapter === undefined) return finishSkipped('触发方式不可用：' + task.triggerMethod)
  const missing = missingReadyFields(adapter.descriptor, task.triggerConfig, task.triggerSecretSet)
  if (missing.length > 0) return finishSkipped('触发配置不完整：' + missing.join('、'))

  let ctx: RpaInvocationContext
  try {
    // 所有要出网的文本**一次**过闸：触发文本 + 携带的历史文本逐条替换，
    // 少闸一条就等于多出一条未脱敏的原文（隐私闸按条返回，不能用同一个结果铺开）。
    const sourceTexts = [record.text, ...(record.texts ?? []).map((item) => item.text)]
    const gated = deps.gate('task_callback', { sessions: 1, messages: sourceTexts.length }, sourceTexts)
    const gatedList = Array.isArray(gated) ? gated.map((value) => taskCellStr(value)) : []
    const outbound = adapter.descriptor.governance.contentOutbound
    const text = outbound ? (gatedList[0] ?? record.text) : ''
    const texts = outbound
      ? (record.texts ?? []).map((item, index) => ({ ...item, text: gatedList[index + 1] ?? item.text }))
      : []
    const recordContext = buildRecordContext(task, record, text, texts)
    const webhookHasImages = task.triggerMethod === 'webhook' && record.images.length > 0
    const imageLinks = usesImageParamSources(adapter.descriptor, task.triggerConfig) || webhookHasImages
      ? await buildRpaImageLinks(
        recordContext,
        { decodedDir, decodeImage: deps.decodeImage },
        deps.mediaLinks?.(record.id),
      )
      : []
    if (webhookHasImages) rememberImageUrls(file, record.id, record.images, imageLinks)
    ctx = buildInvocationContext(task, record, target.secrets ?? {}, recordContext, imageLinks)
  } catch (e) {
    return finishSkipped('投递准备失败：' + taskErrorText(e))
  }

  let outcome: RpaDispatchOutcome
  try {
    outcome = await dispatchRpaRecord({
      adapter,
      ctx,
      deps: {
        ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
        signal: guard.signal,
        onOutboundAttempt: async () => {
          if (!(await guard.markOutboundStarted())) {
            throw new Error('投递租约已失效，已中止出网')
          }
        },
      },
      buildDeps: { decodedDir, decodeImage: deps.decodeImage },
    })
  } catch (e) {
    outcome = { status: 'failed', error: taskErrorText(e) }
  }
  const abortedAfterOutbound = guard.signal.aborted && guard.outboundStarted()
  guard.stop()
  const { result, error } = outcomeResult(outcome)
  if (abortedAfterOutbound) {
    const current = currentCallbackStatus(file, claim.id)
    if (current === 'sent' || current === 'failed') {
      return {
        handled: true,
        result: {
          ok: false,
          status: current,
          error: '投递租约已失效，本次结果未覆盖新状态；请刷新后核对',
        },
      }
    }
    return {
      handled: true,
      result: unconfirmedResult(result, '租约续期失败，在途请求已中止'),
    }
  }
  return {
    handled: true,
    result: await persistClaimedResult(file, claim, result, error, guard.outboundStarted()),
  }
}

export async function dispatchTaskCallback(
  decryptedDir: string,
  decodedDir: string,
  triggerId: number,
  deps: TaskDispatchDeps,
  options: TaskDispatchOptions = {},
): Promise<TaskCallbackDispatchResult> {
  return (await dispatchTaskCallbackInternal(decryptedDir, decodedDir, triggerId, deps, options)).result
}

/**
 * 投递一批 `pending` 记录。
 *
 * 只按「记录 pending + 所属任务 ready」捞（**不再按厂商列过滤**）：同一批里最多
 * {@link DISPATCH_CONCURRENCY} 条同时出网。未配置/厂商下线的记录会被 skipped 并写明原因
 * （**落库为 skipped**，否则同一批 pending 会每拍重复占用名额、队头阻塞）。单条失败不连坐
 * （错误只收集前 10 条）；这一批成功写满上限时立刻再捞，最多 {@link DISPATCH_DRAIN_ROUNDS} 轮。
 * @param decryptedDir - 解密数据根。
 * @param decodedDir - 图片解码缓存根。
 * @param deps - 解码 / 隐私闸 / fetch 注入。
 * @param limit - 每一轮最多捞几条（默认 10）。写满且这一轮有成功时会再捞，最多 4 轮。
 * @returns 成功/失败计数与失败原因。
 */
export async function dispatchPendingTaskCallbacks(
  decryptedDir: string,
  decodedDir: string,
  deps: TaskDispatchDeps,
  limit = PENDING_DISPATCH_LIMIT,
): Promise<PendingDispatchResult> {
  if (!storeExists(decryptedDir)) return { dispatched: 0, failed: 0 }
  const cap = clampTaskInt(limit, PENDING_DISPATCH_LIMIT, 1, 100)
  const now = Date.now()
  let ids: number[] = []
  try {
    ids = withWritableDb(taskDbPath(decryptedDir), (db) => {
      // 老库在这里顺手补列：下面 SELECT 引用了外部任务 id / 通用配置等新列。
      ensureTaskSchema(db)
      const rows = db.prepare(`SELECT t.id AS id FROM task_triggers t
        JOIN task_info i ON i.id = t.task_id
        WHERE t.callback_status = 'pending'
          AND i.status = 'ready'
          AND t.callback_lease_until <= ?
        ORDER BY t.triggered_at ASC, t.id ASC LIMIT ?`).all(now, cap) as Array<{ id?: unknown }>
      return rows.map((row) => taskCellNum(row.id))
    })
  } catch (e) {
    return { dispatched: 0, failed: 0, errors: ['读取待投递记录失败：' + taskErrorText(e)] }
  }
  let dispatched = 0
  let failed = 0
  const errors: string[] = []
  for (let round = 0; round < DISPATCH_DRAIN_ROUNDS; round += 1) {
    let roundIds = ids
    if (round > 0) {
      try {
        roundIds = readPendingTriggerIds(decryptedDir, cap)
      } catch {
        break
      }
    }
    if (roundIds.length === 0) break
    const roundDispatched = await dispatchTriggerIds(decryptedDir, decodedDir, roundIds, deps, errors, (ok) => {
      if (ok) dispatched += 1
      else failed += 1
    })
    if (roundIds.length < cap || roundDispatched === 0) break
  }
  return errors.length > 0 ? { dispatched, failed, errors } : { dispatched, failed }
}

/** 捞下一批仍可认领的 pending 记录 id。读失败时按空批次处理，由调用方结束这一拍。 */
function readPendingTriggerIds(decryptedDir: string, cap: number): number[] {
  const now = Date.now()
  return withWritableDb(taskDbPath(decryptedDir), (db) => {
    ensureTaskSchema(db)
    const rows = db.prepare(`SELECT t.id AS id FROM task_triggers t
      JOIN task_info i ON i.id = t.task_id
      WHERE t.callback_status = 'pending'
        AND i.status = 'ready'
        AND t.callback_lease_until <= ?
      ORDER BY t.triggered_at ASC, t.id ASC LIMIT ?`).all(now, cap) as Array<{ id?: unknown }>
    return rows.map((row) => taskCellNum(row.id))
  })
}

/**
 * 重叠投递一批记录。认领与落库仍按记录隔离，网络等待最多 {@link DISPATCH_CONCURRENCY} 路同时进行。
 * @returns 这一批里成功发出的条数。
 */
async function dispatchTriggerIds(
  decryptedDir: string,
  decodedDir: string,
  ids: readonly number[],
  deps: TaskDispatchDeps,
  errors: string[],
  count: (ok: boolean) => void,
): Promise<number> {
  let cursor = 0
  let sent = 0
  const workers = Array.from({ length: Math.min(DISPATCH_CONCURRENCY, ids.length) }, async () => {
    while (cursor < ids.length) {
      const index = cursor
      cursor += 1
      const id = ids[index]
      if (id === undefined) return
      try {
        const entry = await dispatchTaskCallbackInternal(decryptedDir, decodedDir, id, deps, {
          mode: 'automatic',
        })
        if (!entry.handled) continue
        const ok = entry.result.ok
        if (ok) sent += 1
        count(ok)
        if (!ok && errors.length < 10) {
          errors.push('记录 ' + String(id) + '：' + (entry.result.error ?? entry.result.status))
        }
      } catch (e) {
        count(false)
        if (errors.length < 10) errors.push('记录 ' + String(id) + '：' + taskErrorText(e))
      }
    }
  })
  await Promise.all(workers)
  return sent
}
