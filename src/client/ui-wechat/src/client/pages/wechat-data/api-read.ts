/**
 * `api.ts` 的「只读快照：会话/联系人/消息/朋友圈/收藏/资产/文件/记录/账本/通话/隐私/操作日志/图谱」部分（M21 拆分）。
 *
 * 从原模块原样搬出，**行为逐字节不变**；原文件继续以 `export *` 转发
 * ⇒ 所有既有 import 一行都不用改。
 *
 * @module api-read
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
  SelfProfile,
  ImageDataUrlResult,
  KeysInfoResult,
  LedgerSnapshot,
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
  MessageAnalysisResult,
} from '@deepseek-ai/dsh-wechat-data/types'
import {
  cachedFetch,
  cachedGet,
  invalidateSnapshotCache,
  invalidateAndNotify,
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
import { KB_LIST_CACHE_KEY, kbCacheKey } from './kb-scope-keys.ts'
import { KnowledgeSnapshotRead, remote, unwrap } from './api-core.ts'
import { isLegacyChatId } from './utils/chat-identity.ts'

// ── sessions / contacts / messages (Remote) ──
/**
 * Fetch the session list (optional keyword filter + limit).
 * @param options - Query options: keyword fuzzy search, limit max rows.
 * @returns SessionsSnapshot with items + total.
 */
export async function apiGetSessions(options?: {
  keyword?: string
  limit?: number
  offset?: number
  jobId?: string
  /**
   * 实时事件驱动刷新时直取后端，绕过 30 秒 SWR 持久缓存。
   *
   * 普通面板切换仍走缓存；只有「已经知道数据变了」的路径才传 true。
   * 该字段是客户端包装层参数，不会传给 Remote。
   */
  fresh?: boolean
}): Promise<SessionsSnapshot> {
  const { fresh: _fresh, ...query } = options ?? {}
  // 可取消任务的 jobId 是一次性的；缓存它会把已取消的部分结果带给下一轮。
  // 普通会话列表仍走 30 秒缓存，避免面板切换重复冷算。
  if (_fresh === true || (query.jobId !== undefined && query.jobId !== '')) {
    return unwrap(await remote().getSessions(query))
  }
  return cachedFetch('sessions:' + JSON.stringify(query), async () => unwrap(await remote().getSessions(query)), 30_000)
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
export async function apiGetContacts(options?: { limit?: number; offset?: number; category?: string; categories?: readonly string[] }): Promise<ContactsSnapshot> {
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
 *   for paging, or beforeLocalId for an exact quote/message jump. cursor 与
 *   cursorLocalId 必须成对回传：只传 cursor 会在 sort_seq 重复处丢消息。
 * @returns MessagesSnapshot.
 */
export async function apiGetMessages(options: {
  talker: string
  limit?: number
  cursor?: number
  cursorLocalId?: number
  beforeLocalId?: number
  /** 实时事件驱动刷新时直取后端；普通打开仍允许 5 秒 SWR 缓存。 */
  fresh?: boolean
}): Promise<MessagesSnapshot> {
  const { fresh: _fresh, ...query } = options
  if (_fresh === true || query.cursor !== undefined || query.beforeLocalId !== undefined || isLegacyChatId(query.talker)) {
    return unwrap(await remote().getMessages(query))
  }
  return cachedFetch('messages:' + query.talker + ':' + String(query.limit ?? 50), async () => unwrap(await remote().getMessages(query)), 5_000)
}
/**
 * Fetch messages newer than a composite `(sortSeq, localId)` watermark.
 * @param options - Query options: talker, after watermark (and its localId), optional limit.
 * @returns MessagesSnapshot with the newer messages only.
 */
export async function apiGetNewMessages(options: {
  talker: string
  after: number
  afterLocalId?: number
  limit?: number
}): Promise<MessagesSnapshot> {
  return unwrap(await remote().getNewMessages(options))
}

/**
 * 「聊天素材收集任务」的客户端包装已在 2026-10-19 移除：聊天侧「新建任务」改为
 * 【任务信息】的触发式任务（`api-task-center.ts`），旧收集弹窗连同它的调用点一起删了。
 * 后端 `createChatCollectTask` / `listChatCollectTasks` 两个 @Remote 仍保留（`WechatRemote`
 * 镜像必须与后端方法面对齐），但界面不再有入口 —— 留着这两个 UI 层包装只会让
 * `read-error-visibility.spec.ts` 找不到调用方（它要求「谁调谁读 readError」）。
 * 若将来恢复素材收集面板，从 `remote().listChatCollectTasks()` 重新包一层即可。
 */

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
/**
 * 当前账号的展示信息（昵称/备注），侧栏品牌位用。
 * @returns 形如 `{ username, name, alias? }`；取不到时 name 为空串。
 */
export async function apiGetSelfProfile(): Promise<SelfProfile> {
  return unwrap(await remote().getSelfProfile())
}
/** Fetch full-history author activity counts (ranked descending). */
export async function apiGetMomentsAuthors(): Promise<Array<{ username: string; name: string; enterpriseName?: string; count: number }>> {
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
export async function apiGetMomentsMonthly(options?: { author?: string; authorName?: string }): Promise<MomentsMonthlySnapshot> {
  return unwrap(await remote().getMomentsMonthly(options))
}
/**
 * 词云词频（界面优化阶段 4）：scope=global（可带年份）/ chat（单会话）/ moments（朋友圈正文）。
 * 本地 bigram 计数 + 实体保护 + 双重停用过滤；每次现算，不落库。
 * @param options - scope / username / year / limit（默认 60）。
 * @returns Top-N 词频与扫描条数。
 */
export async function apiGetWordCloud(options?: { scope?: 'global' | 'chat' | 'moments'; username?: string; year?: number; limit?: number }): Promise<{ words: Array<{ text: string; count: number }>; scanned: number; canceled?: boolean }> {
  return unwrap(await remote().getWordCloud(options))
}

/**
 * 分析一条消息（单聊与群聊用两套问题域）。
 *
 * 单聊回答「他想要什么、情绪如何、我该怎么回」；群聊回答「这条消息是否针对我、
 * 他在群里做什么动作、我该不该接话、公开回还是私聊」。
 *
 * 走 `analyze_message` 隐私闸后调用设置里的当前对话模型，输出严格 JSON；
 * 结果在后端按（会话、消息、模型+提示词版本）缓存，重复查看同一条是即时的。
 * @param options - 会话 username、消息定位键（localId/sortSeq）与是否强制重算。
 * @returns 结构化分析；`ok:false` 时 `error` 可直接展示。
 */
export async function apiAnalyzeMessage(options: {
  talker: string
  localId: number
  sortSeq?: number
  force?: boolean
}): Promise<MessageAnalysisResult> {
  return unwrap(await remote().analyzeMessage(options))
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
  // 账本是一条**跨全年聚合**的重查询（本机几百毫秒），而总览面板把它挂在数据事件上 ——
  // 实时同步活跃期约每 10 秒一次。以前这里是 api 层唯一一个**完全没有缓存**的重读，
  // 于是每次事件都整条重算（P2-4 记的那笔账）。`cachedGet` 的键按月分：切月份不互相污染。
  return cachedGet('ledger:' + (options?.month ?? 'all'), async () => unwrap(await remote().getLedger(options)))
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
export async function apiSetPrivacyState(options: { redactSensitive?: boolean }): Promise<PrivacyStateSnapshot> {
  const r = await remote().setPrivacyState(options)
  invalidateAndNotify('privacy')
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
