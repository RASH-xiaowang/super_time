/**
 * Daily-summary task store, rewritten from st_control daily_summary/crud.rs.
 * Persists scheduled summary tasks + generated records in <wechat>/daily_summary.db.
 * The LLM generation itself lives in the gateway (needs ctx.llm).
 */
import { DatabaseSync } from './db-open.ts'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SummaryTaskInput } from '../types.ts'
import { SUMMARY_WEBHOOK_TARGET_MAX, normalizeSummaryWebhookUrl } from './summary-webhook.ts'
import {
  displayNameForUsername,
  isMessageTableHash,
  resolveTalkerUsername,
} from './message-identity.ts'

/** Daily-summary DB path: sibling of the decrypted dir. */
function dbPath(decryptedDir: string): string {
  return join(dirname(decryptedDir), 'daily_summary.db')
}

/** 错误文本（Error.message 优先，非 Error 一律 String()）。 */
function errorText(e: unknown): string {
  const msg = (e as { message?: unknown } | null | undefined)?.message
  return typeof msg === 'string' && msg !== '' ? msg : String(e)
}

/**
 * Open (create) the summary store with schema.
 *
 * 显式建父目录（N1）：与待办库同族 —— 库建在解密数据根的**父目录**，那个目录只有在
 * 解密过至少一个库之后才存在，否则 SQLite 报 `unable to open database file`。
 * 建目录失败刻意吞掉（留日志），失败语义交给下面的 `DatabaseSync`，与改动前一致。
 * @param decryptedDir - decrypted data root.
 * @returns an opened store with schema ensured.
 */
function openStore(decryptedDir: string): DatabaseSync {
  const file = dbPath(decryptedDir)
  try {
    mkdirSync(dirname(file), { recursive: true })
  } catch (e) {
    console.warn('[summary-tasks] 数据根目录创建失败，继续尝试打开库：' + errorText(e))
  }
  const db = new DatabaseSync(file)
  db.exec("CREATE TABLE IF NOT EXISTS summary_tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, group_username TEXT NOT NULL, group_name TEXT NOT NULL DEFAULT '', target_users TEXT NOT NULL DEFAULT '[]', provider_id TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', format TEXT NOT NULL DEFAULT 'brief', custom_prompt TEXT NOT NULL DEFAULT '', schedule_time TEXT NOT NULL DEFAULT '08:00', enabled INTEGER NOT NULL DEFAULT 1, last_run_at INTEGER, last_status TEXT NOT NULL DEFAULT '', last_error TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)")
  db.exec("CREATE TABLE IF NOT EXISTS summary_records (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, group_username TEXT NOT NULL, group_name TEXT NOT NULL DEFAULT '', target_users TEXT NOT NULL DEFAULT '[]', summary_date TEXT NOT NULL, provider_id TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', format TEXT NOT NULL DEFAULT 'brief', summary TEXT NOT NULL DEFAULT '', char_count INTEGER NOT NULL DEFAULT 0, message_count INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'done', error TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL)")
  ensureWebhookColumns(db)
  return db
}

/**
 * 老库补列：`webhook_url` / `webhook_target`（2026-11-18 新增）。
 *
 * 为什么必须补而不是只改建表语句：`CREATE TABLE IF NOT EXISTS` 对**已存在**的表什么都不做，
 * 而线上早就有一堆建好的 `daily_summary.db`。不补列的话，升级后第一次 `SELECT *`
 * 会因为 `rowToTask` 读不到列而拿到 undefined（看起来像「配置丢了」），
 * 写入则会直接报 `table summary_tasks has no column named webhook_url`。
 *
 * 判据用 `PRAGMA table_info` 而不是「try ALTER / catch」：后者会把真正的写失败
 * 也一起吞掉。默认值空串 = 不推送，老任务行为完全不变。
 * @param db - 已打开的任务库。
 */
function ensureWebhookColumns(db: DatabaseSync): void {
  const present = new Set(
    (db.prepare('PRAGMA table_info(summary_tasks)').all() as Array<Record<string, unknown>>)
      .map(row => cellStr(row['name']).toLowerCase()),
  )
  if (!present.has('webhook_url')) {
    db.exec("ALTER TABLE summary_tasks ADD COLUMN webhook_url TEXT NOT NULL DEFAULT ''")
  }
  if (!present.has('webhook_target')) {
    db.exec("ALTER TABLE summary_tasks ADD COLUMN webhook_target TEXT NOT NULL DEFAULT ''")
  }
}

/** One summary task. */
export interface SummaryTask {
  id: number
  groupUsername: string
  groupName: string
  targetUsers: string[]
  format: string
  customPrompt: string
  scheduleTime: string
  enabled: boolean
  /**
   * Feather 的发送端点 `/webhook/<token>`；空串 = 不推送（2026-11-18 新增）。
   *
   * 地址里带着 token（就是凭据），所以**只在本机任务库里存**，
   * 界面上回显时走 `redactWebhookEndpoint` 的脱敏形式。
   */
  webhookUrl: string
  /** 推送对象（微信会话名，例如「文件传输助手」）；空串时由调用方退回群名。 */
  webhookTarget: string
  lastRunAt?: number
  lastStatus: string
  lastError: string
  createdAt: number
  updatedAt: number
}

/** One generated summary record. */
export interface SummaryRecord {
  id: number
  taskId: number
  groupUsername: string
  groupName?: string
  summaryDate: string
  summary: string
  messageCount: number
  status: string
  error: string
  createdAt: number
}

/** Coerce a DB cell to a string (null -> '', else String()). */
function cellStr(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === null || v === undefined) return ''
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol') return String(v)
  return ''
}

/**
 * Keep persisted summary identities canonical and human-readable.
 *
 * Older builds could store the message-table hash in both columns. A valid
 * hash is mapped back to its real group; an unresolvable one is shown as an
 * unnamed chat instead of being exposed as an internal key.
 * @param decryptedDir - decrypted data root.
 * @param storedUsername - raw `group_username` cell.
 * @param storedName - raw `group_name` cell.
 * @returns canonical username and safe display name.
 */
function canonicalSummaryIdentity(
  decryptedDir: string,
  storedUsername: string,
  storedName: string,
): { groupUsername: string; groupName: string } {
  const rawUsername = storedUsername.trim()
  const rawName = storedName.trim()
  const groupUsername = rawUsername ? resolveTalkerUsername(decryptedDir, rawUsername) : ''
  if (!rawUsername) return { groupUsername: '', groupName: rawName && !isMessageTableHash(rawName) ? rawName : '' }
  if (!groupUsername) return { groupUsername: '', groupName: '未命名会话' }
  const unsafeName = !rawName || rawName === rawUsername || isMessageTableHash(rawName)
  return {
    groupUsername,
    groupName: unsafeName ? displayNameForUsername(groupUsername) : rawName,
  }
}

/** Map a DB row to a task. */
function rowToTask(r: Record<string, unknown>, decryptedDir: string): SummaryTask {
  let targetUsers: string[] = []
  try { targetUsers = JSON.parse(cellStr(r['target_users'] ?? '[]')) as string[] } catch { /* keep empty */ }
  const identity = canonicalSummaryIdentity(
    decryptedDir,
    cellStr(r['group_username'] ?? ''),
    cellStr(r['group_name'] ?? ''),
  )
  const base: SummaryTask = {
    id: Number(r['id'] ?? 0),
    groupUsername: identity.groupUsername,
    groupName: identity.groupName,
    targetUsers,
    format: cellStr(r['format'] ?? 'brief'),
    customPrompt: cellStr(r['custom_prompt'] ?? ''),
    scheduleTime: cellStr(r['schedule_time'] ?? '08:00'),
    enabled: Number(r['enabled'] ?? 1) !== 0,
    webhookUrl: cellStr(r['webhook_url'] ?? ''),
    webhookTarget: cellStr(r['webhook_target'] ?? ''),
    lastStatus: cellStr(r['last_status'] ?? ''),
    lastError: cellStr(r['last_error'] ?? ''),
    createdAt: Number(r['created_at'] ?? 0),
    updatedAt: Number(r['updated_at'] ?? 0),
  }
  if (r['last_run_at']) base.lastRunAt = Number(r['last_run_at'])
  return base
}

/**
 * Read result: 既有调用方按 items/total 用不受影响，额外带一个**只在读失败时出现**的
 * `readError`（「库读不到」与「确实没有任务」必须可区分，见 N1）。
 */
export interface SummaryTaskSnapshotRead {
  items: SummaryTask[]
  total: number
  /** 读不到库时非空（此时 items 恒为 []）；确无任务时为 undefined。 */
  readError?: string
}

/**
 * List summary tasks.
 * @param decryptedDir - decrypted data root.
 * @returns summary task items plus total count.
 */
export function listSummaryTasks(decryptedDir: string): SummaryTaskSnapshotRead {
  try {
    const db = openStore(decryptedDir)
    const rows = db.prepare('SELECT * FROM summary_tasks ORDER BY id DESC').all() as Array<Record<string, unknown>>
    db.close()
    const items = rows.map(row => rowToTask(row, decryptedDir))
    return { items, total: items.length }
  } catch (e) {
    const readError = errorText(e)
    console.warn('[summary-tasks] 摘要任务读取失败（与「确无任务」不同）：' + dbPath(decryptedDir) + ': ' + readError)
    return { items: [], total: 0, readError }
  }
}

/**
 * Save a task (insert when id=0, else update).
 *
 * 入参形状统一在 API 面定义一份（`../types.ts` 的 `SummaryTaskInput`）：本模块那份 `SummaryTask`
 * 与 API 面那份是同形的历史重复（写侧/读侧各一份），但**入参**只有一份定义 ——
 * 否则「剔掉运行状态三列」这件事就得在 4 处各自记得。
 * 运行状态三列（`lastRunAt` / `lastStatus` / `lastError`）**不在入参里**，
 * 要改它们用 {@link updateSummaryTaskRunState}。
 * @param decryptedDir - decrypted data root.
 * @param task - task payload (id 0 inserts, otherwise updates).
 * @returns ok plus the saved task id, or an error description.
 */
export function saveSummaryTask(decryptedDir: string, task: SummaryTaskInput): { ok: boolean; id?: number; error?: string } {
  try {
    const hasUsername = task.groupUsername.trim() !== ''
    const identity = canonicalSummaryIdentity(decryptedDir, task.groupUsername, task.groupName)
    if (hasUsername && identity.groupUsername === '') {
      return { ok: false, error: '无法解析群会话身份，请重新选择会话' }
    }
    const db = openStore(decryptedDir)
    const ts = Date.now()
    const target = JSON.stringify(task.targetUsers)
    /**
     * 推送地址在**写入前**规范化：非法地址不该等到「到点推送失败」才被发现。
     *
     * 三态落到 SQL 的方式见 `SummaryWebhookUrlCheck.kind`：`keep` / `undefined` → NULL
     * （由 `COALESCE(?, 列)` 保留原值），`clear` → 空串，`set` → 规范化后的地址。
     */
    const rawWebhookUrl = typeof task.webhookUrl === 'string' ? task.webhookUrl : undefined
    const webhook = rawWebhookUrl === undefined ? null : normalizeSummaryWebhookUrl(rawWebhookUrl)
    if (webhook !== null && !webhook.ok) {
      db.close()
      return { ok: false, error: webhook.error ?? '推送地址无效' }
    }
    const webhookUrlCell = webhook === null || webhook.kind === 'keep'
      ? null
      : (webhook.kind === 'set' ? webhook.url : '')
    const webhookTargetCell = typeof task.webhookTarget === 'string'
      ? task.webhookTarget.trim().slice(0, SUMMARY_WEBHOOK_TARGET_MAX)
      : null
    if (task.id && task.id > 0) {
      // COALESCE(?, 列) —— 参数为 NULL 时保留原值。别改成「先读再写」：
      // 那会多一次查询，而且读到与写入之间还有被并发改写的窗口。
      db.prepare('UPDATE summary_tasks SET group_username = ?, group_name = ?, target_users = ?, format = ?, custom_prompt = ?, schedule_time = ?, enabled = ?, webhook_url = COALESCE(?, webhook_url), webhook_target = COALESCE(?, webhook_target), updated_at = ? WHERE id = ?').run(identity.groupUsername, identity.groupName, target, task.format, task.customPrompt, task.scheduleTime, task.enabled ? 1 : 0, webhookUrlCell, webhookTargetCell, ts, task.id)
      db.close()
      return { ok: true, id: task.id }
    }
    const r = db.prepare('INSERT INTO summary_tasks(group_username, group_name, target_users, format, custom_prompt, schedule_time, enabled, webhook_url, webhook_target, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(identity.groupUsername, identity.groupName, target, task.format, task.customPrompt, task.scheduleTime, task.enabled ? 1 : 0, webhookUrlCell ?? '', webhookTargetCell ?? '', ts, ts)
    const id = Number(r.lastInsertRowid)
    db.close()
    return { ok: true, id }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/**
 * Delete a task by id.
 * @param decryptedDir - decrypted data root.
 * @param id - task id to delete.
 * @returns ok, or an error description.
 */
/** Record a task's last run state (timestamp/status/error) so the scheduler does not re-run the same minute. */
export function updateSummaryTaskRunState(
  decryptedDir: string,
  id: number,
  lastRunAt: number,
  lastStatus: string,
  lastError: string,
): { ok: boolean; error?: string } {
  try {
    const db = openStore(decryptedDir)
    db.prepare('UPDATE summary_tasks SET last_run_at = ?, last_status = ?, last_error = ?, updated_at = ? WHERE id = ?').run(lastRunAt, lastStatus, lastError, Date.now(), id)
    db.close()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export function deleteSummaryTask(decryptedDir: string, id: number): { ok: boolean; error?: string } {
  try {
    const db = openStore(decryptedDir)
    db.prepare('DELETE FROM summary_tasks WHERE id = ?').run(id)
    db.close()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/**
 * Toggle a task enabled state.
 * @param decryptedDir - decrypted data root.
 * @param id - task id to toggle.
 * @param enabled - new enabled state.
 * @returns ok, or an error description.
 */
export function toggleSummaryTask(decryptedDir: string, id: number, enabled: boolean): { ok: boolean; error?: string } {
  try {
    const db = openStore(decryptedDir)
    db.prepare('UPDATE summary_tasks SET enabled = ?, updated_at = ? WHERE id = ?').run(enabled ? 1 : 0, Date.now(), id)
    db.close()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/**
 * Record a generated summary.
 * @param decryptedDir - decrypted data root.
 * @param rec - summary record payload (id/createdAt are generated).
 * @returns ok plus the new record id, or an error description.
 */
export function saveSummaryRecord(decryptedDir: string, rec: Omit<SummaryRecord, 'id' | 'createdAt'>): { ok: boolean; id?: number; error?: string } {
  try {
    const db = openStore(decryptedDir)
    const r = db.prepare('INSERT INTO summary_records(task_id, group_username, group_name, summary_date, summary, message_count, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(rec.taskId, rec.groupUsername, rec.groupName ?? '', rec.summaryDate, rec.summary, rec.messageCount, rec.status, rec.error, Date.now())
    const id = Number(r.lastInsertRowid)
    db.close()
    return { ok: true, id }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/**
 * Delete a generated record by id.
 * @param decryptedDir - decrypted data root.
 * @param id - record id to delete.
 * @returns ok, or an error description.
 */
export function deleteSummaryRecord(decryptedDir: string, id: number): { ok: boolean; error?: string } {
  try {
    const db = openStore(decryptedDir)
    db.prepare('DELETE FROM summary_records WHERE id = ?').run(id)
    db.close()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/**
 * List generated records (optionally for one task).
 * @param decryptedDir - decrypted data root.
 * @param taskId - optional task id to filter by.
 * @returns summary record items plus total count.
 */
export function listSummaryRecords(decryptedDir: string, taskId?: number): { items: SummaryRecord[]; total: number; readError?: string } {
  try {
    const db = openStore(decryptedDir)
    let rows: Array<Record<string, unknown>>
    if (taskId) {
      rows = db.prepare('SELECT * FROM summary_records WHERE task_id = ? ORDER BY created_at DESC LIMIT 50').all(taskId)
    } else {
      // 2026-10-17：100 → 200。周期总结现在也落库（`taskId=0`），会和每日总结共用这张表；
      // 100 条在"每天一份 + 每周/每月各一份"的节奏下只够看三个月。
      rows = db.prepare('SELECT * FROM summary_records ORDER BY created_at DESC LIMIT 200').all()
    }
    db.close()
    const items = rows.map((r) => {
      const identity = canonicalSummaryIdentity(
        decryptedDir,
        cellStr(r['group_username'] ?? ''),
        cellStr(r['group_name'] ?? ''),
      )
      return {
        id: Number(r['id'] ?? 0),
        taskId: Number(r['task_id'] ?? 0),
        groupUsername: identity.groupUsername,
        // 2026-10-17：`group_name` 之前漏读了 —— 类型里有这个字段，但映射时没取，
        // 于是「总结阅览」里永远显示 username 而不是群名。
        groupName: identity.groupName,
        summaryDate: cellStr(r['summary_date'] ?? ''),
        summary: cellStr(r['summary'] ?? ''),
        messageCount: Number(r['message_count'] ?? 0),
        status: cellStr(r['status'] ?? ''),
        error: cellStr(r['error'] ?? ''),
        createdAt: Number(r['created_at'] ?? 0),
      }
    })
    return { items, total: items.length }
  } catch (e) {
    const readError = errorText(e)
    console.warn('[summary-tasks] 摘要记录读取失败（与「确无记录」不同）：' + dbPath(decryptedDir) + ': ' + readError)
    return { items: [], total: 0, readError }
  }
}
