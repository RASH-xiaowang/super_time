/**
 * WechatDataGateway 方法面 · 只读快照与本地逻辑壳（数据读取 / 检索取消 / 历史删除）（M21 结构刀自 gateway.ts 拆出）。
 *
 * 这一层只有 `@Remote` 壳（装饰器 + 签名 + 一行转发）；装饰器标记会落到**最派生原型**上，
 * 因此协议层枚举到的方法面与拆分前逐名相同（守卫：`gateway-remote-surface.spec.ts`）。
 */

import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type { AccountsSnapshot, AnnualReport, AnnualSnapshot, AskHistoryClearResult, AskHistoryDeleteResult, AskHistoryQuery, AskHistorySnapshot, AskOptimizeResult, AskResult, AutoDbKeyResult, AutoImageKeyResult, AvatarResult, BackupMutationResult, BackupPreviewSnapshot, BackupSnapshot, CalendarSnapshot, CallsSnapshot, ChatHistoryResolveResult, ConfigSnapshot, ContactsSnapshot, DailySummaryResult, DbStatusSnapshot, DecryptAllResult, DecryptImagesResult, DecryptStatus, DeleteFavoriteResult, DraftClearResult, DraftsClearResult, EditMutationResult, EditedListSnapshot, EmoticonsSnapshot, ExportResult, ExportStatus, ExportHistoryDeleteResult, ExportHistoryQuery, ExportHistorySnapshot, ExportHistoryPruneOptions, FavoritesSnapshot, FilesSnapshot, GenerateKeysResult, GraphSnapshot, GroupInfoSnapshot, ImageDataUrlResult, KeysInfoResult, MemberSearchSnapshot, MessagesSnapshot, MomentsSnapshot, OverviewInsights, OverviewSnapshot, PaymentStatus, PrivacySnapshot, RecordsSnapshot, RevokedSnapshot, SearchBuildResult, SearchIndexStatus, SearchSnapshot, SessionsSnapshot, SimpleResult, StorageSnapshot, SummaryRecord, SummaryRecordSnapshot, SummaryTask, SummaryTaskMutationResult, SummaryTaskRunResult, SummaryTaskSnapshot, VerifyImageKeyResult, VerifyKeyResult, VideoInfoResult, VoiceDataUrlResult, VoiceInfoResult, VoiceTranscriptResult, VoiceTranscribeOneResult, VoiceTranscribeResult, WechatAccount, WechatConfigFull, WechatConfigPatch, WhisperDownloadProgress, WhisperDownloadResult, WhisperStatus, WhisperTranscribing, AssetInsightsSnapshot, BackupRestoreResult, Contact360Snapshot, DbHealthSnapshot, GroupInsightsSnapshot, HandoffRemindsSnapshot, LedgerSnapshot, MediaAssetsSnapshot, MomentsInsightsSnapshot, MomentsMonthlyRow, OfficialAssetsSnapshot, OperationCategory, OperationLogClearResult, OperationLogQuery, OperationLogSnapshot, OperationStatus, PeriodSummaryResult, PrivacyAuditClearResult, PrivacyAuditRow, PrivacyStateSnapshot, RegionMapSnapshot, TaskMutationResult, TasksSnapshot, UnifiedSearchSnapshot, KnowledgeSnapshot, NotesSnapshot, NoteMutationResult, KbDeleteAction, KbListSnapshot, KbMeta, KbMutationResult } from './types.ts'
import { querySessions } from './query/sessions.ts'
import { queryGroupInfo } from './query/group-info.ts'
import { queryPaymentStatus } from './query/payments.ts'
import { queryContacts } from './query/contacts.ts'
import { queryRegionMap } from './query/region-map.ts'
import { queryMessageByServerId, queryMessages, queryNewMessages } from './query/messages.ts'
import { queryMoments, queryMomentsAuthors } from './query/moments.ts'
import { deleteFavoriteItems, queryFavorites } from './query/favorites.ts'
import { queryOverview } from './query/overview.ts'
import { queryRecords, queryRevoked } from './query/records.ts'
import { queryStorageStats } from './query/storage.ts'
import { queryAnnual } from './query/annual.ts'
import { openNativePath } from '@deepseek-ai/dsh-native-command'
import { queryCalls } from './query/calls.ts'
import { queryGraph } from './query/graph.ts'
import { getDailyCounts } from './query/calendar.ts'
import { buildSearchIndex, ensureSearchIndex, getSearchIndexStatus, knownEntityNames, searchIndexMessages, searchIndexMessagesCancellable } from './query/search.ts'
import { searchMembers } from './query/members.ts'
import { resolveArticleCoverDataUrl } from './query/article-cover.ts'
import { queryOverviewInsights } from './query/overview-insights.ts'
import { detectWechatAccounts, generateKeysFile, getConfig, getKeysInfo, saveConfig, verifyDatabaseKey, weixinInstallPath, weixinVersion } from './query/config.ts'
import { WHISPER_DOWNLOAD_FILES, installWhisperEngine, migrateWhisperEngineDir, migrateWhisperModels, resolveWhisperModelsDir, whisperDownloadModel, whisperEnginePath, whisperHasCuda, whisperModelsStatus } from './query/whisper.ts'
import { cachedTranscript, transcribeOneVoice, transcribeVoiceBatch } from './query/voice-transcribe.ts'
import { resolveVoiceDataUrl, svrIdByChatLocal } from './query/voice.ts'
import { clearAskHistory, deleteAskHistory, listAskHistory, recordAsk } from './query/ask-history.ts'
import { loadRetrievalConfig, saveRetrievalConfig as saveRetrievalConfigFile, defaultRetrievalConfig } from './query/retrieval/config.ts'
import { adaptWeights, attributeFeatures, feedbackStats, listFeedback, loadAdaptedWeights, recordFeedback, saveAdaptedWeights } from './query/retrieval/feedback.ts'
import type { FeedbackRecord, IntentKind, RerankWeights } from './query/retrieval/types.ts'
import { queryLedger } from './query/ledger.ts'
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
import { normalizeJobId, rawWechatBase } from './gateway-support.ts'
import { GatewayCore } from './gateway-core.ts'

/** 方法面的一层：继承链上的一环，不单独实例化（abstract：`runSummaryTask` 由更下面那层实现）。 */
export abstract class GatewayRead extends GatewayCore {
  @Remote('getSessions')
  getSessions(options?: { keyword?: string; limit?: number; offset?: number }): SessionsSnapshot {
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
  getOverviewInsights(): OverviewInsights {
    return queryOverviewInsights(this._dirs.decrypted, this.selfUsername())
  }

  @Remote('getOverview')
  getOverview(): OverviewSnapshot {
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
   *   第 96 轮补上了群内路径漏掉的 `quan_pin`/`alias`（此前「按备注全拼在群里搜人」永远搜不到），
   *   由 `scripts/check-members-search.js` 对着真实库把关。
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
  getStorageStats(): StorageSnapshot {
    return queryStorageStats(this._dirs.decrypted, rawWechatBase(this._dirs.decrypted) || undefined)
  }

  /**
   * Annual years.
   * @returns AnnualSnapshot: available yearly overview data.
   */
  @Remote('getAnnual')
  getAnnual(): AnnualSnapshot {
    return queryAnnual(this._dirs.decrypted)
  }

  /**
   * Relationship graph.
   * @returns GraphSnapshot: chat relationship graph data.
   */
  @Remote('getGraph')
  getGraph(): GraphSnapshot {
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
    const id = normalizeJobId(options?.jobId)
    const ctrl = id === '' ? undefined : this._searchJobs.get(id)
    if (!ctrl) return { ok: false }
    ctrl.abort()
    return { ok: true }
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
  resolveChatHistory(options: { serverId: string }): ChatHistoryResolveResult {
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
  /** Open an owned path (config/output dir/file) with the system default. @returns the opened path. */
  @Remote('openPath')
  async openPath(options: { path: string }, signal: AbortSignal): Promise<{ ok: boolean; path: string }> {
    const p = options.path
    try {
      await openNativePath(p, signal)
      return { ok: true, path: p }
    } catch {
      return { ok: false, path: p }
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
  transcribeVoiceMessage(options: { username: string; localId: number }): VoiceTranscribeOneResult {
    if (this.whisperTranscribing.active) { this.op('task', 'transcribe_voice_message', 'fail', options.username, '已有转写任务进行中'); return { ok: false, error: '已有转写任务进行中' } }
    const cfg = getConfig(this._dirs.decrypted)
    const modelsDir = resolveWhisperModelsDir(cfg['whisper_models_dir'] as string | undefined, this._dirs.decrypted)
    const configBin = typeof cfg['whisper_bin'] === 'string' ? cfg['whisper_bin'] : ''
    const engine = whisperEnginePath(configBin, modelsDir)
    if (!engine) { this.op('task', 'transcribe_voice_message', 'fail', options.username, '未检测到 whisper.cpp 引擎'); return { ok: false, error: '未检测到 whisper.cpp 引擎（可在第 5 步点击「下载引擎」）' } }
    const modelId = typeof cfg['whisper_model'] === 'string' && cfg['whisper_model'] ? cfg['whisper_model'] : 'medium'
    const r = transcribeOneVoice(this._dirs.decrypted, this._dirs.decoded, modelsDir, modelId, engine, options.username, options.localId)
    this.op('task', 'transcribe_voice_message', r.ok ? 'ok' : 'fail', options.username, r.error ?? '转写成功')
    return r
  }

  /**
   * Set CDN auto-fetch flag.
   * @param options - enabled: whether CDN auto-fetch is on.
   * @returns SimpleResult: ok, or error on failure.
   */
  @Remote('setCdnImageEnabled')
  setCdnImageEnabled(options: { enabled: boolean }): SimpleResult {
    const r = saveConfig(this._dirs.decrypted, { cdn_enabled: options.enabled })
    this.op('settings', 'set_cdn_image_enabled', r.ok ? 'ok' : 'fail', '', r.error ?? (options.enabled ? '开启' : '关闭'))
    return r
  }

  /**
   * Set CDN local/service decrypt flag.
   * @param options - localDecrypt: whether decryption runs locally.
   * @returns SimpleResult: ok, or error on failure.
   */
  @Remote('setCdnImageLocalDecrypt')
  setCdnImageLocalDecrypt(options: { localDecrypt: boolean }): SimpleResult {
    const r = saveConfig(this._dirs.decrypted, { cdn_local_decrypt: options.localDecrypt })
    this.op('settings', 'set_cdn_image_local_decrypt', r.ok ? 'ok' : 'fail', '', r.error ?? (options.localDecrypt ? '本地解密' : '服务端解密'))
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
  /**
   * 年度回顾（看板）：15 张卡片所需的完整年度聚合。
   * 「人物类」指标只算我发出的（real_sender_id 归属），「规模类」算全部消息。
   * @param options - year to compute the report for.
   * @returns AnnualReview: 完整看板数据。
   */
  @Remote('getAnnualReview')
  getAnnualReview(options: { year: number }): AnnualReview {
    try {
      const r = queryAnnualReview(this._dirs.decrypted, options.year, this.selfUsername())
      this.op('task', 'annual_review', 'ok', String(options.year),
        `发出 ${r.sent} · 全部 ${r.ranking.reduce((a, x) => a + x.total, 0)} · 活跃 ${r.activeDaysMine} 天`)
      return r
    } catch (e) {
      this.op('task', 'annual_review', 'fail', String(options.year), (e as Error).message)
      throw e
    }
  }

  @Remote('getAnnualReport')
  getAnnualReport(options: { year: number }): AnnualReport {
    try {
      const r = queryAnnualReport(this._dirs.decrypted, options.year) as unknown as AnnualReport
      this.op('task', 'generate_annual_report', 'ok', String(options.year), `共 ${r.total} 条`)
      return r
    } catch (e) {
      this.op('task', 'generate_annual_report', 'fail', String(options.year), (e as Error).message)
      throw e
    }
  }

  /**
   * Resolve a 公众号 article cover (og:image) to a base64 data URL.
   * @param options - mp.weixin.qq.com article URL.
   * @returns ImageDataUrlResult: base64 data URL or error.
   */
  @Remote('getArticleCover')
  async getArticleCover(options: { contentUrl: string }): Promise<ImageDataUrlResult> {
    return resolveArticleCoverDataUrl(options.contentUrl, this._dirs.decoded, this.cdnSwitches())
  }

  @Remote('getAssetInsights')
  getAssetInsights(): AssetInsightsSnapshot {
    return queryAssetInsights(this._dirs.decrypted)
  }

  @Remote('getContact360')
  getContact360(options: { username: string }): Contact360Snapshot {
    return queryContact360(this._dirs.decrypted, options.username)
  }

  @Remote('getCalls')
  getCalls(options?: { topPeers?: number; recentLimit?: number }): CallsSnapshot {
    return queryCalls(this._dirs.decrypted, this.selfUsername(), options?.topPeers, options?.recentLimit)
  }

  @Remote('getGroupInsights')
  getGroupInsights(options: { username: string }): GroupInsightsSnapshot {
    return queryGroupInsights(this._dirs.decrypted, options.username)
  }

  @Remote('getLedger')
  getLedger(options?: { month?: string }): LedgerSnapshot {
    return queryLedger(this._dirs.decrypted, options?.month, this.selfUsername())
  }

  @Remote('getMediaAssets')
  getMediaAssets(): MediaAssetsSnapshot {
    return queryMediaAssets(this._dirs.decrypted)
  }

  @Remote('getMomentsInsights')
  getMomentsInsights(options?: { author?: string }): MomentsInsightsSnapshot {
    return queryMomentsInsights(this._dirs.decrypted, options?.author)
  }

  @Remote('getMomentsMonthly')
  getMomentsMonthly(options?: { author?: string; authorName?: string }): MomentsMonthlyRow[] {
    return queryMomentsMonthly(this._dirs.decrypted, options?.author, options?.authorName)
  }

  @Remote('getOfficialAssets')
  getOfficialAssets(): OfficialAssetsSnapshot {
    return queryOfficialAssets(this._dirs.decrypted)
  }

  @Remote('searchUnified')
  searchUnified(options: { query: string; limit?: number }): UnifiedSearchSnapshot {
    return searchUnified(this._dirs.decrypted, options.query, options.limit)
  }
}
