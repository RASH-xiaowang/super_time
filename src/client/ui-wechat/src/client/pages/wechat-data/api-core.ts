/**
 * `api.ts` 的「远程面与骨架：快照/结果类型、WechatRemote 接口、remote 注入与 unwrap、目录选择与面板截图」部分（M21 拆分）。
 *
 * 从原模块原样搬出，**行为逐字节不变**；原文件继续以 `export *` 转发
 * ⇒ 所有既有 import 一行都不用改。
 *
 * @module api-core
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
import type {
  KbDeleteAction,
  KbFileAddResult,
  KbFileChunkPage,
  KbFileListSnapshot,
  KbFileMeta,
  KbFileMutationResult,
  KbFileRegisterResult,
  KbListSnapshot,
  KbMutationResult,
  KbSearchResult,
  KbSummaryResult,
  KbVectorBuildResult,
  KbVectorIndexView,
  KbModelConfigResult,
  KbModelConfigView,
  KbExtractResult,
  KbLinkSuggestResult,
  KnowledgeSnapshot,
  NoteMutationResult,
  NotesSnapshot,
} from './types.ts'
import { RetrievalConfigShape, RetrievalEvalResult, RetrievalFeedbackItem, RetrievalStatus, VectorBuildResult } from './api-config.ts'
import { AnnualReviewShape } from './api-status.ts'

// M21：缓存层已拆到 ./cache.ts 与 ./media-cache.ts（纯搬移）。这里继续转发，
// 使 40 多个面板的 `from './api.ts'` 一行都不用改。
// 注意：`export … from` **不会**把名字带进本模块作用域，而下面这些函数在 api.ts 内部
// 也会被调用（各种失效/写缓存路径），所以既要 import（供内部用）又要 export from（供外部用）。
export {
  invalidateSnapshotCache,
  invalidateWechatCache,
  readRenderCache,
  snapshotDelete,
  subscribeSnapshot,
  writeRenderCache,
} from './cache.ts'
export { snsMediaCacheGet, snsMediaCacheGetMany, snsMediaCacheSet } from './media-cache.ts'
// 两个广播：`NOTES_UPDATED_EVENT` 是笔记内容变了，`KBS_UPDATED_EVENT` 是库表变了。
// 同 cache.ts 的口径，import 供内部调用 + export 供面板订阅。分开两个事件是刻意的：
// 合并成一个会让「记一条笔记」也去重拉一次库列表（而库表根本没变）。
export { KBS_UPDATED_EVENT, NOTES_UPDATED_EVENT } from './notes-events.ts'
// 知识笔记/知识图谱类型刻意从本地 types.ts 取（node_modules 那份宿主副本已陈旧，
// 原因见该文件顶部注释）。
// 知识库作用域键的**定义处**（叶子模块，不反向依赖本文件）：快照缓存的库后缀从这里出。
// 别处不许自己拼 `'kb:graph:' + id` —— 缓存键与布局坐标必须用同一个作用域名，
// 两处各拼一次就会漂移成「模型里有节点、图上没有」那种只在切库后才现形的偏差。

/**
 * 「读取失败」与「确无数据」的可区分标志（N1）。
 *
 * 后端三个只读 store（待办 / 摘要任务与记录 / 笔记与知识图谱）在 catch 里仍然返回空列表
 * （面板不该整块崩掉），但**同时**带上 `readError`：没有它，「库打不开」与「一条都没有」
 * 在界面上长得一模一样，用户会按「暂无数据」去排查，方向全错。
 *
 * 类型就地声明而不是等宿主包重建：`@deepseek-ai/dsh-wechat-data/types` 由 `build:types`
 * 生成，本轮不跑构建；运行期后端已经把该字段放进 JSON（见 `query/wechat-tasks.ts` 的
 * `TasksSnapshotRead`）。字段是可选的，所以旧宿主（不带 readError）也照样能跑。
 */
export interface TasksSnapshotRead extends TasksSnapshot { readError?: string }
export interface SummaryTaskSnapshotRead extends SummaryTaskSnapshot { readError?: string }
export interface SummaryRecordSnapshotRead extends SummaryRecordSnapshot { readError?: string }
export interface NotesSnapshotRead extends NotesSnapshot { readError?: string }
export interface KnowledgeSnapshotRead extends KnowledgeSnapshot { readError?: string }
/**
 * 库列表 + 只在读失败时出现的 `readError`。
 *
 * 与上面两条同一原因：后端的 `getKbs` 声明的是 `KbListSnapshot`（与 `getNotes` /
 * `getKnowledgeGraph` 一致），但运行期把 `readError` 放进 JSON 了 —— 没有它，
 * 「库打不开」与「一个库都没有」在界面上长得一样，而后者会让用户去新建一个库，
 * 用一个空库盖住真正的问题（N1）。
 */
export interface KbListSnapshotRead extends KbListSnapshot { readError?: string }

/** 批量取图的一条结果（`url` / `error` 与单张入口同义）。 */
export interface ImageDataUrlBatchItem {
  username: string
  localId: number
  url?: string
  format?: string
  error?: string
}

/** 远程图片代理（M23）的一条结果：`url` 是请求时带去的那个地址，原样回当键。 */
export interface RemoteImageItem {
  url: string
  dataUrl?: string
  /** 这次是否直接从本机缓存拿到（关掉 CDN 开关时仍可能为 true）。 */
  fromCache?: boolean
  error?: string
}

/** 导出/备份任务的最新进度（M3）。 */
export interface ExportProgressSnapshot {
  found: boolean
  phase: string
  done: number
  total: number
  finished: boolean
  error?: string
}

/** Remote face injected by ui-pages apply (ctx.remote.wechatData). */
export interface WechatRemote {
  getSessions(options?: { keyword?: string; limit?: number; offset?: number }): Promise<RemoteResult<SessionsSnapshot>>
  getContacts(options?: { limit?: number; offset?: number }): Promise<RemoteResult<ContactsSnapshot>>
  getContact360(options: { username: string }): Promise<RemoteResult<Contact360Snapshot>>
  getMessages(options: { talker: string; limit?: number; cursor?: number; cursorLocalId?: number }): Promise<RemoteResult<MessagesSnapshot>>
  getNewMessages(options: { talker: string; after: number; limit?: number }): Promise<RemoteResult<MessagesSnapshot>>
  getMoments(options?: { offset?: number; limit?: number; author?: string }): Promise<RemoteResult<MomentsSnapshot>>
  getSelfUsername(): Promise<RemoteResult<{ username: string }>>
  getMomentsAuthors(): Promise<RemoteResult<Array<{ name: string; count: number }>>>
  getMomentsInsights(options?: { author?: string }): Promise<RemoteResult<MomentsInsightsSnapshot>>
  getMomentsMonthly(options?: { author?: string; authorName?: string }): Promise<RemoteResult<MomentsMonthlyRow[]>>
  getFavorites(options?: { limit?: number; offset?: number; q?: string }): Promise<RemoteResult<FavoritesSnapshot>>
  getAssetInsights(): Promise<RemoteResult<AssetInsightsSnapshot>>
  getOfficialAssets(): Promise<RemoteResult<OfficialAssetsSnapshot>>
  getMediaAssets(): Promise<RemoteResult<MediaAssetsSnapshot>>
  getFiles(options?: { limit?: number; offset?: number; category?: string; q?: string }): Promise<RemoteResult<FilesSnapshot>>
  getOverview(): Promise<RemoteResult<OverviewSnapshot>>
  getOverviewInsights(): Promise<RemoteResult<OverviewInsights>>
  getRegionMap(): Promise<RemoteResult<RegionMapSnapshot>>
  getRecords(options: { kind: string; limit?: number; offset?: number; q?: string; from?: number; to?: number; direction?: 'asc' | 'desc' }): Promise<RemoteResult<RecordsSnapshot>>
  getLedger(options?: { month?: string }): Promise<RemoteResult<LedgerSnapshot>>
  getCalls(options?: { topPeers?: number; recentLimit?: number }): Promise<RemoteResult<CallsSnapshot>>
  getRevoked(options?: { limit?: number; offset?: number; q?: string }): Promise<RemoteResult<RevokedSnapshot>>
  getEmoticons(options?: { limit?: number; offset?: number }): Promise<RemoteResult<EmoticonsSnapshot>>
  getStorageStats(): Promise<RemoteResult<StorageSnapshot>>
  getAnnual(): Promise<RemoteResult<AnnualSnapshot>>
  getWechatConfig(): Promise<RemoteResult<ConfigSnapshot>>
  getPrivacyScan(): Promise<RemoteResult<PrivacySnapshot>>
  getPrivacyState(): Promise<RemoteResult<PrivacyStateSnapshot>>
  setPrivacyState(options: { redactSensitive?: boolean; blockOutbound?: boolean }): Promise<RemoteResult<PrivacyStateSnapshot>>
  getPrivacyAuditRows(): Promise<RemoteResult<PrivacyAuditRow[]>>
  clearPrivacyAudit(): Promise<RemoteResult<PrivacyAuditClearResult>>
  getOperationLog(options?: OperationLogQuery): Promise<RemoteResult<OperationLogSnapshot>>
  clearOperationLog(): Promise<RemoteResult<OperationLogClearResult>>
  getGraph(): Promise<RemoteResult<GraphSnapshot>>
  // ── 知识笔记 / 知识图谱 ──
  // `kbId` 是**必填的位置参数、不给默认值**：一个库 = 一批笔记 + 一个链接解析域 + 一张图，
  // 少传就等于「读错了库」，而这种错在编译期完全看不见（它是跨 JSON 边界的调用）。
  // 不给默认值的代价是所有漏传的调用点会在 typecheck 时集体转红 —— 这正是我们要的。
  getNotes(kbId: number, options?: { query?: string; limit?: number }): Promise<RemoteResult<NotesSnapshotRead>>
  saveNote(kbId: number, options: {
    id?: number
    title: string
    body?: string
    tags?: string[] | string
    sourceKind?: 'manual' | 'ask'
    sourceUsername?: string
    sourceQuestion?: string
  }): Promise<RemoteResult<NoteMutationResult>>
  deleteNote(kbId: number, options: { id: number }): Promise<RemoteResult<NoteMutationResult>>
  getKnowledgeGraph(kbId: number): Promise<RemoteResult<KnowledgeSnapshotRead>>
  // ── 知识库管理（全局；`getKbs` 与 `deleteKb` 是唯二不带 kbId 的两个）──
  getKbs(): Promise<RemoteResult<KbListSnapshotRead>>
  createKb(options: { name: string }): Promise<RemoteResult<KbMutationResult>>
  renameKb(options: { id: number; name: string }): Promise<RemoteResult<KbMutationResult>>
  deleteKb(options: { id: number; action: KbDeleteAction }): Promise<RemoteResult<KbMutationResult>>
  // ── 知识库文件（T2）：kbId 一律是**必填位置参数**，没有「所有库」模式 ──
  getKbFiles(kbId: number, options?: { limit?: number; offset?: number }): Promise<RemoteResult<KbFileListSnapshot>>
  getKbFileChunks(kbId: number, fileId: number, options?: { limit?: number; offset?: number }): Promise<RemoteResult<KbFileChunkPage>>
  addKbFiles(options: { kbId: number; paths: string[]; includeInRag?: boolean }): Promise<RemoteResult<KbFileAddResult>>
  deleteKbFile(options: { kbId: number; id: number }): Promise<RemoteResult<KbFileMutationResult>>
  setKbFileRag(options: { kbId: number; id: number; includeInRag: boolean }): Promise<RemoteResult<KbFileMutationResult>>
  summarizeKbFile(options: { kbId: number; id: number }): Promise<RemoteResult<KbSummaryResult>>
  searchKb(options: { kbId: number; query?: string; topK?: number }): Promise<RemoteResult<KbSearchResult>>
  getKbVectorIndex(options: { kbId: number }): Promise<RemoteResult<KbVectorIndexView>>
  buildKbVectorIndex(options: { kbId: number; force?: boolean }): Promise<RemoteResult<KbVectorBuildResult>>
  getKbModelConfig(options: { kbId: number }): Promise<RemoteResult<KbModelConfigView>>
  setKbModelConfig(options: { kbId: number; chatRef?: string; embedRef?: string; rerankRef?: string }): Promise<RemoteResult<KbModelConfigResult>>
  extractKbEntities(options: { kbId: number; fileIds?: number[]; limit?: number }): Promise<RemoteResult<KbExtractResult>>
  suggestKbLinks(options: { kbId: number; text?: string; topK?: number; excludeTitle?: string }): Promise<RemoteResult<KbLinkSuggestResult>>
  getSearchIndexStatus(): Promise<RemoteResult<SearchIndexStatus>>
  buildSearchIndex(options?: { force?: boolean }): Promise<RemoteResult<SearchBuildResult>>
  searchMessages(options: { query: string; limit?: number; username?: string; jobId?: string }): Promise<RemoteResult<SearchSnapshot>>
  cancelSearch(options: { jobId: string }): Promise<RemoteResult<{ ok: boolean }>>
  searchUnified(options: { query: string; limit?: number }): Promise<RemoteResult<UnifiedSearchSnapshot>>
  suggestReplies(options: { username: string; kbId?: number; count?: number }): Promise<RemoteResult<ReplySuggestResult>>
  askWechat(options: {
    question: string
    username?: string
    from?: string
    to?: string
    history?: Array<{ role: 'user' | 'assistant'; content: string }>
    /** 流式标识：带上它后端会推送 wechat-ask/delta 增量事件。 */
    streamId?: string
    /** 入口来源（'ask'/'session'）与会话显示名：写进问答历史，供列表区分与直显。 */
    source?: string
    usernameName?: string
    /**
     * 当前知识库 id：本次提问把该库的**文件块**一并纳入检索（与消息命中同编号）。
     *
     * 不传 = 不检索知识库，而不是「搜所有库」—— `kbId` 是作用域，没有「全部库」这一档；
     * 漏传应当表现为「没检索到文件」，而不是把别的库的内容也端上来。
     */
    kbId?: number
  }): Promise<RemoteResult<AskResult>>
  optimizeAskQuestion(options: {
    question: string
    username?: string
    from?: string
    to?: string
    history?: Array<{ role: 'user' | 'assistant'; content: string }>
  }): Promise<RemoteResult<AskOptimizeResult>>
  // ── RAG 检索层（意图路由 / 混合召回 / 评估 / 反馈闭环 / 调参）──
  getRetrievalStatus(): Promise<RemoteResult<RetrievalStatus>>
  saveRetrievalConfig(options?: { patch?: unknown }): Promise<RemoteResult<{ ok: boolean; config: RetrievalConfigShape }>>
  buildRagVectorIndex(options?: { force?: boolean }): Promise<RemoteResult<VectorBuildResult>>
  submitAskFeedback(options: {
    retrievalId?: string
    rating: 'up' | 'down'
    useful?: number[]
    useless?: number[]
    question?: string
    answer?: string
  }): Promise<RemoteResult<{ ok: boolean; adaptedWeights?: Record<string, number>; features?: string[]; message?: string }>>
  listRetrievalFeedback(options?: { limit?: number }): Promise<RemoteResult<{ items: RetrievalFeedbackItem[]; stats: { total: number; up: number; down: number } }>>
  resetRetrievalWeights(): Promise<RemoteResult<{ ok: boolean; weights: Record<string, number> }>>
  evaluateRetrieval(options?: { k?: number }): Promise<RemoteResult<RetrievalEvalResult>>
  getGroupInfo(options: { username: string }): Promise<RemoteResult<GroupInfoSnapshot>>
  getGroupInsights(options: { username: string }): Promise<RemoteResult<GroupInsightsSnapshot>>
  searchMembers(options: { q: string; limit?: number; roomUsername?: string }): Promise<RemoteResult<MemberSearchSnapshot>>
  resolveChatHistory(options: { serverId: string }): Promise<RemoteResult<ChatHistoryResolveResult>>
  getPaymentStatus(options: { serverId: string }): Promise<RemoteResult<PaymentStatus>>
  getDailyCounts(options: { username: string; year: number; month: number }): Promise<RemoteResult<CalendarSnapshot>>
  getImageDataUrl(options: { username: string; localId: number }): Promise<RemoteResult<ImageDataUrlResult>>
  /** 一次 RPC 解码一批消息图片（N16：批量入口，路径表只查一次）。 */
  getImageDataUrlsBatch(options: { items: Array<{ username: string; localId: number }> }): Promise<RemoteResult<{ items: ImageDataUrlBatchItem[] }>>
  /** 取消一个在跑的导出/备份任务（M3）。 */
  cancelExportJob(options: { jobId: string }): Promise<RemoteResult<{ ok: boolean; error?: string }>>
  /** 读一个导出/备份任务的最新进度（M3；事件中继之外的兜底路径）。 */
  getExportProgress(options: { jobId: string }): Promise<RemoteResult<ExportProgressSnapshot>>
  /** 文件消息里的图片（聊天记录里的原图）：与 getImageDataUrl 不同，它按文件 md5 定位。 */
  getFileImageDataUrl(options: { md5: string }): Promise<RemoteResult<ImageDataUrlResult>>
  getEmoticonDataUrl(options: { md5: string }): Promise<RemoteResult<ImageDataUrlResult>>
  getImageOriginal(options: { username?: string; localId?: number }): Promise<RemoteResult<{ ok: boolean; format?: string; bytes?: number; note?: string; error?: string }>>
  getRemoteImages(options: { urls?: string[] }): Promise<RemoteResult<{ items: RemoteImageItem[] }>>
  getSnsImageDataUrl(options: { md5: string; timelineId?: string; mediaId?: string }): Promise<RemoteResult<ImageDataUrlResult>>
  getSnsVideoCoverDataUrl(options: { md5?: string; timelineId?: string; mediaId?: string }): Promise<RemoteResult<ImageDataUrlResult>>
  getSnsVideoDataUrl(options: { md5?: string; timelineId?: string; mediaId?: string }): Promise<RemoteResult<ImageDataUrlResult>>
  getArticleCover(options: { contentUrl: string }): Promise<RemoteResult<ImageDataUrlResult>>
  getMessageFile(options: { fileName: string; size?: number; createTime?: number }): Promise<RemoteResult<ImageDataUrlResult>>
  getDbStatus(): Promise<RemoteResult<DbStatusSnapshot>>
  getDbHealth(): Promise<RemoteResult<DbHealthSnapshot>>
  getVoiceInfo(options: { username: string; localId: number }): Promise<RemoteResult<VoiceInfoResult>>
  /** 语音消息的可播放 wav（data URL）—— 就该地播放用，见后端 resolveVoiceDataUrl。 */
  getVoiceDataUrl(options: { username: string; localId: number }): Promise<RemoteResult<VoicePlaybackResult>>
  getVideoInfo(options: { username: string; localId: number }): Promise<RemoteResult<VideoInfoResult>>
  exportSessionMessages(options: {
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
    /** 会话显示名，仅用于导出历史的可读说明。 */
    sessionName?: string
    /** 带上它可订阅 `wechat-export/progress` 进度并通过 cancelExportJob 取消（M3）。 */
    jobId?: string
  }): Promise<RemoteResult<ExportResult>>
  listBackups(): Promise<RemoteResult<BackupSnapshot>>
  previewBackup(options: { name: string }): Promise<RemoteResult<BackupPreviewSnapshot>>
  createBackup(): Promise<RemoteResult<BackupMutationResult>>
  createEncryptedBackup(options: { password: string; jobId?: string }): Promise<RemoteResult<BackupMutationResult>>
  restoreBackup(options: { name: string; password: string }): Promise<RemoteResult<BackupRestoreResult>>
  deleteBackup(options: { name: string }): Promise<RemoteResult<BackupMutationResult>>
  generateDailySummary(options: { date: string; provider?: string; model?: string }): Promise<RemoteResult<DailySummaryResult>>
  generatePeriodSummary(options: {
    from: string
    to: string
    provider?: string
    model?: string
  }): Promise<RemoteResult<PeriodSummaryResult>>
  listLlmProviders(): Promise<RemoteResult<{ providers: Array<{ id: string; name: string }> }>>
  listLlmModels(options: { provider: string }): Promise<RemoteResult<{ models: Array<{ id: string; name: string }> }>>
  listEditedMessages(options?: { sessionId?: string }): Promise<RemoteResult<EditedListSnapshot>>
  editChatMessage(options: { username: string; localId: number; content: string }): Promise<RemoteResult<EditMutationResult>>
  resetEditedMessage(options: { username: string; localId: number }): Promise<RemoteResult<EditMutationResult>>
  exportCsv(options: { kind: string; recordsKind?: string; dest?: string; category?: string }): Promise<RemoteResult<ExportResult>>
  getExportHistory(options?: ExportHistoryQuery): Promise<RemoteResult<ExportHistorySnapshot>>
  deleteExportHistory(options: { ids: number[]; deleteFiles?: boolean }): Promise<RemoteResult<ExportHistoryDeleteResult>>
  pruneExportHistory(options?: ExportHistoryPruneOptions): Promise<RemoteResult<ExportHistoryDeleteResult>>
  // ── 问答历史（后端按数据根隔离保存，前端只读/删）──
  getAskHistory(options?: AskHistoryQuery): Promise<RemoteResult<AskHistorySnapshot>>
  deleteAskHistory(options: { ids: number[] }): Promise<RemoteResult<AskHistoryDeleteResult>>
  clearAskHistory(): Promise<RemoteResult<AskHistoryClearResult>>
  exportAnnualReport(options: { year: number; format: string; dir?: string; filename?: string }): Promise<RemoteResult<ExportResult>>
  exportAllSessions(options?: { dir?: string; filename?: string; jobId?: string }): Promise<RemoteResult<ExportResult>>
  exportMoments(options?: {
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
  }): Promise<RemoteResult<ExportResult>>
  /** 导出朋友圈视频到指定路径（后端负责解密与写盘）。 */
  exportSnsVideo(options: {
    md5?: string; timelineId?: string; mediaId?: string; url?: string; key?: string; dest: string
  }): Promise<RemoteResult<{ ok: boolean; bytes?: number; source?: string; error?: string }>>
  clearSessionDraft(options: { username: string }): Promise<RemoteResult<DraftClearResult>>
  clearAllSessionDrafts(): Promise<RemoteResult<DraftsClearResult>>
  listSummaryTasks(): Promise<RemoteResult<SummaryTaskSnapshotRead>>
  saveSummaryTask(options: { task: Omit<SummaryTask, 'id' | 'createdAt' | 'updatedAt'> & { id?: number } }): Promise<RemoteResult<SummaryTaskMutationResult>>
  deleteSummaryTask(options: { id: number }): Promise<RemoteResult<SummaryTaskMutationResult>>
  toggleSummaryTask(options: { id: number; enabled: boolean }): Promise<RemoteResult<SummaryTaskMutationResult>>
  runSummaryTask(options: { id: number }): Promise<RemoteResult<SummaryTaskRunResult>>
  listSummaryRecords(options?: { taskId?: number }): Promise<RemoteResult<SummaryRecordSnapshotRead>>
  deleteSummaryRecord(options: { id: number }): Promise<RemoteResult<SummaryTaskMutationResult>>
  listTasks(): Promise<RemoteResult<TasksSnapshotRead>>
  getHandoffReminds(): Promise<RemoteResult<HandoffRemindsSnapshot>>
  syncHandoffTasks(): Promise<RemoteResult<TaskMutationResult>>
  addTask(options: { title: string; dueAt?: number }): Promise<RemoteResult<TaskMutationResult>>
  setTaskStatus(options: { id: number; status: 'open' | 'done' }): Promise<RemoteResult<TaskMutationResult>>
  deleteTask(options: { id: number }): Promise<RemoteResult<TaskMutationResult>>
  extractTasks(options?: { days?: number }): Promise<RemoteResult<TaskMutationResult>>
  getAvatar(options: { username: string; nickname?: string }): Promise<RemoteResult<AvatarResult>>
  getAvatarsLocal(options: { usernames: string[] }): Promise<RemoteResult<Record<string, string>>>
  getWechatConfigFull(): Promise<RemoteResult<WechatConfigFull>>
  openConfig(signal?: AbortSignal): Promise<RemoteResult<{ ok: boolean; path: string }>>
  openPath(options: { path: string }, signal?: AbortSignal): Promise<RemoteResult<{ ok: boolean; path: string }>>
  saveWechatConfig(options: { patch: WechatConfigPatch }): Promise<RemoteResult<SimpleResult>>
  detectWechatAccounts(): Promise<RemoteResult<AccountsSnapshot>>
  autoGetDbKey(options: { dbPath?: string; wechatInstallDir?: string }): Promise<RemoteResult<AutoDbKeyResult>>
  autoGetImageKey(options: { accountDir?: string; pid?: number }): Promise<RemoteResult<AutoImageKeyResult>>
  verifyDatabaseKey(options: { dbPath: string; encKeyHex: string }): Promise<RemoteResult<VerifyKeyResult>>
  generateKeysFile(options: {
    dbDir: string
    keysFile: string
    encKeyHex: string
    keyFormat?: string
  }): Promise<RemoteResult<GenerateKeysResult>>
  getWechatKeysInfo(): Promise<RemoteResult<KeysInfoResult>>
  verifyImageKey(): Promise<RemoteResult<VerifyImageKeyResult>>
  decryptAllDatabases(): Promise<RemoteResult<DecryptAllResult>>
  decryptAllImages(options?: { concurrency?: number }): Promise<RemoteResult<DecryptImagesResult>>
  getDecryptStatus(): Promise<RemoteResult<DecryptStatus>>
  getWhisperStatus(): Promise<RemoteResult<WhisperStatus>>
  downloadWhisperModel(options: { model: string }): Promise<RemoteResult<WhisperDownloadResult>>
  installWhisperEngine(): Promise<RemoteResult<WhisperDownloadResult>>
  transcribeVoiceBatch(options?: { limit?: number }): Promise<RemoteResult<VoiceTranscribeResult>>
  getVoiceTranscript(options: { username: string; localId: number }): Promise<RemoteResult<VoiceTranscriptResult>>
  transcribeVoiceMessage(options: { username: string; localId: number }): Promise<RemoteResult<VoiceTranscribeOneResult>>
  setCdnImageEnabled(options: { enabled: boolean }): Promise<RemoteResult<SimpleResult>>
  setCdnImageLocalDecrypt(options: { localDecrypt: boolean }): Promise<RemoteResult<SimpleResult>>
  deleteFavoriteItems(options: { ids: number[] }): Promise<RemoteResult<DeleteFavoriteResult>>
  getAnnualReport(options: { year: number }): Promise<RemoteResult<AnnualReport>>
  getAnnualReview(options: { year: number }): Promise<RemoteResult<AnnualReviewShape>>
}

/** Remote envelope (mirror of dsh-typert-protocol RemoteResult). */
export interface RemoteResult<T> {
  ok: boolean
  value?: T
  error?: { code: string; message: string }
}

/**
 * 语音播放的响应（后端 `VoiceDataUrlResult`）。
 *
 * 为什么在客户端本地声明而不从 `@deepseek-ai/dsh-wechat-data/types` 导入：
 * `node_modules` 里那份是 file: 依赖的**旧副本**（09/09，比 src 旧），没有这个成员 ——
 * 既有的 48 条类型错误全部同源。为一个字段去改 node_modules 不划算，
 * 这里显式声明并在注释里标出真源；等哪天重跑 `npm install` 同步副本后可以删掉它。
 */
export interface VoicePlaybackResult {
  url?: string
  /** 由 wav 头算出的时长（秒）。 */
  durationSec?: number
  error?: string
}

let _remote: (() => WechatRemote) | null = null

/**
 * Rewrite a session-authentication failure (HTTP 401 from the API channel,
 * which is the browser cookie gate) into an actionable message. The raw
 * transport text ("transport failure for ...: HTTP 401") leaves the user with
 * no idea that reopening the app re-authenticates.
 * @param e - the thrown error from a remote call.
 * @returns an Error with a user-facing message when the failure is HTTP 401.
 */
export function actionableRemoteError(e: unknown): Error {
  const msg = e instanceof Error ? e.message : String(e)
  if (/HTTP 401\b/.test(msg)) {
    return new Error('本地会话认证已失效（HTTP 401）：请关闭并重新打开本页面；若仍失败，请用「dsh web」启动时打印的带 token 的地址重新打开应用以完成重新认证')
  }
  return e instanceof Error ? e : new Error(msg)
}

/**
 * Install the Remote client (called from ui-pages apply).
 * @param remote - The Remote client to install.
 */
export function setWechatRemote(remote: WechatRemote | (() => WechatRemote)): void {
  const base = typeof remote === 'function' ? remote : () => remote
  // Wrap every method so transport failures (HTTP 401 session expiry) surface an
  // actionable message across all panels, not only explicit catch sites.
  _remote = () => new Proxy(base(), {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver)
      if (typeof v !== 'function') return v
      return (...args: unknown[]) => {
        try {
          const r = (v as (...a: unknown[]) => unknown).apply(target, args)
          return r instanceof Promise
            ? r.catch((e: unknown) => { throw actionableRemoteError(e) })
            : r
        } catch (e) {
          throw actionableRemoteError(e)
        }
      }
    },
  }) as WechatRemote
}

export function remote(): WechatRemote {
  if (_remote === null) throw new Error('wechat-data remote not installed')
  return _remote()
}

let _pickDirectory: (() => Promise<string | null>) | null = null

/** Install the host directory chooser (ui-pages apply injects ctx.workspaces). */
export function setDirectoryPicker(pick: () => Promise<string | null>): void {
  _pickDirectory = pick
}

/** Open the native directory chooser; returns the picked path or null on cancel. */
export async function pickDirectory(): Promise<string | null> {
  if (_pickDirectory === null) return null
  return _pickDirectory()
}

/** 面板截图导出的结果。 */
export interface CaptureResult {
  ok: boolean
  /** 用户在保存对话框里取消了。 */
  canceled?: boolean
  /** 落盘路径（成功时）。 */
  path?: string
  bytes?: number
  width?: number
  height?: number
  message?: string
}

/**
 * 把界面上的一个矩形区域导出成 PNG（主进程 capturePage + 保存对话框）。
 * 坐标用 `element.getBoundingClientRect()` 直接传即可（同为视口 CSS 像素）。
 * @param rect - { x, y, width, height, filename? }。
 * @returns 导出结果（取消时 canceled=true）。
 */
export async function apiCapturePanel(rect: {
  x: number; y: number; width: number; height: number; filename?: string
}): Promise<CaptureResult> {
  const api = (window as unknown as { electronAPI?: { capturePanel?: (r: unknown) => Promise<CaptureResult> } }).electronAPI
  if (!api?.capturePanel) return { ok: false, message: '当前环境不支持截图导出' }
  const r = await api.capturePanel(rect)
  return r ?? { ok: false, message: '截图导出无返回' }
}

export function unwrap<T>(r: RemoteResult<T>): T {
  if (!r.ok) throw new Error(r.error?.message ?? r.error?.code ?? 'remote call failed')
  return r.value as T
}
