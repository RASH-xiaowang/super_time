/**
 * Operation log for the WeChat data panel: append-only records of the work
 * this app performs (settings, keys, sync, exports, deletes, backups, edits,
 * tasks) plus the failures it observes. Entries carry metadata only — never
 * message bodies, image or file contents — so an export is safe to share.
 * Persisted in the same <data-root>/wechat_privacy.db as the privacy audit
 * log.
 */
import { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'
import type {
  OperationCategory,
  OperationLogClearResult,
  OperationLogEntry,
  OperationLogQuery,
  OperationLogSnapshot,
  OperationStatus,
} from '../types.ts'

/** Categories accepted from the client; anything else is dropped by the filter. */
const CATEGORIES: readonly OperationCategory[] = ['settings', 'keys', 'sync', 'export', 'delete', 'backup', 'edit', 'task', 'error']
const ALLOWED_CATEGORIES = new Set<string>(CATEGORIES)
/** Valid result statuses. */
const STATUSES: readonly OperationStatus[] = ['ok', 'fail', 'skip']
const DEFAULT_LIMIT = 500
const MAX_LIMIT = 5000

function dbPath(decryptedDir: string): string {
  return join(dirname(decryptedDir), 'wechat_privacy.db')
}

function openStore(decryptedDir: string): DatabaseSync {
  const db = new DatabaseSync(dbPath(decryptedDir))
  db.exec('CREATE TABLE IF NOT EXISTS operation_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, category TEXT NOT NULL, action TEXT, target TEXT, status TEXT NOT NULL, detail TEXT)')
  db.exec('CREATE INDEX IF NOT EXISTS operation_log_ts ON operation_log(ts)')
  return db
}

/**
 * 把缺失/占位的文本收敛成空串。
 *
 * 为什么需要：`this.op('task', 'generate_annual_report', 'ok', String(options.year), …)`
 * 在调用方没传 `year` 时会写入**字面量字符串 `undefined`**，界面上就会出现一行
 * 「目标 = undefined」（第 48 轮在操作日志里实测到）。这里在**写入与读取两侧**都收敛：
 * 写入侧防止新脏数据，读取侧把库里已有的 `undefined`/`null` 历史行显示成空。
 */
function cleanText(v: unknown): string {
  if (typeof v !== 'string') return ''
  const t = v.trim()
  return t === 'undefined' || t === 'null' ? '' : t
}

/** Append one operation row. Best-effort: a logging failure never breaks the operation it records. */
export function recordOperation(decryptedDir: string, entry: Omit<OperationLogEntry, 'id' | 'ts'> & { ts?: number }): void {
  try {
    const db = openStore(decryptedDir)
    db.prepare('INSERT INTO operation_log(ts, category, action, target, status, detail) VALUES (?, ?, ?, ?, ?, ?)')
      .run(entry.ts ?? Date.now(), entry.category, cleanText(entry.action), cleanText(entry.target), entry.status, cleanText(entry.detail))
    db.close()
  } catch { /* operation log is best-effort */ }
}

/** Build the WHERE clause + bound params for one query, from its optional filters. */
function whereClause(query: OperationLogQuery): { sql: string; params: (string | number)[] } {
  const clauses: string[] = []
  const params: (string | number)[] = []
  if (query.from !== undefined) { clauses.push('ts >= ?'); params.push(query.from) }
  if (query.to !== undefined) { clauses.push('ts <= ?'); params.push(query.to) }
  if (query.status !== undefined) { clauses.push('status = ?'); params.push(query.status) }
  const categories = (query.categories ?? []).filter(c => ALLOWED_CATEGORIES.has(c))
  if (categories.length > 0) {
    clauses.push('category IN (' + categories.map(() => '?').join(', ') + ')')
    params.push(...categories)
  }
  const kw = (query.q ?? '').trim()
  if (kw !== '') {
    // 转义 % 与 _，否则用户输入里的通配符会被当成 SQL 通配符（搜「%」等于全表）。
    const like = '%' + kw.replace(/[\\%_]/g, (m) => '\\' + m) + '%'
    clauses.push("(action LIKE ? ESCAPE '\\' OR target LIKE ? ESCAPE '\\' OR detail LIKE ? ESCAPE '\\')")
    params.push(like, like, like)
  }
  return { sql: clauses.length > 0 ? ' WHERE ' + clauses.join(' AND ') : '', params }
}

function asCategory(v: unknown): OperationCategory {
  return CATEGORIES.find(c => c === v) ?? 'error'
}

function asStatus(v: unknown): OperationStatus {
  return STATUSES.find(s => s === v) ?? 'fail'
}

function toEntry(r: Record<string, unknown>): OperationLogEntry {
  /* v8 ignore next -- id is the AUTOINCREMENT primary key; a stored row always has it. */
  const id = Number(r['id'] ?? 0)
  /* v8 ignore next -- ts is a NOT NULL column; a stored row always has it. */
  const ts = Number(r['ts'] ?? 0)
  return {
    id,
    ts,
    category: asCategory(r['category']),
    action: cleanText(r['action']),
    target: cleanText(r['target']),
    status: asStatus(r['status']),
    detail: cleanText(r['detail']),
  }
}

/**
 * Read matching operation rows, newest first. `total` counts every match,
 * ignoring `limit`.
 * @param decryptedDir - decrypted WeChat data root.
 * @param query - optional time-range / category / status / limit filters.
 * @returns OperationLogSnapshot: matching items + full match count.
 */
export function listOperations(decryptedDir: string, query: OperationLogQuery = {}): OperationLogSnapshot {
  const { sql, params } = whereClause(query)
  const limit = Math.min(Math.max(Math.floor(query.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT)
  const offset = Math.max(Math.floor(query.offset ?? 0), 0)
  try {
    const db = openStore(decryptedDir)
    const countRow = db.prepare('SELECT COUNT(*) AS n FROM operation_log' + sql).get(...params) as { n?: number } | undefined
    const rows = db.prepare('SELECT id, ts, category, action, target, status, detail FROM operation_log' + sql + ' ORDER BY id DESC LIMIT ? OFFSET ?')
      .all(...params, limit, offset) as Array<Record<string, unknown>>
    db.close()
    /* v8 ignore next -- COUNT(*) always returns exactly one row, so countRow and its n are defined. */
    return { items: rows.map(toEntry), total: countRow?.n ?? 0 }
  } catch {
    return { items: [], total: 0 }
  }
}

/**
 * Delete all operation-log rows.
 * @param decryptedDir - decrypted WeChat data root.
 * @returns OperationLogClearResult: ok + removed row count.
 */
export function clearOperationLog(decryptedDir: string): OperationLogClearResult {
  try {
    const db = openStore(decryptedDir)
    const r = db.prepare('DELETE FROM operation_log').run()
    db.close()
    return { ok: true, removed: Number(r.changes) }
  } catch {
    return { ok: false, removed: 0 }
  }
}
