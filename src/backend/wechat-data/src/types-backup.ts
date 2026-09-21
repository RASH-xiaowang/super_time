/**
 * `types.ts` 的 backup 部分（M21 拆分；纯类型，无运行期值）。
 *
 * 从 `types.ts` 原样搬出，`types.ts` 继续以 `export *` 转发 ⇒ 所有
 * `from './types.ts'` / `from '../types.ts'` 的导入路径一行都不用改。
 *
 * @module types-backup
 */
/** One backup entry. */
export interface BackupEntry {
  name: string
  path: string
  size: number
  modified: number
  kind: 'dir' | 'enc'
  /** Short content summary (dir: item count + db count; enc: format note). */
  summary?: string
  /** Integrity: dir backup has at least one DB; enc backup has a valid header. */
  ok?: boolean
}

/** One file/dir inside a backup (for the restore preview). */
export interface BackupPreviewItem {
  name: string
  size: number
  isDir: boolean
}

/** Backup list snapshot. */
export interface BackupSnapshot {
  items: BackupEntry[]
  total: number
}

/** Backup restore-preview snapshot (bounded file list). */
export interface BackupPreviewSnapshot {
  items: BackupPreviewItem[]
  total: number
}

/** Backup mutation result. */
export interface BackupMutationResult {
  ok: boolean
  error?: string
  name?: string
}

/** Backup restore result. */
export interface BackupRestoreResult {
  ok: boolean
  path?: string
  error?: string
}

/** Daily summary result: LLM summary + collected message stats. */
export interface DailySummaryResult {
  summary: string
  date: string
  sessions: number
  messages: number
  /** Total messages in the day (all types). */
  total: number
  /** Message type -> count. */
  types: Record<string, number>
  /** 24h message distribution. */
  hourly: number[]
  /** Top chatrooms by message count. */
  topSessions: Array<{ username: string; count: number }>
}

/** Period summary result (weekly/monthly/custom range): LLM summary + stats. */
export interface PeriodSummaryResult {
  summary: string
  from: string
  to: string
  sessions: number
  messages: number
  total: number
  types: Record<string, number>
  hourly: number[]
  topSessions: Array<{ username: string; count: number }>
}

/** One extracted/imported WeChat task. */
export interface WechatTask {
  id: number
  title: string
  status: 'open' | 'done'
  dueAt?: number
  sourceUsername?: string
  sourceLocalId?: number
  messageTime?: number
  createdAt: number
  updatedAt: number
}

/** Task list snapshot. */
export interface TasksSnapshot {
  items: WechatTask[]
  total: number
}

/** Task mutation result (add/status/delete/extract). */
export interface TaskMutationResult {
  ok: boolean
  id?: number
  added?: number
  error?: string
}
