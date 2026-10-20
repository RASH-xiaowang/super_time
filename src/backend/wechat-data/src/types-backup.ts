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

/**
 * AI 年报叙述的一个分段结果（W2-8.6）。
 */
export interface AnnualSegmentResult {
  /** 段名（「2024-03」/「2024-03（第 2 段）」）。 */
  label: string
  /** 本段正文；失败时是失败原因（如实说，不假装成功）。 */
  text: string
  /** 本段是否成功。 */
  ok: boolean
}

/** AI 年报叙述结果（分段 LLM，W2-8.6）。 */
export interface AnnualNarrativeResult {
  ok: boolean
  year: number
  segments: AnnualSegmentResult[]
  /** 拼接好的全文。 */
  text: string
  /** 段数是否被 MAX_SEGMENTS 截断。 */
  truncated: boolean
  error?: string
}

/** One extracted/imported WeChat task. */
export interface WechatTask {  id: number
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

/** One chat resource collection task（新建任务：保留某会话最近 N 条文本 + M 张图片）。 */
export interface ChatCollectTask {
  id: number
  username: string
  displayName: string
  /** 创建时选择的文本条数。 */
  textLimit: number
  /** 创建时选择的图片张数。 */
  imageLimit: number
  /** 实际保留的文本条数。 */
  textCount: number
  /** 实际落盘的图片张数（解码失败的图片不计入）。 */
  imageCount: number
  /** 资源目录：texts.json / images/ / task.json 所在。 */
  dir: string
  createdAt: number
}

/** 收集任务列表快照。 */
export interface ChatCollectTaskSnapshot {
  items: ChatCollectTask[]
  total: number
  readError?: string
}

/** 收集任务创建结果。 */
export interface ChatCollectTaskResult {
  ok: boolean
  task?: ChatCollectTask
  error?: string
}
