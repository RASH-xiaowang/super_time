/**
 * WechatDataGateway 方法面 · 只读快照与本地逻辑壳（数据读取 / 检索取消 / 历史删除）（M21 结构刀自 gateway.ts 拆出）。
 *
 * 这一层只有 `@Remote` 壳（装饰器 + 签名 + 一行转发）；装饰器标记会落到**最派生原型**上，
 * 因此协议层枚举到的方法面与拆分前逐名相同（守卫：`gateway-remote-surface.spec.ts`）。
 */

import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type { AccountsSnapshot, SelfProfile, AnnualReport, AnnualSnapshot, AskHistoryClearResult, AskHistoryDeleteResult, AskHistoryQuery, AskHistorySnapshot, AskOptimizeResult, AskResult, AutoDbKeyResult, AutoImageKeyResult, AvatarResult, BackupMutationResult, BackupPreviewSnapshot, BackupSnapshot, CalendarSnapshot, CallsSnapshot, ChatHistoryResolveResult, ConfigSnapshot, ContactsSnapshot, DailySummaryResult, DbStatusSnapshot, DecryptAllResult, DecryptImagesResult, DecryptStatus, DeleteFavoriteResult, DraftClearResult, DraftsClearResult, EditMutationResult, EditedListSnapshot, EmoticonsSnapshot, ExportResult, ExportStatus, ExportHistoryDeleteResult, ExportHistoryQuery, ExportHistorySnapshot, ExportHistoryPruneOptions, FavoritesSnapshot, FilesSnapshot, GenerateKeysResult, GraphSnapshot, GroupInfoSnapshot, ImageDataUrlResult, ArticleCoversResult, KeysInfoResult, MemberSearchSnapshot, MessagesSnapshot, MomentsSnapshot, OverviewInsights, OverviewSnapshot, PaymentStatus, PrivacySnapshot, RecordsSnapshot, RevokedSnapshot, SearchBuildResult, SearchIndexStatus, SearchSnapshot, SessionsSnapshot, SimpleResult, StorageSnapshot, SummaryRecord, SummaryRecordSnapshot, SummaryTask, SummaryTaskMutationResult, SummaryTaskRunResult, SummaryTaskSnapshot, VerifyImageKeyResult, VerifyKeyResult, VideoInfoResult, VoiceDataUrlResult, VoiceInfoResult, VoiceTranscriptResult, VoiceTranscribeOneResult, VoiceTranscribeResult, WechatAccount, WechatConfigFull, WechatConfigPatch, WhisperDownloadProgress, WhisperDownloadResult, WhisperStatus, WhisperTranscribing, AssetInsightsSnapshot, BackupRestoreResult, Contact360Snapshot, DbHealthSnapshot, GroupInsightsSnapshot, HandoffRemindsSnapshot, LedgerSnapshot, MediaAssetsSnapshot, MomentsInsightsSnapshot, MomentsMonthlyRow, MomentsMonthlySnapshot, OfficialAssetsSnapshot, OperationCategory, OperationLogClearResult, OperationLogQuery, OperationLogSnapshot, OperationStatus, PeriodSummaryResult, PrivacyAuditClearResult, PrivacyAuditRow, PrivacyStateSnapshot, RegionMapSnapshot, TaskMutationResult, TasksSnapshot, UnifiedSearchSnapshot, KnowledgeSnapshot, NotesSnapshot, NoteMutationResult, KbDeleteAction, KbListSnapshot, KbMeta, KbMutationResult } from './types.ts'
import { querySessions } from './query/sessions.ts'
import { queryGroupInfo } from './query/group-info.ts'
import { queryPaymentStatus } from './query/payments.ts'
import { queryContacts } from './query/contacts.ts'
import { queryRegionMap } from './query/region-map.ts'
import { createChatCollectTask, listChatCollectTasks } from './query/chat-collect.ts'
import type { ChatCollectTaskResult, ChatCollectTaskSnapshot } from './types.ts'
import { queryMessageByServerId, queryMessages, queryNewMessages } from './query/messages.ts'
import { queryMoments, queryMomentsAuthors } from './query/moments.ts'
import { querySelfProfile } from './query/self-profile.ts'
import { deleteFavoriteItems, queryFavorites } from './query/favorites.ts'
import { queryOverview } from './query/overview.ts'
import { queryRecords, queryRevoked } from './query/records.ts'
import { queryStorageStats } from './query/storage.ts'
import { queryAnnual } from './query/annual.ts'
import { join } from 'node:path'
import { openNativePath } from '@deepseek-ai/dsh-native-command'
import { openDenialReason } from './query/path-policy.ts'
import { queryCalls } from './query/calls.ts'
import { queryGraph } from './query/graph.ts'
import { getDailyCounts } from './query/calendar.ts'
import { buildSearchIndex, ensureSearchIndex, getSearchIndexStatus, knownEntityNames, searchIndexMessages, searchIndexMessagesCancellable } from './query/search.ts'
import { searchMembers } from './query/members.ts'
import { resolveArticleCoverDataUrl, resolveArticleCoversDataUrls } from './query/article-cover.ts'
import type { LocalCoverProbe } from './query/article-cover.ts'
import { findSnsMediaDataUrlByIndex, hasSnsMediaIndexEntries } from './query/sns-image.ts'
import { resolveImageKeyPair } from './query/image-key.ts'
import { createHash } from 'node:crypto'
import { queryOverviewInsights } from './query/overview-insights.ts'
import { detectWechatAccounts, generateKeysFile, getConfig, getKeysInfo, saveConfig, verifyDatabaseKey, weixinInstallPath, weixinVersion } from './query/config.ts'
import { WHISPER_DOWNLOAD_FILES, installWhisperEngine, migrateWhisperEngineDir, migrateWhisperModels, resolveWhisperModelsDir, whisperDownloadModel, whisperEnginePath, whisperHasCuda, whisperModelsStatus } from './query/whisper.ts'
import { cachedTranscript, transcribeOneVoiceAsync, transcribeVoiceBatch } from './query/voice-transcribe.ts'
import { svrIdByChatLocal } from './query/voice.ts'
import { clearAskHistory, deleteAskHistory, listAskHistory, recordAsk } from './query/ask-history.ts'
import { loadRetrievalConfig, saveRetrievalConfig as saveRetrievalConfigFile, defaultRetrievalConfig } from './query/retrieval/config.ts'
import { adaptWeights, attributeFeatures, feedbackStats, listFeedback, loadAdaptedWeights, recordFeedback, saveAdaptedWeights } from './query/retrieval/feedback.ts'
import type { FeedbackRecord, IntentKind, RerankWeights } from './query/retrieval/types.ts'
import { queryLedger } from './query/ledger.ts'
import type { WordCloudOptions, WordCloudResult } from './query/wordcloud.ts'
import { queryContact360 } from './query/contact360.ts'
import { queryGroupInsights } from './query/group-insights.ts'
import { queryAssetInsights } from './query/asset-insights.ts'
import { queryMediaAssets } from './query/media-assets.ts'
import { queryMomentsInsights } from './query/moments-insights.ts'
import { queryMomentsMonthly } from './query/moments-monthly.ts'
import { queryOfficialAssets } from './query/official-assets.ts'
import { searchUnified } from './query/unified-search.ts'
import { queryAnnualReport } from './query/annual-report.ts'
import { queryAnnualReview, type AnnualReview } from './query/annual-review.ts'
import { editChatMessage as editMsg, listEditedMessages as listEdits, resetEditedMessage as resetEdit } from './query/edit.ts'
import { clearAllSessionDrafts as clearAllDrafts, clearSessionDraft as clearDraft } from './query/drafts.ts'
import { deleteSummaryRecord as delRec, deleteSummaryTask as delTask, listSummaryRecords as listRecs, listSummaryTasks as listTasks, saveSummaryRecord as saveRec, saveSummaryTask as saveTask, toggleSummaryTask as toggleTask, updateSummaryTaskRunState } from './query/summary-tasks.ts'
import { rawWechatBase } from './gateway-support.ts'
import { cancelJobIn } from './gateway-job-signals.ts'
import { GatewayCore } from './gateway-core.ts'

/** 方法面的一层：继承链上的一环，不单独实例化（abstract：`runSummaryTask` 由更下面那层实现）。 */
export abstract class GatewayRead extends GatewayCore {
  @Remote('getSessions')
  async getSessions(options?: { keyword?: string; limit?: number; offset?: number }): Promise<SessionsSnapshot> {
    return querySessions(this._dirs.decrypted, options?.keyword, options?.limit, options?.offset)
  }

  /**
   * Contact book.
   * @param options - Optional page size + offset for incremental loading, plus a
   *   category filter (friend/group/official/service/enterprise/member/system/deleted).
   *   The filter is applied **before** pagination so a category tab shows its own
   *   complete list and an accurate `total`.
   * @returns ContactsSnapshot: contacts list (items + total) + per-category stats.
   */
  @Remote('getContacts')
  getContacts(options?: { limit?: number; offset?: number; category?: string }): ContactsSnapshot {
    return queryContacts(this._dirs.decrypted, options)
  }

  /**
   * One-screen data overview.
   * @returns OverviewSnapshot: aggregate counts for the overview screen.
   */
  @Remote('getOverviewInsights')
  async getOverviewInsights(): Promise<OverviewInsights> {
    return queryOverviewInsights(this._dirs.decrypted, this.selfUsername())
  }

  @Remote('getOverview')
  async getOverview(): Promise<OverviewSnapshot> {
    return queryOverview(this._dirs.decrypted)
  }

  /**
   * Friend-region map (世界板块地图): world → country → province → city → friends.
   * @returns RegionMapSnapshot.
   */
  @Remote('getRegionMap')
  getRegionMap(): RegionMapSnapshot {
    return queryRegionMap(this._dirs.decrypted)
  }

  /**
   * Records (revokes/transfers/redpackets/finder/miniprograms/friendverifications).
   * @param options - Record kind to query plus pagination/filter options.
   * @returns RecordsSnapshot: record items (items + total).
   */
  @Remote('getRecords')
  getRecords(options: { kind: string; limit?: number; offset?: number; q?: string; from?: number; to?: number; direction?: 'asc' | 'desc' }): RecordsSnapshot {
    return queryRecords(this._dirs.decrypted, options.kind, options.limit, options.offset, options.q, options)
  }

  /**
   * Contact / group-member search.
   * @param options - search term, optional limit and room scope.
   * @returns MemberSearchSnapshot: matching members (items + total + source).
   * 保留理由：界面暂无入口（全局搜索走 searchUnified），保留给宿主/后续的群成员选择器。
   *   第 96 轮补上了群内路径漏掉的 `quan_pin`/`alias`（此前「按备注全拼在群里搜人」永远搜不到）；
   *   第 97 轮才发现 FTS 那条路径同样漏着（`contact_fts` 只有 `name` 可检索），且它才是默认路径。
   *   把关：`wechat-data/tests/members-search-columns.spec.ts`。
   */
  @Remote('searchMembers')
  searchMembers(options: { q: string; limit?: number; roomUsername?: string }): MemberSearchSnapshot {
    return searchMembers(this._dirs.decrypted, options.q, options)
  }

  /**
   * Revoked messages.
   * @param options - Optional limit for the number of rows returned.
   * @returns RevokedSnapshot: revoked message items.
   */
  @Remote('getRevoked')
  getRevoked(options?: { limit?: number; offset?: number; q?: string }): RevokedSnapshot {
    return queryRevoked(this._dirs.decrypted, options?.limit, options?.offset, options?.q)
  }

  /**
   * Storage stats.
   * @returns StorageSnapshot: per-category storage usage stats.
   */
  @Remote('getStorageStats')
  async getStorageStats(): Promise<StorageSnapshot> {
    return queryStorageStats(this._dirs.decrypted, rawWechatBase(this._dirs.decrypted) || undefined)
  }

  /**
   * Annual years.
   * @returns AnnualSnapshot: available yearly overview data.
   */
  @Remote('getAnnual')
  async getAnnual(): Promise<AnnualSnapshot> {
    return queryAnnual(this._dirs.decrypted)
  }

  /**
   * Relationship graph.
   * @returns GraphSnapshot: chat relationship graph data.
   */
  @Remote('getGraph')
  async getGraph(): Promise<GraphSnapshot> {
    return queryGraph(this._dirs.decrypted, this.selfUsername())
  }

  /**
   * Moments page.
   * @param options - Pagination (offset/limit) and optional author filter.
   * @returns MomentsSnapshot: moments items (items + total).
   */
  @Remote('getMoments')
  getMoments(options?: { offset?: number; limit?: number; author?: string }): MomentsSnapshot {
    // Pass selfUsername so queryMoments can mark is_self (drives the "我" tag + 范围 filter).
    return queryMoments(this._dirs.decrypted, options?.offset, options?.limit, options?.author, this.selfUsername())
  }

  /**
   * Return the current account's own WeChat username (user_name).
   * @returns { username } - used by the panel to filter "我" authored comments.
   */
  @Remote('getSelfUsername')
  getSelfUsername(): { username: string } {
    return { username: this.selfUsername() }
  }

  /**
   * 当前账号的展示信息（备注 > 昵称 > 微信号），供侧栏品牌位显示用户网名。
   * 只读 contact.db 自己那一行；未解密/取不到时 name 为空串（调用方回退品牌名）。
   * @returns SelfProfile.
   */
  @Remote('getSelfProfile')
  getSelfProfile(): SelfProfile {
    return querySelfProfile(this._dirs.decrypted)
  }

  /**
   * Full-history author activity counts (ranked desc).
   * @returns Array of { name, count } for every moments author.
   */
  @Remote('getMomentsAuthors')
  getMomentsAuthors(): Array<{ name: string; count: number }> {
    return queryMomentsAuthors(this._dirs.decrypted)
  }

  /**
   * Favorites list.
   * @param options - Optional limit for the number of rows returned.
   * @returns FavoritesSnapshot: favorite items (items + total).
   */
  @Remote('getFavorites')
  getFavorites(options?: { limit?: number; offset?: number; q?: string }): FavoritesSnapshot {
    return queryFavorites(this._dirs.decrypted, options?.limit, options?.offset, options?.q)
  }

  /**
   * Messages of one talker.
   * @param options - Talker username, optional limit and pagination cursor.
   * @returns MessagesSnapshot: message items for the talker.
   */
  @Remote('getMessages')
  getMessages(options: { talker: string; limit?: number; cursor?: number; cursorLocalId?: number }): MessagesSnapshot {
    return queryMessages(
      this._dirs.decrypted, options.talker, options.limit, options.cursor,
      this.selfUsername(), options.cursorLocalId,
    )
  }

  /**
   * Incremental messages newer than a sort_seq watermark (real-time polling).
   * @param options - talker, after watermark, optional limit.
   * @returns MessagesSnapshot with only the newer messages.
   */
  @Remote('getNewMessages')
  getNewMessages(options: { talker: string; after: number; limit?: number }): MessagesSnapshot {
    return queryNewMessages(this._dirs.decrypted, options.talker, options.after, options.limit, this.selfUsername())
  }

  /**
   * 新建「聊天素材收集任务」：保留某会话最近 N 条文本 + M 张图片到任务目录。
   *
   * 图片解码密钥与账号根目录只在这一层解析（query 层不 import gateway-support，
   * 避免 query → gateway 的反向依赖）。
   */
  @Remote('createChatCollectTask')
  async createChatCollectTask(options: { username: string; displayName?: string; textLimit?: number; imageLimit?: number }): Promise<ChatCollectTaskResult> {
    const base = rawWechatBase(this._dirs.decrypted) || undefined
    const { aesKey, xorKey } = resolveImageKeyPair(this._dirs.decrypted)
    return createChatCollectTask(this._dirs.decrypted, this._dirs.decoded, {
      ...options,
      selfUsername: this.selfUsername(),
      ...(base === undefined ? {} : { wechatBaseDir: base }),
      ...(aesKey === undefined ? {} : { aesKey }),
      xorKey,
    })
  }

  /** 收集任务列表（最新在前；`readError` 与「确实没有任务」区分）。 */
  @Remote('listChatCollectTasks')
  listChatCollectTasks(): ChatCollectTaskSnapshot {
    return listChatCollectTasks(this._dirs.decrypted)
  }

  /**
   * Search index status.
   * @returns SearchIndexStatus: whether the FTS5 index exists and its row count.
   */
  @Remote('getSearchIndexStatus')
  getSearchIndexStatus(): SearchIndexStatus {
    return getSearchIndexStatus(this._dirs.decrypted)
  }

  /**
   * 取消一次正在跑的消息搜索（N9）。
   * @param options - `jobId` 为渲染层生成的任务标识。
   * @returns `ok: true` 表示确实打断了一个在跑的搜索；找不到（已跑完/从未注册）时为 false。
   */
  @Remote('cancelSearch')
  cancelSearch(options?: { jobId?: string }): { ok: boolean } {
    return { ok: cancelJobIn(this._searchJobs, options?.jobId) }
  }

  /**
   * Group chat info (群聊信息): name/remark, announcement, own alias, member
   * grid and local settings mirror.
   * @param options - chatroom username.
   * @returns GroupInfoSnapshot: the group (null when unknown).
   */
  @Remote('getGroupInfo')
  getGroupInfo(options: { username: string }): GroupInfoSnapshot {
    return queryGroupInfo(this._dirs.decrypted, options.username, this.selfUsername())
  }

  /**
   * Resolve a nested merged chat-log pointer by server_id.
   * @param options - the record's fromnewmsgid (server_id) value.
   * @returns ChatHistoryResolveResult: found flag plus the parsed message.
   */
  /**
   * Authoritative transfer/redpacket status by message server_id.
   * @param options - the message server_id (string, may exceed 2^53).
   * @returns PaymentStatus: found flag plus authoritative fields.
   */
  @Remote('getPaymentStatus')
  getPaymentStatus(options: { serverId: string }): PaymentStatus {
    return queryPaymentStatus(this._dirs.decrypted, options.serverId)
  }

  @Remote('resolveChatHistory')
  async resolveChatHistory(options: { serverId: string }): Promise<ChatHistoryResolveResult> {
    return queryMessageByServerId(this._dirs.decrypted, options.serverId)
  }

  /**
   * Per-day message counts for one month (chat calendar heatmap).
   * @param options - username, year and month to aggregate.
   * @returns CalendarSnapshot: per-day message counts.
   */
  @Remote('getDailyCounts')
  getDailyCounts(options: { username: string; year: number; month: number }): CalendarSnapshot {
    return getDailyCounts(this._dirs.decrypted, options.username, options.year, options.month)
  }

  /**
   * 重置调参权重回默认值（丢弃反馈带来的偏移；反馈记录本身保留）。
   */
  @Remote('resetRetrievalWeights')
  resetRetrievalWeights(): { ok: boolean; weights: RerankWeights } {
    const cfg = loadRetrievalConfig(this._dirs.decrypted)
    saveAdaptedWeights(this._dirs.decrypted, cfg.rerank.weights)
    this.op('settings', 'reset_retrieval_weights', 'ok')
    return { ok: true, weights: cfg.rerank.weights }
  }

  /**
   * List edited messages (optionally for one session).
   * @param options - optional sessionId filter.
   * @returns EditedListSnapshot: edited message records (items + total).
   */
  @Remote('listEditedMessages')
  listEditedMessages(options?: { sessionId?: string }): EditedListSnapshot {
    return listEdits(this._dirs.decrypted, options?.sessionId)
  }

  /**
   * Edit one message content (records the original in the edit store).
   * @param options - username, localId and new content.
   * @returns EditMutationResult: ok, or error on failure.
   */
  @Remote('editChatMessage')
  editChatMessage(options: { username: string; localId: number; content: string }): EditMutationResult {
    const r = editMsg(this._dirs.decrypted, options.username, options.localId, options.content)
    this.op('edit', 'edit_chat_message', r.ok ? 'ok' : 'fail', options.username, r.error ?? `localId=${options.localId}`)
    return r
  }

  /**
   * 删除若干条问答历史。
   *
   * 与导出历史不同，这里**没有**「连带删除外部文件」这个选项 —— 问答记录的内容全部在库里，
   * 删记录就是删全部，没有第二个动作会顺手动到用户磁盘上的东西。
   * @param options - ids。
   * @returns 实际删除条数。
   */
  @Remote('deleteAskHistory')
  deleteAskHistory(options: { ids: number[] }): AskHistoryDeleteResult {
    const ids = Array.isArray(options?.ids) ? options.ids : []
    const r = deleteAskHistory(this._dirs.decrypted, ids)
    this.op('delete', 'delete_ask_history', r.removed > 0 ? 'ok' : 'skip', String(r.removed), `${r.removed} 条问答记录`)
    return r
  }

  /**
   * 清空全部问答历史（由界面上的显式入口 + 二次确认触发，不做任何自动清理）。
   * @returns 实际删除条数。
   */
  @Remote('clearAskHistory')
  clearAskHistory(): AskHistoryClearResult {
    const r = clearAskHistory(this._dirs.decrypted)
    this.op('delete', 'clear_ask_history', r.removed > 0 ? 'ok' : 'skip', String(r.removed), `${r.removed} 条问答记录`)
    return r
  }

  /**
   * Clear one session draft (decrypted copy only).
   * @param options - username of the session to clear.
   * @returns DraftClearResult: ok, or error on failure.
   */
  @Remote('clearSessionDraft')
  clearSessionDraft(options: { username: string }): DraftClearResult {
    const r = clearDraft(this._dirs.decrypted, options.username)
    this.op('delete', 'clear_session_draft', r.ok ? 'ok' : 'fail', options.username, r.error ?? `已清除 ${r.updated} 条草稿`)
    return r
  }

  /**
   * Clear all session drafts, returning the cleared list.
   * @returns DraftsClearResult: cleared session list (items + total).
   */
  @Remote('clearAllSessionDrafts')
  clearAllSessionDrafts(): DraftsClearResult {
    const r = clearAllDrafts(this._dirs.decrypted)
    this.op('delete', 'clear_all_session_drafts', r.ok ? 'ok' : 'fail', '', r.error ?? `已清除 ${r.count} 个会话草稿`)
    return r
  }

  /**
   * List generated summary records.
   * @param options - optional taskId filter.
   * @returns SummaryRecordSnapshot: summary records (items + total).
   */
  @Remote('listSummaryRecords')
  listSummaryRecords(options?: { taskId?: number }): SummaryRecordSnapshot {
    return listRecs(this._dirs.decrypted, options?.taskId)
  }

  /**
   * Detect installed WeChat 4.x accounts.
   * @returns AccountsSnapshot: detected accounts (accounts + total).
   */
  @Remote('detectWechatAccounts')
  detectWechatAccounts(): AccountsSnapshot {
    const accounts: WechatAccount[] = detectWechatAccounts()
    const snapshot: AccountsSnapshot = { accounts, total: accounts.length }
    const installDir = weixinInstallPath()
    if (installDir) {
      snapshot.install_dir = installDir
      const version = weixinVersion(installDir)
      if (version) snapshot.version = version
    }
    this.op('keys', 'detect_accounts', 'ok', '', `发现 ${snapshot.total} 个账号`)
    return snapshot
  }

  /**
   * Verify a database key (SQLCipher PBKDF2 + AES + HMAC).
   * @param options - dbPath and encKeyHex of the key to verify.
   * @returns VerifyKeyResult: valid flag plus optional AES/HMAC checks.
   */
  @Remote('verifyDatabaseKey')
  verifyDatabaseKey(options: { dbPath: string; encKeyHex: string }): VerifyKeyResult {
    const r = verifyDatabaseKey(options.dbPath, options.encKeyHex)
    this.op('keys', 'verify_db_key', r.valid ? 'ok' : 'fail', options.dbPath, r.error ?? (r.valid ? '有效' : '无效'))
    return r
  }

  /**
   * Verify the saved image key pair against real V2 templates.
   * @returns VerifyImageKeyResult: verified flag + xor/template evidence.
   */
  /** Open the owned WeChat config.json (e.g. for manual edit). @returns the opened path. */
  /**
   * Open an owned path (config/output dir/file) with the system default.
   *
   * P2-6：这条路在 vendored 依赖里最终走到 `powershell.exe … Invoke-Item`，
   * 而对 `.exe` 那就是**直接执行** —— 渲染层被控时就成了 RCE 原语。
   * 现在只允许打开数据根之内、或应用确实往里写过产出的目录（导出对话框选过的位置），
   * 且可执行/脚本扩展名一律拒。被拒不等于静默失败：理由要回给界面，
   * 否则用户看到的又是「点了没反应」（P1-1 那一族的反面）。
   * @param options - 要打开的路径。
   * @param signal - 调用取消信号。
   * @returns 打开结果与被拒理由。
   */
  @Remote('openPath')
  async openPath(options: { path: string }, signal: AbortSignal = new AbortController().signal): Promise<{ ok: boolean; path: string; error?: string }> {
    const p = options.path
    const dataRoot = join(this._dirs.decrypted, '..')
    /*
     * ⚠️ 2026-10-17：应用有**两个**自己的数据目录，它们是兄弟关系：
     *   · `<userData>/wechat-data/` —— 解密快照、导出、缓存（= `dataRoot`）；
     *   · `<userData>/wechat/` —— `config.json` / `llm.json` / `logs/`（配置与日志）。
     * 设置弹窗底部那个「配置: wechat/config.json ↗」要打开的是**后者** ——
     * 它不在 `dataRoot` 之下，于是被路径政策拒掉，用户看到的就是「点了没反应」
     * （真机实测：`openPath` 返回 `ok:false` + 「只能打开应用自己数据目录内的文件」）。
     *
     * 只放行**这两个**兄弟目录，不放行整个 `<userData>/` —— 那里还有 Electron 自己的
     * 缓存（`Cache` / `GPUCache` / `Local Storage` …）与 `license.json`，
     * 它们不是「用户该去手动编辑的东西」。
     */
    const userData = join(dataRoot, '..')
    const extraRoots = [join(userData, 'wechat'), join(userData, 'wechat-data')]
    const denial = openDenialReason(p, dataRoot, extraRoots)
    if (denial !== null) return { ok: false, path: p, error: denial }
    try {
      await openNativePath(p, signal)
      return { ok: true, path: p }
    } catch {
      return { ok: false, path: p, error: '系统没能打开这个路径' }
    }
  }

  /**
   * Cached transcript for one voice message (if already transcribed).
   * @param options - message username + local_id.
   * @returns VoiceTranscriptResult: text or an error.
   */
  @Remote('getVoiceTranscript')
  getVoiceTranscript(options: { username: string; localId: number }): VoiceTranscriptResult {
    const svrId = svrIdByChatLocal(this._dirs.decrypted, options.username, options.localId)
    if (!svrId) return { error: '未找到语音消息' }
    const text = cachedTranscript(this._dirs.decoded, svrId)
    return text ? { text } : { error: '尚未转写' }
  }

  /**
   * Transcribe one voice message on demand (chat bubble 语音转文字).
   * @param options - message username + local_id.
   * @returns VoiceTranscribeOneResult: ok + text, or an error.
   */
  @Remote('transcribeVoiceMessage')
  async transcribeVoiceMessage(options: { username: string; localId: number }): Promise<VoiceTranscribeOneResult> {
    if (this.whisperTranscribing.active) { this.op('task', 'transcribe_voice_message', 'fail', options.username, '已有转写任务进行中'); return { ok: false, error: '已有转写任务进行中' } }
    const cfg = getConfig(this._dirs.decrypted)
    const modelsDir = resolveWhisperModelsDir(cfg['whisper_models_dir'] as string | undefined, this._dirs.decrypted)
    const configBin = typeof cfg['whisper_bin'] === 'string' ? cfg['whisper_bin'] : ''
    const engine = whisperEnginePath(configBin, modelsDir)
    if (!engine) { this.op('task', 'transcribe_voice_message', 'fail', options.username, '未检测到 whisper.cpp 引擎'); return { ok: false, error: '未检测到 whisper.cpp 引擎（可在第 5 步点击「下载引擎」）' } }
    const modelId = typeof cfg['whisper_model'] === 'string' && cfg['whisper_model'] ? cfg['whisper_model'] : 'medium'
    const r = await transcribeOneVoiceAsync(this._dirs.decrypted, this._dirs.decoded, modelsDir, modelId, engine, options.username, options.localId)
    this.op('task', 'transcribe_voice_message', r.ok ? 'ok' : 'fail', options.username, r.error ?? '转写成功')
    return r
  }

  /**
   * Delete favorite items by local_id.
   * @param options - ids of the favorite items to delete.
   * @returns DeleteFavoriteResult: ok + deleted count, or error.
   */
  @Remote('deleteFavoriteItems')
  deleteFavoriteItems(options: { ids: number[] }): DeleteFavoriteResult {
    const r = deleteFavoriteItems(this._dirs.decrypted, options.ids)
    this.op('delete', 'delete_favorite_items', r.ok ? 'ok' : 'fail', '', r.error ?? `删除 ${r.deleted} 项`)
    return r
  }

  /**
   * 年度回顾（看板）：15 张卡片所需的完整年度聚合。
   * 「人物类」指标只算我发出的（real_sender_id 归属），「规模类」算全部消息。
   * @param options - year to compute the report for.
   * @returns AnnualReview: 完整看板数据。
   */
  @Remote('getAnnualReview')
  async getAnnualReview(options: { year: number }): Promise<AnnualReview> {
    try {
      // 2026-09-28：`queryAnnualReview` 改 async —— 实测本方法冷跑 **2150ms 且一次都不让出**。
      const r = await queryAnnualReview(this._dirs.decrypted, options.year, this.selfUsername())
      this.op('task', 'annual_review', 'ok', String(options.year),
        `发出 ${r.sent} · 全部 ${r.ranking.reduce((a, x) => a + x.total, 0)} · 活跃 ${r.activeDaysMine} 天`)
      return r
    } catch (e) {
      this.op('task', 'annual_review', 'fail', String(options.year), (e as Error).message)
      throw e
    }
  }

  @Remote('getAnnualReport')
  async getAnnualReport(options: { year: number }): Promise<AnnualReport> {
    try {
      // 2026-09-28：`queryAnnualReport` 改 async —— 真实 @Remote 探针实测本方法
      // 冷跑 **2254ms 且一次都不让出**（`working/probe-remote.txt`）。
      const r = await queryAnnualReport(this._dirs.decrypted, options.year) as unknown as AnnualReport
      this.op('task', 'generate_annual_report', 'ok', String(options.year), `共 ${r.total} 条`)
      return r
    } catch (e) {
      this.op('task', 'generate_annual_report', 'fail', String(options.year), (e as Error).message)
      throw e
    }
  }

  /**
   * Resolve a 公众号 article cover (og:image) to a base64 data URL.
   *
   * A4（2026-09-28）：先用朋友圈媒体索引确认本机有没有这张图 —— **索引命中才截流**，
   * 没命中一律照旧出网（见 `article-cover.ts` 的 `LocalCoverProbe`）。
   * @param options - mp.weixin.qq.com article URL.
   * @returns ImageDataUrlResult: base64 data URL or error.
   */
  @Remote('getArticleCover')
  async getArticleCover(options: { contentUrl: string }): Promise<ImageDataUrlResult> {
    return resolveArticleCoverDataUrl(
      options.contentUrl, this._dirs.decoded, buildCoverLocalProbe(this._dirs),
    )
  }

  /**
   * 批量解析公众号文章封面（A1，2026-09-28 性能修复）。
   *
   * 现场日志里 `getArticleCover` 是最频繁的慢调用（1221 次 / 均 1.9s），根因是前端逐张发 RPC。
   * 这个批量壳把一屏的封面收成一个 RPC，后端按 `COVER_CONCURRENCY` 分批并发。
   * A4 之后本机已有封面的那些**连网络都不出**（同一个探测函数）。
   * @param options - `urls` 为一屏待解析的文章链接（自动去重、忽略空串）。
   * @returns 逐条结果（键 = 请求的 url），顺序与去重后的入参一致。
   */
  @Remote('getArticleCovers')
  async getArticleCovers(options: { urls: readonly string[] }): Promise<ArticleCoversResult> {
    return {
      items: await resolveArticleCoversDataUrls(
        options.urls, this._dirs.decoded, buildCoverLocalProbe(this._dirs),
      ),
    }
  }

  @Remote('getAssetInsights')
  async getAssetInsights(): Promise<AssetInsightsSnapshot> {
    return queryAssetInsights(this._dirs.decrypted)
  }

  @Remote('getContact360')
  getContact360(options: { username: string }): Contact360Snapshot {
    return queryContact360(this._dirs.decrypted, options.username)
  }

  @Remote('getCalls')
  async getCalls(options?: { topPeers?: number; recentLimit?: number }): Promise<CallsSnapshot> {
    return queryCalls(this._dirs.decrypted, this.selfUsername(), options?.topPeers, options?.recentLimit)
  }

  @Remote('getGroupInsights')
  getGroupInsights(options: { username: string }): GroupInsightsSnapshot {
    return queryGroupInsights(this._dirs.decrypted, options.username)
  }

  @Remote('getLedger')
  async getLedger(options?: { month?: string }): Promise<LedgerSnapshot> {
    return queryLedger(this._dirs.decrypted, options?.month, this.selfUsername())
  }

  @Remote('getMediaAssets')
  getMediaAssets(): MediaAssetsSnapshot {
    return queryMediaAssets(this._dirs.decrypted)
  }

  @Remote('getWordCloud')
  async getWordCloud(options?: WordCloudOptions): Promise<WordCloudResult> {
    return this.wordcloudRemotes().getWordCloud(options)
  }

  @Remote('getMomentsInsights')
  async getMomentsInsights(options?: { author?: string }): Promise<MomentsInsightsSnapshot> {
    return queryMomentsInsights(this._dirs.decrypted, options?.author)
  }

  @Remote('getMomentsMonthly')
  async getMomentsMonthly(options?: { author?: string; authorName?: string }): Promise<MomentsMonthlySnapshot> {
    return queryMomentsMonthly(this._dirs.decrypted, options?.author, options?.authorName)
  }

  @Remote('getOfficialAssets')
  async getOfficialAssets(): Promise<OfficialAssetsSnapshot> {
    return queryOfficialAssets(this._dirs.decrypted)
  }

  @Remote('searchUnified')
  searchUnified(options: { query: string; limit?: number }): UnifiedSearchSnapshot {
    return searchUnified(this._dirs.decrypted, options.query, options.limit)
  }
}

/**
 * 构造 A4 的「本机有没有这张封面」探测函数。
 *
 * 为什么要包一层而不是直接传 `findSnsMediaFileByIndex`：
 *   ① 微信原始目录只在这里解析（`rawWechatBase`），且可能为 undefined（没配）；
 *   ② 这里还要拿到 AES/XOR 密钥（`resolveImageKeyPair`）—— 索引要按解密后的 md5 比对；
 *   ③ 探测必须交回**可渲染的 data URL** 才叫「本机有这份封面」，解不开就返回
 *      undefined（让调用方照旧出网），绝不把坏文件当成命中。
 * 任一环节出问题都返回一个恒 undefined 的探测 ⇒ 行为退回 A4 之前。
 *
 * ⚠ 这是**模块级函数**，不是 `GatewayRead` 的私有方法：`gateway-read-shell.spec.ts`
 * 的守卫要求 `GatewayRead.prototype` 上每个方法都必须带 `@Remote`（防漏装饰器），
 * 私有辅助方法挂 prototype 会稳定违反它（实测红过一次）。
 */
function buildCoverLocalProbe(dirs: { decrypted: string }): LocalCoverProbe | undefined {
  const base = rawWechatBase(dirs.decrypted)
  if (!base) return undefined
  // 成本闸门：本会话还没建过任何朋友圈索引 ⇒ 不建探测函数。
  // 这样「用户没进过朋友圈」时 A4 的成本为零（否则会为他多扫一个月的图片目录）。
  if (!hasSnsMediaIndexEntries()) return undefined
  const { aesKey, xorKey } = resolveImageKeyPair(dirs.decrypted)
  return (contentUrl: string) => {
    // 公众号封面在 SNS 媒体库里以 `md5(contentUrl)` 作为查表键（与 `sns-image.ts` 同一算法）。
    const key = createHash('md5').update(contentUrl, 'utf8').digest('hex')
    return findSnsMediaDataUrlByIndex(base, aesKey, xorKey, key)
  }
}
