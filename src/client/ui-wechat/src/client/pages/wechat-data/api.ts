/**
 * WeChat data access layer — backed by the DSH WechatDataGateway Remote
 * (node:sqlite over the owned local decrypted DBs). All panels read through
 * ctx.remote.wechatData.*; there is no HTTP dependency.
 *
 * Panels also use the stale-while-revalidate render cache below: the first
 * successful render is persisted, the next open renders it synchronously
 * (instant paint), and fresh data replaces it in the background.
 */


/**
 * In-memory snapshot cache with a short TTL. The WeChat panels unmount when
 * the user switches tabs; a shared cache makes returning to a tab show the
 * last snapshot instantly, then refresh in the background (stale-while-revalidate).
 * Invalidated wholesale when the host reports new decrypted data
 * (see the 'dsh-wechat-data-updated' DOM event).
 */
const SNAPSHOT_TTL_MS = 30_000
const _snapshotCache = new Map<string, { value: unknown; ts: number }>()
const _snapshotListeners = new Map<string, Set<() => void>>()

/** Read a fresh-enough cached snapshot, or undefined when absent/stale. */
function snapshotHit(key: string): unknown {
  const hit = _snapshotCache.get(key)
  if (hit === undefined) return undefined
  if (Date.now() - hit.ts < SNAPSHOT_TTL_MS) return hit.value
  // 过期即释放：否则整份快照会被这个模块级 Map 一直持有到渲染进程结束。
  _snapshotCache.delete(key)
  return undefined
}

/**
 * 快照缓存条目上限。面板卸载后快照仍留在模块级 Map 中，而键包含
 * talker / limit / 筛选条件等易变参数，因此必须设上限，
 * 否则长时间浏览（每敲一次搜索、每翻一页）都会留下一条永不回收的条目。
 */
const SNAPSHOT_CACHE_MAX = 60

/** 写入快照缓存；超出上限时按插入顺序淘汰最旧的键。 */
function snapshotSet(key: string, value: unknown): void {
  _snapshotCache.delete(key)
  while (_snapshotCache.size >= SNAPSHOT_CACHE_MAX) {
    const oldest = _snapshotCache.keys().next()
    if (oldest.done) break
    _snapshotCache.delete(oldest.value)
  }
  _snapshotCache.set(key, { value, ts: Date.now() })
}

/** Fetch-through cache: returns the cached value immediately when fresh, else fetches and caches. */
function cachedGet<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const hit = snapshotHit(key)
  if (hit !== undefined) return Promise.resolve(hit as T)
  return fetcher().then((value) => {
    snapshotSet(key, value)
    for (const fn of _snapshotListeners.get(key) ?? []) { try { fn() } catch { /* ignore */ } }
    return value
  })
}

/** Subscribe to cache writes for one key (drives re-render after a background refresh). */
export function subscribeSnapshot(key: string, fn: () => void): () => void {
  const set = _snapshotListeners.get(key) ?? new Set<() => void>()
  set.add(fn)
  _snapshotListeners.set(key, set)
  return () => { set.delete(fn) }
}

/** Invalidate the whole snapshot cache (realtime update / manual refresh). */
export function invalidateSnapshotCache(): void {
  _snapshotCache.clear()
  for (const set of _snapshotListeners.values()) for (const fn of set) { try { fn() } catch { /* ignore */ } }
}

if (typeof window !== 'undefined') {
  // The ui-wechat plugin relays the host realtime sync signal as this DOM event;
  // new decrypted data means every cached snapshot is stale, so drop them all.
  window.addEventListener('dsh-wechat-data-updated', () => { invalidateSnapshotCache() })
}

const RENDER_CACHE_PREFIX = 'wxdata-render-cache:'

/** Read the last successfully rendered snapshot for a panel (sync, instant paint). */
export function readRenderCache<T>(key: string, ..._rest: T[]): T | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(RENDER_CACHE_PREFIX + key)
    return raw ? JSON.parse(raw) as T : null
  } catch { /* 无缓存或损坏:走正常加载 */ }
  return null
}

/** Save a snapshot after a successful render (quota-safe: drops silently when full). */
export function writeRenderCache(key: string, data: unknown): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(RENDER_CACHE_PREFIX + key, JSON.stringify(data))
  } catch { /* 容量超限:放弃缓存,不影响主流程 */ }
}

import type {
  AccountsSnapshot,
  AnnualReport,
  AnnualSnapshot,
  AssetInsightsSnapshot,
  AutoDbKeyResult,
  AutoImageKeyResult,
  AskOptimizeResult,
  AskResult,
  AvatarResult,
  BackupMutationResult,
  BackupRestoreResult,
  BackupPreviewSnapshot,
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
// 知识笔记/知识图谱类型刻意从本地 types.ts 取（node_modules 那份宿主副本已陈旧，
// 原因见该文件顶部注释）。
import type { KnowledgeSnapshot, NoteMutationResult, NotesSnapshot } from './types.ts'

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
  getFavorites(options?: { limit?: number; offset?: number }): Promise<RemoteResult<FavoritesSnapshot>>
  getAssetInsights(): Promise<RemoteResult<AssetInsightsSnapshot>>
  getOfficialAssets(): Promise<RemoteResult<OfficialAssetsSnapshot>>
  getMediaAssets(): Promise<RemoteResult<MediaAssetsSnapshot>>
  getFiles(options?: { limit?: number; offset?: number }): Promise<RemoteResult<FilesSnapshot>>
  getOverview(): Promise<RemoteResult<OverviewSnapshot>>
  getOverviewInsights(): Promise<RemoteResult<OverviewInsights>>
  getRegionMap(): Promise<RemoteResult<RegionMapSnapshot>>
  getRecords(options: { kind: string; limit?: number; offset?: number; q?: string; from?: number; to?: number; direction?: 'asc' | 'desc' }): Promise<RemoteResult<RecordsSnapshot>>
  getLedger(options?: { month?: string }): Promise<RemoteResult<LedgerSnapshot>>
  getCalls(options?: { topPeers?: number; recentLimit?: number }): Promise<RemoteResult<CallsSnapshot>>
  getRevoked(options?: { limit?: number; offset?: number }): Promise<RemoteResult<RevokedSnapshot>>
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
  getNotes(options?: { query?: string; limit?: number }): Promise<RemoteResult<NotesSnapshot>>
  saveNote(options: {
    id?: number
    title: string
    body?: string
    tags?: string[] | string
    sourceKind?: 'manual' | 'ask'
    sourceUsername?: string
    sourceQuestion?: string
  }): Promise<RemoteResult<NoteMutationResult>>
  deleteNote(options: { id: number }): Promise<RemoteResult<NoteMutationResult>>
  getKnowledgeGraph(): Promise<RemoteResult<KnowledgeSnapshot>>
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
  }): Promise<RemoteResult<ExportResult>>
  listBackups(): Promise<RemoteResult<BackupSnapshot>>
  previewBackup(options: { name: string }): Promise<RemoteResult<BackupPreviewSnapshot>>
  createBackup(): Promise<RemoteResult<BackupMutationResult>>
  createEncryptedBackup(options: { password: string }): Promise<RemoteResult<BackupMutationResult>>
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
  exportCsv(options: { kind: string; recordsKind?: string }): Promise<RemoteResult<ExportResult>>
  exportAnnualReport(options: { year: number; format: string; dir?: string; filename?: string }): Promise<RemoteResult<ExportResult>>
  exportAllSessions(options?: { dir?: string; filename?: string }): Promise<RemoteResult<ExportResult>>
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
  }): Promise<RemoteResult<ExportResult>>
  /** 导出朋友圈视频到指定路径（后端负责解密与写盘）。 */
  exportSnsVideo(options: {
    md5?: string; timelineId?: string; mediaId?: string; url?: string; key?: string; dest: string
  }): Promise<RemoteResult<{ ok: boolean; bytes?: number; source?: string; error?: string }>>
  clearSessionDraft(options: { username: string }): Promise<RemoteResult<DraftClearResult>>
  clearAllSessionDrafts(): Promise<RemoteResult<DraftsClearResult>>
  listSummaryTasks(): Promise<RemoteResult<SummaryTaskSnapshot>>
  saveSummaryTask(options: { task: Omit<SummaryTask, 'id' | 'createdAt' | 'updatedAt'> & { id?: number } }): Promise<RemoteResult<SummaryTaskMutationResult>>
  deleteSummaryTask(options: { id: number }): Promise<RemoteResult<SummaryTaskMutationResult>>
  toggleSummaryTask(options: { id: number; enabled: boolean }): Promise<RemoteResult<SummaryTaskMutationResult>>
  runSummaryTask(options: { id: number }): Promise<RemoteResult<SummaryTaskRunResult>>
  listSummaryRecords(options?: { taskId?: number }): Promise<RemoteResult<SummaryRecordSnapshot>>
  deleteSummaryRecord(options: { id: number }): Promise<RemoteResult<SummaryTaskMutationResult>>
  listTasks(): Promise<RemoteResult<TasksSnapshot>>
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

// ── 本地缓存层：先渲染缓存，后台刷新后再写回，加速资源预加载 ──
const CACHE_PREFIX = 'dsh-wechat-cache-v1:'
const CACHE_TTL_DEFAULT = 60_000

interface CacheEnvelope { at: number; v: unknown }

function cacheGet(key: string, ttlMs = CACHE_TTL_DEFAULT): unknown {
  try {
    const s = localStorage.getItem(CACHE_PREFIX + key)
    if (!s) return null
    const env = JSON.parse(s) as CacheEnvelope
    if (typeof env.at !== 'number' || !('v' in env)) return null
    if (Date.now() - env.at > ttlMs) {
      localStorage.removeItem(CACHE_PREFIX + key)
      return null
    }
    return env.v
  } catch {
    return null
  }
}

function cacheSet(key: string, value: unknown): void {
  try {
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ at: Date.now(), v: value } satisfies CacheEnvelope))
  } catch {
    /* localStorage 满时忽略（媒体大图不入缓存） */
  }
}

/** Remove cache entries whose key starts with the given prefix (both layers). */
export function invalidateWechatCache(prefix: string): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i -= 1) {
      const k = localStorage.key(i)
      if (!k) continue
      if (k.startsWith(CACHE_PREFIX + prefix)) localStorage.removeItem(k)
      if (k.startsWith(RENDER_CACHE_PREFIX + prefix)) localStorage.removeItem(k)
    }
  } catch { /* quota/security errors are best-effort */ }
}

// ── 解密媒体持久化缓存（IndexedDB）：已解密的朋友圈图片/视频封面跨会话复用，
//    避免下次进入朋友圈再次并发解密。localStorage 容量不足以存 base64 大图。 ──
const MEDIA_DB_NAME = 'dsh-wechat-media'
const MEDIA_STORE = 'sns-images'
const MEDIA_MAX_ENTRIES = 4000
let mediaDb: Promise<IDBDatabase> | null = null

function openMediaDb(): Promise<IDBDatabase> {
  if (mediaDb) return mediaDb
  mediaDb = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('indexedDB unavailable')); return }
    const req = indexedDB.open(MEDIA_DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(MEDIA_STORE)) {
        db.createObjectStore(MEDIA_STORE).createIndex('by_at', 'at')
      }
    }
    req.onsuccess = () => { resolve(req.result); void trimMediaCache(req.result) }
    req.onerror = () => { mediaDb = null; reject(req.error ?? new Error('open media db failed')) }
  })
  return mediaDb
}

/** 删除超出容量上限的最旧条目（按写入时间 at 升序）。 */
async function trimMediaCache(db: IDBDatabase): Promise<void> {
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(MEDIA_STORE, 'readonly')
      const store = tx.objectStore(MEDIA_STORE)
      const keysReq = store.getAllKeys()
      const valsReq = store.getAll()
      let keys: IDBValidKey[] = []
      let vals: Array<{ url: string; at: number }> = []
      keysReq.onsuccess = () => { keys = keysReq.result }
      valsReq.onsuccess = () => { vals = valsReq.result as Array<{ url: string; at: number }> }
      tx.oncomplete = () => {
        if (keys.length <= MEDIA_MAX_ENTRIES) { resolve(); return }
        const rows = keys.map((key, i) => ({ key, at: vals[i]?.at ?? 0 })).sort((a, b) => a.at - b.at)
        const drop = rows.slice(0, keys.length - MEDIA_MAX_ENTRIES)
        if (drop.length === 0) { resolve(); return }
        const dtx = db.transaction(MEDIA_STORE, 'readwrite')
        for (const d of drop) dtx.objectStore(MEDIA_STORE).delete(d.key)
        dtx.oncomplete = () => { resolve() }
        dtx.onerror = () => { resolve() }
      }
      tx.onerror = () => { resolve() }
    })
  } catch { /* best-effort */ }
}

/** Read one cached decrypted media data URL by key, or null. */
export async function snsMediaCacheGet(key: string): Promise<string | null> {
  try {
    const db = await openMediaDb()
    return await new Promise<string | null>((resolve) => {
      const req = db.transaction(MEDIA_STORE, 'readonly').objectStore(MEDIA_STORE).get(key)
      req.onsuccess = () => {
        const r = req.result as { url?: string } | undefined
        resolve(typeof r?.url === 'string' ? r.url : null)
      }
      req.onerror = () => { resolve(null) }
    })
  } catch { return null }
}

/** Batch-read cached media data URLs for the given keys. */
export async function snsMediaCacheGetMany(keys: readonly string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  if (keys.length === 0) return out
  try {
    const db = await openMediaDb()
    await new Promise<void>((resolve) => {
      const tx = db.transaction(MEDIA_STORE, 'readonly')
      const store = tx.objectStore(MEDIA_STORE)
      for (const k of keys) {
        const req = store.get(k)
        req.onsuccess = () => {
          const r = req.result as { url?: string } | undefined
          if (typeof r?.url === 'string') out[k] = r.url
        }
      }
      tx.oncomplete = () => { resolve() }
      tx.onerror = () => { resolve() }
    })
  } catch { /* best-effort */ }
  return out
}

/** Persist one decrypted media data URL. */
export async function snsMediaCacheSet(key: string, url: string): Promise<void> {
  try {
    const db = await openMediaDb()
    await new Promise<void>((resolve) => {
      const tx = db.transaction(MEDIA_STORE, 'readwrite')
      tx.objectStore(MEDIA_STORE).put({ url, at: Date.now() }, key)
      tx.oncomplete = () => { resolve() }
      tx.onerror = () => { resolve() }
    })
  } catch { /* best-effort */ }
}

/** 读快照：命中缓存时先返回缓存作早显，随后前台等待新鲜值并写回；
 *  后台刷新失败降级返回缓存。无缓存时直接请求并写回。 */
/** 记录一次 panel 数据取数的耗时（超过阈值才打印，便于观察“及时响应”与回归）。 */
async function timedFetch<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const t0 = performance.now()
  try {
    return await fetcher()
  } finally {
    const ms = performance.now() - t0
    if (ms > 250) console.info(`[wxdata] ${key} ${ms.toFixed(0)}ms`)
  }
}

async function cachedFetch<T>(key: string, fetcher: () => Promise<T>, ttlMs = CACHE_TTL_DEFAULT): Promise<T> {
  const hit = cacheGet(key, ttlMs) as T | null
  if (hit !== null && !isEmptySnapshot(hit)) {
    try {
      const fresh = await timedFetch(key, fetcher)
      cacheSet(key, fresh)
      return fresh
    } catch {
      return hit
    }
  }
  const fresh = await timedFetch(key, fetcher)
  cacheSet(key, fresh)
  return fresh
}

/**
 * 空结果不参与缓存：一个临时的空快照（例如数据根尚未就绪时写入的）会
 * 永久盖住真实数据——命中后界面渲染空列表，后台刷新只改写 localStorage
 * 而不重绘界面。列表型快照（moments/items/favorites/…）无任何条目且
 * 总数为 0 时视为空；统计类快照（无数组字段）不受影响。
 */
function isEmptySnapshot(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const entries = Object.values(value as Record<string, unknown>)
  let sawList = false
  for (const entry of entries) {
    if (Array.isArray(entry)) {
      sawList = true
      if (entry.length > 0) return false
    }
  }
  if (!sawList) return false
  return !entries.some(entry => typeof entry === 'number' && entry > 0)
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
 * Fetch the contact list (optional page size + offset).
 * @param options - Query options: limit page size, offset page start.
 * @returns ContactsSnapshot.
 */
export async function apiGetContacts(options?: { limit?: number; offset?: number }): Promise<ContactsSnapshot> {
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
export async function apiGetFavorites(options?: { limit?: number; offset?: number }): Promise<FavoritesSnapshot> { return cachedGet('favorites:' + JSON.stringify(options ?? {}), async () => unwrap(await remote().getFavorites(options))) }
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
export async function apiGetFiles(options?: { limit?: number; offset?: number; category?: string }): Promise<FilesSnapshot> { return cachedGet('files:' + JSON.stringify(options ?? {}), async () => unwrap(await remote().getFiles(options))) }
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
export async function apiGetRevoked(options?: { limit?: number; offset?: number }): Promise<RevokedSnapshot> { return cachedGet('revoked:' + JSON.stringify(options ?? {}), async () => unwrap(await remote().getRevoked(options))) }
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
 * Fused with the social snapshot client-side via each note's `sourceUsername`.
 * @returns KnowledgeSnapshot.
 */
export async function apiGetKnowledgeGraph(): Promise<KnowledgeSnapshot> {
  return cachedGet('kb:graph', async () => unwrap(await remote().getKnowledgeGraph()))
}

/**
 * List knowledge notes.
 *
 * 刻意**不走缓存**：笔记是本地 sqlite 的直读，代价可忽略，而搜索框每敲一个字都
 * 需要最新结果 —— 挂上 30s 快照缓存只会让用户看到过期列表。
 * @param options - Optional search query and row cap.
 * @returns NotesSnapshot.
 */
export async function apiGetNotes(options?: { query?: string; limit?: number }): Promise<NotesSnapshot> {
  return unwrap(await remote().getNotes(options))
}

/**
 * Create or update one note. Invalidates the knowledge caches so the graph
 * panel reflects the change without waiting out the snapshot TTL.
 * @param input - Note fields; omit `id` to create.
 * @returns NoteMutationResult.
 */
export async function apiSaveNote(input: {
  id?: number
  title: string
  body?: string
  tags?: string[] | string
  sourceKind?: 'manual' | 'ask'
  sourceUsername?: string
  sourceQuestion?: string
}): Promise<NoteMutationResult> {
  const result = unwrap(await remote().saveNote(input))
  invalidateKnowledgeCaches()
  return result
}

/** Delete one note (links pointing at it become stubs). */
export async function apiDeleteNote(id: number): Promise<NoteMutationResult> {
  const result = unwrap(await remote().deleteNote({ id }))
  invalidateKnowledgeCaches()
  return result
}

/**
 * Drop every cache layer that can hold knowledge data.
 *
 * 笔记的写入**不会**触发 'dsh-wechat-data-updated'（那不是解密数据变更），所以这里
 * 必须自己失效：内存快照层（cachedGet 用的 _snapshotCache）与 localStorage 渲染层
 * （readRenderCache 的 'kb-' 前缀）是两套互不相通的缓存，只清一层会出现
 * 「图谱刷新了但列表还是旧的」这类半刷新状态。
 */
function invalidateKnowledgeCaches(): void {
  invalidateSnapshotCache()
  invalidateWechatCache('kb-')
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

export async function apiGetImageDataUrl(options: { username: string; localId: number }): Promise<ImageDataUrlResult> {
  return unwrap(await remote().getImageDataUrl(options))
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
 * Export a session’s messages in the given format.
 * @param options - Query options: username, format, optional count.
 * @returns ExportResult.
 */
export async function apiExportSessionMessages(options: { username: string; format: string; count?: number }): Promise<ExportResult> {
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
export async function apiCreateEncryptedBackup(options: { password: string }): Promise<BackupMutationResult> {
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

export async function apiExportAllSessions(options?: { dir?: string; filename?: string }): Promise<ExportResult> {
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
}): Promise<ExportResult> {
  return unwrap(await remote().exportMoments(options))
}

export async function apiExportCsv(options: { kind: string; recordsKind?: string }): Promise<ExportResult> {
  return unwrap(await remote().exportCsv(options))
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
 * @returns SummaryTaskSnapshot.
 */
export async function apiListSummaryTasks(): Promise<SummaryTaskSnapshot> {
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
 * @returns SummaryRecordSnapshot.
 */
export async function apiListSummaryRecords(options?: { taskId?: number }): Promise<SummaryRecordSnapshot> {
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
 * @returns TasksSnapshot.
 */
export async function apiListTasks(): Promise<TasksSnapshot> {
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

/** 微信问答模型配置（OpenAI 兼容）。 */
export interface WechatLlmConfig {
  provider: string
  model: string
  apiKey: string
  apiUrl: string
  apiPath: string
  timeoutMs: number
  /** RAG 稠密检索用的向量模型；留空则回退到 chat model。 */
  embeddingModel?: string
  /** 向量化接口路径（默认 /embeddings）。 */
  embedPath?: string
}

/** 读取微信问答模型配置。 */
export async function apiGetLlmConfig(): Promise<WechatLlmConfig> {
  const api = (window as any)?.electronAPI?.wechat
  if (!api?.getLlmConfig) return { provider: 'openai-compat', model: '', apiKey: '', apiUrl: 'https://api.openai.com/v1', apiPath: '/chat/completions', embedPath: '/embeddings', timeoutMs: 120000 }
  const res = await api.getLlmConfig()
  if (!res?.ok) throw new Error(res?.error?.message || '读取模型配置失败')
  return res.value
}

/** 保存微信问答模型配置。 */
export async function apiSaveLlmConfig(config: WechatLlmConfig): Promise<WechatLlmConfig> {
  const api = (window as any)?.electronAPI?.wechat
  if (!api?.saveLlmConfig) throw new Error('模型配置接口不可用')
  const res = await api.saveLlmConfig(config)
  if (!res?.ok) throw new Error(res?.error?.message || '保存模型配置失败')
  return res.value
}

/** 「获取官方模型」结果：models 来自实时接口（live）或未填 Key 时的内置参考清单（catalog）。 */
export interface LlmModelsResult {
  models: string[]
  source: 'live' | 'catalog'
  vendor?: string
  note?: string
}

/** 通过 base_url 拉取官方模型列表（OpenAI 兼容 GET {base_url}/models）。
 *  实际请求在主进程发出（渲染页 file:// 跨域 fetch 会被 CORS 拦截）；
 *  未填 API Key 时后端会按厂商回退内置参考清单（source='catalog'）。
 *  注意：与上方的 apiListLlmModels(provider)（日总结模型选择器，走 Remote）不同。 */
export async function apiFetchLlmModels(options: { apiUrl: string; apiKey: string }): Promise<LlmModelsResult> {
  const api = (window as any)?.electronAPI?.wechat
  if (!api?.listLlmModels) throw new Error('模型列表接口不可用')
  const res = await api.listLlmModels({ baseUrl: options.apiUrl, apiKey: options.apiKey })
  if (!res?.ok) throw new Error(res?.error?.message || '获取模型列表失败')
  return {
    models: Array.isArray(res.value?.models) ? res.value.models : [],
    source: res.value?.source === 'catalog' ? 'catalog' : 'live',
    vendor: typeof res.value?.vendor === 'string' ? res.value.vendor : undefined,
    note: typeof res.value?.note === 'string' ? res.value.note : undefined,
  }
}
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

/** 读取检索层状态（配置 + 向量库 + 反馈 + 权重 + 意图自评）。 */
export async function apiGetRetrievalStatus(): Promise<RetrievalStatus> {
  return unwrap(await remote().getRetrievalStatus())
}

/** 保存检索配置（只传要改的字段）。 */
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


