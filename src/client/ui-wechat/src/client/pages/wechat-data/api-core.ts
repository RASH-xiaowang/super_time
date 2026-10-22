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
  ThreadState,
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
  ChatCollectTaskResult,
  ChatCollectTaskSnapshot,
  ChatHistoryResolveResult,
  ClawbotBindQr,
  ClawbotBindStateSnapshot,
  ClawbotBindingSnapshot,
  ClawbotEnvSnapshot,
  ClawbotInstanceConfig,
  ClawbotInstanceCreated,
  ClawbotInstanceDeleted,
  ClawbotInstancesSnapshot,
  ClawbotMediaResult,
  ClawbotMessageQuery,
  ClawbotMessageSnapshot,
  ClawbotSendResult,
  ConfigSnapshot,
  Contact360Snapshot,
  ContactsSnapshot,
  DailySummaryResult,
  AnnualNarrativeResult,
  DbHealthSnapshot,
  DbIntegrityResult,
  DbRepairResult,
  DbStatusSnapshot,
  DataRevision,
  DecryptAllResult,
  DecryptImagesResult,
  DecryptStatus,
  ImageUpgradeResult,
  OriginalBatchResult,
  OriginalFetchPlan,
  HarvestResult,
  HarvestStatus,
  WxcdnQuota,
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
  FileImageDataUrlsResult,
  SelfProfile,
  ImageDataUrlResult,
  KeysInfoResult,
  LedgerSnapshot,
  MapGeoJsonResult,
  MediaAssetsSnapshot,
  MemberSearchSnapshot,
  MessagesSnapshot,
  MomentsInsightsSnapshot,
  MomentsMonthlyRow, MomentsMonthlySnapshot,
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
  RerankWeights,
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
  SummaryTaskInput,
  SummaryTaskMutationResult,
  SummaryTaskRunResult,
  SummaryTaskSnapshot,
  TaskMutationResult,
  TasksSnapshot,
  UnifiedSearchSnapshot,
  VerifyImageKeyResult,
  VerifyKeyResult,
  VideoInfoResult,
  VoiceDataUrlResult,
  VoiceInfoResult,
  VoiceTranscriptResult,
  VoiceTranscribeOneResult,
  VoiceTranscribeResult,
  WechatConfigFull,
  WechatConfigPatch,
  WechatImageAutoDownloadStatus,
  WhisperDownloadResult,
  WhisperStatus,
  LayaAnalysisView,
  LayaDownloadOutcome,
  LayaStatus,
  LayaVisibleAnalysisResult,
} from '@deepseek-ai/dsh-wechat-data/types'
// 任务信息 / 触发记录（2026-10-19）：类型单一真源在后端 `types-taskcenter.ts`，
// 这里只转发，不在前端镜像字段。单独一条 import 而不是塞进上面那一大坨，
// 是为了让「这一域新增了什么类型」在 diff 里一眼可见。
import type {
  RpaVendorCatalog,
  TaskCallbackDispatchResult,
  TaskInfoInput,
  TaskInfoMutationResult,
  TaskBatchMutationResult,
  TaskInfoSnapshot,
  TaskInfoStatus,
  TaskTriggerQuery,
  TaskTriggerScanResult,
  TaskTriggerSecretRevealResult,
  TaskTriggerSnapshot,
} from '@deepseek-ai/dsh-wechat-data/types'
import {
  SNAPSHOT_REFRESHED_EVENT,
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
// 这两个方向**只是类型**：写成 `import type` 之后编译期就擦掉，不再构成运行期依赖
// （`api-config`/`api-status` 反过来要 `remote`/`unwrap` 是真值边，方向是单向的）。
// 不标的话 `module-cycle-guard.spec.ts` 会把整组 api-* 读成一个 4 文件环。
import type { RetrievalConfigPatch, RetrievalConfigShape, RetrievalEvalResult, RetrievalFeedbackItem, RetrievalStatus, VectorBuildResult } from './api-config.ts'
import type { AnnualReviewShape } from './api-status.ts'

// M21：缓存层已拆到 ./cache.ts 与 ./media-cache.ts（纯搬移）。这里继续转发，
// 使 40 多个面板的 `from './api.ts'` 一行都不用改。
// 注意：`export … from` **不会**把名字带进本模块作用域，而下面这些函数在 api.ts 内部
// 也会被调用（各种失效/写缓存路径），所以既要 import（供内部用）又要 export from（供外部用）。
export {
  SNAPSHOT_REFRESHED_EVENT,
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
  /** true = 缩略/中图（与单张入口的 `ImageDataUrlResult.thumb` 同义）。预取写缓存要用它。 */
  thumb?: boolean
  /** 相对 decoded_images 的落盘路径；有它就转 wechat-media://（见 wechat-media.ts）。 */
  file?: string
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
  getContacts(options?: { limit?: number; offset?: number; category?: string }): Promise<RemoteResult<ContactsSnapshot>>
  getContact360(options: { username: string }): Promise<RemoteResult<Contact360Snapshot>>
  getMessages(options: { talker: string; limit?: number; cursor?: number; cursorLocalId?: number }): Promise<RemoteResult<MessagesSnapshot>>
  getNewMessages(options: { talker: string; after: number; limit?: number }): Promise<RemoteResult<MessagesSnapshot>>
  /** 新建聊天素材收集任务（保留会话最近 N 条文本 + M 张图片）。 */
  createChatCollectTask(options: { username: string; displayName?: string; textLimit?: number; imageLimit?: number }): Promise<RemoteResult<ChatCollectTaskResult>>
  /** 收集任务列表（最新在前）。 */
  listChatCollectTasks(): Promise<RemoteResult<ChatCollectTaskSnapshot>>
  /** 任务信息列表（最新在前；readError 与「确实没有任务」区分）。 */
  listTaskInfos(): Promise<RemoteResult<TaskInfoSnapshot>>
  /** 触发方式目录（内置 webhook + 已注册 RPA 厂商描述符；编辑抽屉据此渲染选择器与动态表单）。 */
  listRpaVendors(): Promise<RemoteResult<RpaVendorCatalog>>
  /**
   * 按需回读本机已保存的任务凭据原文（编辑抽屉「眼睛」用；桌面端本机通道专属）。
   *
   * 语义与其它 Remote 不同：结果对象自带 `ok`，不套 `RemoteResult` 信封；
   * 手机/浏览器远程通道已在后端 LOCAL_ONLY 拒绝。凭据原文不写日志、不进列表快照。
   */
  revealTaskTriggerSecret(options: { id: number }): Promise<RemoteResult<TaskTriggerSecretRevealResult>>
  /** 新建 / 更新任务信息（id 缺省 = 新建；新建默认「待完善」）。 */
  saveTaskInfo(options: TaskInfoInput): Promise<RemoteResult<TaskInfoMutationResult>>
  /** 删除任务信息（触发记录保留）。 */
  deleteTaskInfo(options: { id: number }): Promise<RemoteResult<TaskInfoMutationResult>>
  /** 批量删除任务信息（触发记录保留）。 */
  deleteTaskInfos(options: { ids: number[] }): Promise<RemoteResult<TaskBatchMutationResult>>
  /** 批量删除任务触发记录（后端重算任务统计）。 */
  deleteTaskTriggers(options: { ids: number[] }): Promise<RemoteResult<TaskBatchMutationResult>>
  /** 标记「待完善 / 已完善」——已完善才参与触发与回调投递。 */
  setTaskInfoStatus(options: { id: number; status: TaskInfoStatus }): Promise<RemoteResult<TaskInfoMutationResult>>
  /** 任务触发记录（可按任务过滤；最新在前）。 */
  listTaskTriggers(options?: TaskTriggerQuery): Promise<RemoteResult<TaskTriggerSnapshot>>
  /** 立即按关键词扫描一次新消息并生成触发记录（常驻扫描另在网关定时器里）。 */
  scanTaskTriggers(): Promise<RemoteResult<TaskTriggerScanResult>>
  /** 手动重投一条触发记录的回调。 */
  dispatchTaskCallback(options: { triggerId: number }): Promise<RemoteResult<TaskCallbackDispatchResult>>
  getMoments(options?: { offset?: number; limit?: number; author?: string }): Promise<RemoteResult<MomentsSnapshot>>
  getSelfUsername(): Promise<RemoteResult<{ username: string }>>
  /**
   * 当前账号的展示信息（备注 > 昵称 > 微信号），侧栏品牌位显示用户网名用。
   * 未解密/取不到时 name 为空串（界面回退品牌名）。
   */
  getSelfProfile(): Promise<RemoteResult<SelfProfile>>
  getMomentsAuthors(): Promise<RemoteResult<Array<{ name: string; count: number }>>>
  getMomentsInsights(options?: { author?: string }): Promise<RemoteResult<MomentsInsightsSnapshot>>
  getMomentsMonthly(options?: { author?: string; authorName?: string }): Promise<RemoteResult<MomentsMonthlySnapshot>>
  getWordCloud(options?: { scope?: 'global' | 'chat' | 'moments'; username?: string; year?: number; limit?: number }): Promise<RemoteResult<{ words: Array<{ text: string; count: number }>; scanned: number; canceled?: boolean }>>
  analyzeMessages(options: { talker: string; contextLimit?: number }): Promise<RemoteResult<LayaAnalysisView>>
  analyzeVisibleMessages(options: { talker: string; targets: Array<{ localId: number; sortSeq: number }>; jobId?: string }): Promise<RemoteResult<LayaVisibleAnalysisResult>>
  getLayaStatus(): Promise<RemoteResult<LayaStatus>>
  downloadLayaModel(options?: { jobId?: string }): Promise<RemoteResult<LayaDownloadOutcome>>
  cancelLayaDownload(options: { jobId: string }): Promise<RemoteResult<{ ok: boolean; message?: string }>>
  adoptLayaModel(options: { sourceDir: string }): Promise<RemoteResult<LayaStatus>>
  unloadLaya(): Promise<RemoteResult<{ ok: boolean }>>
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
  setPrivacyState(options: { redactSensitive?: boolean }): Promise<RemoteResult<PrivacyStateSnapshot>>
  getPrivacyAuditRows(): Promise<RemoteResult<PrivacyAuditRow[]>>
  clearPrivacyAudit(): Promise<RemoteResult<PrivacyAuditClearResult>>
  getOperationLog(options?: OperationLogQuery): Promise<RemoteResult<OperationLogSnapshot>>
  clearOperationLog(): Promise<RemoteResult<OperationLogClearResult>>
  // ── 微信 ClawBot 集成（多实例，2026-10-13；iLink 通道 2026-10-12 接入，可发可收）──
  // Super Time 自己就是被绑定的桌面端宿主；**一个微信号 = 一个实例**，可同时管几个。
  // 实例管理与行为配置（自动回复 / 知识库）只读写下本机 `clawbot.db`，**不出网**；
  // 会出网的仍是绑定与会话那几条，中继在 `query/clawbot/clawbot-ilink.ts`（取码 / 状态轮询 / 发送），
  // 媒体按需取数在 `query/clawbot/clawbot-media.ts`；每实例一条接收通道，随网关常驻。
  listClawbotInstances(): Promise<RemoteResult<ClawbotInstancesSnapshot>>
  createClawbotInstance(): Promise<RemoteResult<ClawbotInstanceCreated>>
  deleteClawbotInstance(options: { slot: number }): Promise<RemoteResult<ClawbotInstanceDeleted>>
  setClawbotInstanceConfig(options: { slot: number, autoReply?: boolean, kbEnabled?: boolean, kbId?: number | null, systemPrompt?: string, splitReply?: boolean }): Promise<RemoteResult<ClawbotInstanceConfig>>
  renameClawbotInstance(options: { slot: number, label: string }): Promise<RemoteResult<ClawbotBindingSnapshot>>
  getClawbotBinding(options?: { slot?: number }): Promise<RemoteResult<ClawbotBindingSnapshot>>
  createClawbotBindQr(options?: { slot?: number }): Promise<RemoteResult<ClawbotBindQr>>
  getClawbotBindState(options?: { slot?: number }): Promise<RemoteResult<ClawbotBindStateSnapshot>>
  unbindClawbot(options?: { slot?: number }): Promise<RemoteResult<ClawbotBindingSnapshot>>
  listClawbotMessages(options?: ClawbotMessageQuery): Promise<RemoteResult<ClawbotMessageSnapshot>>
  clearClawbotMessages(options?: { slot?: number }): Promise<RemoteResult<{ removed: number, messages: ClawbotMessageSnapshot }>>
  getClawbotDefaultPrompt(): Promise<RemoteResult<{ prompt: string }>>
  checkClawbotEnv(options?: { slot?: number }): Promise<RemoteResult<ClawbotEnvSnapshot>>
  sendClawbotMessage(options: { text: string, slot?: number }): Promise<RemoteResult<ClawbotSendResult>>
  getClawbotMedia(options: { id: number }): Promise<RemoteResult<ClawbotMediaResult>>
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
    sourceKind?: 'manual' | 'ask' | 'file'
    sourceUsername?: string
    sourceQuestion?: string
    /** 来源文件 id（`sourceKind === 'file'` 时才有）。 */
    sourceFileId?: number
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
  buildKbVectorIndex(options: { kbId: number; force?: boolean; jobId?: string }): Promise<RemoteResult<KbVectorBuildResult>>
  /**
   * 停止本库正在跑的向量构建（W3-11.5）。
   * @param options - jobId（必填，即 `buildKbVectorIndex` 那次的同一标识）。
   * @returns ok + 停不上的原因（该批已算完 / 标识不认识）。
   */
  cancelKbIndexBuild(options: { jobId: string }): Promise<RemoteResult<{ ok: boolean; message?: string }>>
  getKbModelConfig(options: { kbId: number }): Promise<RemoteResult<KbModelConfigView>>
  setKbModelConfig(options: { kbId: number; chatRef?: string; embedRef?: string; rerankRef?: string }): Promise<RemoteResult<KbModelConfigResult>>
  extractKbEntities(options: { kbId: number; fileIds?: number[]; limit?: number }): Promise<RemoteResult<KbExtractResult>>
  suggestKbLinks(options: { kbId: number; text?: string; topK?: number; excludeTitle?: string }): Promise<RemoteResult<KbLinkSuggestResult>>
  getSearchIndexStatus(): Promise<RemoteResult<SearchIndexStatus>>
  buildSearchIndex(options?: { force?: boolean; jobId?: string }): Promise<RemoteResult<SearchBuildResult>>
  searchMessages(options: { query: string; limit?: number; username?: string; jobId?: string }): Promise<RemoteResult<SearchSnapshot>>
  cancelSearch(options?: { jobId?: string }): Promise<RemoteResult<{ ok: boolean }>>
  searchUnified(options: { query: string; limit?: number }): Promise<RemoteResult<UnifiedSearchSnapshot>>
  suggestReplies(options: { username?: string; kbId?: number; count?: number }): Promise<RemoteResult<ReplySuggestResult>>
  askWechat(options: {
    question: string
    username?: string
    from?: string
    to?: string
    history?: Array<{ role: 'user' | 'assistant'; content: string }>
    /** 流式标识：带上它后端会推送 wechat-ask/delta 增量事件。 */
    streamId?: string
    /** 入口来源（'ask' / 'session' / 'auto'，后者 = ClawBot 自动回复）与会话显示名：写进问答历史，供列表区分与直显。 */
    source?: string
    usernameName?: string
    /**
     * 当前知识库 id：本次提问把该库的**文件块**一并纳入检索（与消息命中同编号）。
     *
     * 不传 = 不检索知识库，而不是「搜所有库」—— `kbId` 是作用域，没有「全部库」这一档；
     * 漏传应当表现为「没检索到文件」，而不是把别的库的内容也端上来。
     */
    kbId?: number
    /**
     * 取消标识（W3-6.1）：与 `streamId` 取同一个值。带上它，「停止生成」才有地方使力 ——
     * 面板拿这个 id 调 `cancelAsk`，后端的 AbortController 就在这一轮上。
     * 不传 = 这一轮不可取消（旧客户端行为，与改动前一致）。
     */
    jobId?: string
    /** 随问题送模型的图片（2026-10-18，ClawBot 自动回复的「识别图中内容」；手动问答不传）。 */
    images?: Array<{ data: string; mediaType: string; name?: string }>
    /** 上一轮返回的结构化线程状态；用于跨请求继承会话、联系人与时间窗。 */
    threadState?: ThreadState
  }): Promise<RemoteResult<AskResult>>
  /** 取消一轮正在生成的问答（W3-6.1）。找不到在跑的那一轮时 ok=false + message。 */
  cancelAsk(options: { jobId: string }): Promise<RemoteResult<{ ok: boolean; message?: string }>>
  /**
   * 停止一批正在跑的逐条本地分析（W3-11.5）。
   * @param options - jobId = `analyzeVisibleMessages` 那批的同一标识。
   * @returns ok + 停不上的原因（该批已算完 / 标识不认识）。
   */
  cancelLayaAnalysis(options: { jobId: string }): Promise<RemoteResult<{ ok: boolean; message?: string }>>
  /**
   * 停止一次正在跑的搜索索引构建（W3-11.5）。
   *
   * 取消只在**分片边界**与分片内的让出点生效；被取消的构建会 ROLLBACK，
   * 所以旧索引原封不动（不是「留半份索引」）。
   * @param options - jobId（必填，即 `buildSearchIndex` 那次的同一标识）。
   * @returns ok + 停不上的原因（构建已结束 / 标识不认识）。
   */
  cancelSearchIndexBuild(options: { jobId: string }): Promise<RemoteResult<{ ok: boolean; message?: string }>>
  optimizeAskQuestion(options: {
    question: string
    username?: string
    from?: string
    to?: string
    history?: Array<{ role: 'user' | 'assistant'; content: string }>
  }): Promise<RemoteResult<AskOptimizeResult>>
  // ── RAG 检索层（意图路由 / 混合召回 / 评估 / 反馈闭环 / 调参）──
  getRetrievalStatus(): Promise<RemoteResult<RetrievalStatus>>
  saveRetrievalConfig(options?: { patch?: RetrievalConfigPatch } | RetrievalConfigPatch): Promise<RemoteResult<{ ok: boolean; config: RetrievalConfigShape }>>
  buildRagVectorIndex(options?: { force?: boolean }): Promise<RemoteResult<VectorBuildResult>>
  submitAskFeedback(options: {
    retrievalId?: string
    rating: 'up' | 'down'
    useful?: number[]
    useless?: number[]
    question?: string
    answer?: string
  }): Promise<RemoteResult<{ ok: boolean; adaptedWeights?: RerankWeights; features?: string[]; feedbackTotal?: number; message?: string }>>
  listRetrievalFeedback(options?: { limit?: number }): Promise<RemoteResult<{ items: RetrievalFeedbackItem[]; stats: { total: number; up: number; down: number } }>>
  resetRetrievalWeights(): Promise<RemoteResult<{ ok: boolean; weights: RerankWeights }>>
  evaluateRetrieval(options?: { k?: number }): Promise<RemoteResult<RetrievalEvalResult>>
  getGroupInfo(options: { username: string }): Promise<RemoteResult<GroupInfoSnapshot>>
  getGroupInsights(options: { username: string }): Promise<RemoteResult<GroupInsightsSnapshot>>
  searchMembers(options: { q: string; limit?: number; roomUsername?: string }): Promise<RemoteResult<MemberSearchSnapshot>>
  resolveChatHistory(options: { serverId: string }): Promise<RemoteResult<ChatHistoryResolveResult>>
  getPaymentStatus(options: { serverId: string }): Promise<RemoteResult<PaymentStatus>>
  getDailyCounts(options: { username: string; year: number; month: number }): Promise<RemoteResult<CalendarSnapshot>>
  getImageDataUrl(options: { username: string; localId: number; fileOnly?: boolean }): Promise<RemoteResult<ImageDataUrlResult>>
  /** 一次 RPC 解码一批消息图片（N16：批量入口，路径表只查一次）。 */
  getImageDataUrlsBatch(options: { items: Array<{ username: string; localId: number }>; fileOnly?: boolean }): Promise<RemoteResult<{ items: ImageDataUrlBatchItem[] }>>
  /** 取消一个在跑的导出/备份任务（M3）。 */
  cancelExportJob(options: { jobId: string }): Promise<RemoteResult<{ ok: boolean; error?: string }>>
  /** 读一个导出/备份任务的最新进度（M3；事件中继之外的兜底路径）。 */
  getExportProgress(options: { jobId: string }): Promise<RemoteResult<ExportProgressSnapshot>>
  /** 文件消息里的图片（聊天记录里的原图）：与 getImageDataUrl 不同，它按文件 md5 定位。 */
  getFileImageDataUrl(options: { md5: string; thumbFirst?: boolean }): Promise<RemoteResult<ImageDataUrlResult>>
  /**
   * 批量取文件库图片（2026-10-21，一屏 1 次 RPC；借鉴 Alpha 的批量 token）。
   * `files-thumbs.ts` 用它攒批；单张入口继续服务灯箱。
   */
  getFileImageDataUrls(options: { keys: string[]; thumbFirst?: boolean }): Promise<RemoteResult<FileImageDataUrlsResult>>
  /**
   * 收藏资源本地缓存：`business/favorite` 按明文 MD5 匹配，
   * 图片、视频、文件、语音和未知资源共用。
   */
  getFavoriteMediaDataUrl(options: {
    md5?: string
    thumbMd5?: string
    fullMd5?: string
    kind?: 'image' | 'video' | 'audio' | 'file' | 'unknown'
    ext?: string
    fileName?: string
    size?: number
  }): Promise<RemoteResult<ImageDataUrlResult>>
  getEmoticonDataUrl(options: { md5: string; emojiUrl?: string }): Promise<RemoteResult<ImageDataUrlResult>>
  /**
   * 批量取表情（E1，2026-09-28 性能修复）。
   * 一屏 N 张从 N 个 RPC 收成 1 个；后端先本地解码、再对剩余的 8 并发出网。
   * 返回项带 `md5` 回信（入参去重后顺序不再一一对应，调用方按 md5 匹配）。
   */
  getEmoticonDataUrls(options: { items: Array<{ md5: string; emojiUrl?: string }> }): Promise<RemoteResult<{ items: Array<{ md5: string; dataUrl?: string; format?: string; error?: string }> }>>
  getImageOriginal(options: { username?: string; localId?: number }): Promise<RemoteResult<{ ok: boolean; format?: string; bytes?: number; note?: string; error?: string }>>
  getRemoteImages(options: { urls?: string[] }): Promise<RemoteResult<{ items: RemoteImageItem[] }>>
  /**
   * 公共地图 GeoJSON 代理。渲染层不直接出网，地址白名单与取回都在后端完成。
   */
  getMapGeoJson(options: { urls?: string[] }): Promise<RemoteResult<MapGeoJsonResult>>
  getSnsImageDataUrl(options: {
    md5: string
    timelineId?: string
    mediaId?: string
    url?: string
    token?: string
    seed?: string
    offline?: boolean
  }): Promise<RemoteResult<ImageDataUrlResult>>
  /**
   * 一批朋友圈视频封面（W2-5.6）：一屏 N 条合成一次往返。
   * @param options - items + 整批是否离线。
   * @returns md5 → 结果（按 md5 对齐，不按下标）。
   */
  getSnsVideoCoversBatch(options: { items: Array<{ md5?: string; timelineId?: string; mediaId?: string; thumb?: string; key?: string }>; offline?: boolean }): Promise<RemoteResult<{ items: Array<{ md5: string; url?: string; error?: string }> }>>
  getSnsVideoCoverDataUrl(options: { md5?: string; timelineId?: string; mediaId?: string; thumb?: string; key?: string; offline?: boolean }): Promise<RemoteResult<ImageDataUrlResult>>
  getSnsVideoDataUrl(options: { md5?: string; timelineId?: string; mediaId?: string; url?: string; key?: string }): Promise<RemoteResult<ImageDataUrlResult>>
  getArticleCover(options: { contentUrl: string }): Promise<RemoteResult<ImageDataUrlResult>>
  /**
   * 批量解析文章封面（A1，2026-09-28 性能修复）。
   * 一屏 N 篇从 N 个 RPC 收成 1 个；后端按 8 并发分批，返回顺序 = 去重后的入参顺序。
   */
  getArticleCovers(options: { urls: readonly string[] }): Promise<RemoteResult<{ items: Array<{ url: string; dataUrl?: string; error?: string }> }>>
  getMessageFile(options: { fileName: string; size?: number; createTime?: number; fileMd5?: string }): Promise<RemoteResult<ImageDataUrlResult>>
  getDbStatus(): Promise<RemoteResult<DbStatusSnapshot>>
  /**
   * 实时同步修订（纯内存读，1s 级轮询可用）：`revision` 判断有没有新数据落地，
   * `messageChanged` 判断要不要真去查消息增量。
   */
  getDataRevision(): Promise<RemoteResult<DataRevision>>
  getDbHealth(): Promise<RemoteResult<DbHealthSnapshot>>
  /**
   * 逐库完整性体检（PRAGMA integrity_check）——「库文件已损坏」处方指向的检查。
   * 显式动作（「重新检查 / 修复」时才打），不随健康快照自动跑。
   */
  checkDbIntegrity(): Promise<RemoteResult<DbIntegrityResult>>
  getVoiceInfo(options: { username: string; localId: number }): Promise<RemoteResult<VoiceInfoResult>>
  /**
   * 语音消息的可播放 wav（data URL）—— 就地播放用，见后端 resolveVoiceDataUrl。
   * 普通消息传 username + localId；收藏语音没有会话上下文，改传 svrId。
   */
  getVoiceDataUrl(options: { username?: string; localId?: number; svrId?: string }): Promise<RemoteResult<VoiceDataUrlResult>>
  getVideoInfo(options: { username?: string; localId?: number; md5?: string }): Promise<RemoteResult<VideoInfoResult>>
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
  generateDailySummary(options: { date: string; provider?: string; model?: string; format?: string }): Promise<RemoteResult<DailySummaryResult>>
  generateAnnualNarrative(options: { year: number; jobId?: string }): Promise<RemoteResult<AnnualNarrativeResult>>
  generatePeriodSummary(options: {
    from: string
    to: string
    provider?: string
    model?: string
    format?: string
  }): Promise<RemoteResult<PeriodSummaryResult>>
  listLlmProviders(): Promise<RemoteResult<{ providers: Array<{ id: string; name: string }> }>>
  listLlmModels(options: { provider: string }): Promise<RemoteResult<{ models: Array<{ id: string; name: string }> }>>
  listEditedMessages(options?: { sessionId?: string }): Promise<RemoteResult<EditedListSnapshot>>
  editChatMessage(options: { username: string; localId: number; content: string; mode?: 'text' | 'source' }): Promise<RemoteResult<EditMutationResult>>
  resetEditedMessage(options: { username: string; localId: number }): Promise<RemoteResult<EditMutationResult>>
  exportCsv(options: { kind: string; recordsKind?: string; dest?: string; category?: string; jobId?: string }): Promise<RemoteResult<ExportResult>>
  getExportHistory(options?: ExportHistoryQuery): Promise<RemoteResult<ExportHistorySnapshot>>
  deleteExportHistory(options: { ids: number[]; deleteFiles?: boolean }): Promise<RemoteResult<ExportHistoryDeleteResult>>
  pruneExportHistory(options?: ExportHistoryPruneOptions): Promise<RemoteResult<ExportHistoryDeleteResult>>
  // ── 问答历史（后端按数据根隔离保存，前端只读/删）──
  getAskHistory(options?: AskHistoryQuery): Promise<RemoteResult<AskHistorySnapshot>>
  deleteAskHistory(options: { ids: number[] }): Promise<RemoteResult<AskHistoryDeleteResult>>
  clearAskHistory(): Promise<RemoteResult<AskHistoryClearResult>>
  exportAnnualReport(options: { year: number; format: string; dir?: string; filename?: string; jobId?: string }): Promise<RemoteResult<ExportResult>>
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
  saveSummaryTask(options: { task: SummaryTaskInput }): Promise<RemoteResult<SummaryTaskMutationResult>>
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
  openConfig(signal?: AbortSignal): Promise<RemoteResult<{ ok: boolean; path: string; error?: string }>>
  openPath(options: { path: string }, signal?: AbortSignal): Promise<RemoteResult<{ ok: boolean; path: string; error?: string }>>
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
  /**
   * 微信原图自动下载（实验）：`start` 打开开关并让微信开始下载新图片的原图 /
   * `stop` 关闭并还原微信进程 / `status` 只读状态（界面轮询用）。
   *
   * 仅桌面端可调：它会向本机微信进程注入组件并改变其内存行为（见设置 → 图片解码卡片）。
   * @param options - 动作；缺省为 `status`。
   * @returns 最新状态快照（含错误码、组件路径与清理提示）。
   */
  wechatImageAutoDownload(options?: { action?: 'start' | 'stop' | 'status' }): Promise<RemoteResult<WechatImageAutoDownloadStatus>>
  verifyImageKey(): Promise<RemoteResult<VerifyImageKeyResult>>
  decryptAllDatabases(): Promise<RemoteResult<DecryptAllResult>>
  /**
   * 修复损坏的库：体检 → 只重解密损坏的那几个 → 复检。
   * 与「立即解密」的区别是范围（只动坏的），见后端 query/db-repair.ts。
   */
  repairCorruptDbs(): Promise<RemoteResult<DbRepairResult>>
  decryptAllImages(options?: { concurrency?: number }): Promise<RemoteResult<DecryptImagesResult>>
  upgradeDecodedImages(): Promise<RemoteResult<ImageUpgradeResult>>
  planOriginalFetch(): Promise<RemoteResult<OriginalFetchPlan>>
  fetchOriginalImagesBatch(options?: { limit?: number; concurrency?: number }): Promise<RemoteResult<OriginalBatchResult>>
  /** 原图自动收割：`start` 启动监控 / `stop` 停止监控 / `now` 手动收割一次。 */
  originalHarvest(options: { action: 'start' | 'stop' | 'now' }): Promise<RemoteResult<HarvestResult | HarvestStatus>>
  /** 读原图自动收割状态（纯内存，毫秒级；不占重任务槽）。 */
  getOriginalHarvestStatus(): Promise<RemoteResult<HarvestStatus>>
  /** 读第三方原图服务的额度（wxcdn.c3o.re）。 */
  getWxcdnQuota(): Promise<RemoteResult<{ quota?: WxcdnQuota; error?: string }>>
  getDecryptStatus(): Promise<RemoteResult<DecryptStatus>>
  getWhisperStatus(): Promise<RemoteResult<WhisperStatus>>
  downloadWhisperModel(options: { model: string; jobId?: string }): Promise<RemoteResult<WhisperDownloadResult>>
  /**
   * W3-5.5：停止一次正在跑的下载。取消只在下一个 chunk 生效，
   * 已下载的部分保留为 `.part`（下次可续传）。
   * @param options - jobId（必填）。
   * @returns ok + 停不上的原因。
   */
  cancelWhisperDownload(options: { jobId: string }): Promise<RemoteResult<{ ok: boolean; message?: string }>>
  installWhisperEngine(options?: { jobId?: string }): Promise<RemoteResult<WhisperDownloadResult>>
  transcribeVoiceBatch(options?: { limit?: number }): Promise<RemoteResult<VoiceTranscribeResult>>
  getVoiceTranscript(options: { username: string; localId: number }): Promise<RemoteResult<VoiceTranscriptResult>>
  transcribeVoiceMessage(options: { username: string; localId: number }): Promise<RemoteResult<VoiceTranscribeOneResult>>
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

/** 打开原生目录选择框；取消返回 null。 */
export async function pickDirectory(): Promise<string | null> {
  if (_pickDirectory === null) return null
  return _pickDirectory()
}

/**
 * 宿主环境能力表（M9）。
 *
 * 为什么是**注入**而不是在本包 import `ui-app/capabilities.ts`：那会反向跨包根
 * （ui-wechat 的 tsconfig 以自身 `src` 为 rootDir，ui-app 在它外面）。
 * 本包已有的先例就是这条缝 —— `setWechatRemote` / `setDirectoryPicker` 都由宿主注入，
 * 面板只读注入结果；判环境的口径仍然只有 ui-app 那一份。
 */
export interface RuntimeCapabilities {
  isDesktop: boolean
  isBrowser: boolean
  /** 交接态：浏览器里临时拥有桌面端权限（原生动作由服务端代理）。 */
  desktopEquivalent: boolean
  dirPicker: boolean
  capturePanel: boolean
  shellOpen: boolean
  license: boolean
  diag: boolean
  update: boolean
}

let _caps: RuntimeCapabilities | null = null

/** 宿主在装 remote 的同处注入能力表。 */
export function setCapabilities(c: RuntimeCapabilities): void {
  _caps = c
}

/**
 * 读能力表。**没注入时一律按浏览器**（`isDesktop:false`）——
 * 宁可少几个按钮，也不能让界面去调一个不存在的桥（那是直接抛，不是降级）。
 */
export function runtimeCapabilities(): RuntimeCapabilities {
  return _caps ?? { isDesktop: false, isBrowser: true, desktopEquivalent: false, dirPicker: false, capturePanel: false, shellOpen: false, license: false, diag: false, update: false }
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
  const api = window.electronAPI
  if (!api?.capturePanel) return { ok: false, message: '当前环境不支持截图导出' }
  const r = await api.capturePanel(rect)
  return r ?? { ok: false, message: '截图导出无返回' }
}

export function unwrap<T>(r: RemoteResult<T>): T {
  if (!r.ok) {
    // 错误码必须跟着一起抛：调用方要靠它区分「用户主动停止」与「真失败」——
    // 两者对用户是两回事（ask 的取消、导出的取消都是这个形态）。只带 message 的话，
    // 面板只能把一次正常的取消显示成红色错误。
    const err = new Error(r.error?.message ?? r.error?.code ?? 'remote call failed') as Error & { code?: string }
    if (typeof r.error?.code === 'string') err.code = r.error.code
    throw err
  }
  return r.value as T
}
