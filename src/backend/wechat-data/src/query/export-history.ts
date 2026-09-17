/**
 * 导出历史：记录每次导出，并支撑「打开文件 / 定位文件 / 复制路径 / 重新导出 /
 * 删除记录 / 清理失效记录」这些操作。
 *
 * ── 为什么复用 `wechat_privacy.db` ─────────────────────────────
 * 与 `operation-log.ts` 同一个库（`<数据根>/wechat_privacy.db`）。两者都是「本机元数据」
 * 且都按数据根隔离，再开一个库只会多一份文件与一套建表/清理逻辑。
 *
 * ── 与操作日志的分工 ─────────────────────────────────────────
 * `operation_log` 是**审计**：谁在何时做了什么，只留脱敏元数据，便于导出给人看。
 * 本模块是**可操作**：必须记住绝对路径与重跑参数，用户才能据此打开文件或重新导出。
 * 所以两张表各自独立 —— 不把「绝对路径」塞进审计表（那会让审计导出带上本机路径）。
 *
 * 写入一律 **best-effort**：记录失败绝不能影响导出本身（与 `recordOperation` 同口径）。
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type {
  ExportHistoryDeleteResult,
  ExportHistoryEntry,
  ExportHistoryPruneOptions,
  ExportHistoryQuery,
  ExportHistorySnapshot,
  ExportStatus,
} from '../types.ts'

const DEFAULT_LIMIT = 200
const MAX_LIMIT = 2000
const STATUSES: readonly ExportStatus[] = ['ok', 'fail', 'canceled']
const ALLOWED_STATUS = new Set<string>(STATUSES)
/** 排序列白名单 —— 直接拼进 SQL，必须白名单化（不参数化标识符）。 */
const SORT_COLUMNS: Record<string, string> = {
  ts: 'ts',
  size: 'size_bytes',
  rows: 'rows',
  name: 'filename',
}

function dbPath(decryptedDir: string): string {
  return join(dirname(decryptedDir), 'wechat_privacy.db')
}

function openStore(decryptedDir: string): DatabaseSync {
  const db = new DatabaseSync(dbPath(decryptedDir))
  db.exec(`CREATE TABLE IF NOT EXISTS export_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL,
    label TEXT,
    format TEXT,
    path TEXT NOT NULL,
    filename TEXT,
    size_bytes INTEGER,
    rows INTEGER,
    status TEXT NOT NULL,
    error TEXT,
    params TEXT
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS export_history_ts ON export_history(ts)')
  return db
}

/** 收敛缺失/占位文本（与 operation-log 同口径，避免界面上出现字面量 "undefined"）。 */
function cleanText(v: unknown): string {
  if (typeof v !== 'string') return ''
  const t = v.trim()
  return t === 'undefined' || t === 'null' ? '' : t
}

/** 记录一次导出。入口都只需给「已经发生的事实」。 */
export interface RecordExportInput {
  kind: string
  label?: string
  format?: string
  path: string
  /** 未给时从 path 推导。 */
  filename?: string
  sizeBytes?: number | null
  rows?: number
  status: ExportStatus
  error?: string
  /** 重新导出所需的原始入参（会被 JSON 序列化）。 */
  params?: unknown
  ts?: number
}

/**
 * 追加一条导出历史。best-effort：失败只留痕，绝不抛给调用方。
 * @param decryptedDir - 解密数据根（历史库位于其父目录）。
 * @param input - 本次导出的事实。
 * @returns 新记录 id；写入失败返回 null。
 */
export function recordExport(decryptedDir: string, input: RecordExportInput): number | null {
  try {
    const filePath = cleanText(input.path)
    if (!filePath) return null
    // size 缺省时尽力从磁盘取；取不到就存 null（不猜 0 —— 0 会被误读成空文件）。
    let size: number | null = input.sizeBytes ?? null
    if (size === null && input.status === 'ok') {
      try {
        const st = statSync(filePath)
        if (st.isFile()) size = st.size
      } catch { /* 文件不在了就留 null */ }
    }
    const db = openStore(decryptedDir)
    try {
      const info = db.prepare(`INSERT INTO export_history
        (ts, kind, label, format, path, filename, size_bytes, rows, status, error, params)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          input.ts ?? Date.now(),
          cleanText(input.kind) || 'unknown',
          cleanText(input.label),
          cleanText(input.format),
          filePath,
          cleanText(input.filename) || basename(filePath),
          size,
          Number.isFinite(input.rows) ? Number(input.rows) : 0,
          ALLOWED_STATUS.has(input.status) ? input.status : 'ok',
          cleanText(input.error),
          input.params === undefined ? '' : safeJson(input.params),
        )
      return Number(info.lastInsertRowid ?? 0) || null
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}

/** JSON 序列化，失败时退回空串（params 只用于「重新导出」，坏掉不影响历史本身）。 */
function safeJson(v: unknown): string {
  try {
    const s = JSON.stringify(v)
    return typeof s === 'string' ? s : ''
  } catch {
    return ''
  }
}

/** 把一个查询条件翻译成 WHERE 子句与参数。 */
function buildWhere(query: ExportHistoryQuery): { sql: string; params: Array<string | number> } {
  const clauses: string[] = []
  const params: Array<string | number> = []
  const kinds = (query.kinds ?? []).filter(k => typeof k === 'string' && k.trim() !== '')
  if (kinds.length > 0) {
    clauses.push('kind IN (' + kinds.map(() => '?').join(', ') + ')')
    params.push(...kinds)
  }
  if (query.status && ALLOWED_STATUS.has(query.status)) {
    clauses.push('status = ?')
    params.push(query.status)
  }
  if (typeof query.from === 'number' && Number.isFinite(query.from)) {
    clauses.push('ts >= ?')
    params.push(query.from)
  }
  if (typeof query.to === 'number' && Number.isFinite(query.to)) {
    clauses.push('ts <= ?')
    params.push(query.to)
  }
  const q = cleanText(query.q)
  if (q) {
    // 搜索面：文件名 / 说明 / 路径 / 种类。用 LIKE + 转义，避免 % 与 _ 被当成通配符
    // （用户搜 "2026_09" 时下划线不该变成「任意一个字符」）。
    const like = '%' + q.replace(/[\\%_]/g, m => '\\' + m) + '%'
    clauses.push("(filename LIKE ? ESCAPE '\\' OR label LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\' OR kind LIKE ? ESCAPE '\\')")
    params.push(like, like, like, like)
  }
  return { sql: clauses.length > 0 ? ' WHERE ' + clauses.join(' AND ') : '', params }
}

/** 行 → 条目（把磁盘存在性刷新为**当前**事实）。 */
function rowToEntry(r: Record<string, unknown>): ExportHistoryEntry {
  const path = cleanText(r['path'])
  return {
    id: Number(r['id'] ?? 0),
    ts: Number(r['ts'] ?? 0),
    kind: cleanText(r['kind']),
    label: cleanText(r['label']),
    format: cleanText(r['format']),
    path,
    filename: cleanText(r['filename']) || (path ? basename(path) : ''),
    sizeBytes: r['size_bytes'] === null || r['size_bytes'] === undefined ? null : Number(r['size_bytes']),
    rows: Number(r['rows'] ?? 0),
    status: (ALLOWED_STATUS.has(cleanText(r['status'])) ? cleanText(r['status']) : 'ok') as ExportStatus,
    error: cleanText(r['error']),
    params: cleanText(r['params']),
    // 每次读取都重新核对 —— 用户可能在资源管理器里移走/删掉了文件，
    // 历史列表必须显示「已不在」，否则「打开」按钮点了没反应会像 bug。
    existsNow: path ? existsSync(path) : false,
  }
}

/**
 * 读取导出历史。
 * @param decryptedDir - 解密数据根。
 * @param query - 搜索/筛选/排序/分页条件。
 * @returns 一页条目 + 命中总数 + 各聚合计数。
 */
export function listExportHistory(decryptedDir: string, query: ExportHistoryQuery = {}): ExportHistorySnapshot {
  const empty: ExportHistorySnapshot = { items: [], total: 0, statusCounts: {}, kindCounts: {}, totalBytes: 0, missingCount: 0 }
  const { sql: where, params } = buildWhere(query)
  const limitRaw = Number(query.limit)
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), MAX_LIMIT) : DEFAULT_LIMIT
  const offsetRaw = Number(query.offset)
  const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 0
  const col = SORT_COLUMNS[String(query.sort ?? 'ts')] ?? 'ts'
  const dir = query.order === 'asc' ? 'ASC' : 'DESC'
  try {
    const db = openStore(decryptedDir)
    try {
      const rows = db.prepare(
        `SELECT id, ts, kind, label, format, path, filename, size_bytes, rows, status, error, params
         FROM export_history${where} ORDER BY ${col} ${dir}, id DESC LIMIT ? OFFSET ?`,
      ).all(...params, limit, offset) as Array<Record<string, unknown>>
      const total = Number((db.prepare(`SELECT COUNT(*) AS c FROM export_history${where}`).get(...params) as { c?: number } | undefined)?.c ?? 0)
      // 聚合计数按**未分页**的命中集合算，否则页签数字会随翻页变化。
      const statusRows = db.prepare(`SELECT status, COUNT(*) AS c FROM export_history${where} GROUP BY status`).all(...params) as Array<{ status: string; c: number }>
      const kindRows = db.prepare(`SELECT kind, COUNT(*) AS c FROM export_history${where} GROUP BY kind`).all(...params) as Array<{ kind: string; c: number }>
      const statusCounts: Record<string, number> = {}
      for (const r of statusRows) statusCounts[cleanText(r.status)] = Number(r.c ?? 0)
      const kindCounts: Record<string, number> = {}
      for (const r of kindRows) kindCounts[cleanText(r.kind)] = Number(r.c ?? 0)
      const items = rows.map(rowToEntry)
      let totalBytes = 0
      let missingCount = 0
      for (const it of items) {
        if (it.existsNow) totalBytes += Math.max(0, it.sizeBytes ?? 0)
        else missingCount += 1
      }
      return { items, total, statusCounts, kindCounts, totalBytes, missingCount }
    } finally {
      db.close()
    }
  } catch {
    return empty
  }
}

/**
 * 删除若干条历史记录，可选连带删除磁盘文件。
 *
 * **默认不删文件**：删记录是「我不想再看到这条历史」，删文件是「我不要这个导出了」。
 * 两件事风险差一个量级，必须由界面显式选择，不能顺手做掉。
 *
 * @param decryptedDir - 解密数据根。
 * @param ids - 要删除的记录 id。
 * @param deleteFiles - 是否同时删除磁盘上的导出文件。
 * @returns 删除计数与文件删除失败清单。
 */
export function deleteExportHistory(
  decryptedDir: string,
  ids: readonly number[],
  deleteFiles = false,
): ExportHistoryDeleteResult {
  const result: ExportHistoryDeleteResult = { removed: 0, filesDeleted: 0, fileErrors: [] }
  const wanted = ids.map(Number).filter(n => Number.isFinite(n) && n > 0)
  if (wanted.length === 0) return result
  try {
    const db = openStore(decryptedDir)
    try {
      const sel = db.prepare(`SELECT id, path FROM export_history WHERE id IN (${wanted.map(() => '?').join(', ')})`)
      const rows = sel.all(...wanted) as Array<{ id: number; path: string }>
      if (deleteFiles) {
        const seen = new Set<string>()
        for (const r of rows) {
          const p = cleanText(r.path)
          if (!p || seen.has(p)) continue
          seen.add(p)
          try {
            // 只统计**真的存在并被删掉**的文件：文件早就没了还报「已删除 1 个」，
            // 会让用户以为清理动作动了别的东西（实测用例抓到这个多报）。
            // 目录型导出（备份目录）用 recursive，对文件型等价。
            if (existsSync(p)) {
              rmSync(p, { recursive: true, force: true })
              result.filesDeleted += 1
            }
          } catch (e) {
            result.fileErrors.push(basename(p) + ' — ' + (e as Error).message)
          }
        }
      }
      const del = db.prepare(`DELETE FROM export_history WHERE id IN (${wanted.map(() => '?').join(', ')})`)
      const info = del.run(...wanted)
      result.removed = Number(info.changes ?? rows.length)
      return result
    } finally {
      db.close()
    }
  } catch (e) {
    result.fileErrors.push((e as Error).message)
    return result
  }
}

/**
 * 按策略清理导出历史。
 *
 * 安全闸：`olderThanDays` 与 `keepLatest` **都为 0/缺省**且未指定 `onlyMissing` 时
 * **什么都不删** —— 防止调用方传一个空对象就把用户的历史清空。
 *
 * @param decryptedDir - 解密数据根。
 * @param opts - 清理策略。
 * @returns 与 `deleteExportHistory` 同形的结果。
 */
export function pruneExportHistory(
  decryptedDir: string,
  opts: ExportHistoryPruneOptions = {},
): ExportHistoryDeleteResult {
  const result: ExportHistoryDeleteResult = { removed: 0, filesDeleted: 0, fileErrors: [] }
  const days = Number(opts.olderThanDays)
  const keep = Number(opts.keepLatest)
  const hasDays = Number.isFinite(days) && days > 0
  const hasKeep = Number.isFinite(keep) && keep > 0
  if (!opts.onlyMissing && !hasDays && !hasKeep) return result // 安全闸：不做无差别清空

  try {
    const db = openStore(decryptedDir)
    let ids: number[] = []
    try {
      if (opts.onlyMissing) {
        // 失效记录：把 path 全部读出来在 JS 侧判断（SQL 里没法 existsSync）
        const rows = db.prepare('SELECT id, path FROM export_history').all() as Array<{ id: number; path: string }>
        ids = rows.filter(r => { const p = cleanText(r.path); return !p || !existsSync(p) }).map(r => Number(r.id))
      } else {
        const clauses: string[] = []
        const params: number[] = []
        if (hasKeep) {
          // 保留最近 keep 条：先取第 keep 条的时间戳做阈值（同一毫秒的多条一并保留）
          const anchor = db.prepare('SELECT ts FROM export_history ORDER BY ts DESC, id DESC LIMIT 1 OFFSET ?')
            .get(Math.max(0, Math.floor(keep) - 1)) as { ts?: number } | undefined
          if (anchor && typeof anchor.ts === 'number') {
            clauses.push('ts < ?')
            params.push(anchor.ts)
          }
        }
        if (hasDays) {
          clauses.push('ts < ?')
          params.push(Date.now() - Math.floor(days) * 86_400_000)
        }
        if (clauses.length > 0) {
          const rows = db.prepare(`SELECT id FROM export_history WHERE ${clauses.join(' AND ')}`).all(...params) as Array<{ id: number }>
          ids = rows.map(r => Number(r.id))
        }
      }
    } finally {
      db.close()
    }
    if (ids.length === 0) return result
    return deleteExportHistory(decryptedDir, ids, opts.deleteFiles === true)
  } catch (e) {
    result.fileErrors.push((e as Error).message)
    return result
  }
}
