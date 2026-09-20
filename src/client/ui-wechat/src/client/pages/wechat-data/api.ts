/**
 * WeChat data access layer — backed by the DSH WechatDataGateway Remote
 * (node:sqlite over the owned local decrypted DBs). All panels read through
 * ctx.remote.wechatData.*; there is no HTTP dependency.
 *
 * Panels also use the stale-while-revalidate render cache below: the first
 * successful render is persisted, the next open renders it synchronously
 * (instant paint), and fresh data replaces it in the background.
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

// M21：缓存层已拆到 ./cache.ts 与 ./media-cache.ts（纯搬移）。这里继续转发，
// 使 40 多个面板的 `from './api.ts'` 一行都不用改。
// 注意：`export … from` **不会**把名字带进本模块作用域，而下面这些函数在 api.ts 内部
// 也会被调用（各种失效/写缓存路径），所以既要 import（供内部用）又要 export from（供外部用）。
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
import { notifyKbsUpdated, notifyNotesUpdated } from './notes-events.ts'
export { KBS_UPDATED_EVENT, NOTES_UPDATED_EVENT } from './notes-events.ts'
// 知识笔记/知识图谱类型刻意从本地 types.ts 取（node_modules 那份宿主副本已陈旧，
// 原因见该文件顶部注释）。
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
// 知识库作用域键的**定义处**（叶子模块，不反向依赖本文件）：快照缓存的库后缀从这里出。
// 别处不许自己拼 `'kb:graph:' + id` —— 缓存键与布局坐标必须用同一个作用域名，
// 两处各拼一次就会漂移成「模型里有节点、图上没有」那种只在切库后才现形的偏差。
import { KB_LIST_CACHE_KEY, kbCacheKey } from './kb-scope-keys.ts'
import { createImageLoadQueue } from './image-batch.ts'

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
  searchMessages(options: { query: string; limit?: number; username?: string }): Promise<RemoteResult<SearchSnapshot>>
  searchUnified(options: { query: string; limit?: number }): Promise<RemoteResult<UnifiedSearchSnapshot>>
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
function actionableRemoteError(e: unknown): Error {
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

function remote(): WechatRemote {
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

function unwrap<T>(r: RemoteResult<T>): T {
  if (!r.ok) throw new Error(r.error?.message ?? r.error?.code ?? 'remote call failed')
  return r.value as T
}

// ── sessions / contacts / messages (Remote) ──
/**
 * Fetch the session list (optional keyword filter + limit).
 * @param options - Query options: keyword fuzzy search, limit max rows.
 * @returns SessionsSnapshot with items + total.
 */
export async function apiGetSessions(options?: { keyword?: string; limit?: number; offset?: number }): Promise<SessionsSnapshot> {
  return cachedFetch('sessions:' + JSON.stringify(options ?? {}), async () => unwrap(await remote().getSessions(options)), 30_000)
}
/**
 * Fetch the contact list (optional page size + offset + category filter).
 *
 * `category` is forwarded to the backend, which filters **before** paginating —
 * so each category tab gets its own complete list and a matching `total`.
 * Filtering client-side after pagination would show an empty tab whenever the
 * globally-sorted first page happens to contain none of that category.
 *
 * @param options - Query options: limit page size, offset page start, category filter.
 * @returns ContactsSnapshot.
 */
export async function apiGetContacts(options?: { limit?: number; offset?: number; category?: string }): Promise<ContactsSnapshot> {
  return cachedGet('contacts:' + JSON.stringify(options ?? {}), async () => unwrap(await remote().getContacts(options)))
}
/**
 * Fetch the contact 360° profile snapshot.
 * @param username - target username.
 * @returns Contact360Snapshot.
 */
export async function apiGetContact360(username: string): Promise<Contact360Snapshot> {
  return unwrap(await remote().getContact360({ username }))
}
/**
 * Fetch messages for a talker.
 * @param options - Query options: talker username, limit, cursor (+ cursorLocalId)
 *   for paging. cursor 与 cursorLocalId 必须成对回传：只传 cursor 会在 sort_seq
 *   重复处丢消息。
 * @returns MessagesSnapshot.
 */
export async function apiGetMessages(options: { talker: string; limit?: number; cursor?: number; cursorLocalId?: number }): Promise<MessagesSnapshot> {
  if (options.cursor !== undefined) return unwrap(await remote().getMessages(options))
  return cachedFetch('messages:' + options.talker + ':' + String(options.limit ?? 50), async () => unwrap(await remote().getMessages(options)), 5_000)
}
/**
 * Fetch messages newer than a sort_seq watermark (real-time polling).
 * @param options - Query options: talker, after watermark, optional limit.
 * @returns MessagesSnapshot with the newer messages only.
 */
export async function apiGetNewMessages(options: { talker: string; after: number; limit?: number }): Promise<MessagesSnapshot> {
  return unwrap(await remote().getNewMessages(options))
}
/**
 * Fetch the moments feed (paging + author filter).
 * @param options - Query options: offset, limit, author filter.
 * @returns MomentsSnapshot.
 */
export async function apiGetMoments(options?: { offset?: number; limit?: number; author?: string }): Promise<MomentsSnapshot> {
  return cachedFetch('moments:' + JSON.stringify(options ?? {}), async () => unwrap(await remote().getMoments(options)))
}
/** Fetch the current account's own WeChat username (for filtering "我" authored comments). */
export async function apiGetSelfUsername(): Promise<string> {
  const r = await remote().getSelfUsername()
  return unwrap(r).username
}
/** Fetch full-history author activity counts (ranked descending). */
export async function apiGetMomentsAuthors(): Promise<Array<{ name: string; count: number }>> {
  return unwrap(await remote().getMomentsAuthors())
}
/**
 * Fetch moments insights for an author (default: self).
 * @param options - optional author username.
 * @returns MomentsInsightsSnapshot.
 */
export async function apiGetMomentsInsights(options?: { author?: string }): Promise<MomentsInsightsSnapshot> { return cachedGet('momentsInsights:' + JSON.stringify(options ?? {}), async () => unwrap(await remote().getMomentsInsights(options))) }
/**
 * Fetch the full monthly distribution of moments (all authors, or one author).
 * Not paginated, so it reflects every month.
 * @param options - optional author username (`author`) or author display-name
 *   (`authorName`) filter (all when omitted).
 * @returns monthly rows sorted ascending by month.
 */
export async function apiGetMomentsMonthly(options?: { author?: string; authorName?: string }): Promise<MomentsMonthlyRow[]> {
  return unwrap(await remote().getMomentsMonthly(options))
}
/**
 * Fetch the favorites list.
 * @param options - Query options: limit.
 * @returns FavoritesSnapshot.
 */
export async function apiGetFavorites(options?: { limit?: number; offset?: number; q?: string }): Promise<FavoritesSnapshot> { return cachedGet('favorites:' + JSON.stringify(options ?? {}), async () => unwrap(await remote().getFavorites(options))) }
/**
 * Fetch favorites + emoticon asset insights.
 * @returns AssetInsightsSnapshot.
 */
export async function apiGetAssetInsights(): Promise<AssetInsightsSnapshot> {
  return unwrap(await remote().getAssetInsights())
}
/**
 * Fetch official account content assets.
 * @returns OfficialAssetsSnapshot.
 */
export async function apiGetOfficialAssets(): Promise<OfficialAssetsSnapshot> {
  return unwrap(await remote().getOfficialAssets())
}
/**
 * Fetch media assets inventory.
 * @returns MediaAssetsSnapshot.
 */
export async function apiGetMediaAssets(): Promise<MediaAssetsSnapshot> {
  return unwrap(await remote().getMediaAssets())
}
/**
 * Fetch the files list.
 * @param options - Query options: limit.
 * @returns FilesSnapshot.
 */
export async function apiGetFiles(options?: { limit?: number; offset?: number; category?: string; q?: string }): Promise<FilesSnapshot> { return cachedGet('files:' + JSON.stringify(options ?? {}), async () => unwrap(await remote().getFiles(options))) }
/**
 * Fetch the overall statistics overview.
 * @returns OverviewSnapshot.
 */
export async function apiGetOverviewInsights(): Promise<OverviewInsights> { return cachedGet('overviewInsights:x', async () => unwrap(await remote().getOverviewInsights())) }

export async function apiGetOverview(): Promise<OverviewSnapshot> { return cachedGet('overview:x', async () => unwrap(await remote().getOverview())) }
/**
 * Fetch the friend-region map (世界 → 国家 → 省 → 市 → 好友).
 * @returns RegionMapSnapshot.
 */
export async function apiGetRegionMap(): Promise<RegionMapSnapshot> {
  return unwrap(await remote().getRegionMap())
}

/**
 * Fetch records with kind filter + paging + free-text query.
 * @param options - Query options: kind, limit, offset, q.
 * @returns RecordsSnapshot.
 */
export async function apiGetRecords(options: { kind: string; limit?: number; offset?: number; q?: string; from?: number; to?: number; direction?: 'asc' | 'desc' }): Promise<RecordsSnapshot> {
  return cachedFetch('records:' + JSON.stringify(options), async () => unwrap(await remote().getRecords(options)))
}
/**
 * Fetch the funds ledger snapshot (transfer/red-packet aggregates).
 * @param options - Optional month filter (YYYY-MM).
 * @returns LedgerSnapshot.
 */
export async function apiGetLedger(options?: { month?: string }): Promise<LedgerSnapshot> {
  return unwrap(await remote().getLedger(options))
}
/**
 * Fetch the call (type 50) inventory snapshot.
 * @param options - Optional peer/recent list sizes.
 * @returns CallsSnapshot.
 */
export async function apiGetCalls(options?: { topPeers?: number; recentLimit?: number }): Promise<CallsSnapshot> {
  return unwrap(await remote().getCalls(options))
}
/**
 * Fetch revoked messages.
 * @param options - Query options: limit.
 * @returns RevokedSnapshot.
 */
export async function apiGetRevoked(options?: { limit?: number; offset?: number; q?: string }): Promise<RevokedSnapshot> { return cachedGet('revoked:' + JSON.stringify(options ?? {}), async () => unwrap(await remote().getRevoked(options))) }
/**
 * Fetch the emoticons list.
 * @param options - Query options: limit/offset.
 * @returns EmoticonsSnapshot.
 */
export async function apiGetEmoticons(options?: { limit?: number; offset?: number }): Promise<EmoticonsSnapshot> { return cachedGet('emoticons:' + JSON.stringify(options ?? {}), async () => unwrap(await remote().getEmoticons(options))) }
/**
 * Fetch storage usage statistics.
 * @returns StorageSnapshot.
 */
export async function apiGetStorageStats(): Promise<StorageSnapshot> { return cachedGet('storage:x', async () => unwrap(await remote().getStorageStats())) }
/**
 * Fetch annual statistics.
 * @returns AnnualSnapshot.
 */
export async function apiGetAnnual(): Promise<AnnualSnapshot> { return cachedGet('annual:x', async () => unwrap(await remote().getAnnual())) }
/**
 * Fetch the current WeChat config snapshot.
 * @returns ConfigSnapshot.
 */
export async function apiGetWechatConfig(): Promise<ConfigSnapshot> {
  return unwrap(await remote().getWechatConfig())
}
/**
 * Fetch the privacy scan result.
 * @returns PrivacySnapshot.
 */
export async function apiGetPrivacyScan(): Promise<PrivacySnapshot> {
  return cachedFetch('privacy', async () => unwrap(await remote().getPrivacyScan()))
}
/**
 * Fetch privacy settings + audit snapshot.
 * @returns PrivacyStateSnapshot.
 */
export async function apiGetPrivacyState(): Promise<PrivacyStateSnapshot> {
  return unwrap(await remote().getPrivacyState())
}
/**
 * Update privacy settings.
 * @param options - partial settings patch.
 * @returns the updated privacy state snapshot.
 */
export async function apiSetPrivacyState(options: { redactSensitive?: boolean; blockOutbound?: boolean }): Promise<PrivacyStateSnapshot> {
  const r = await remote().setPrivacyState(options)
  invalidateWechatCache('privacy')
  return unwrap(r)
}
/**
 * Fetch recent raw privacy audit rows.
 * @returns recent audit rows.
 */
export async function apiGetPrivacyAuditRows(): Promise<PrivacyAuditRow[]> {
  return unwrap(await remote().getPrivacyAuditRows())
}
/**
 * Clear the privacy audit log.
 * @returns clear result with removed row count.
 */
export async function apiClearPrivacyAudit(): Promise<PrivacyAuditClearResult> {
  return unwrap(await remote().clearPrivacyAudit())
}
/**
 * List recent operation-log rows (newest first) with optional filters.
 * @param options - time range / categories / status / limit filters.
 * @returns matching operation-log entries + total count.
 */
export async function apiGetOperationLog(options?: OperationLogQuery): Promise<OperationLogSnapshot> {
  return unwrap(await remote().getOperationLog(options))
}
/**
 * Clear the operation log (a sensitive action, itself recorded first).
 * @returns clear result with removed row count.
 */
export async function apiClearOperationLog(): Promise<OperationLogClearResult> {
  return unwrap(await remote().clearOperationLog())
}
/**
 * Fetch the relationship graph snapshot.
 * @returns GraphSnapshot.
 */
export async function apiGetGraph(): Promise<GraphSnapshot> { return cachedGet('graph:x', async () => unwrap(await remote().getGraph())) }

/**
 * Knowledge graph (note nodes + `[[wiki]]` edges + unresolved stubs).
 * Nodes come exclusively from the knowledge base — no social/contact data is mixed in
 * (the former client-side "fused" view was removed; see panels/graph-model.ts).
 * @returns KnowledgeSnapshot.
 */
export async function apiGetKnowledgeGraph(kbId: number): Promise<KnowledgeSnapshotRead> {
  return cachedGet(kbCacheKey('kb:graph', kbId), async () => unwrap(await remote().getKnowledgeGraph(kbId)))
}

/**
 * List knowledge notes.
 *
 * 刻意**不走缓存**：笔记是本地 sqlite 的直读，代价可忽略，而搜索框每敲一个字都
 * 需要最新结果 —— 挂上 30s 快照缓存只会让用户看到过期列表。
 * @param options - Optional search query and row cap.
 * @returns NotesSnapshot（读不到库时带 `readError`，与「确无笔记」可区分）。
 */
export async function apiGetNotes(kbId: number, options?: { query?: string; limit?: number }): Promise<NotesSnapshotRead> {
  return unwrap(await remote().getNotes(kbId, options))
}

/**
 * Create or update one note. Invalidates the knowledge caches so the graph
 * panel reflects the change without waiting out the snapshot TTL.
 * @param input - Note fields; omit `id` to create.
 * @returns NoteMutationResult.
 */
export async function apiSaveNote(kbId: number, input: {
  id?: number
  title: string
  body?: string
  tags?: string[] | string
  sourceKind?: 'manual' | 'ask'
  sourceUsername?: string
  sourceQuestion?: string
}): Promise<NoteMutationResult> {
  const result = unwrap(await remote().saveNote(kbId, input))
  invalidateKnowledgeCaches()
  return result
}

/** Delete one note (links pointing at it become stubs). */
export async function apiDeleteNote(kbId: number, id: number): Promise<NoteMutationResult> {
  const result = unwrap(await remote().deleteNote(kbId, { id }))
  invalidateKnowledgeCaches()
  return result
}

/**
 * 库列表（含每库笔记条数）。
 *
 * 走快照缓存：切换器、笔记面板、图谱面板各挂一次 `useKbScope()`，不缓存就是同一张几张行的
 * 小表被 RPC 三遍。它的键**刻意不叫 `kb-list`**：`kb-` 那一族是「某个库的内容」，
 * 而库登记表是另一类东西 —— 笔记内容变了不该动它，库表变了才动它（两条失效路径因此分开）。
 * @returns KbListSnapshot.
 */
export async function apiGetKbs(): Promise<KbListSnapshotRead> {
  return cachedGet(KB_LIST_CACHE_KEY, async () => unwrap(await remote().getKbs()))
}

/**
 * 新建一个知识库。
 * @param name - 库名（后端去空白 + 归一化后按库判重）。
 * @returns KbMutationResult.
 */
export async function apiCreateKb(name: string): Promise<KbMutationResult> {
  const result = unwrap(await remote().createKb({ name }))
  invalidateKbCaches()
  return result
}

/**
 * 重命名一个知识库（默认库也在内：它是「不可删」，不是「不可改」）。
 * @param id - 库 id。
 * @param name - 新库名。
 * @returns KbMutationResult.
 */
export async function apiRenameKb(id: number, name: string): Promise<KbMutationResult> {
  const result = unwrap(await remote().renameKb({ id, name }))
  invalidateKbCaches()
  return result
}

/**
 * 删除一个知识库。`action` **必填**（见 `KbDeleteAction`）：删掉一个非空库是
 * 「笔记一起删」还是「移到别的库」必须由用户明说，后端不猜。
 *
 * 这里**刻意不广播 `NOTES_UPDATED_EVENT`**：删的是当前库时，面板手上那个 kbId 已经不存在了，
 * 一广播就会先闪一次「知识库不存在」。重取由作用域切换驱动 ——
 * `KBS_UPDATED_EVENT` → `useKbScope` 发现当前库不在列表里 → 退回一个存在的库 →
 * 面板的 effect 依赖 kbId，自然重取。删的是别的库时，当前库的笔记本就没变。
 * 缓存仍然要清（不广播不等于不清）：否则切回去时会读到已被删掉那个库的旧列表。
 * @param id - 库 id。
 * @param action - 库内笔记的处理方式。
 * @returns KbMutationResult.
 */
export async function apiDeleteKb(id: number, action: KbDeleteAction): Promise<KbMutationResult> {
  const result = unwrap(await remote().deleteKb({ id, action }))
  dropKnowledgeCaches()
  invalidateKbCaches()
  return result
}

// ── 知识库文件（KB-RAG 计划的 T2） ─────────────────────────────────────────
// 文件是知识库的**第三类内容**（笔记 / 图谱 / 文件），作用域同样由 kbId 划。
// 后端落在独立的 `wechat_kb_files.db`（不是 notes 库里的几张表）：这样「文件功能整体
// 回退」= 删一个库文件 + 摘掉这几个 Remote 注册，不会在 notes 库里留下半张表。

/**
 * 一个知识库里的文件列表（新上传的在前）。
 *
 * `kbId` 必填、**没有**「所有库的文件」这种视图 —— 与 `apiGetNotes` 同口径：
 * 文件、分块、检索全部按库划作用域，漏传就会「切了库但文件列表没变」。
 *
 * 刻意**不走快照缓存**（同 `apiGetNotes` 的理由）：列表是本地 sqlite 的直读，
 * 代价可忽略，而上传 / 删除之后要求立刻看到最新结果 —— 挂 TTL 只会让用户对着
 * 旧列表怀疑「根本没传上去」。首帧的即时感由面板侧的渲染缓存（`kb-files:<id>`）负责。
 * @param kbId - 知识库 id（必填位置参数）。
 * @param options - 分页。
 * @returns 文件列表快照；读不到库时带 `readError`（与「还没有文件」可区分）。
 */
export async function apiGetKbFiles(kbId: number, options?: { limit?: number; offset?: number }): Promise<KbFileListSnapshot> {
  return unwrap(await remote().getKbFiles(kbId, options))
}

/**
 * 读某个文件解析出来的正文（分页）。界面上「就地展开看内容」走这一条。
 *
 * **不走快照缓存**（同 `apiGetKbFiles`）：一次是一页、最多 200 块，本地 sqlite 直读的
 * 代价可忽略；而缓存它要额外回答「什么时候算旧」—— 重新解析、改库、删文件都得记得清，
 * 漏一处就是「明明重解析了，展开看到的还是旧正文」。
 *
 * ⚠ `kbId` 与 `fileId` 都要传：后端会确认这个文件确实属于这个库，
 * 否则只凭 fileId 就能读到别的库的内容，而这条返回的是**正文**不是计数。
 * @param kbId - 知识库 id（必填）。
 * @param fileId - 目标文件。
 * @param options - 分页。
 * @returns KbFileChunkPage；`readError` 非空时 `items` 为空。
 */
export async function apiGetKbFileChunks(
  kbId: number, fileId: number, options?: { limit?: number; offset?: number },
): Promise<KbFileChunkPage> {
  return unwrap(await remote().getKbFileChunks(kbId, fileId, options))
}

/**
 * 登记一批文件（原生对话框多选的结果）。
 *
 * 逐项回执：**部分成功是常态**（一次选 10 个、3 个重复、1 个类型不支持），
 * 所以返回 `added` / `failed` / `results`，由调用方逐条说清哪几个为什么没进来 ——
 * 一句笼统的「添加失败」会让用户把没问题的文件也重选一遍。
 * @param kbId - 知识库 id。
 * @param paths - 用户电脑上的绝对路径（后端只登记，**不写不删原件**）。
 * @param includeInRag - 是否参与向量化（出网）；不给按后端缺省（参与）。
 * @returns KbFileAddResult。
 */
export async function apiAddKbFiles(kbId: number, paths: string[], includeInRag?: boolean): Promise<KbFileAddResult> {
  const result = unwrap(await remote().addKbFiles({ kbId, paths, ...(includeInRag === undefined ? {} : { includeInRag }) }))
  invalidateKbFileCaches(kbId)
  return result
}

/**
 * 从知识库里删掉一个文件（连带分块 / 关键词索引 / 向量 / blob 副本）。
 *
 * **不碰用户电脑上的原文件** —— 删的是知识库里的这一份，那份原文件仍在他的盘上。
 * `kbId` 是**守卫**：文件 id 全局自增，拿甲库的 id 调乙库会删掉甲库那一条，
 * 而删除是物理的、没有撤销。
 * @param kbId - 知识库 id（守卫）。
 * @param id - 文件行 id。
 * @returns KbFileMutationResult（回执带连带清掉的分块数）。
 */
export async function apiDeleteKbFile(kbId: number, id: number): Promise<KbFileMutationResult> {
  const result = unwrap(await remote().deleteKbFile({ kbId, id }))
  invalidateKbFileCaches(kbId)
  return result
}

/**
 * 切换一个文件是否参与向量化（出网）。
 *
 * 关掉之后该文件**完全不出网**，但仍留在关键词索引里可被搜到 —— 这正是
 * 「库里有合同，但我还想搜到它」的实现方式。全局「禁止 AI 出网」仍是同一道闸门，
 * 一起拦下。
 * @param kbId - 知识库 id（守卫）。
 * @param id - 文件行 id。
 * @param includeInRag - 是否参与。
 * @returns KbFileMutationResult。
 */
export async function apiSetKbFileRag(kbId: number, id: number, includeInRag: boolean): Promise<KbFileMutationResult> {
  const result = unwrap(await remote().setKbFileRag({ kbId, id, includeInRag }))
  invalidateKbFileCaches(kbId)
  return result
}

/**
 * 用模型给某个知识库文件生成摘要。**这是一条出网调用**（发的是那份文件的前若干字正文）。
 *
 * 后端会按顺序过三道闸：「禁止 AI 出网」→ 该文件的「参与语义检索（会出网）」→ 敏感字段
 * 打码 + 审计。任何一道拦下都返回 `{ ok: false, error }`，不会静默降级。
 *
 * 成功后**必须清本库的文件列表缓存**：摘要写进了 `kb_files` 行，而列表是渲染缓存的 ——
 * 不清的话生成完界面还是空的，用户会以为没成功再点一次，又发一遍正文出去。
 * @param kbId - 知识库 id（守卫）。
 * @param id - 文件行 id。
 * @returns KbSummaryResult（含 `coveredChars` / `totalChars`，界面用它标注覆盖范围）。
 */
export async function apiSummarizeKbFile(kbId: number, id: number): Promise<KbSummaryResult> {
  const result: KbSummaryResult = unwrap(await remote().summarizeKbFile({ kbId, id }))
  if (result.ok) invalidateKbFileCaches(kbId)
  return result
}

/**
 * 在当前知识库里做关键词（FTS5 稀疏通道）检索。
 *
 * 设计稿 §8.4「不给模式开关」：用户只输入一个词，走哪条通道由系统决定、
 * 结果区标题说明实际走了什么。所以这里**没有** `mode` 参数 ——
 * 加一个「只用关键词」的开关，就等于把一个本不该由用户决定的实现细节变成他的配置。
 *
 * **不走快照缓存**（同 `apiGetKbFiles`）：检索是本地 sqlite 的直读，代价可忽略；
 * 挂 TTL 只会让用户输入新词之后仍看到上一次的结果。
 * @param kbId - 知识库 id（必填位置参数，漏传就会串库）。
 * @param query - 用户输入（可为多词，空格分隔）。
 * @param topK - 最多返回多少条；不给按后端默认。
 * @returns 命中（按相关度）+ 统计 + 降级说明；`error` / `readError` 是两种不同的没搜成。
 */
export async function apiSearchKb(kbId: number, query: string, topK?: number): Promise<KbSearchResult> {
  return unwrap(await remote().searchKb({ kbId, query, ...(topK === undefined ? {} : { topK }) }))
}

/**
 * 本库的向量索引状态（多少块、哪个模型算的、与当前绑定是否一致、有没有在飞构建）。
 *
 * **不挂缓存**：这是要被轮询的瞬时态（建索引期间进度在动），缓存它等于让按钮卡在旧进度上。
 * @param kbId - 知识库 id。
 * @returns 状态视图。
 */
export async function apiGetKbVectorIndex(kbId: number): Promise<KbVectorIndexView> {
  return unwrap(await remote().getKbVectorIndex({ kbId }))
}

/**
 * 为**本库**构建 / 增量更新向量索引（会出网：把文件正文送去 embedding）。
 *
 * **不清任何缓存**：建索引只写 `wechat_kb_vectors.db`，`kb_files` 一行都没变 ——
 * 清文件列表缓存等于白取一次数。界面要刷新的是索引状态，那是轮询 `apiGetKbVectorIndex` 拿的。
 * @param kbId - 知识库 id。
 * @param force - 清空本库重算。
 * @returns 构建结果（`ok` 为假时带 `error`）。
 */
export async function apiBuildKbVectorIndex(kbId: number, force = false): Promise<KbVectorBuildResult> {
  return unwrap(await remote().buildKbVectorIndex({ kbId, force }))
}

/**
 * 读本库的模型设置（三个角色的引用与实际生效值）。
 *
 * 按 `kbCacheKey('kb-model', kbId)` 缓存：打开弹层时读一次就够，
 * 而键**必须带库 id** —— 不带就会出现「甲库的覆盖显示在乙库头上」那种串味。
 * @param kbId - 知识库 id。
 * @returns 设置视图。
 */
export async function apiGetKbModelConfig(kbId: number): Promise<KbModelConfigView> {
  return cachedFetch(kbCacheKey('kb-model', kbId), async () => unwrap(await remote().getKbModelConfig({ kbId })))
}

/**
 * 写本库的模型覆盖（空串 = 取消覆盖、回到继承）。
 *
 * 两层都要失效，理由各不相同：
 *   · `kb-model:<id>` —— 刚写的引用串，弹层下次打开要看到新值；
 *   · 库列表那一族 —— `modelOverrides`（芯片上的「N 项自定义」）是 `getKbs` 合流出来的
 *     **派生值**，它确实变了，所以走完整的 `invalidateKbCaches()`（清快照 + 清渲染缓存 + 广播）。
 *     这里不省那一次广播：省了芯片就会一直停在旧数字上，而芯片正是这个操作的结果显示。
 * @param kbId - 知识库 id。
 * @param patch - 要改的引用串（未传的字段保持原值）。
 * @returns 后端结果（引用串不合法时 `ok:false` + 原因）。
 */
export async function apiSetKbModelConfig(kbId: number, patch: { chatRef?: string; embedRef?: string; rerankRef?: string }): Promise<KbModelConfigResult> {
  const result: KbModelConfigResult = unwrap(await remote().setKbModelConfig({ kbId, ...patch }))
  invalidateWechatCache(kbCacheKey('kb-model', kbId))
  if (result.ok) invalidateKbCaches()
  return result
}

/**
 * 对本库的文件跑一次「模型抽实体」（推断层）。
 *
 * 失效三层，缺一层的现场都不同：
 *   · `kb-model:<id>` —— 弹层里那一行「已存 N 条 / 还有 M 个没抽」就是这次操作的结果；
 *   · 快照 + `kb-` 渲染缓存 + `NOTES_UPDATED_EVENT` —— 实体是知识图谱的**节点来源**，
 *     抽完不广播的话，正在看图的人要切一次库才看得见新点（而他会以为「抽了个寂寞」）。
 * @param kbId - 知识库 id。
 * @param opts - 只抽指定文件（`fileIds`）与单轮上限（`limit`）。
 * @returns 后端结果（含逐文件的失败原因；被隐私闸拦下时 `ok:false` + 原因）。
 */
export async function apiExtractKbEntities(kbId: number, opts: { fileIds?: number[]; limit?: number } = {}): Promise<KbExtractResult> {
  const result: KbExtractResult = unwrap(await remote().extractKbEntities({ kbId, ...opts }))
  invalidateWechatCache(kbCacheKey('kb-model', kbId))
  if (result.saved > 0) invalidateKnowledgeCaches()
  return result
}

/**
 * 要一批「模型建议的链接」（笔记编辑器正文下方的芯片）。
 *
 * **刻意不缓存**：建议的对象是用户**正在敲**的那段正文，缓存层会把上一次的主题
 * 留在屏幕上，看起来像「建议不更新」；而它本身是一次 embedding 请求，不该被复用。
 * @param kbId - 知识库 id。
 * @param text - 当前正文（后端会截断）。
 * @param opts - `topK` 与要排除的标题（正在编辑的那篇）。
 * @returns 候选与说明。
 */
export async function apiSuggestKbLinks(kbId: number, text: string, opts: { topK?: number; excludeTitle?: string } = {}): Promise<KbLinkSuggestResult> {
  return unwrap(await remote().suggestKbLinks({ kbId, text, ...opts }))
}

/**
 * 弹出文件选择对话框（可多选）。**只取路径**：读盘与登记由后端做 ——
 * 选中的可能是几十 MB 的文件，不适合经 IPC 传字节（与 `apiSaveFileDialog` 同口径）。
 *
 * `filters` 由调用方传（知识库传后端白名单），不在主进程写死一份：
 * 写死就会与后端 `ACCEPTED_EXTS` 漂移成两份，症状是「对话框里看不到」或者更糟 ——
 * 「选得进来但登记被拒」。
 * @param opts - 对话框标题与扩展名过滤器。
 * @returns `{ canceled, files }`；环境不支持时给 `error` 而不是抛异常。
 */
export async function apiOpenFileDialog(opts?: {
  title?: string
  filters?: Array<{ name: string; extensions: string[] }>
}): Promise<{ canceled: boolean; files: string[]; error?: string }> {
  const api = (window as unknown as {
    electronAPI?: { openFile?: (o?: unknown) => Promise<{ canceled: boolean; files: string[]; error?: string }> }
  }).electronAPI
  if (!api?.openFile) return { canceled: true, files: [], error: '当前环境不支持文件选择' }
  return api.openFile(opts)
}

/**
 * 文件变了：清本库的文件缓存（`kb-files:<id>`），**并且**让库列表失效。
 *
 * 为什么必须连库列表一起清：`KbMeta.fileCount` 不是文件库自己的字段，而是 `getKbs`
 * 把两个库文件合流出来的**派生值**，它住在另外两套缓存里（`KB_LIST_CACHE_KEY` 快照层
 * 与 `kbs-` 渲染层）。只清 `kb-files:<id>` ⇒ 加完文件之后，切换器 / 管理弹层 /
 * **删库弹层**仍拿着旧的 `fileCount`。真机探针实测过一次：库里有 2 个文件，删库弹层
 * 却说「这个库里没有笔记也没有文件」，并且因为 `canMoveInstead` 判假而**不给「移到…」
 * 分支** —— 一个装了几百份资料、笔记一条没写的库，唯一出口只剩「一并删除」。
 *
 * 为什么光清缓存还不够、还要广播：清缓存只保证「下一次取数拿到新值」，不会叫醒
 * **已经挂载**的切换器（它手里是上一次的数组）。所以走 `invalidateKbCaches()` 这一个
 * 入口 —— 它一次做全三件事（清快照 + 清渲染缓存 + 广播）。
 * 广播的是 `KBS_UPDATED_EVENT`（库列表），**不是** `NOTES_UPDATED_EVENT`：笔记库 /
 * 知识图谱 / 问答并不读 `kb_files`，叫醒它们只会白重取一次。
 *
 * 键名由 `kbCacheKey` 拼，别处不许手写 `kb-files:` + id：带库 id 的键字面量散开
 * 就会出现「模型里有、图上看不到」那类只在切库后才现形的偏差。
 * （`invalidateWechatCache` 是**前缀**匹配，所以 `kb-files:3` 会顺带清掉
 *  `kb-files:30` 的渲染缓存 —— 只会多清一层缓存，不会少清，故可接受。）
 * @param kbId - 知识库 id。
 */
function invalidateKbFileCaches(kbId: number): void {
  invalidateWechatCache(kbCacheKey('kb-files', kbId))
  // 同上：`KbMeta.fileCount` 是 getKbs 合流的派生值，与文件列表分属两套缓存。
  invalidateKbCaches()
}

/**
 * Drop every cache layer that can hold knowledge data, then broadcast the change.
 *
 * 笔记的写入**不会**触发 'dsh-wechat-data-updated'（那不是解密数据变更），所以这里
 * 必须自己失效：内存快照层（cachedGet 用的 _snapshotCache）与 localStorage 渲染层
 * （readRenderCache 的 'kb-' 前缀）是两套互不相通的缓存，只清一层会出现
 * 「图谱刷新了但列表还是旧的」这类半刷新状态。
 *
 * 但**清缓存 ≠ 刷新页面**：它只保证「下一次取数拿到新数据」，不会叫醒已经挂载的面板。
 * 所以末尾必须再广播一次（`NOTES_UPDATED_EVENT`），否则正在看知识图谱的人改完笔记
 * 仍停在旧图上 —— 这是「内容更新时图谱节点要同步刷新」里最容易漏掉的一半。
 * saveNote / deleteNote 是仅有的两个调用点，因此广播收在这一个入口。
 */
function invalidateKnowledgeCaches(): void {
  dropKnowledgeCaches()
  notifyNotesUpdated()
}

/** 清掉一切可能装着知识数据的缓存层，但**不广播**（广播与否是两条不同路径，见调用点）。 */
function dropKnowledgeCaches(): void {
  invalidateSnapshotCache()
  invalidateWechatCache('kb-')
}

/**
 * 库表变了（新建 / 改名 / 删除）：只让库列表那一条失效。
 *
 * 为什么不顺手 `invalidateSnapshotCache()`：建一个库、改一个名字，与聊天、朋友圈、
 * 待办等面板的快照毫无关系，清全部会让它们下次切页时全体重新取数。
 * 真正的**内容**变化由 `dropKnowledgeCaches()` 负责，两者在 `apiDeleteKb` 里同时出现 ——
 * 因为删库既动了库表又动了笔记（迁移或删除）。
 *
 * `invalidateWechatCache('kbs-')` 清的是渲染缓存层（`useKbScope` 用它做冷启动首帧），
 * 与上面那行提到的快照层是互不相通的两套 —— 只清一层会留下「切换器显示旧名字」。
 */
function invalidateKbCaches(): void {
  snapshotDelete(KB_LIST_CACHE_KEY)
  invalidateWechatCache('kbs-')
  notifyKbsUpdated()
}

/**
 * Fetch search index build status.
 * @returns SearchIndexStatus.
 */
export async function apiGetSearchIndexStatus(): Promise<SearchIndexStatus> {
  return unwrap(await remote().getSearchIndexStatus())
}
/**
 * Trigger a search index build (optionally forced).
 * @param options - Query options: force rebuild even when up to date.
 * @returns SearchBuildResult.
 */
export async function apiBuildSearchIndex(options?: { force?: boolean }): Promise<SearchBuildResult> {
  return unwrap(await remote().buildSearchIndex(options))
}
/**
 * Search messages by query text.
 * @param options - Query options: query text and limit.
 * @returns SearchSnapshot.
 */
export async function apiSearchMessages(options: { query: string; limit?: number; username?: string }): Promise<SearchSnapshot> {
  return unwrap(await remote().searchMessages(options))
}
/**
 * Run the unified local search across several data domains.
 * @param options - Query options: query text, optional per-domain limit.
 * @returns UnifiedSearchSnapshot.
 */
export async function apiSearchUnified(options: { query: string; limit?: number }): Promise<UnifiedSearchSnapshot> {
  return unwrap(await remote().searchUnified(options))
}
/**
 * Ask a question over the local WeChat data (multi-turn: intent plan → retrieval → synthesis).
 * @param options - Question plus optional talker/date scope and conversation history.
 * @returns AskResult: answer, source citations, and the retrieval plan.
 */
export async function apiAskWechat(options: {
  question: string
  username?: string
  from?: string
  to?: string
  /** 多轮对话历史（此前轮次的问答，最多带最近 8 轮）。 */
  history?: Array<{ role: 'user' | 'assistant'; content: string }>
  /** 流式标识：带上它，后端会在生成过程中推送 wechat-ask/delta 增量事件
   *  （渲染端监听 dsh-wechat-ask-delta）。不传则退化为一次性返回。 */
  streamId?: string
  /** 入口来源（'ask'/'session'）与会话显示名：写进问答历史，供列表区分与直显。 */
  source?: string
  usernameName?: string
  /** 当前知识库 id（见 Remote 接口上的说明）：知识库文件块参与本轮检索。 */
  kbId?: number
}): Promise<AskResult> {
  return unwrap(await remote().askWechat(options))
}

/**
 * Optimize a question for retrieval (rewrite + suggestions) via the configured LLM.
 * @param options - Question plus optional scope/history for context.
 * @returns AskOptimizeResult: optimized question + improvement suggestions.
 */
export async function apiOptimizeAskQuestion(options: {
  question: string
  username?: string
  from?: string
  to?: string
  history?: Array<{ role: 'user' | 'assistant'; content: string }>
}): Promise<AskOptimizeResult> {
  return unwrap(await remote().optimizeAskQuestion(options))
}

/** Group chat info (群聊信息) for the open chatroom. */
export async function apiSearchMembers(options: { q: string; limit?: number; roomUsername?: string }): Promise<MemberSearchSnapshot> {
  return unwrap(await remote().searchMembers(options))
}

export async function apiGetGroupInfo(username: string): Promise<GroupInfoSnapshot> {
  return cachedFetch('group:' + username, async () => unwrap(await remote().getGroupInfo({ username })))
}
/**
 * Fetch offline group insights for one chatroom.
 * @param username - chatroom username.
 * @returns GroupInsightsSnapshot.
 */
export async function apiGetGroupInsights(username: string): Promise<GroupInsightsSnapshot> {
  return unwrap(await remote().getGroupInsights({ username }))
}

/** Resolve a nested merged chat-log pointer by its server_id. */
export async function apiResolveChatHistory(serverId: string): Promise<ChatHistoryResolveResult> {
  return unwrap(await remote().resolveChatHistory({ serverId }))
}

/** Authoritative transfer/redpacket status by message server_id. */
export async function apiGetPaymentStatus(serverId: string): Promise<PaymentStatus> {
  return cachedFetch('pay:' + serverId, async () => unwrap(await remote().getPaymentStatus({ serverId })))
}
/**
 * Fetch per-day message counts for a month.
 * @param options - Query options: username, year, month.
 * @returns CalendarSnapshot.
 */
export async function apiGetDailyCounts(options: { username: string; year: number; month: number }): Promise<CalendarSnapshot> {
  return cachedFetch('daily:' + options.username + ':' + String(options.year) + '-' + String(options.month), async () => unwrap(await remote().getDailyCounts(options)))
}
/**
 * Resolve an image message to a data URL.
 * @param options - Query options: username and message localId.
 * @returns ImageDataUrlResult.
 */
export async function apiGetSnsImageDataUrl(options: { md5: string; timelineId?: string; mediaId?: string }): Promise<ImageDataUrlResult> {
  return unwrap(await remote().getSnsImageDataUrl(options))
}
/**
 * Resolve a file-library image (hardlink md5) to a data URL.
 * 优先读已解密缓存，否则定位 .dat 原图解密。
 * @param options - file md5.
 * @returns ImageDataUrlResult.
 */
export async function apiGetFileImageDataUrl(options: { md5: string }): Promise<ImageDataUrlResult> {
  return unwrap(await remote().getFileImageDataUrl(options))
}
/**
 * Resolve a custom emoticon (sticker) md5 to a data URL.
 * @param options - emoticon md5 from message XML.
 * @returns ImageDataUrlResult.
 */
export async function apiGetEmoticonDataUrl(options: { md5: string; emojiUrl?: string }): Promise<ImageDataUrlResult> {
  return cachedGet('emoticon:' + options.md5, async () => unwrap(await remote().getEmoticonDataUrl(options)))
}
/**
 * Resolve a moments video cover to a data URL (offline Sns/Video jpg).
 * @param options - media md5 / timeline id / media id.
 * @returns ImageDataUrlResult.
 */
export async function apiGetSnsVideoCoverDataUrl(options: {
  md5?: string
  timelineId?: string
  mediaId?: string
  /** XML 里的 `<thumb>`：本机没缓存时按需从 CDN 取回（后端会解密）。 */
  thumb?: string
  /** XML 里的 `<enc key>`：CDN 加密流的解密种子。 */
  key?: string
}): Promise<ImageDataUrlResult> {
  return unwrap(await remote().getSnsVideoCoverDataUrl(options))
}
/**
 * Resolve a moments video body to an offline data URL for inline playback.
 * @param options - media md5 / timeline id / media id.
 * @returns ImageDataUrlResult.
 */
export async function apiGetSnsVideoDataUrl(options: { md5?: string; timelineId?: string; mediaId?: string; url?: string; key?: string }): Promise<ImageDataUrlResult> {
  return unwrap(await remote().getSnsVideoDataUrl(options))
}

/**
 * 把一条朋友圈视频写到用户选定路径（本机缓存优先，否则 CDN 取回+解密，都在后端完成）。
 * @param options - 缓存键 / 远端地址与 `<enc key>` / 目标路径。
 * @returns ok + 字节数，或错误说明。
 */
export async function apiExportSnsVideo(options: {
  md5?: string; timelineId?: string; mediaId?: string; url?: string; key?: string; dest: string
}): Promise<{ ok: boolean; bytes?: number; source?: string; error?: string }> {
  return unwrap(await remote().exportSnsVideo(options))
}

/** 弹出保存对话框并返回选定路径（写盘由后端做）。 */
/**
 * 诊断日志信息（M6）：日志目录与各份轮转文件大小。
 * @returns 目录、当前文件与各份大小。
 */
export async function apiDiagLogInfo(): Promise<{
  ok: boolean; dir?: string; current?: string; files?: Array<{ name: string; size: number }>; error?: string
}> {
  const api = (window as unknown as { electronAPI?: { diag?: { logInfo?: () => Promise<{ ok: boolean; dir?: string; current?: string; files?: Array<{ name: string; size: number }>; error?: string }> } } }).electronAPI
  if (!api?.diag?.logInfo) return { ok: false, error: '当前环境不支持诊断日志' }
  return api.diag.logInfo()
}

/**
 * 导出诊断日志（主进程弹出保存对话框，并把所有轮转文件 + 环境信息拼成一个文件）。
 * @returns ok/path/bytes，或 canceled，或 error。
 */
export async function apiExportDiagLog(): Promise<{ ok: boolean; path?: string; bytes?: number; canceled?: boolean; error?: string }> {
  const api = (window as unknown as { electronAPI?: { diag?: { exportLog?: () => Promise<{ ok: boolean; path?: string; bytes?: number; canceled?: boolean; error?: string }> } } }).electronAPI
  if (!api?.diag?.exportLog) return { ok: false, error: '当前环境不支持导出诊断日志' }
  return api.diag.exportLog()
}

/**
 * 在文件管理器中定位日志文件。
 * @returns ok，或错误说明。
 */
export async function apiRevealDiagLog(): Promise<{ ok: boolean; path?: string; error?: string }> {
  const api = (window as unknown as { electronAPI?: { diag?: { revealLog?: () => Promise<{ ok: boolean; path?: string; error?: string }> } } }).electronAPI
  if (!api?.diag?.revealLog) return { ok: false, error: '当前环境不支持定位日志文件' }
  return api.diag.revealLog()
}

/** 弹出保存对话框并返回选定路径（写盘由后端做）。 */
export async function apiSaveFileDialog(opts: {
  defaultName?: string; title?: string; filters?: Array<{ name: string; extensions: string[] }>
}): Promise<{ canceled: boolean; path: string | null }> {
  const api = (window as unknown as { electronAPI?: { saveFileDialog?: (o: unknown) => Promise<{ canceled: boolean; path: string | null }> } }).electronAPI
  if (!api?.saveFileDialog) return { canceled: true, path: null }
  return api.saveFileDialog(opts)
}
/**
 * Resolve a 公众号 article cover (og:image) to a data URL.
 * @param options - mp.weixin.qq.com article URL.
 * @returns ImageDataUrlResult.
 */
export async function apiGetArticleCover(options: { contentUrl: string }): Promise<ImageDataUrlResult> {
  return unwrap(await remote().getArticleCover(options))
}
/**
 * Resolve a received message file (msg/file) to a data URL.
 *
 * `size` / `createTime` 来自消息本体（appmsg `<totallen>` 与 create_time）：
 * `msg/file` 只按月份分目录、同名文件可能属于别的会话，带上这两条线索
 * 才能在候选里挑出属于这条消息的那一份。
 * @param options - original file name plus attribution hints from the message.
 * @returns ImageDataUrlResult.
 */
export async function apiGetMessageFile(options: { fileName: string; size?: number; createTime?: number }): Promise<ImageDataUrlResult> {
  return unwrap(await remote().getMessageFile(options))
}

/** 一批取图里的分块上限（与后端 `IMAGE_BATCH_MAX` 对齐：超出的分多次发）。 */
const IMAGE_BATCH_CHUNK = 200

/** 把一个批量条目收敛成单张入口的形状（字段有则带、无则不带）。 */
function toImageResult(item: ImageDataUrlBatchItem | undefined): ImageDataUrlResult {
  if (!item) return { error: '批量取图未返回该条目' }
  return {
    ...(item.url ? { url: item.url } : {}),
    ...(item.format ? { format: item.format } : {}),
    ...(item.error ? { error: item.error } : {}),
  }
}

/**
 * 取图合并队列（N16）：合并语义在 `./image-batch.ts`，这里只把 `flush` 接到批量 RPC 上。
 *
 * 为什么合并发生在 api 层而不是各面板：列表型取图的面板（聊天的 `MessageThumb`、图片组
 * 网格）是「一屏挂 N 个组件、每个组件各自取图」，逐处改要动好几处调用点；它们全部经过
 * {@link apiGetImageDataUrl}，在这里攒批能让它们**一行都不用改**吃到批量入口。
 */
const imageLoadQueue = createImageLoadQueue<{ username: string; localId: number }, ImageDataUrlResult>({
  chunkSize: IMAGE_BATCH_CHUNK,
  onMissing: () => ({ error: '批量取图未返回该条目' }),
  flush: async (keys) => {
    const r = unwrap(await remote().getImageDataUrlsBatch({ items: keys.map(k => ({ username: k.username, localId: k.localId })) }))
    const got = Array.isArray(r?.items) ? r.items : []
    return got.map(toImageResult)
  },
})

/**
 * Decode one message image to a data URL.
 *
 * 语义与改前一致（一个请求拿一个 data URL），但**不再是单张 RPC**：同一次渲染提交内的
 * 多个请求会在一个微任务窗口里合并成一次 `getImageDataUrlsBatch`（见 {@link imageLoadQueue}）。
 * 单个请求（大图查看器那类）只多一个微任务延迟。
 * @param options - username and localId of the message image.
 * @returns ImageDataUrlResult.
 */
export function apiGetImageDataUrl(options: { username: string; localId: number }): Promise<ImageDataUrlResult> {
  return imageLoadQueue.enqueue({ username: options.username, localId: options.localId })
}

/**
 * 一次 RPC 解码一批消息图片（N16 的显式入口）。
 *
 * 面板需要「明确按批取图」时用它（例如已知要展示的一屏图片列表）；逐项取图的调用点走
 * {@link apiGetImageDataUrl} 即可 —— 那条路径同样会被合并成批量调用。
 * @param items - 一批 (username, localId)。
 * @returns 与传入顺序一一对应的条目。
 */
export async function apiGetImageDataUrlsBatch(items: Array<{ username: string; localId: number }>): Promise<ImageDataUrlBatchItem[]> {
  const r = unwrap(await remote().getImageDataUrlsBatch({ items }))
  return Array.isArray(r?.items) ? r.items : []
}

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
/**
 * Fetch the avatar for a username.
 * @param options - Query options: username.
 * @returns AvatarResult.
 */
export async function apiGetAvatar(options: { username: string; nickname?: string }): Promise<AvatarResult> {
  return unwrap(await remote().getAvatar(options))
}
/**
 * 批量读取本地头像(head_image.db,单次请求,纯本地)。
 * @param options - usernames 列表。
 * @returns username → data URL。
 */
export async function apiGetAvatarsLocal(options: { usernames: string[] }): Promise<Record<string, string>> {
  return unwrap(await remote().getAvatarsLocal(options))
}
/**
 * Fetch the full WeChat config (including keys-related settings).
 * @returns WechatConfigFull.
 */
export async function apiGetWechatConfigFull(): Promise<WechatConfigFull> {
  return unwrap(await remote().getWechatConfigFull())
}
/**
 * Save a WeChat config patch.
 * @param options - Mutation options: the config patch.
 * @returns SimpleResult.
 */

/** Open the owned WeChat config.json (e.g. for manual edit). @returns the opened path. */
/** Open an owned path (dir/file) with the system default. @returns the opened path. */
export async function apiOpenPath(path: string): Promise<{ ok: boolean; path: string }> {
  return unwrap(await remote().openPath({ path }))
}
export async function apiOpenConfig(): Promise<{ ok: boolean; path: string }> {
  return unwrap(await remote().openConfig())
}
/** 路径配置中心 wechat/config.json 的绝对路径（用于“点击打开”）。 */
export async function apiGetWechatPathConfig(): Promise<string> {
  try {
    const api = (window as any)?.electronAPI?.wechat
    if (!api?.info) return ''
    const res = await api.info()
    return res?.ok ? (res.value?.pathConfig ?? '') : ''
  } catch {
    return ''
  }
}

/**
 * AI 大模型配置（当前配置 + 已保存的配置集）：实现住在 `./llm-config.ts`。
 *
 * 搬出去的两个原因：① 它们走的是主进程 IPC 而不是 `ctx.remote.wechatData.*`，
 * 与缓存层一样属于「另一个领域」；② 本文件有 < 2010 行的预算守卫（`api-module-split.spec.ts`）。
 * 这里继续转发，使既有调用方（AiModelConfig / Ask / DailySummary / PeriodSummary）
 * 的 `from '../api.ts'` 一行都不用改 —— 与 cache.ts 的拆分口径一致。
 */
export {
  apiGetLlmConfig,
  apiSaveLlmConfig,
  apiFetchLlmModels,
  apiGetLlmProfiles,
  apiActivateLlmProfile,
  apiSaveLlmProfile,
  apiDeleteLlmProfile,
} from './llm-config.ts'
export type { WechatLlmConfig, WechatLlmProfile, LlmProfilesSnapshot, LlmModelsResult } from './llm-config.ts'
// ─────────────────────────────────────────────────────────────
// RAG 检索层：状态 / 调参 / 向量索引 / 评估 / 反馈闭环
// ─────────────────────────────────────────────────────────────

/** 检索配置（与后端 RetrievalConfig 对齐；只声明前端面板用到的字段）。 */
export interface RetrievalConfigShape {
  enabled: boolean
  embedding: { enabled: boolean; model: string; batchSize: number; maxDocsPerBuild: number; maxCharsPerDoc: number }
  channels: {
    sparse: { enabled: boolean; topK: number }
    dense: { enabled: boolean; topK: number; minSimilarity: number; candidatePool: number }
    structured: { enabled: boolean; topK: number }
  }
  fusion: { k: number; keep: number }
  rerank: { weights: Record<string, number>; minScore: number }
  compress: { maxChars: number; maxChunks: number; linesPerChunk: number; dedupThreshold: number }
  intent: { llmAssist: boolean }
  feedback: { enabled: boolean; learningRate: number; maxRecords: number }
}

/** 检索层综合状态。 */
export interface RetrievalStatus {
  enabled: boolean
  config: RetrievalConfigShape
  vector: { rows: number; dim: number; model: string }
  feedback: { total: number; up: number; down: number }
  weights: Record<string, number>
  intentAccuracy: { correct: number; total: number; accuracy: number }
}

/** 向量索引构建结果。 */
export interface VectorBuildResult {
  ok: boolean
  status: string
  rows: number
  embedded: number
  elapsed_ms: number
  message?: string
}

/** 一条历史反馈。 */
export interface RetrievalFeedbackItem {
  id: string
  question: string
  answer: string
  rating: 'up' | 'down'
  citedUseful: number[]
  citedUseless: number[]
  intent: string
  features: string[]
  createdAt: number
}

/** 评估报告（合成评测集 + 混合/稀疏消融）。 */
export interface RetrievalEvalResult {
  report: string
  hybrid: { precision: number; recall: number; mrr: number; ndcg: number; map: number; cases: number; hits: number }
  sparseOnly: { precision: number; recall: number; mrr: number; ndcg: number; map: number; cases: number; hits: number }
  intentAccuracy: { correct: number; total: number; accuracy: number }
}

/**
 * 检索层的诊断/运维接口镜像（配置 + 向量库 + 反馈 + 权重 + 意图自评）。
 *
 * ⚠️ **界面已不再暴露任何检索参数**：`RetrievalPanel` 面板已下线，阈值 / 权重 / 容量 /
 * 通道开关一律固化为产品默认值（后端 `query/retrieval/config.ts`），稠密向量索引在
 * 首次提问时由网关自动增量构建。本组 `api*Retrieval*` 包装只为与后端 Remote 对齐
 * （诊断用 / 将来说不定有高级模式），**不要接线到界面** ——
 * `scripts/ui-ask-smoke.tsx` 里有对应的源码级回归闸门。
 */
export async function apiGetRetrievalStatus(): Promise<RetrievalStatus> {
  return unwrap(await remote().getRetrievalStatus())
}

/** 保存检索配置（只传要改的字段）。界面已不再暴露该入口，仅供诊断/测试使用。 */
export async function apiSaveRetrievalConfig(patch: unknown): Promise<void> {
  unwrap(await remote().saveRetrievalConfig({ patch }))
}

/** 立即构建/重建稠密向量索引。 */
export async function apiBuildRagVectorIndex(force = false): Promise<VectorBuildResult> {
  return unwrap(await remote().buildRagVectorIndex({ force }))
}

/** 提交问答反馈（赞/踩 + 有用/无用引用），后端据此微调检索权重。 */
export async function apiSubmitAskFeedback(options: {
  retrievalId?: string
  rating: 'up' | 'down'
  useful?: number[]
  useless?: number[]
  question?: string
  answer?: string
}): Promise<{ ok: boolean; adaptedWeights?: Record<string, number>; features?: string[]; message?: string }> {
  return unwrap(await remote().submitAskFeedback(options))
}

/** 历史反馈列表。 */
export async function apiListRetrievalFeedback(limit = 50): Promise<{ items: RetrievalFeedbackItem[]; stats: { total: number; up: number; down: number } }> {
  return unwrap(await remote().listRetrievalFeedback({ limit }))
}

/** 丢弃反馈带来的权重偏移，回默认值。 */
export async function apiResetRetrievalWeights(): Promise<{ ok: boolean; weights: Record<string, number> }> {
  return unwrap(await remote().resetRetrievalWeights())
}

/** 跑离线召回评估（合成评测集），返回混合 vs 纯稀疏的对比。 */
export async function apiEvaluateRetrieval(k = 10): Promise<RetrievalEvalResult> {
  return unwrap(await remote().evaluateRetrieval({ k }))
}

export async function apiSaveWechatConfig(options: { patch: WechatConfigPatch }): Promise<SimpleResult> {
  return unwrap(await remote().saveWechatConfig(options))
}
/**
 * Detect locally installed WeChat accounts.
 * @returns AccountsSnapshot.
 */
export async function apiDetectWechatAccounts(): Promise<AccountsSnapshot> {
  return unwrap(await remote().detectWechatAccounts())
}
/**
 * Auto-recover the V4 database key from the running WeChat process.
 * @param options - optional probe db path and install dir.
 * @returns AutoDbKeyResult: ok + 64-hex key, or an error.
 */
export async function apiAutoGetDbKey(options: { dbPath?: string; wechatInstallDir?: string } = {}): Promise<AutoDbKeyResult> {
  return unwrap(await remote().autoGetDbKey(options))
}
/**
 * Auto-recover the image key from the running WeChat process (V2-verified).
 * @param options - account dir (wxid_* folder) and optional pid.
 * @returns AutoImageKeyResult: ok + xor/aes pair, or an error.
 */
export async function apiAutoGetImageKey(options: { accountDir?: string; pid?: number } = {}): Promise<AutoImageKeyResult> {
  return unwrap(await remote().autoGetImageKey(options))
}
/**
 * Verify a decrypted database key against a database file.
 * @param options - Mutation options: dbPath and encKeyHex.
 * @returns VerifyKeyResult.
 */
export async function apiVerifyDatabaseKey(options: { dbPath: string; encKeyHex: string }): Promise<VerifyKeyResult> {
  return unwrap(await remote().verifyDatabaseKey(options))
}
/**
 * Generate a keys file from the given encrypted key.
 * @param options - Mutation options: dbDir, keysFile, encKeyHex, optional keyFormat.
 * @returns GenerateKeysResult.
 */
export async function apiGenerateKeysFile(options: {
  dbDir: string
  keysFile: string
  encKeyHex: string
  keyFormat?: string
}): Promise<GenerateKeysResult> {
  return unwrap(await remote().generateKeysFile(options))
}
/**
 * Fetch information about loaded WeChat keys.
 * @returns KeysInfoResult.
 */
export async function apiGetWechatKeysInfo(): Promise<KeysInfoResult> {
  return unwrap(await remote().getWechatKeysInfo())
}
/**
 * Verify the saved image key pair against real V2 templates.
 * @returns VerifyImageKeyResult: verified flag + xor/template evidence.
 */
export async function apiVerifyImageKey(): Promise<VerifyImageKeyResult> {
  return unwrap(await remote().verifyImageKey())
}
/**
 * Full SQLCipher decryption of every db under db_storage.
 * @returns DecryptAllResult: total/ok/failed counts.
 */
export async function apiDecryptAllDatabases(): Promise<DecryptAllResult> {
  return unwrap(await remote().decryptAllDatabases())
}
/**
 * Batch-decode every md5-prefixed .dat image into the decoded-images cache.
 * @param options - optional worker concurrency.
 * @returns DecryptImagesResult: total/ok/failed/skipped counts.
 */
export async function apiDecryptAllImages(options?: { concurrency?: number }): Promise<DecryptImagesResult> {
  return unwrap(await remote().decryptAllImages(options))
}
/**
 * Read the live decryption progress snapshot.
 * @returns DecryptStatus: op/done/total/failed/skipped + current item.
 */
export async function apiGetDecryptStatus(): Promise<DecryptStatus> {
  return unwrap(await remote().getDecryptStatus())
}
/**
 * Read Whisper transcription configuration status.
 * @returns WhisperStatus: engine detection, CUDA presence, model inventory.
 */
export async function apiGetWhisperStatus(): Promise<WhisperStatus> {
  return unwrap(await remote().getWhisperStatus())
}
/**
 * Download one official whisper.cpp ggml model into the models dir.
 * @param options - model id to download.
 * @returns WhisperDownloadResult: ok + file/bytes, or an error.
 */
export async function apiDownloadWhisperModel(options: { model: string }): Promise<WhisperDownloadResult> {
  return unwrap(await remote().downloadWhisperModel(options))
}
/**
 * Download + install the whisper.cpp CLI engine into the models dir.
 * @returns WhisperDownloadResult: ok + path, or an error.
 */
export async function apiInstallWhisperEngine(): Promise<WhisperDownloadResult> {
  return unwrap(await remote().installWhisperEngine())
}
/**
 * Batch-transcribe the most recent voice messages (silk → whisper-cli).
 * @param options - optional message count.
 * @returns VoiceTranscribeResult: done/failed/skipped counts.
 */
export async function apiTranscribeVoiceBatch(options?: { limit?: number }): Promise<VoiceTranscribeResult> {
  return unwrap(await remote().transcribeVoiceBatch(options))
}
/**
 * Cached transcript for one voice message.
 * @param options - username + local_id.
 * @returns VoiceTranscriptResult.
 */
export async function apiGetVoiceTranscript(options: { username: string; localId: number }): Promise<VoiceTranscriptResult> {
  return unwrap(await remote().getVoiceTranscript(options))
}
/**
 * Transcribe one voice message on demand (chat bubble 语音转文字).
 * @param options - username + local_id.
 * @returns VoiceTranscribeOneResult: ok + text, or error.
 */
export async function apiTranscribeVoiceMessage(options: { username: string; localId: number }): Promise<VoiceTranscribeOneResult> {
  return unwrap(await remote().transcribeVoiceMessage(options))
}
/**
 * Enable or disable CDN image handling.
 * @param options - Mutation options: enabled flag.
 * @returns SimpleResult.
 */
export async function apiSetCdnImageEnabled(options: { enabled: boolean }): Promise<SimpleResult> {
  return unwrap(await remote().setCdnImageEnabled(options))
}
/**
 * Enable or disable local decryption of CDN images.
 * @param options - Mutation options: localDecrypt flag.
 * @returns SimpleResult.
 */
export async function apiSetCdnImageLocalDecrypt(options: { localDecrypt: boolean }): Promise<SimpleResult> {
  return unwrap(await remote().setCdnImageLocalDecrypt(options))
}
/**
 * Delete favorite items by ids.
 * @param options - Mutation options: favorite item ids.
 * @returns DeleteFavoriteResult.
 */
export async function apiDeleteFavoriteItems(options: { ids: number[] }): Promise<DeleteFavoriteResult> {
  const r = await remote().deleteFavoriteItems(options)
  invalidateWechatCache('favorites')
  return unwrap(r)
}
/**
 * Fetch the annual report for a year.
 * @param options - Query options: the report year.
 * @returns AnnualReport.
 */
export async function apiGetAnnualReport(options: { year: number }): Promise<AnnualReport> {
  return unwrap(await remote().getAnnualReport(options))
}

// ─────────────────────────────────────────────────────────────
// 年度回顾（看板）：15 张卡片所需的完整年度聚合
// 形状与后端 query/annual-review.ts 的 AnnualReview 对齐。
// 前端在此独立声明（不依赖 lib/types 里那份上游生成的 .d.ts，它没有这个名字）。
// ─────────────────────────────────────────────────────────────

/** 榜单条目。 */
export interface AnnualRankRow { username: string; name: string; total: number; mine: number; theirs: number }
/** 最疯的一天。 */
export interface AnnualBusiestDay {
  date: string; n: number; ratio: number; share: number
  topName: string; topCount: number; firstAt: string; firstText: string; lastAt: string; lastText: string; spanMin: number
}
/** 年度搭子。 */
export interface AnnualBuddy {
  username: string; name: string; total: number; mine: number; theirs: number
  streakDays: number; commonHour: number; replyBacks: number; fastestSec: number; slowestSec: number
}
/** 十二个月的主演。 */
export interface AnnualMonthlyStar { month: number; username: string; name: string; count: number }
/** 深夜卡。 */
export interface AnnualNight {
  share: number; mine: number; theirs: number; topName: string; topCount: number; sampleAt: string; sampleText: string
}
/** 作息切片。 */
export interface AnnualRhythm {
  heat: number[]; brightestDow: number; brightestHour: number; brightestCount: number
  quietestHour: number; quietestCount: number; nightShare: number; workWeekendRatio: number
}
/** 你说的话。 */
export interface AnnualWords {
  mineChars: number; receivedChars: number; keystrokes: number
  voiceSentCount: number; voiceSentSec: number; voiceRecvCount: number; voiceRecvSec: number
  callSec: number; callCount: number; callConnected: number; callMissed: number
  videoSent: number; voiceMsgSent: number; longestVoiceSec: number; longestVoiceFrom: string
}
/** 年度口头禅。 */
export interface AnnualCatchphrase {
  phrase: string; count: number; top: Array<{ phrase: string; count: number }>; shortTotal: number; catchTotal: number
}
/** 回复速度。 */
export interface AnnualReply {
  medianSec: number; p90Sec: number
  avgPartnerName: string; avgPartnerSec: number
  fastestName: string; fastestSec: number; slowestName: string; slowestSec: number
}
/** 谁先开口。 */
export interface AnnualOpener {
  mine: number; theirs: number; share: number
  mostInitiatedByMe: Array<{ name: string; count: number }>
  mostInitiatedByThem: Array<{ name: string; count: number }>
}
/** 表情宇宙。 */
export interface AnnualEmoji {
  threw: number; kept: number; perDay: number; days: number
  peakDow: number; peakHour: number; peakCount: number
  top: Array<{ emoji: string; count: number }>
}
/** 「还有这些人」。`username` 用于点头像/跳会话（后端 annual-review.ts 一直在发，这里漏了）。 */
export interface AnnualHighlight { label: string; name: string; username: string; value: string }

/** 年度回顾完整结果。 */
export interface AnnualReviewShape {
  year: number
  sent: number; sentTo: number; sentDailyAvg: number; activeDaysMine: number
  longestStreak: number; newFriends: number; mediaSent: number
  longestSpanFrom: string; longestSpanTo: string
  calendar: Array<{ d: string; n: number }>; activeDaysAll: number; maxDayAll: number
  busiest: AnnualBusiestDay | null
  buddy: AnnualBuddy | null
  monthlyStar: AnnualMonthlyStar[]
  starName: string; starUsername: string; starMonths: number; hottestMonth: number; hottestMonthCount: number
  night: AnnualNight
  rhythm: AnnualRhythm
  words: AnnualWords
  catchphrase: AnnualCatchphrase
  reply: AnnualReply
  opener: AnnualOpener
  ranking: AnnualRankRow[]
  emoji: AnnualEmoji
  highlights: AnnualHighlight[]
  firstAt: string; firstText: string; lastAt: string; lastText: string
}

/**
 * 取某年的完整年度回顾（首次扫描较慢：要逐条读该年消息以计算序列类指标）。
 * @param year - 自然年。
 * @returns 年度回顾看板数据。
 */
export async function apiGetAnnualReview(year: number): Promise<AnnualReviewShape> {
  return unwrap(await remote().getAnnualReview({ year }))
}

// ── Remote gateway readiness status ──
/**
 * Remote gateway readiness status: unknown before the first probe, online/offline after.
 */
export type ApiStatus = 'unknown' | 'online' | 'offline'
let _status: ApiStatus = 'unknown'
const _listeners = new Set<() => void>()
/**
 * Return the current Remote gateway readiness status.
 * @returns ApiStatus ('unknown' | 'online' | 'offline').
 */
export function getApiStatus(): ApiStatus { return _status }
/**
 * Subscribe to Remote gateway status changes.
 * @param fn - Callback invoked when the status changes.
 * @returns An unsubscribe function that removes the listener.
 */
export function subscribeApiStatus(fn: () => void): () => void {
  _listeners.add(fn)
  return () => { _listeners.delete(fn) }
}
function setApiStatus(s: ApiStatus): void {
  if (_status === s) return
  _status = s
  for (const fn of _listeners) { try { fn() } catch { /* ignore */ } }
}

/**
 * Probe the WeChat Remote gateway (local decrypted data ready).
 * @returns true when the gateway responds to a minimal getSessions probe, false otherwise.
 */
export async function checkApiHealth(): Promise<boolean> {
  try {
    await remote().getSessions({ limit: 1 })
    setApiStatus('online')
    return true
  } catch {
    setApiStatus('offline')
    return false
  }
}


