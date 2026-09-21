/**
 * `api.ts` 的「导出与运维：导出进度与取消、库状态与健康、语音与视频、会话导出、备份、总结产物、模型列表、编辑记录、导出历史、草稿、任务」部分（M21 拆分）。
 *
 * 从原模块原样搬出，**行为逐字节不变**；原文件继续以 `export *` 转发
 * ⇒ 所有既有 import 一行都不用改。
 *
 * @module api-export-ops
 */

import type {
  AccountsSnapshot,
  AnnualReport,
  AnnualSnapshot,
  AssetInsightsSnapshot,
  AutoDbKeyResult,
  AutoImageKeyResult,
  AskHistoryClearResult,
  AskHistoryDeleteResult,
  AskHistoryQuery,
  AskHistorySnapshot,
  AskOptimizeResult,
  AskResult,
  ReplySuggestResult,
  AvatarResult,
  BackupMutationResult,
  BackupRestoreResult,
  BackupPreviewSnapshot,
  ExportHistoryDeleteResult,
  ExportHistoryPruneOptions,
  ExportHistoryQuery,
  ExportHistorySnapshot,
  BackupSnapshot,
  CalendarSnapshot,
  ChatHistoryResolveResult,
  ConfigSnapshot,
  Contact360Snapshot,
  ContactsSnapshot,
  DailySummaryResult,
  DbHealthSnapshot,
  DbStatusSnapshot,
  DecryptAllResult,
  DecryptImagesResult,
  DecryptStatus,
  DeleteFavoriteResult,
  DraftClearResult,
  DraftsClearResult,
  EditMutationResult,
  EditedListSnapshot,
  EmoticonsSnapshot,
  ExportResult,
  FavoritesSnapshot,
  FilesSnapshot,
  GenerateKeysResult,
  CallsSnapshot,
  GraphSnapshot,
  GroupInfoSnapshot,
  GroupInsightsSnapshot,
  HandoffRemindsSnapshot,
  ImageDataUrlResult,
  KeysInfoResult,
  LedgerSnapshot,
  MediaAssetsSnapshot,
  MemberSearchSnapshot,
  MessagesSnapshot,
  MomentsInsightsSnapshot,
  MomentsMonthlyRow,
  MomentsSnapshot,
  OfficialAssetsSnapshot,
  OverviewInsights,
  OverviewSnapshot,
  RegionMapSnapshot,
  OperationLogClearResult,
  OperationLogQuery,
  OperationLogSnapshot,
  PaymentStatus,
  PeriodSummaryResult,
  PrivacyAuditClearResult,
  PrivacyAuditRow,
  PrivacySnapshot,
  PrivacyStateSnapshot,
  RecordsSnapshot,
  RevokedSnapshot,
  SearchBuildResult,
  SearchIndexStatus,
  SearchSnapshot,
  SessionsSnapshot,
  SimpleResult,
  StorageSnapshot,
  SummaryRecordSnapshot,
  SummaryTask,
  SummaryTaskMutationResult,
  SummaryTaskRunResult,
  SummaryTaskSnapshot,
  TaskMutationResult,
  TasksSnapshot,
  UnifiedSearchSnapshot,
  VerifyImageKeyResult,
  VerifyKeyResult,
  VideoInfoResult,
  VoiceInfoResult,
  VoiceTranscriptResult,
  VoiceTranscribeOneResult,
  VoiceTranscribeResult,
  WechatConfigFull,
  WechatConfigPatch,
  WhisperDownloadResult,
  WhisperStatus,
} from '@deepseek-ai/dsh-wechat-data/types'
import {
  cachedFetch,
  cachedGet,
  invalidateSnapshotCache,
  invalidateWechatCache,
  readRenderCache,
  snapshotDelete,
  subscribeSnapshot,
  writeRenderCache,
} from './cache.ts'
import { ExportProgressSnapshot, SummaryRecordSnapshotRead, SummaryTaskSnapshotRead, TasksSnapshotRead, VoicePlaybackResult, remote, unwrap } from './api-core.ts'

/**
 * 取消一个在跑的导出/备份任务（M3）。
 * @param jobId - 调用导出时传下去的那个标识。
 * @returns ok=false 时 error 是可读原因（无此任务 / 已结束）。
 */
export async function apiCancelExportJob(jobId: string): Promise<{ ok: boolean; error?: string }> {
  return unwrap(await remote().cancelExportJob({ jobId }))
}

/**
 * 读一个导出/备份任务的最新进度（M3）。
 *
 * 进度事件 `wechat-export/progress` 要经过宿主 → 渲染层的白名单中继才能到达 `window`；
 * 轮询这条 RPC 不依赖中继，是「进度拿得到」的兜底路径（例如面板在任务中途才打开）。
 * @param jobId - 调用导出时传下去的那个标识。
 * @returns 最近一次进度；`found:false` 表示该标识已不存在（进程重启过）。
 */
export async function apiGetExportProgress(jobId: string): Promise<ExportProgressSnapshot> {
  return unwrap(await remote().getExportProgress({ jobId }))
}
/**
 * Fetch decrypted database status.
 * @returns DbStatusSnapshot.
 */
export async function apiGetDbStatus(): Promise<DbStatusSnapshot> {
  return unwrap(await remote().getDbStatus())
}
/**
 * Fetch the data-health snapshot.
 * @returns DbHealthSnapshot.
 */
export async function apiGetDbHealth(): Promise<DbHealthSnapshot> {
  return unwrap(await remote().getDbHealth())
}
/**
 * Fetch voice message info.
 * @param options - Query options: username and message localId.
 * @returns VoiceInfoResult.
 */
export async function apiGetVoiceInfo(options: { username: string; localId: number }): Promise<VoiceInfoResult> {
  return unwrap(await remote().getVoiceInfo(options))
}
/**
 * Fetch a voice message as an inline-playable wav data URL.
 * @param options - Query options: username and message localId.
 * @returns VoicePlaybackResult.
 */
export async function apiGetVoiceDataUrl(options: { username: string; localId: number }): Promise<VoicePlaybackResult> {
  return unwrap(await remote().getVoiceDataUrl(options))
}
/**
 * Fetch video message info.
 * @param options - Query options: username and message localId.
 * @returns VideoInfoResult.
 */
export async function apiGetVideoInfo(options: { username: string; localId: number }): Promise<VideoInfoResult> {
  return unwrap(await remote().getVideoInfo(options))
}
/**
 * Export one session's messages.
 *
 * 整个 options 原样透传（不再只挑 4 个字段）：会话导出支持
 * `dir`/`filename`/`types`/`from`/`to`/`zip` 等条件，**少传任何一个都会导出不同结果**；
 * 导出历史里的「重新导出」正是靠这些参数重放的。
 * @param options - 会话导出参数（透传给后端）。
 * @returns ExportResult.
 */
export async function apiExportSessionMessages(options: {
  username: string
  format: string
  count?: number
  dir?: string
  types?: number[]
  richTypes?: string[]
  from?: number
  to?: number
  filename?: string
  zip?: boolean
  sessionName?: string
  jobId?: string
}): Promise<ExportResult> {
  return unwrap(await remote().exportSessionMessages(options))
}
/**
 * List decrypted-data backups.
 * @returns BackupSnapshot.
 */
export async function apiListBackups(): Promise<BackupSnapshot> {
  return unwrap(await remote().listBackups())
}
/**
 * Preview a backup's contents before restore.
 * @param options - backup name.
 * @returns BackupPreviewSnapshot.
 */
export async function apiPreviewBackup(options: { name: string }): Promise<BackupPreviewSnapshot> {
  return unwrap(await remote().previewBackup(options))
}
/**
 * Create a new backup.
 * @returns BackupMutationResult.
 */
export async function apiCreateBackup(): Promise<BackupMutationResult> {
  return unwrap(await remote().createBackup())
}
/**
 * Create an encrypted `.wcb` backup bundle.
 * @param options - encryption password.
 * @returns BackupMutationResult.
 */
export async function apiCreateEncryptedBackup(options: { password: string; jobId?: string }): Promise<BackupMutationResult> {
  return unwrap(await remote().createEncryptedBackup(options))
}
/**
 * Restore an encrypted backup into a plain directory.
 * @param options - backup name and password.
 * @returns BackupRestoreResult.
 */
export async function apiRestoreBackup(options: { name: string; password: string }): Promise<BackupRestoreResult> {
  const r = await remote().restoreBackup(options)
  invalidateWechatCache('')
  return unwrap(r)
}
/**
 * Delete a backup by name.
 * @param options - Query options: backup name.
 * @returns BackupMutationResult.
 */
export async function apiDeleteBackup(options: { name: string }): Promise<BackupMutationResult> {
  return unwrap(await remote().deleteBackup(options))
}
/**
 * Generate a daily summary for the given date.
 * @param options - Query options: the date (YYYY-MM-DD).
 * @returns DailySummaryResult.
 */
export async function apiGenerateDailySummary(options: { date: string; provider?: string; model?: string }): Promise<DailySummaryResult> {
  return unwrap(await remote().generateDailySummary(options))
}
/**
 * Generate a period (weekly/monthly/custom) chat summary via DSH LLM.
 * @param options - inclusive date range plus optional model override.
 * @returns PeriodSummaryResult.
 */
export async function apiGeneratePeriodSummary(options: {
  from: string
  to: string
  provider?: string
  model?: string
}): Promise<PeriodSummaryResult> {
  return unwrap(await remote().generatePeriodSummary(options))
}

/** List available LLM providers for the daily-summary model selector. */
export async function apiListLlmProviders(): Promise<{ providers: Array<{ id: string; name: string }> }> {
  return unwrap(await remote().listLlmProviders())
}

/** List models for one LLM provider. */
export async function apiListLlmModels(options: { provider: string }): Promise<{ models: Array<{ id: string; name: string }> }> {
  return unwrap(await remote().listLlmModels(options))
}
/**
 * List edited-message records (optionally filtered by session).
 * @param options - Query options: optional sessionId filter.
 * @returns EditedListSnapshot.
 */
export async function apiListEditedMessages(options?: { sessionId?: string }): Promise<EditedListSnapshot> {
  return unwrap(await remote().listEditedMessages(options))
}
/**
 * Apply an edit to a chat message.
 * @param options - Mutation options: username, message localId, new content.
 * @returns EditMutationResult.
 */
export async function apiEditChatMessage(options: { username: string; localId: number; content: string }): Promise<EditMutationResult> {
  const r = await remote().editChatMessage(options)
  invalidateWechatCache('messages:')
  invalidateWechatCache('chat-msgs:')
  invalidateWechatCache('sessions:')
  return unwrap(r)
}
/**
 * Reset an edited chat message back to its original content.
 * @param options - Mutation options: username and message localId.
 * @returns EditMutationResult.
 */
export async function apiResetEditedMessage(options: { username: string; localId: number }): Promise<EditMutationResult> {
  const r = await remote().resetEditedMessage(options)
  invalidateWechatCache('messages:')
  invalidateWechatCache('chat-msgs:')
  invalidateWechatCache('sessions:')
  return unwrap(r)
}
/**
 * Export a record kind to CSV.
 * @param options - Query options: record kind, optional recordsKind.
 * @returns ExportResult.
 */
export async function apiExportAnnualReport(options: {
  year: number
  format: string
  dir?: string
  filename?: string
}): Promise<ExportResult> {
  return unwrap(await remote().exportAnnualReport(options))
}

export async function apiExportAllSessions(options?: { dir?: string; filename?: string; jobId?: string }): Promise<ExportResult> {
  return unwrap(await remote().exportAllSessions(options))
}

export async function apiExportMoments(options?: {
  format?: string
  username?: string
  authorName?: string
  q?: string
  images?: boolean
  media?: string
  month?: string
  mine?: string
  zip?: boolean
  from?: number
  to?: number
  dir?: string
  filename?: string
  jobId?: string
}): Promise<ExportResult> {
  return unwrap(await remote().exportMoments(options))
}

export async function apiExportCsv(options: { kind: string; recordsKind?: string; dest?: string; category?: string }): Promise<ExportResult> {
  return unwrap(await remote().exportCsv(options))
}

/**
 * 读取导出历史（导出记录弹窗）。
 *
 * **不走 `cachedGet`**：历史里带 `existsNow`（文件是否还在磁盘上），缓存住的旧结果会在
 * 用户于资源管理器里删掉文件后仍然显示「存在」—— 这类「按当前事实」的数据不应缓存。
 * @param options - 搜索/筛选/排序/分页条件。
 * @returns 导出历史一页 + 聚合计数。
 */
export async function apiGetExportHistory(options?: ExportHistoryQuery): Promise<ExportHistorySnapshot> {
  return unwrap(await remote().getExportHistory(options))
}

/** 删除导出历史记录（`deleteFiles` 默认 false —— 删记录不等于删文件）。 */
export async function apiDeleteExportHistory(options: { ids: number[]; deleteFiles?: boolean }): Promise<ExportHistoryDeleteResult> {
  return unwrap(await remote().deleteExportHistory(options))
}

/** 按策略清理导出历史（按天数 / 保留最近 N 条 / 只清失效记录）。 */
export async function apiPruneExportHistory(options?: ExportHistoryPruneOptions): Promise<ExportHistoryDeleteResult> {
  return unwrap(await remote().pruneExportHistory(options))
}

/** 读取问答历史（「历史记录」弹窗）。**不走 `cachedGet`** —— 刚问完就打开必须能看到那一条。 */
export async function apiGetAskHistory(options?: AskHistoryQuery): Promise<AskHistorySnapshot> {
  return unwrap(await remote().getAskHistory(options))
}
/** 删除若干条问答历史。 */
export async function apiDeleteAskHistory(options: { ids: number[] }): Promise<AskHistoryDeleteResult> {
  return unwrap(await remote().deleteAskHistory(options))
}
/** 清空全部问答历史（界面上必须二次确认后再调）。 */
export async function apiClearAskHistory(): Promise<AskHistoryClearResult> {
  return unwrap(await remote().clearAskHistory())
}
/**
 * Clear a session’s draft.
 * @param options - Mutation options: session username.
 * @returns DraftClearResult.
 */
export async function apiClearSessionDraft(options: { username: string }): Promise<DraftClearResult> {
  const r = await remote().clearSessionDraft(options)
  invalidateWechatCache('sessions:')
  return unwrap(r)
}
/**
 * Clear all session drafts.
 * @returns DraftsClearResult.
 */
export async function apiClearAllSessionDrafts(): Promise<DraftsClearResult> {
  const r = await remote().clearAllSessionDrafts()
  invalidateWechatCache('sessions:')
  return unwrap(r)
}
/**
 * List summary tasks.
 * @returns SummaryTaskSnapshot（读不到库时带 `readError`）。
 */
export async function apiListSummaryTasks(): Promise<SummaryTaskSnapshotRead> {
  return unwrap(await remote().listSummaryTasks())
}
/**
 * Create or update a summary task.
 * @param options - Mutation options: the task payload (with optional id for updates).
 * @returns SummaryTaskMutationResult.
 */
export async function apiSaveSummaryTask(options: { task: Omit<SummaryTask, 'id' | 'createdAt' | 'updatedAt'> & { id?: number } }): Promise<SummaryTaskMutationResult> {
  return unwrap(await remote().saveSummaryTask(options))
}
/**
 * Delete a summary task by id.
 * @param options - Mutation options: task id.
 * @returns SummaryTaskMutationResult.
 */
export async function apiDeleteSummaryTask(options: { id: number }): Promise<SummaryTaskMutationResult> {
  return unwrap(await remote().deleteSummaryTask(options))
}
/**
 * Enable or disable a summary task.
 * @param options - Mutation options: task id and enabled flag.
 * @returns SummaryTaskMutationResult.
 */
export async function apiToggleSummaryTask(options: { id: number; enabled: boolean }): Promise<SummaryTaskMutationResult> {
  return unwrap(await remote().toggleSummaryTask(options))
}
/**
 * Run a summary task now.
 * @param options - Mutation options: task id.
 * @returns SummaryTaskRunResult.
 */
export async function apiRunSummaryTask(options: { id: number }): Promise<SummaryTaskRunResult> {
  return unwrap(await remote().runSummaryTask(options))
}
/**
 * List summary records (optionally filtered by task).
 * @param options - Query options: optional taskId filter.
 * @returns SummaryRecordSnapshot（读不到库时带 `readError`）。
 */
export async function apiListSummaryRecords(options?: { taskId?: number }): Promise<SummaryRecordSnapshotRead> {
  return unwrap(await remote().listSummaryRecords(options))
}
/**
 * Delete a summary record by id.
 * @param options - Mutation options: record id.
 * @returns SummaryTaskMutationResult.
 */
export async function apiDeleteSummaryRecord(options: { id: number }): Promise<SummaryTaskMutationResult> {
  return unwrap(await remote().deleteSummaryRecord(options))
}
/**
 * List extracted WeChat tasks.
 * @returns TasksSnapshot（读不到库时带 `readError`，见 N1）。
 */
export async function apiListTasks(): Promise<TasksSnapshotRead> {
  return unwrap(await remote().listTasks())
}
/**
 * List native WeChat reminders.
 * @returns HandoffRemindsSnapshot.
 */
export async function apiGetHandoffReminds(): Promise<HandoffRemindsSnapshot> {
  return unwrap(await remote().getHandoffReminds())
}
/**
 * Import native reminders into the plugin task store.
 * @returns TaskMutationResult with added count.
 */
export async function apiSyncHandoffTasks(): Promise<TaskMutationResult> {
  return unwrap(await remote().syncHandoffTasks())
}
/**
 * Add one manual task.
 * @param options - title and optional due epoch ms.
 * @returns TaskMutationResult.
 */
export async function apiAddTask(options: { title: string; dueAt?: number }): Promise<TaskMutationResult> {
  return unwrap(await remote().addTask(options))
}
/**
 * Set a task status.
 * @param options - task id and target status.
 * @returns TaskMutationResult.
 */
export async function apiSetTaskStatus(options: { id: number; status: 'open' | 'done' }): Promise<TaskMutationResult> {
  return unwrap(await remote().setTaskStatus(options))
}
/**
 * Delete a task.
 * @param options - task id.
 * @returns TaskMutationResult.
 */
export async function apiDeleteTask(options: { id: number }): Promise<TaskMutationResult> {
  return unwrap(await remote().deleteTask(options))
}
/**
 * Extract todo/reminder items from recent messages via DSH LLM.
 * @param options - optional lookback days.
 * @returns TaskMutationResult with added count.
 */
export async function apiExtractTasks(options?: { days?: number }): Promise<TaskMutationResult> {
  return unwrap(await remote().extractTasks(options))
}
