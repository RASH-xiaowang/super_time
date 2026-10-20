/**
 * WechatDataGateway 方法面 · 配置 / 密钥解密 / 任务 / 操作审计链路的 @Remote 壳。
 *
 * 与其它 gateway-* 壳共同构成继承链；装饰器标记会落到最派生原型上，
 * 因此协议层枚举到的方法面与拆分前逐名相同（守卫：gateway-remote-surface.spec.ts）。
 */

import { Remote } from '@deepseek-ai/dsh-typert-protocol'
import type { AccountsSnapshot, AnnualReport, AnnualSnapshot, AskHistoryClearResult, AskHistoryDeleteResult, AskHistoryQuery, AskHistorySnapshot, AskOptimizeResult, AskResult, AutoDbKeyResult, AutoImageKeyResult, AvatarResult, BackupMutationResult, BackupPreviewSnapshot, BackupSnapshot, CalendarSnapshot, CallsSnapshot, ChatHistoryResolveResult, ConfigSnapshot, ContactsSnapshot, DailySummaryResult, DbStatusSnapshot, DecryptAllResult, DecryptImagesResult, DecryptStatus, DeleteFavoriteResult, DraftClearResult, DraftsClearResult, EditMutationResult, EditedListSnapshot, EmoticonsSnapshot, EmoticonDataUrlsResult, ExportResult, ExportStatus, ExportHistoryDeleteResult, ExportHistoryQuery, ExportHistorySnapshot, ExportHistoryPruneOptions, FavoritesSnapshot, FilesSnapshot, GenerateKeysResult, GraphSnapshot, GroupInfoSnapshot, ImageDataUrlResult, ImageUpgradeResult, KeysInfoResult, MemberSearchSnapshot, MessagesSnapshot, MomentsSnapshot, OverviewInsights, OverviewSnapshot, PaymentStatus, PrivacySnapshot, RecordsSnapshot, OriginalBatchResult, OriginalFetchPlan, RevokedSnapshot, SearchBuildResult, SearchIndexStatus, SearchSnapshot, SessionsSnapshot, SimpleResult, StorageSnapshot, SummaryRecord, SummaryRecordSnapshot, SummaryTask, SummaryTaskMutationResult, SummaryTaskRunResult, SummaryTaskSnapshot, VerifyImageKeyResult, VerifyKeyResult, VideoInfoResult, VoiceDataUrlResult, VoiceInfoResult, VoiceTranscriptResult, VoiceTranscribeOneResult, VoiceTranscribeResult, WechatAccount, WechatConfigFull, WechatConfigPatch, WhisperDownloadProgress, WhisperDownloadResult, WhisperStatus, WhisperTranscribing, AssetInsightsSnapshot, BackupRestoreResult, Contact360Snapshot, DbHealthSnapshot, GroupInsightsSnapshot, HandoffRemindsSnapshot, LedgerSnapshot, MediaAssetsSnapshot, MomentsInsightsSnapshot, MomentsMonthlyRow, OfficialAssetsSnapshot, OperationCategory, OperationLogClearResult, OperationLogQuery, OperationLogSnapshot, OperationStatus, PeriodSummaryResult, PrivacyAuditClearResult, PrivacyAuditRow, PrivacyStateSnapshot, RegionMapSnapshot, TaskMutationResult, TasksSnapshot, UnifiedSearchSnapshot, KnowledgeSnapshot, NotesSnapshot, NoteMutationResult, KbDeleteAction, KbListSnapshot, KbMeta, KbMutationResult, LayaAnalysisView, LayaDownloadOutcome, LayaStatus, LayaVisibleAnalysisResult } from './types.ts'
import { GatewayVoiceOps } from './gateway-voice-ops.ts'
import { readDataRevision, type DataRevision } from './query/sync-status.ts'

export abstract class GatewayConfigOps extends GatewayVoiceOps {

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
  async getPrivacyScan(): Promise<PrivacySnapshot> {
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
   *
   * `sourceKind: 'file'`（2026-10-17 新增）marks a note distilled from a knowledge-base
   * file's summary/body. 改前文件摘要只存在文件元数据里、不会变成笔记 ——
   * 「文件 → 笔记 → 图谱」这条链路是断的（导入并解析了 195 块，笔记库却永远是空的）。
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
    sourceKind?: 'manual' | 'ask' | 'file'
    sourceUsername?: string
    sourceQuestion?: string
    /** 来源文件 id（`sourceKind === 'file'` 时才有）。 */
    sourceFileId?: number
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
  async openConfig(signal: AbortSignal = new AbortController().signal): Promise<{ ok: boolean; path: string; error?: string }> {
    return this.configRemotes().openConfig(signal)
  }


  @Remote('verifyImageKey')
  async verifyImageKey(): Promise<VerifyImageKeyResult> {
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
  async decryptAllImages(options?: { concurrency?: number }): Promise<DecryptImagesResult> {
    return this.keysDecryptRemotes().decryptAllImages(options)
  }


  /**
   * 升级老解码缓存：把 `<decoded>/<md5>.<ext>` 里由低档 `.dat`（聊天版 / 缩略图）解出来的图，
   * 用本机现存最好的一档（`_h` 原图，含 wxgf 转码）重解一遍。**不联网**。
   *
   * 为什么要有这一条：缓存是「谁先解出来谁占坑」（见 `query/media-image.ts` 的 `cachedImage`），
   * 逐条读图时命中缓存就直接返回、不会回头找更好的源。所以 2026-09 那批先解了缩略图的缓存，
   * 在用户后来于微信里点开原图、或本机装上 wxgf 解码库之后**仍然是糊的那一份**。
   * 判据是「重解结果严格更大才覆盖」⇒ 幂等、且永远不会把 CDN 原图降级成本机的较小那份。
   * 实时进度通过 getDecryptStatus 轮询读取（`op` = `image-upgrade`）。
   * @returns ImageUpgradeResult: 检查/已升级/无需升级/本机无源/失败 计数 + 明细。
   */
  @Remote('upgradeDecodedImages')
  async upgradeDecodedImages(): Promise<ImageUpgradeResult> {
    return this.keysDecryptRemotes().upgradeDecodedImages()
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
   * Decrypted DB status summary.
   * @returns DbStatusSnapshot: per-database status summary.
   */
  @Remote('getDbStatus')
  getDbStatus(): DbStatusSnapshot {
    return this.configRemotes().getDbStatus()
  }


  /**
   * 实时同步修订（纯内存读，1s 级轮询可用）。
   *
   * 聊天面板的轮询用 `revision` 判断「这一秒有没有新数据落地」，用 `messageChanged`
   * 判断「值不值得真去查一次消息增量」—— 把每秒一次消息 SQL 降成每秒一次内存读。
   * @returns DataRevision: revision / updatedAt / shards / messageChanged。
   */
  @Remote('getDataRevision')
  getDataRevision(): DataRevision {
    return readDataRevision()
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


  @Remote('deleteTask')
  deleteTask(options: { id: number }): TaskMutationResult {
    return this.tasksRemotes().deleteTask(options)
  }


  @Remote('extractTasks')
  async extractTasks(options?: { days?: number }): Promise<TaskMutationResult> {
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


  @Remote('listTasks')
  listTasks(): TasksSnapshot {
    return this.tasksRemotes().listTasks()
  }


  @Remote('setPrivacyState')
  setPrivacyState(options: { redactSensitive?: boolean }): PrivacyStateSnapshot {
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
