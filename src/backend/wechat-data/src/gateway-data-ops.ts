/**
 * WechatDataGateway 方法面 · 数据与运维链路的转发（媒体 / 导出 / 备份 / 配置 / 任务）（M21 结构刀自 gateway.ts 拆出）。
 *
 * 这一层只有 `@Remote` 壳（装饰器 + 签名 + 一行转发）；装饰器标记会落到**最派生原型**上，
 * 因此协议层枚举到的方法面与拆分前逐名相同（守卫：`gateway-remote-surface.spec.ts`）。
 */

import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type { AccountsSnapshot, AnnualReport, AnnualSnapshot, AskHistoryClearResult, AskHistoryDeleteResult, AskHistoryQuery, AskHistorySnapshot, AskOptimizeResult, AskResult, AutoDbKeyResult, AutoImageKeyResult, AvatarResult, BackupMutationResult, BackupPreviewSnapshot, BackupSnapshot, CalendarSnapshot, CallsSnapshot, ChatHistoryResolveResult, ConfigSnapshot, ContactsSnapshot, DailySummaryResult, DbStatusSnapshot, DecryptAllResult, DecryptImagesResult, DecryptStatus, DeleteFavoriteResult, DraftClearResult, DraftsClearResult, EditMutationResult, EditedListSnapshot, EmoticonsSnapshot, ExportResult, ExportStatus, ExportHistoryDeleteResult, ExportHistoryQuery, ExportHistorySnapshot, ExportHistoryPruneOptions, FavoritesSnapshot, FilesSnapshot, GenerateKeysResult, GraphSnapshot, GroupInfoSnapshot, ImageDataUrlResult, KeysInfoResult, MemberSearchSnapshot, MessagesSnapshot, MomentsSnapshot, OverviewInsights, OverviewSnapshot, PaymentStatus, PrivacySnapshot, RecordsSnapshot, RevokedSnapshot, SearchBuildResult, SearchIndexStatus, SearchSnapshot, SessionsSnapshot, SimpleResult, StorageSnapshot, SummaryRecord, SummaryRecordSnapshot, SummaryTask, SummaryTaskMutationResult, SummaryTaskRunResult, SummaryTaskSnapshot, VerifyImageKeyResult, VerifyKeyResult, VideoInfoResult, VoiceDataUrlResult, VoiceInfoResult, VoiceTranscriptResult, VoiceTranscribeOneResult, VoiceTranscribeResult, WechatAccount, WechatConfigFull, WechatConfigPatch, WhisperDownloadProgress, WhisperDownloadResult, WhisperStatus, WhisperTranscribing, AssetInsightsSnapshot, BackupRestoreResult, Contact360Snapshot, DbHealthSnapshot, GroupInsightsSnapshot, HandoffRemindsSnapshot, LedgerSnapshot, MediaAssetsSnapshot, MomentsInsightsSnapshot, MomentsMonthlyRow, OfficialAssetsSnapshot, OperationCategory, OperationLogClearResult, OperationLogQuery, OperationLogSnapshot, OperationStatus, PeriodSummaryResult, PrivacyAuditClearResult, PrivacyAuditRow, PrivacyStateSnapshot, RegionMapSnapshot, TaskMutationResult, TasksSnapshot, UnifiedSearchSnapshot, KnowledgeSnapshot, NotesSnapshot, NoteMutationResult, KbDeleteAction, KbListSnapshot, KbMeta, KbMutationResult } from './types.ts'
import type { ImageBatchItem } from './remotes/media.ts'
import { getDbStatus } from './query/status.ts'
import { detectWechatAccounts, generateKeysFile, getConfig, getKeysInfo, saveConfig, verifyDatabaseKey, weixinInstallPath, weixinVersion } from './query/config.ts'
import { WHISPER_DOWNLOAD_FILES, installWhisperEngine, migrateWhisperEngineDir, migrateWhisperModels, resolveWhisperModelsDir, whisperDownloadModel, whisperEnginePath, whisperHasCuda, whisperModelsStatus } from './query/whisper.ts'
import { cachedTranscript, transcribeOneVoice, transcribeVoiceBatch } from './query/voice-transcribe.ts'
import { exportAllSessions, exportAnnualReport, exportCsv, exportMoments, exportSessionMessagesStreamed } from './query/export.ts'
import { deleteExportHistory, listExportHistory, pruneExportHistory, recordExport } from './query/export-history.ts'
import { clearOperationLog, listOperations, recordOperation } from './query/operation-log.ts'
import { clearPrivacyAudit, getPrivacyStateSnapshot, listPrivacyAudit, readPrivacySettings, recordPrivacyAudit, redactSensitiveText, writePrivacySettings } from './query/privacy-audit.ts'
import { deleteTask, insertTask, listTasks as listWechatTasks, setTaskStatus } from './query/wechat-tasks.ts'
import { createEncryptedBackup, restoreEncryptedBackup } from './query/backup.ts'
import { deleteSummaryRecord as delRec, deleteSummaryTask as delTask, listSummaryRecords as listRecs, listSummaryTasks as listTasks, saveSummaryRecord as saveRec, saveSummaryTask as saveTask, toggleSummaryTask as toggleTask, updateSummaryTaskRunState } from './query/summary-tasks.ts'
import { GatewayAskOps } from './gateway-ask-ops.ts'

/** 方法面的一层：继承链上的一环，不单独实例化（abstract：`runSummaryTask` 由更下面那层实现）。 */
export abstract class GatewayDataOps extends GatewayAskOps {
  /**
   * Custom emoticons.
   * @param options - Optional limit/offset for incremental loading.
   * @returns EmoticonsSnapshot: emoticon items.
   */
  @Remote('getEmoticons')
  getEmoticons(options?: { limit?: number; offset?: number }): EmoticonsSnapshot {
  return this.mediaRemotes().getEmoticons(options)
  }

  /**
   * WeChat config summary.
   * @returns ConfigSnapshot: current WeChat config summary.
   */
  @Remote('getWechatConfig')
  getWechatConfig(): ConfigSnapshot {
    return this.configRemotes().getWechatConfig()
  }

  /**
   * Privacy scan.
   * @returns PrivacySnapshot: privacy scan result.
   */
  @Remote('getPrivacyScan')
  getPrivacyScan(): PrivacySnapshot {
    return this.opsLogRemotes().getPrivacyScan()
  }

  /**
   * Knowledge notes list of **one** knowledge base.
   *
   * 命中集与 `total` 都只统计本库：改前 `total` 是全表 `COUNT(*)`，多库之后
   * 会显示成「12 / 37」这种跨库数字。
   * @param kbId - the knowledge base to read; required, there is no "all kbs" mode.
   * @param options - Optional case-insensitive search query and row cap.
   * @returns NotesSnapshot: notes (newest first) plus the same-kb unpaged total.
   */
  @Remote('getNotes')
  getNotes(kbId: number, options?: { query?: string; limit?: number }): NotesSnapshot {
    return this.tasksRemotes().getNotes(kbId, options)
  }

  /**
   * Create (no `id`) or update (`id` given) one knowledge note.
   *
   * `sourceKind: 'ask'` marks a note distilled from a WeChat Q&A answer — that
   * is the join point with the social graph: the panel draws an edge from the
   * note to its source chat instead of leaving knowledge nodes floating.
   * @param kbId - owning knowledge base for a new note / expected owner for an update.
   *   Title uniqueness is checked **within** that kb, not across the whole store.
   * @param options - Note fields; title is required and unique in that kb (case-insensitive).
   * @returns NoteMutationResult: `{ ok, id }`, or `{ ok: false, error }`.
   */
  @Remote('saveNote')
  saveNote(kbId: number, options: {
    id?: number
    title: string
    body?: string
    tags?: string[] | string
    sourceKind?: 'manual' | 'ask'
    sourceUsername?: string
    sourceQuestion?: string
  }): NoteMutationResult {
    return this.tasksRemotes().saveNote(kbId, options)
  }

  /**
   * Delete one knowledge note.
   *
   * `kbId` 不是「附加信息」而是**守卫**：笔记 id 全局自增，拿着甲库的 id 调乙库
   * 会删掉甲库那一篇（数据直接没了）。归属不符时返回「笔记不存在」。
   * @param kbId - expected owner; a row belonging to another kb is **not** deleted.
   * @param options - Note id.
   * @returns NoteMutationResult.
   */
  @Remote('deleteNote')
  deleteNote(kbId: number, options: { id: number }): NoteMutationResult {
    return this.tasksRemotes().deleteNote(kbId, options)
  }

  /**
   * Resource files.
   * @param options - Optional limit/offset and category filter for incremental loading.
   * @returns FilesSnapshot: resource file items.
   */
  @Remote('getFiles')
  getFiles(options?: { limit?: number; offset?: number; category?: string; q?: string }): FilesSnapshot {
  return this.mediaRemotes().getFiles(options)
  }

  /**
   * Look up one voice message (silk decode degrades in Node).
   * @param options - username and localId of the voice message.
   * @returns VoiceInfoResult: voice metadata / decoded file info.
   */
  @Remote('getVoiceInfo')
  getVoiceInfo(options: { username: string; localId: number }): VoiceInfoResult {
  return this.mediaRemotes().getVoiceInfo(options)
  }

  /**
   * Resolve one voice message to an inline-playable wav data URL.
   * 语音实体是 silk，需要解码成 wav 才能播；产物落在转写链路同一份缓存里。
   * @param options - username and localId of the voice message.
   * @returns VoiceDataUrlResult: base64 wav data URL (+ duration) or error.
   */
  @Remote('getVoiceDataUrl')
  getVoiceDataUrl(options: { username: string; localId: number }): VoiceDataUrlResult {
  return this.mediaRemotes().getVoiceDataUrl(options)
  }

  /**
   * Look up one video message: cover thumbnail + the on-disk video path.
   * 封面与实体都在真实微信目录 `msg/video` 下，所以要带上数据根目录。
   * @param options - username and localId of the video message.
   * @returns VideoInfoResult: video cover/thumbnail info.
   */
  @Remote('getVideoInfo')
  getVideoInfo(options: { username: string; localId: number }): VideoInfoResult {
  return this.mediaRemotes().getVideoInfo(options)
  }

  /**
   * Export a conversation messages to txt/csv/excel/html.
   *
   * M3：本入口改为 `async` 并走**流式**实现 —— 同步版必须「先把整份 xlsx 拼进内存」，
   * 行数一大峰值就与行数成正比；`exportSessionMessagesStreamed` 把 sheet 逐块写进 zip 条目
   * （峰值与行数无关）。契约没变：仍是 `Promise<ExportResult>`，客户端镜像无需改。
   * @param options - username, export format and optional message count.
   * @returns ExportResult: exported file path/count info.
   */
  @Remote('exportSessionMessages')
  async exportSessionMessages(options: {
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
    /** 会话显示名，仅用于导出历史的可读说明（不参与导出本身）。 */
    sessionName?: string
    /** 进度/取消的任务标识（M3）：传了才有 `wechat-export/progress`，也才谈得上「中止」。 */
    jobId?: string
  }): Promise<ExportResult> {
  return this.exportRemotes().exportSessionMessages(options)
  }

  /**
   * List local WeChat backups.
   * @returns BackupSnapshot: backup entries (items + total).
   */
  @Remote('listBackups')
  listBackups(): BackupSnapshot {
    return this.backupRemotes().listBackups()
  }

  /**
   * Preview a backup's contents (bounded file list) before restore.
   * @param options - backup name.
   * @returns BackupPreviewSnapshot: items + total.
   */
  @Remote('previewBackup')
  previewBackup(options: { name: string }): BackupPreviewSnapshot {
    return this.backupRemotes().previewBackup(options)
  }

  /**
   * Create a local backup snapshot.
   * @returns BackupMutationResult: ok + backup name, or error.
   */
  @Remote('createBackup')
  createBackup(): BackupMutationResult {
    return this.backupRemotes().createBackup()
  }

  /**
   * Delete one backup by name.
   * @param options - name of the backup to delete.
   * @returns BackupMutationResult: ok, or error on failure.
   */
  @Remote('deleteBackup')
  deleteBackup(options: { name: string }): BackupMutationResult {
    return this.backupRemotes().deleteBackup(options)
  }

  /**
   * Export a data category (contacts/favorites/records/moments) to CSV.
   * @param options - data category kind and optional records sub-kind.
   * @returns ExportResult: exported file path/count info.
   */
  /**
   * Export the annual report as markdown / html / json.
   * @param options - year, format, optional dir/filename.
   * @returns ExportResult: written file path + filename + count.
   */
  /**
   * List the daily-summary model provider(s): the default model's provider
   * (the one the user actually configured), clean and unambiguous.
   */
  @Remote('listLlmProviders')
  listLlmProviders(): { providers: Array<{ id: string; name: string }> } {
    return this.voiceLlmRemotes().listLlmProviders()
  }

  /** List the provider's configured models (from the "设置 → 模型" settings section), falling back to the provider catalog. */
  @Remote('listLlmModels')
  async listLlmModels(options: { provider: string }): Promise<{ models: Array<{ id: string; name: string }> }> {
    return this.voiceLlmRemotes().listLlmModels(options)
  }

  @Remote('exportAnnualReport')
  exportAnnualReport(options: { year: number; format: string; dir?: string; filename?: string }): ExportResult {
  return this.exportRemotes().exportAnnualReport(options)
  }

  /**
   * Export ALL sessions as a single txt ZIP archive (账号归档).
   * @param options - optional dir/filename（+ 可选的 jobId：订阅 `wechat-export/progress` 进度并允许取消）.
   * @returns ExportResult: written zip path + total messages.
   */
  @Remote('exportAllSessions')
  async exportAllSessions(options?: { dir?: string; filename?: string; jobId?: string }): Promise<ExportResult> {
  return this.exportRemotes().exportAllSessions(options)
  }

  /**
   * Cancel one running export/backup job (M3).
   *
   * 渲染层点「取消」时调用：这里只唤醒 AbortController，真正的收尾（不留半成品）由
   * query 层在各耗时循环的检查点完成（`throwIfCancelled` + temp+rename）。
   * @param options - jobId the renderer passed to the export call.
   * @returns ok when a running job was aborted; error otherwise.
   */
  @Remote('cancelExportJob')
  cancelExportJob(options: { jobId: string }): { ok: boolean; error?: string } {
  return this.exportRemotes().cancelExportJob(options)
  }

  /**
   * Poll one export/backup job's latest progress (M3).
   *
   * 为什么除了事件推送还要有这个轮询入口：进度事件要经过「宿主事件 → 渲染层」的中继，
   * 而中继只对白名单事件名生效（见 `ui-app/ui-entry.tsx`）。轮询不依赖中继，是
   * 「进度确实推得出去」的那条兜底路径。
   * @param options - jobId the renderer passed to the export call.
   * @returns 最近一次进度；`found:false` 表示 jobId 未知（如进程重启过）。
   */
  @Remote('getExportProgress')
  getExportProgress(options: { jobId: string }): {
    found: boolean
    phase: string
    done: number
    total: number
    finished: boolean
    error?: string
  } {
  return this.exportRemotes().getExportProgress(options)
  }

  /**
   * Export moments (朋友圈) with author + keyword + time filters.
   * @param options - format/username/authorName/q/from/to/dir/filename (+ 可选的 jobId 订阅进度/取消).
   * @returns ExportResult: written file path + count.
   */
  @Remote('exportMoments')
  async exportMoments(options?: {
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
  return this.exportRemotes().exportMoments(options)
  }

  /**
   * Export a CSV table.
   * @param options - `kind` (contacts/favorites/records/moments/privacy); `recordsKind`
   *   when kind=records; `dest` = the full target path the user picked in the save dialog
   *   (falls back to `<dataRoot>/exports/` when omitted); `category` narrows kind=contacts
   *   to one category so the file matches what the panel is showing.
   * @returns ExportResult (path + filename + row count).
   */
  @Remote('exportCsv')
  exportCsv(options: { kind: string; recordsKind?: string; dest?: string; category?: string }): ExportResult {
  return this.exportRemotes().exportCsv(options)
  }

  /**
   * 读取导出历史（供「导出记录」弹窗）。
   * @param options - 搜索 / 种类筛选 / 状态筛选 / 时间范围 / 排序 / 分页。
   * @returns 一页条目 + 命中总数 + 各聚合计数。
   */
  @Remote('getExportHistory')
  getExportHistory(options?: ExportHistoryQuery): ExportHistorySnapshot {
  return this.exportRemotes().getExportHistory(options)
  }

  /**
   * 删除若干条导出历史记录。
   *
   * `deleteFiles` **默认为 false**：删记录与删文件是两件事，风险差一个量级，
   * 必须由界面显式选择（见 `query/export-history.ts` 的说明）。
   * @param options - ids + 是否连带删除磁盘文件。
   * @returns 删除计数与文件删除失败清单。
   */
  @Remote('deleteExportHistory')
  deleteExportHistory(options: { ids: number[]; deleteFiles?: boolean }): ExportHistoryDeleteResult {
  return this.exportRemotes().deleteExportHistory(options)
  }

  /**
   * 按策略清理导出历史（按天数 / 保留最近 N 条 / 只清失效记录）。
   * @param options - 清理策略；三项都缺省时**什么都不删**（安全闸）。
   * @returns 删除计数与文件删除失败清单。
   */
  @Remote('pruneExportHistory')
  pruneExportHistory(options?: ExportHistoryPruneOptions): ExportHistoryDeleteResult {
  return this.exportRemotes().pruneExportHistory(options)
  }

  /**
   * Resolve a user avatar (head_image.db data or contact URL).
   * @param options - username to resolve the avatar for.
   * @returns AvatarResult: avatar data URL or fallback info.
   */
  @Remote('getAvatar')
  getAvatar(options: { username: string; nickname?: string }): AvatarResult {
  return this.mediaRemotes().getAvatar(options)
  }

  /**
   * 批量读取头像(head_image.db 优先,未命中再用 contact 表 URL 兜底;一次 RPC)。
   * @param options - usernames 列表。
   * @returns username → data URL(本地)或 https URL(远端兜底)映射;未命中的不在其中。
   */
  @Remote('getAvatarsLocal')
  getAvatarsLocal(options: { usernames: string[] }): Record<string, string> {
  return this.mediaRemotes().getAvatarsLocal(options)
  }

  /**
   * Read the full WeChat config (incl. keys + resolved paths).
   * @returns WechatConfigFull: complete config with resolved paths.
   */
  @Remote('getWechatConfigFull')
  getWechatConfigFull(): WechatConfigFull {
    return this.configRemotes().getWechatConfigFull()
  }

  /**
   * Save the WeChat config (merge patch).
   * @param options - patch of config fields to merge.
   * @returns SimpleResult: ok, or error on failure.
   */
  @Remote('saveWechatConfig')
  saveWechatConfig(options: { patch: WechatConfigPatch }): SimpleResult {
    return this.configRemotes().saveWechatConfig(options)
  }

  /**
   * Whisper transcription configuration status: engine detection, CUDA
   * presence, models dir + installed ggml binaries, active download progress
   * (inference itself stays bridge-side).
   * @returns WhisperStatus: engine/hasCuda/models inventory.
   */
  @Remote('getWhisperStatus')
  getWhisperStatus(): WhisperStatus {
    return this.voiceLlmRemotes().getWhisperStatus()
  }

  /**
   * Download one official whisper.cpp ggml model into the models dir
   * (streamed, atomic publish; huggingface.co with hf-mirror fallback).
   * @param options - model id to download.
   * @returns WhisperDownloadResult: ok + file/bytes, or an error.
   */
  @Remote('downloadWhisperModel')
  async downloadWhisperModel(options: { model: string }): Promise<WhisperDownloadResult> {
    return this.voiceLlmRemotes().downloadWhisperModel(options)
  }

  /**
   * Verify all DBs in db_dir and write all_keys.json.
   * @param options - dbDir, keysFile, encKeyHex and optional keyFormat.
   * @returns GenerateKeysResult: generation outcome.
   */
  @Remote('generateKeysFile')
  generateKeysFile(options: { dbDir: string; keysFile: string; encKeyHex: string; keyFormat?: string }): GenerateKeysResult {
    return this.configRemotes().generateKeysFile(options)
  }

  /**
   * Read all_keys.json info.
   * @returns KeysInfoResult: key format/count/loaded state.
   */
  @Remote('getWechatKeysInfo')
  getWechatKeysInfo(): KeysInfoResult {
    return this.configRemotes().getWechatKeysInfo()
  }

  /**
   * Auto-recover the V4 database key from the running WeChat process
   * (key_v4 memory scan + Weixin.dll internal-key unmask).
   * @param options - optional probe db path and install dir.
   * @returns AutoDbKeyResult: ok + 64-hex key, or an error.
   */
  @Remote('autoGetDbKey')
  async autoGetDbKey(options: { dbPath?: string; wechatInstallDir?: string }): Promise<AutoDbKeyResult> {
    return this.configRemotes().autoGetDbKey(options)
  }

  /**
   * Auto-recover the image key (V2-verified): a saved-and-valid config key
   * pair is returned first; otherwise the running WeChat process memory is
   * scanned.
   * @param options - account dir (wxid_* 文件夹或其 db_storage) and optional pid.
   * @returns AutoImageKeyResult: ok + xor/aes pair, or an error.
   */
  @Remote('autoGetImageKey')
  async autoGetImageKey(options: { accountDir?: string; pid?: number }): Promise<AutoImageKeyResult> {
    return this.keysDecryptRemotes().autoGetImageKey(options)
  }

  /**
   * 保留理由：与「数据配置」面板现有那条路径等价 —— 界面用 `getWechatPathConfig()` 拿到路径后
   *   再 `openPath()` 打开（Settings.tsx）。这里保留一份「直接打开 config.json」的接口给宿主调用。
   */
  @Remote('openConfig')
  async openConfig(signal: AbortSignal): Promise<{ ok: boolean; path: string }> {
    return this.configRemotes().openConfig(signal)
  }

  @Remote('verifyImageKey')
  verifyImageKey(): VerifyImageKeyResult {
    return this.keysDecryptRemotes().verifyImageKey()
  }

  /**
   * Full SQLCipher decryption: every .db under db_storage is re-decrypted
   * into the decrypted snapshot (逐库原子发布,单库失败不中断)。实时进度
   * 通过 getDecryptStatus 轮询读取。
   * @returns DecryptAllResult: total/ok/failed counts.
   */
  @Remote('decryptAllDatabases')
  async decryptAllDatabases(): Promise<DecryptAllResult> {
    return this.keysDecryptRemotes().decryptAllDatabases()
  }

  /**
   * Batch-decode every md5-prefixed .dat image under msg/attach into the
   * decoded-images cache (并行池,已缓存/HEVC 跳过)。实时进度通过
   * getDecryptStatus 轮询读取。
   * @param options - optional worker concurrency (clamped 1..32).
   * @returns DecryptImagesResult: total/ok/failed/skipped counts.
   */
  @Remote('decryptAllImages')
  async decryptAllImages(options: { concurrency?: number }): Promise<DecryptImagesResult> {
    return this.keysDecryptRemotes().decryptAllImages(options)
  }

  /**
   * Live decryption progress snapshot (polled by the settings panel).
   * @returns DecryptStatus: op/done/total/failed/skipped + current item.
   */
  @Remote('getDecryptStatus')
  getDecryptStatus(): DecryptStatus {
    return this.configRemotes().getDecryptStatus()
  }

  /**
   * Download + install the whisper.cpp CLI engine into the models dir
   * (`<modelsDir>/bin/whisper-cli.exe`), persisting the path as whisper_bin.
   * @returns WhisperDownloadResult: ok + path, or an error.
   */
  @Remote('installWhisperEngine')
  async installWhisperEngine(): Promise<WhisperDownloadResult> {
    return this.voiceLlmRemotes().installWhisperEngine()
  }

  /**
   * Batch-transcribe the most recent voice messages: silk → WAV (bundled
   * wx_silk) → whisper-cli with the selected model → text cached per message.
   * @param options - optional message count (default 50, clamped 1..200).
   * @returns VoiceTranscribeResult: done/failed/skipped counts.
   */
  @Remote('transcribeVoiceBatch')
  async transcribeVoiceBatch(options: { limit?: number }): Promise<VoiceTranscribeResult> {
    return this.voiceLlmRemotes().transcribeVoiceBatch(options)
  }

  /**
   * Decrypted DB status summary.
   * @returns DbStatusSnapshot: per-database status summary.
   */
  @Remote('getDbStatus')
  getDbStatus(): DbStatusSnapshot {
    return this.configRemotes().getDbStatus()
  }

  /**
   * Decode one message image to a base64 data URL.
   * @param options - username and localId of the message image.
   * @returns ImageDataUrlResult: base64 data URL or error.
   */
  @Remote('getImageDataUrl')
  getImageDataUrl(options: { username: string; localId: number }): ImageDataUrlResult {
  return this.mediaRemotes().getImageDataUrl(options)
  }

  /**
   * Decode a whole batch of message images to base64 data URLs (N16).
   *
   * 为什么需要批量入口：`getImageDataUrl` 是**一图一次 RPC**，而每张图内部的路径解析
   * （`WHERE lower(md5) = ?`）在 `image_hardlink_info_v4` 上是全表扫 —— 实测 20 万行
   * 17.27ms/次，30 张图各查一次 ≈518ms。这里先用一次 `IN (...)` 把整批 md5 的 .dat 路径
   * 查出来并预热解码缓存，之后逐张走原有单张入口时命中缓存，不再各扫一次路径表。
   *
   * 诚实边界：① 预热阶段整批 md5 一次取完（`resolveImageMd5sBatch`：每个「会话 × 分片」一条
   * `local_id IN (…)`），但**预热之后每张图仍走一次单张入口**，那一步里 `resolveImageResourceHint`
   * 还会各查一次分片（`WHERE local_id = ?`）。留着这一份复用，是因为错误语义、`data_index` 兜底
   * 与 hevc 判定只该有一处实现；代价是每图还剩一次库开合（本机 30 张：合并前 62 次、合并后 33 次，
   * 数字由 `gateway-image-batch.spec.ts` 的 `[算料]` 打印，理由见 RELEASE-PLAN 的 N36）。
   * ② 拿不到原始微信目录（`wechatBaseDir` 未知）时批量路径查不出东西，行为与逐张调用完全一致。
   * @param options - `items`: 一批 (username, localId)；超过 {@link IMAGE_BATCH_MAX} 的截断。
   * @returns 与传入顺序一一对应的条目（`url` 或 `error`，语义同单张入口）。
   */
  @Remote('getImageDataUrlsBatch')
  getImageDataUrlsBatch(options: { items: Array<{ username: string; localId: number }> }): { items: ImageBatchItem[] } {
  return this.mediaRemotes().getImageDataUrlsBatch(options)
  }

  /**
   * Resolve one SNS (朋友圈) media md5 to an offline base64 data URL
   * from the WeChat cache/<month>/Sns/Img V2-encrypted blobs.
   * @param options - media md5 from the moments XML.
   * @returns ImageDataUrlResult: base64 data URL or error.
   */
  @Remote('getSnsImageDataUrl')
  getSnsImageDataUrl(options: { md5: string; timelineId?: string; mediaId?: string }): ImageDataUrlResult {
  return this.mediaRemotes().getSnsImageDataUrl(options)
  }

  /**
   * Resolve a file-library image (hardlink md5) to an offline base64 data URL.
   * 优先读已解密缓存，否则通过 hardlink.db 定位 .dat 原图解密。
   * @param options - file md5.
   * @returns ImageDataUrlResult: base64 data URL or error.
   */
  @Remote('getFileImageDataUrl')
  getFileImageDataUrl(options: { md5: string }): ImageDataUrlResult {
  return this.mediaRemotes().getFileImageDataUrl(options)
  }

  /**
   * Resolve a custom emoticon (sticker) md5 to an offline base64 data URL.
   * 先读 decoded 缓存 → 扫 msg/attach 与微信的表情缓存目录里解密；
   * 本地解不开时（微信 4.x 的表情缓存是加密文件，项目里没有对应解码器）
   * 用消息 XML 带来的 `cdnurl` 下载一次并落进 decoded 缓存。
   * @param options - emoticon md5 (+ optional CDN url from the message).
   * @returns ImageDataUrlResult: base64 data URL or error.
   */
  @Remote('getEmoticonDataUrl')
  async getEmoticonDataUrl(options: { md5: string; emojiUrl?: string }): Promise<ImageDataUrlResult> {
  return this.mediaRemotes().getEmoticonDataUrl(options)
  }

  /**
   * 取一条图片消息的**原图**，但只走消息里自带的免登录预签名直链（`<img tpurl=…/tphdurl=…>`）。
   *
   * 为什么只做这一类：本机 39,923 张图片消息里 93% 磁盘上只有缩略图，而指向原图的指针有两种，
   * `cdnbigimgurl` 那一种需要**微信登录态凭据**去发私有媒体请求 —— 那已经不是「读本机已有的密钥」，
   * 而是「以你的身份向服务器发请求」，与本应用「不登录、不连微信服务器同步」的边界冲突
   * （口径写在 `query/image-original.ts` 的模块注释）。所以拿不到直链时要把话说清：
   * 让用户回微信里打开那张图点「查看原图」，本机存下来之后这里自然就是原图。
   *
   * 取回的原图写进 `<decoded>/<md5>.<ext>`，也就是 `getImageDataUrl` 第 1a 步优先读的缓存槽，
   * 于是**下一次渲染直接是原图**、之后离线可用（网络只花一次）。字节不经 RPC 回传。
   * @param options - `username` 会话 username；`localId` 消息 local_id。
   * @returns `{ok:true, format, bytes?, note?}`；失败时 `{ok:false, error}`，error 可直接显示。
   *   `note` 是成功时要一并告诉用户的话（例如「这次是重解本机那一份，没联网」）。
   */
  @Remote('getImageOriginal')
  async getImageOriginal(options: { username?: string; localId?: number }): Promise<{ ok: boolean; format?: string; bytes?: number; note?: string; error?: string }> {
  return this.mediaRemotes().getImageOriginal(options)
  }

  /**
   * 远程图片代理（M23）：一批 https 图片地址 → 后端取回并缓存 → data URL。
   *
   * 存在的原因：卡片缩略图 / 朋友圈远程图 / 视频号封面此前由**渲染层直接向消息里的地址发请求**，
   * 那条路径不受「自动获取原图（CDN）」与「禁止出网」两个开关管、不进操作记录、也没有缓存。
   * 收到后端之后这三件事才成立，而 CSP `img-src` 的 `https:` 通配也才可能拿掉。
   * 只代取腾讯系主机（判据见 `query/cdn-hosts.ts`）；站外图床会被拒。
   * @param options - `urls`: 图片地址列表（去重后最多取 40 张，超出的条目回错误）。
   * @returns `{items}`：每条 `{url, dataUrl?, fromCache?, error?}`，`url` 原样带回当键。
   */
  @Remote('getRemoteImages')
  async getRemoteImages(options: { urls?: string[] }): Promise<{ items: Array<{ url: string; dataUrl?: string; fromCache?: boolean; error?: string }> }> {
  return this.mediaRemotes().getRemoteImages(options)
  }

  /**
   * Resolve a received message file (msg/file) to a base64 data URL.
   * @param options - original file name from the message card.
   * @returns ImageDataUrlResult: data URL or error.
   */
  @Remote('getMessageFile')
  getMessageFile(options: { fileName: string; size?: number; createTime?: number }): ImageDataUrlResult {
  return this.mediaRemotes().getMessageFile(options)
  }

  /**
   * Add a WeChat task.
   * @param options - title + optional dueAt.
   * @returns TaskMutationResult.
   */
  @Remote('addTask')
  addTask(options: { title: string; dueAt?: number }): TaskMutationResult {
    return this.tasksRemotes().addTask(options)
  }

  @Remote('clearOperationLog')
  clearOperationLog(): OperationLogClearResult {
    return this.opsLogRemotes().clearOperationLog()
  }

  @Remote('clearPrivacyAudit')
  clearPrivacyAudit(): PrivacyAuditClearResult {
    return this.opsLogRemotes().clearPrivacyAudit()
  }

  @Remote('createEncryptedBackup')
  async createEncryptedBackup(options: { password: string; jobId?: string }): Promise<BackupMutationResult> {
    return this.backupRemotes().createEncryptedBackup(options)
  }

  @Remote('deleteTask')
  deleteTask(options: { id: number }): TaskMutationResult {
    return this.tasksRemotes().deleteTask(options)
  }

  @Remote('extractTasks')
  extractTasks(options?: { days?: number }): TaskMutationResult {
    return this.tasksRemotes().extractTasks(options)
  }

  @Remote('getDbHealth')
  getDbHealth(): DbHealthSnapshot {
    return this.configRemotes().getDbHealth()
  }

  /**
   * 保留理由：读 `general.db` 的 `handoff_remind_v0`（微信自带待办提醒）。本机实测**这张表不存在**
   *   （22 个库里没有任何 `handoff%` 表）⇒ 界面若直接接上去只会永远显示空列表，因此只保留接口；
   *   「待办日程」面板用的是导入路径 `syncHandoffTasks`（把源数据落进插件自己的任务库）。
   */
  @Remote('getHandoffReminds')
  getHandoffReminds(): HandoffRemindsSnapshot {
    return this.tasksRemotes().getHandoffReminds()
  }

  @Remote('getOperationLog')
  getOperationLog(options?: OperationLogQuery): OperationLogSnapshot {
    return this.opsLogRemotes().getOperationLog(options)
  }

  @Remote('getPrivacyAuditRows')
  getPrivacyAuditRows(): PrivacyAuditRow[] {
    return this.opsLogRemotes().getPrivacyAuditRows()
  }

  @Remote('getPrivacyState')
  getPrivacyState(): PrivacyStateSnapshot {
    return this.opsLogRemotes().getPrivacyState()
  }

  /**
   * Resolve one SNS (朋友圈) video cover.
   *
   * 先本机缓存（明文、离线）；没有缓存再按 XML 里的 `<thumb>` 从微信 CDN 取回，
   * 取回要过隐私闸门，并按 `<enc key>` 解密加密头（封面同样是加密流）。
   *
   * @param options - XML 里的 md5/缓存键，加上 `<thumb>` 地址与 `<enc key>` 种子。
   * @returns ImageDataUrlResult。
   */
  @Remote('getSnsVideoCoverDataUrl')
  async getSnsVideoCoverDataUrl(options: { md5?: string; timelineId?: string; mediaId?: string; thumb?: string; key?: string }): Promise<ImageDataUrlResult> {
  return this.mediaRemotes().getSnsVideoCoverDataUrl(options)
  }

  /**
   * Resolve one SNS (朋友圈) video body so it can be played inline.
   *
   * 两级来源：**先本机缓存**（明文，离线、最快），没有缓存再按朋友圈 XML 里的
   * `<url>` 从微信 CDN 按需取回。取回要过隐私闸门（与 AI 调用同一套「出站拦截」），
   * CDN 返回的是客户端加密流，按 `<enc key>` 解密后再**校验容器头与 md5**，
   * 免得把一个放不出来的二进制塞给 <video>。
   *
   * @param options - media md5 from the moments XML（+ 本地缓存键、`<url>` 与 `<enc key>`）。
   * @returns ImageDataUrlResult: base64 data URL or an error explaining which source failed.
   */
  @Remote('getSnsVideoDataUrl')
  async getSnsVideoDataUrl(options: { md5?: string; timelineId?: string; mediaId?: string; url?: string; key?: string }): Promise<ImageDataUrlResult> {
  return this.mediaRemotes().getSnsVideoDataUrl(options)
  }

  /**
   * 把一条朋友圈视频（本机缓存优先，否则 CDN 取回+解密）写到用户选定路径。
   *
   * 为什么放在后端写：视频本体几十 MB，走渲染端 `<a download>` 既落不了盘
   * （实测点了没反应），把 base64 经 IPC 传回主进程也白白多一次几十 MB 的拷贝。
   * 这里直接取字节写文件 —— 路径由主进程的保存对话框给出。
   *
   * @param options - 缓存键 / 远端地址与种子 / 目标路径。
   * @returns ok + 字节数，或错误说明。
   */
  @Remote('exportSnsVideo')
  async exportSnsVideo(options: {
    md5?: string; timelineId?: string; mediaId?: string; url?: string; key?: string; dest: string
  }): Promise<{ ok: boolean; bytes?: number; source?: string; error?: string }> {
  return this.mediaRemotes().exportSnsVideo(options)
  }

  @Remote('listTasks')
  listTasks(): TasksSnapshot {
    return this.tasksRemotes().listTasks()
  }

  @Remote('restoreBackup')
  restoreBackup(options: { name: string; password: string }): BackupRestoreResult {
    return this.backupRemotes().restoreBackup(options)
  }

  @Remote('setPrivacyState')
  setPrivacyState(options: { redactSensitive?: boolean; blockOutbound?: boolean }): PrivacyStateSnapshot {
    return this.opsLogRemotes().setPrivacyState(options)
  }

  @Remote('setTaskStatus')
  setTaskStatus(options: { id: number; status: 'open' | 'done' }): TaskMutationResult {
    return this.tasksRemotes().setTaskStatus(options)
  }

  @Remote('syncHandoffTasks')
  syncHandoffTasks(): TaskMutationResult {
    return this.tasksRemotes().syncHandoffTasks()
  }
}
