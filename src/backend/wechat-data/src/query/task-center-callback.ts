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
import { withWritableDb } from './db-open.ts'
import { findVendor } from './rpa/registry.ts'
import { missingReadyFields, migrateLegacySecrets, normalizeTriggerMethod, parseSecretJson } from './rpa/template.ts'
import { dispatchRpaRecord } from './rpa/dispatch.ts'
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
import type { RpaDispatchOutcome, RpaInvocationContext, RpaRecordContext } from './rpa/types.ts'
import type {
  TaskCallbackDispatchResult,
  TaskInfo,
  TaskTriggerCallbackStatus,
  TaskTriggerRecord,
} from '../types.ts'

/** 投递失败原因落库上限。 */
const CALLBACK_ERROR_MAX = 500
/** 一批待投递记录的上限（定时器每拍只处理这么多，避免一次拍住事件循环太久）。 */
const PENDING_DISPATCH_LIMIT = 10

/** 投递依赖：图片解码、隐私闸与 fetch 都由调用方注入（query 层不 import gateway 侧）。 */
export interface TaskDispatchDeps {
  /**
   * 解码一张图片（`username` + `localId`）。返回 `url`（data URL）或 `file`
   * （相对 `decodedDir` 的路径）之一；两者都没有 = 这张解不出来。
   * 只有 Webhook 适配器使用（其他厂商不发图片）。
   */
  decodeImage: (username: string, localId: number) => Promise<{ url?: string; file?: string }>
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
function readDispatchTarget(file: string, triggerId: number): DispatchTarget {
  return withWritableDb(file, (db) => {
    const triggerRow = db.prepare('SELECT * FROM task_triggers WHERE id = ?').get(triggerId) as Record<string, unknown> | undefined
    if (triggerRow === undefined) return {}
    const record = rowToTrigger(triggerRow)
    const taskRow = db.prepare('SELECT * FROM task_info WHERE id = ?').get(record.taskId) as Record<string, unknown> | undefined
    if (taskRow === undefined) return { record }
    const task = rowToTask(taskRow)
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

/** 把投递结果写回记录（单语句 autocommit；写失败不影响已经发出的请求这一事实）。 */
function saveDispatchResult(
  file: string,
  triggerId: number,
  status: TaskTriggerCallbackStatus,
  error: string,
  externalTaskId: string,
): void {
  withWritableDb(file, (db) => {
    ensureTaskSchema(db)
    db.prepare(`UPDATE task_triggers SET
      callback_status = ?, callback_at = ?, callback_error = ?, external_task_id = ?
      WHERE id = ?`).run(status, Date.now(), error, externalTaskId, triggerId)
  })
}

/**
 * 批量投递时把「任务没配好 / 厂商已下线」的 pending 记录落成 `skipped`。
 *
 * 预检 skipped 不出网；但若不落库，同一批 pending 会被每一拍重复捞到（队头阻塞，
 * 后面配置齐全的记录永远排不上）。落库失败只影响下一拍重试，不改变本次返回。
 * @param file - 任务库路径。
 * @param triggerId - 触发记录 id。
 * @param error - 跳过原因（≤500 字）。
 */
function persistSkipped(file: string, triggerId: number, error: string): void {
  try {
    saveDispatchResult(file, triggerId, 'skipped', error.slice(0, CALLBACK_ERROR_MAX), '')
  } catch {
    /* 落库失败：下一拍还会再遇到它，不改变本次计数 */
  }
}

/**
 * 组装一次投递的上下文（模板占位符的顶层根）。
 *
 * `record.chatType` 取任务配置（触发记录只存会话用户名/显示名，没存类型）；
 * `text` 已过隐私闸；`images` 原样带上（只有 Webhook 会解码）。
 * @param task - 任务配置。
 * @param record - 触发记录。
 * @param secrets - 凭据原文。
 * @param text - 已过隐私闸的触发文本。
 * @returns 投递上下文。
 */
function buildInvocationContext(
  task: TaskInfo,
  record: TaskTriggerRecord,
  secrets: Record<string, string>,
  text: string,
): RpaInvocationContext {
  const recordContext: RpaRecordContext = {
    username: record.chatUsername,
    chatName: record.chatName,
    chatType: task.chatType,
    targetName: record.targetName,
    targetUsername: record.targetUsername,
    text,
    keyword: record.keyword,
    triggeredAt: record.triggeredAt,
    images: record.images,
  }
  return {
    taskId: task.id,
    recordId: record.id,
    idempotencyKey: String(task.id) + ':' + String(record.id),
    taskName: task.name,
    record: recordContext,
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
 * 文本先过**同一个**隐私闸（feature 仍是 `task_callback`）；图片只由 Webhook 适配器按需解码。
 * 失败不抛异常：`{ok:false, status:'failed', error}` 并落进记录，供前端重试。
 * @param decryptedDir - 解密数据根。
 * @param decodedDir - 图片解码缓存根（仅 Webhook 方式使用）。
 * @param triggerId - 触发记录 id。
 * @param deps - 解码 / 隐私闸 / fetch 注入。
 * @returns 投递结果（含 skipped 的几种可读原因）。
 */
export async function dispatchTaskCallback(
  decryptedDir: string,
  decodedDir: string,
  triggerId: number,
  deps: TaskDispatchDeps,
): Promise<TaskCallbackDispatchResult> {
  const id = taskCellNum(triggerId)
  if (id <= 0) return skipped('触发记录不存在')
  if (!storeExists(decryptedDir)) return skipped('触发记录不存在')
  const file = taskDbPath(decryptedDir)
  let target: DispatchTarget
  try {
    target = readDispatchTarget(file, id)
  } catch (e) {
    return skipped('读取触发记录失败：' + taskErrorText(e))
  }
  const { record, task } = target
  if (record === undefined) return skipped('触发记录不存在')
  if (task === undefined) return skipped('任务不存在或已删除')
  if (task.status !== 'ready') return skipped('任务未完善')
  const adapter = findVendor(task.triggerMethod)
  if (adapter === undefined) return skipped('触发方式不可用：' + task.triggerMethod)
  const missing = missingReadyFields(adapter.descriptor, task.triggerConfig, task.triggerSecretSet)
  if (missing.length > 0) return skipped('触发配置不完整：' + missing.join('、'))

  // 所有厂商都发过闸文本；`contentOutbound=false` 的厂商拿空串（当前没有这种厂商）。
  const gated = deps.gate('task_callback', { sessions: 1, messages: 1 }, [record.text])
  const gatedText = Array.isArray(gated) && gated.length > 0 ? taskCellStr(gated[0]) : record.text
  const text = adapter.descriptor.governance.contentOutbound ? gatedText : ''
  const ctx = buildInvocationContext(task, record, target.secrets ?? {}, text)
  let outcome: RpaDispatchOutcome
  try {
    outcome = await dispatchRpaRecord({
      adapter,
      ctx,
      deps: deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl },
      buildDeps: { decodedDir, decodeImage: deps.decodeImage },
    })
  } catch (e) {
    outcome = { status: 'failed', error: taskErrorText(e) }
  }
  const { result, error } = outcomeResult(outcome)
  try {
    saveDispatchResult(file, id, result.status, error, result.externalTaskId ?? '')
  } catch (e) {
    // 请求可能已经到达对端；此时如实说"结果没存下来"，而不是回一个会诱发重复投递的失败。
    return result.ok
      ? { ok: true, status: 'sent', error: '投递结果保存失败：' + taskErrorText(e) }
      : { ok: false, status: result.status, error: error + '（结果保存失败：' + taskErrorText(e) + '）' }
  }
  return result
}

/**
 * 投递一批 `pending` 记录。
 *
 * 只按「记录 pending + 所属任务 ready」捞（**不再按厂商列过滤**）：逐条在 JS 里用注册表
 * 判配置后投递，未配置/厂商下线的记录会被 skipped 并写明原因（**落库为 skipped**，否则
 * 同一批 pending 会每拍重复占用名额、队头阻塞）。单条失败不连坐（错误只收集前 10 条）；
 * 成功/失败/skipped 都算处理过，下一拍不会重复捞。
 * @param decryptedDir - 解密数据根。
 * @param decodedDir - 图片解码缓存根。
 * @param deps - 解码 / 隐私闸 / fetch 注入。
 * @param limit - 本次最多投几条（默认 10）。
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
  let ids: number[] = []
  try {
    ids = withWritableDb(taskDbPath(decryptedDir), (db) => {
      // 老库在这里顺手补列：下面 SELECT 引用了外部任务 id / 通用配置等新列。
      ensureTaskSchema(db)
      const rows = db.prepare(`SELECT t.id AS id FROM task_triggers t
        JOIN task_info i ON i.id = t.task_id
        WHERE t.callback_status = 'pending' AND i.status = 'ready'
        ORDER BY t.triggered_at ASC, t.id ASC LIMIT ?`).all(cap) as Array<{ id?: unknown }>
      return rows.map((row) => taskCellNum(row.id))
    })
  } catch (e) {
    return { dispatched: 0, failed: 0, errors: ['读取待投递记录失败：' + taskErrorText(e)] }
  }
  let dispatched = 0
  let failed = 0
  const errors: string[] = []
  const file = taskDbPath(decryptedDir)
  for (const id of ids) {
    try {
      const r = await dispatchTaskCallback(decryptedDir, decodedDir, id, deps)
      if (r.ok) dispatched += 1
      else {
        failed += 1
        if (errors.length < 10) errors.push('记录 ' + String(id) + '：' + (r.error ?? r.status))
        // 预检 skipped 不出网但必须落库：否则每拍重复捞到同一批，队头阻塞后面的记录。
        if (r.status === 'skipped') persistSkipped(file, id, r.error ?? '')
      }
    } catch (e) {
      failed += 1
      if (errors.length < 10) errors.push('记录 ' + String(id) + '：' + taskErrorText(e))
    }
  }
  return errors.length > 0 ? { dispatched, failed, errors } : { dispatched, failed }
}
