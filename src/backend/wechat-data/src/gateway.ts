/**
 * WeChatDataGateway — Host Remote service exposing st_control's decrypted
 * WeChat SQLite through the DSH Typert RPC. The browser client calls
 * ctx.remote.wechatData.* instead of an HTTP API.
 */
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type { Context } from '@deepseek-ai/cordis'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AccountsSnapshot, AnnualReport, AnnualSnapshot, AskHistoryClearResult, AskHistoryDeleteResult, AskHistoryQuery, AskHistorySnapshot, AskOptimizeResult, AskResult, AutoDbKeyResult, AutoImageKeyResult, AvatarResult, BackupMutationResult, BackupPreviewSnapshot, BackupSnapshot, CalendarSnapshot, CallsSnapshot, ChatHistoryResolveResult, ConfigSnapshot, ContactsSnapshot, DailySummaryResult, DbStatusSnapshot, DecryptAllResult, DecryptImagesResult, DecryptStatus, DeleteFavoriteResult, DraftClearResult, DraftsClearResult, EditMutationResult, EditedListSnapshot, EmoticonsSnapshot, ExportResult, ExportStatus, ExportHistoryDeleteResult, ExportHistoryQuery, ExportHistorySnapshot, ExportHistoryPruneOptions, FavoritesSnapshot, FilesSnapshot, GenerateKeysResult, GraphSnapshot, GroupInfoSnapshot, ImageDataUrlResult, KeysInfoResult, MemberSearchSnapshot, MessagesSnapshot, MomentsSnapshot, OverviewInsights, OverviewSnapshot, PaymentStatus, PrivacySnapshot, RecordsSnapshot, RevokedSnapshot, SearchBuildResult, SearchIndexStatus, SearchSnapshot, SessionsSnapshot, SimpleResult, StorageSnapshot, SummaryRecord, SummaryRecordSnapshot, SummaryTask, SummaryTaskMutationResult, SummaryTaskRunResult, SummaryTaskSnapshot, VerifyImageKeyResult, VerifyKeyResult, VideoInfoResult, VoiceDataUrlResult, VoiceInfoResult, VoiceTranscriptResult, VoiceTranscribeOneResult, VoiceTranscribeResult, WechatAccount, WechatConfigFull, WechatConfigPatch, WhisperDownloadProgress, WhisperDownloadResult, WhisperStatus, WhisperTranscribing, AssetInsightsSnapshot, BackupRestoreResult, Contact360Snapshot, DbHealthSnapshot, GroupInsightsSnapshot, HandoffRemindsSnapshot, LedgerSnapshot, MediaAssetsSnapshot, MomentsInsightsSnapshot, MomentsMonthlyRow, OfficialAssetsSnapshot, OperationCategory, OperationLogClearResult, OperationLogQuery, OperationLogSnapshot, OperationStatus, PeriodSummaryResult, PrivacyAuditClearResult, PrivacyAuditRow, PrivacyStateSnapshot, RegionMapSnapshot, TaskMutationResult, TasksSnapshot, UnifiedSearchSnapshot, KnowledgeSnapshot, NotesSnapshot, NoteMutationResult, KbDeleteAction, KbListSnapshot, KbMeta, KbMutationResult } from './types.ts'
import { querySessions } from './query/sessions.ts'
import { queryGroupInfo } from './query/group-info.ts'
import { queryPaymentStatus } from './query/payments.ts'
import { queryContacts } from './query/contacts.ts'
import { queryRegionMap } from './query/region-map.ts'
import { queryMessageByServerId, queryMessages, queryNewMessages } from './query/messages.ts'
import { resolveImageKeyPair } from './query/image-key.ts'
import { fetchImageOriginalToCache, resolveImageOriginalLink } from './query/image-original.ts'
import { buildReplyPrompt, collectReplyContext, collectReplyKbSnippets, parseReplyCandidates } from './query/reply-suggest.ts'
import { queryMoments, queryMomentsAuthors } from './query/moments.ts'
import { deleteFavoriteItems, queryFavorites } from './query/favorites.ts'
import { queryFiles } from './query/files.ts'
import { queryOverview } from './query/overview.ts'
import { queryRecords, queryRevoked } from './query/records.ts'
import { queryEmoticons } from './query/emoticons.ts'
import { queryStorageStats } from './query/storage.ts'
import { queryAnnual } from './query/annual.ts'
import { queryWechatConfig } from './query/settings.ts'
import { resolveSelfUsername } from './query/config.ts'

/** Compact, readable daily digest for the no-LLM fallback (short per-message previews). */
function compactDailyDigest(lines: string[]): string {
  const parts: string[] = []
  let lastSession = ''
  let shown = 0
  for (const line of lines) {
    const m = line.match(/^【(.+?)】/)
    if (m && m[1]) { lastSession = m[1]; parts.push('\n【' + lastSession + '】'); continue }
    if (shown >= 6) { parts.push('……'); break }
    const s = line.replace(/\s+/g, ' ').slice(0, 48)
    parts.push('- ' + s + (line.length > 48 ? '…' : ''))
    shown += 1
  }
  return parts.join('\n')
}
import { startRealtimeSync } from './query/sync.ts'
import { createTasksRemotes } from './remotes/tasks.ts'
import { createOpsLogRemotes } from './remotes/opslog.ts'
import { createBackupRemotes } from './remotes/backup.ts'
import { createConfigRemotes } from './remotes/config.ts'
import { createSummaryRemotes } from './remotes/summary.ts'
import { createAskRemotes } from './remotes/ask.ts'
import { createKeysDecryptRemotes } from './remotes/keysdec.ts'
import { createGraphSearchRemotes } from './remotes/graphsearch.ts'
import { createKbRemotes } from './remotes/kb.ts'
import { createMediaRemotes } from './remotes/media.ts'
import type { ImageBatchItem } from './remotes/media.ts'
import { createExportRemotes } from './remotes/export.ts'
import { openNativePath } from '@deepseek-ai/dsh-native-command'
import { queryPrivacyScan } from './query/privacy.ts'
import { queryCalls } from './query/calls.ts'
import { queryGraph } from './query/graph.ts'
import { getDailyCounts } from './query/calendar.ts'
import { buildSearchIndex, ensureSearchIndex, getSearchIndexStatus, knownEntityNames, searchIndexMessages, searchIndexMessagesCancellable } from './query/search.ts'
import { searchMembers } from './query/members.ts'
import { clearDecodedImageCache, decodeDatBytes, decodeEmoticonDataUrl, decodeFileImageDataUrl, decodeImageDataUrl, fetchEmoticonRemote, resolveImageFilePathsByMd5, resolveImageResourceHint } from './query/media-image.ts'
import type { StreamControl } from './query/zip.ts'
import type { KbFileAddResult, KbFileChunkPage, KbFileListSnapshot, KbFileMutationResult, KbFileRegisterResult, KbSearchResult, KbSummaryResult } from './types.ts'
import { resolveSnsImageDataUrl } from './query/sns-image.ts'
import { resolveArticleCoverDataUrl } from './query/article-cover.ts'
import { resolveMessageFileDataUrl } from './query/media-file.ts'
import { queryOverviewInsights } from './query/overview-insights.ts'
import { getDbStatus } from './query/status.ts'
import { resolveVoiceInfo } from './query/media-voice.ts'
import { resolveVideoInfo } from './query/media-video.ts'
import { resolveAvatar, resolveAvatarsLocal } from './query/avatar.ts'
import { detectWechatAccounts, generateKeysFile, getConfig, getKeysInfo, saveConfig, verifyDatabaseKey, weixinInstallPath, weixinVersion } from './query/config.ts'
import { fetchDbKey, fetchImageKey, normalizeAccountDir } from './keys/service.ts'
import { scanV2Templates, trustedXorForVerifiedAesKey } from './keys/image-key-resolver.ts'
import { decryptAllDbs } from './query/decrypt-all.ts'
import { decryptAllImageDats } from './query/decrypt-images.ts'
import { WHISPER_DOWNLOAD_FILES, installWhisperEngine, migrateWhisperEngineDir, migrateWhisperModels, resolveWhisperModelsDir, whisperDownloadModel, whisperEnginePath, whisperHasCuda, whisperModelsStatus } from './query/whisper.ts'
import { cachedTranscript, transcribeOneVoice, transcribeVoiceBatch } from './query/voice-transcribe.ts'
import { resolveVoiceDataUrl, svrIdByChatLocal } from './query/voice.ts'
import { exportAllSessions, exportAnnualReport, exportCsv, exportMoments, exportSessionMessagesStreamed } from './query/export.ts'
import { deleteExportHistory, listExportHistory, pruneExportHistory, recordExport } from './query/export-history.ts'
import { clearAskHistory, deleteAskHistory, listAskHistory, recordAsk } from './query/ask-history.ts'
import { formatAskContext, parseAskOptimize, parseAskPlan, parseCitedIndexes, retrieveAskCitations } from './query/ask.ts'
import { auditGrounding, groundingRepairHint } from './query/grounding.ts'
import { loadRetrievalConfig, saveRetrievalConfig as saveRetrievalConfigFile, defaultRetrievalConfig } from './query/retrieval/config.ts'
import { runRetrievalPipeline } from './query/retrieval/pipeline.ts'
import { citationDocKey, fuseKbHits } from './query/retrieval/kb-channel.ts'
import { buildVectorIndex, vectorIndexStatus, vectorIndexSummary, type EmbedFn } from './query/retrieval/embedding.ts'
import { buildKbVectorIndex, kbVectorIndexStatus, searchKbDense } from './query/kb-vectors.ts'
import type { KbVectorBuildResult, KbVectorIndexStatus } from './query/kb-vectors.ts'
import {
  kbModelOverrideCounts,
  kbModelsOnKbDelete,
  readKbModelSettings,
  resolveModelRef,
  touchKbEntitiesAt,
  writeKbModelSettings,
} from './query/kb/model-config.ts'
import type { KbModelRole, KbModelSettings, ResolvedModel } from './query/kb/model-config.ts'
import { extractFileEntities, kbEntitySummary, mergeDocEntities, readDocEntities, type KbEntitySummary } from './query/kb/extract.ts'
import { rankLinkCandidates, SUGGEST_POOL_MAX } from './query/kb/suggest.ts'
import { adaptWeights, attributeFeatures, feedbackStats, listFeedback, loadAdaptedWeights, recordFeedback, saveAdaptedWeights } from './query/retrieval/feedback.ts'
import { runSyntheticEval, syntheticIntentAccuracy } from './query/retrieval/eval-dataset.ts'
import { formatEvalReport } from './query/retrieval/eval.ts'
import type { FeedbackRecord, IntentKind, RerankWeights } from './query/retrieval/types.ts'
import { createBackup as createBackupEntry, deleteBackup as deleteBackupEntry, listBackups as listBackupEntries, previewBackup as previewBackupEntry } from './query/backup.ts'
import { collectDayMessages, collectPeriodMessages } from './query/daily-summary.ts'
import type { ReplySuggestResult } from './types.ts'
import { queryLedger } from './query/ledger.ts'
import { queryContact360 } from './query/contact360.ts'
import { queryDbHealth } from './query/db-health.ts'
import { queryGroupInsights } from './query/group-insights.ts'
import { queryAssetInsights } from './query/asset-insights.ts'
import { queryMediaAssets } from './query/media-assets.ts'
import { queryMomentsInsights } from './query/moments-insights.ts'
import { queryMomentsMonthly } from './query/moments-monthly.ts'
import { queryOfficialAssets } from './query/official-assets.ts'
import { clearOperationLog, listOperations, recordOperation } from './query/operation-log.ts'
import { clearPrivacyAudit, getPrivacyStateSnapshot, listPrivacyAudit, readPrivacySettings, recordPrivacyAudit, redactSensitiveText, writePrivacySettings } from './query/privacy-audit.ts'
import { importHandoffTasks, listHandoffReminds } from './query/handoff.ts'
import { deleteTask, insertTask, listTasks as listWechatTasks, setTaskStatus } from './query/wechat-tasks.ts'
import { createEncryptedBackup, restoreEncryptedBackup } from './query/backup.ts'
import { searchUnified } from './query/unified-search.ts'
import { fetchSnsCoverDataUrl, fetchSnsVideoDataUrl, loadSnsVideoBytes, resolveSnsVideoCoverDataUrl, resolveSnsVideoDataUrl } from './query/sns-video.ts'
import { queryAnnualReport } from './query/annual-report.ts'
import { queryAnnualReview, type AnnualReview } from './query/annual-review.ts'
import { editChatMessage as editMsg, listEditedMessages as listEdits, resetEditedMessage as resetEdit } from './query/edit.ts'
import { clearAllSessionDrafts as clearAllDrafts, clearSessionDraft as clearDraft } from './query/drafts.ts'
import { bumpDataGeneration, boundedSet, invalidateWechatMeta } from './query/meta.ts'
import { contactMeta } from './query/meta.ts'
import { buildKnowledgeGraph, createKb as createKbRow, deleteKb as deleteKbRow, deleteNote as deleteNoteRow, listKbs, listNotes, renameKb as renameKbRow, saveNote as saveNoteRow } from './query/notes.ts'
import type { KnowledgeSnapshotRead } from './query/notes.ts'
// 知识库「文件」域：与笔记**分开一个库文件**（`wechat_kb_files.db`），所以是另一组导入。
import { countKbFilesByKb, deleteKbFile as deleteKbFileRow, getKbFile, kbFilesOnKbDelete, listKbFileChunks, listKbFiles, recoverInterrupted, registerKbFile, setKbFileRagFlag, setKbFileSummary } from './query/kb-files.ts'
import { readDocGraph } from './query/kb/entities.ts'
import { drainKbQueue } from './query/kb-queue.ts'
import { searchKb as searchKbRows } from './query/kb-search.ts'
import { deleteSummaryRecord as delRec, deleteSummaryTask as delTask, listSummaryRecords as listRecs, listSummaryTasks as listTasks, saveSummaryRecord as saveRec, saveSummaryTask as saveTask, toggleSummaryTask as toggleTask, updateSummaryTaskRunState } from './query/summary-tasks.ts'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'

import { bootstrapWechatData, resolveDecodedDir, resolveDecryptedDir } from './dirs.ts'

/**
 * 隐私库读不到时的统一文案。
 *
 * 「读不到」必须与「没开拦截」区分开：前者拦下并说明原因，后者放行。
 * 2026-09-20 之前两处 catch 都把异常翻译成「放行」，于是一个显式开了
 * 「出站拦截」的用户，在 `wechat_privacy.db` 损坏/被锁的那一刻就开始静默出网。
 */
function privacyStoreUnreadable(feature: string, detail: string): string {
  return `读到隐私设置失败（wechat_privacy.db 不可读），已按「出站拦截」处理：已阻止「${feature}」${detail}`
}

/** Resolved data layout (per gateway instance, so tests can stub env). */
interface ResolvedDirs {
  /** Decrypted SQLite libraries the queries read. */
  decrypted: string
  /** Decoded-images cache the media queries write. */
  decoded: string
}

/**
 * Raw WeChat data base dir (the account root, parent of db_storage): env pin
 * first, then the live config db_dir. Resolved per call — config.json may be
 * bootstrapped or re-pointed after the gateway started, and a startup
 * snapshot would stay empty and leave media resolution dead.
 * @param decrypted - decrypted data root (locates config.json).
 * @returns the account root, or '' when config has no usable db_dir.
 */
/**
 * 回答的**数据来源说明**：条数 / 会话数 / 时间跨度。
 *
 * 由检索结果**算出来**，不是让模型写的 —— 模型写的「来源」可能被编造，
 * 而这行数字直接来自本次引用到的原文，用户可逐条对照。
 *
 * ⚠ 会话数**只数消息**：知识库引用的 `username` 是 `kb:<kbId>:<fileId>`（它按文件分组
 * 是为了同源去重，不是会话），把它算进「N 个会话」这行就开始说谎 ——
 * 用户会照着这行去数，然后发现自己只有 2 个会话却写着 3 个。
 * 文件另按**文件**去重单列（同一份文件命中三块是 1 个文件），与「条数」是两个口径。
 * @param citations - 本次检索到的原文（引用锚点）。
 * @returns 一行来源说明；没有原文时返回空串。
 */
function askBasisLine(citations: ReadonlyArray<{
  time?: string
  username?: string
  source?: 'msg' | 'kb'
  kb?: { fileId?: number; fileName?: string }
  snippet?: string
}>): string {
  if (citations.length === 0) return ''
  const msgs = citations.filter(c => c.source !== 'kb')
  const kbItems = citations.filter(c => c.source === 'kb')
  const sessions = new Set(msgs.map(c => c.username ?? '')).size
  const days = msgs.map(c => (c.time ?? '').slice(0, 10)).filter(Boolean).sort()
  const span = days.length > 0 ? ` · ${days[0]} ~ ${days[days.length - 1]}` : ''
  const parts = [`${citations.length} 条原文`]
  if (msgs.length > 0) parts.push(`${sessions} 个会话`)
  if (kbItems.length > 0) {
    const files = new Set(kbItems.map(c => (c.kb?.fileId !== undefined ? 'f' + c.kb.fileId : (c.kb?.fileName ?? c.snippet ?? ''))))
    parts.push(`${files.size} 个知识库文件`)
  }
  return `依据本机记录：${parts.join(' · ')}${span}`
}

/** 微信原始数据根目录（`<账号根>`，用于定位 msg/cache 下的媒体）。 */
function rawWechatBase(decrypted: string): string {
  const pinned = process.env.DSH_WECHAT_BASE_DIR
  if (pinned && pinned.trim().length > 0) return pinned.trim()
  const cfg = getConfig(decrypted)
  const dbDir = typeof cfg['db_dir'] === 'string' ? cfg['db_dir'] : ''
  if (!dbDir) return ''
  const parts = dbDir.replace(/[\\/]+$/, '').split(/[\\/]/)
  return (parts[parts.length - 1] ?? '') === 'db_storage' ? parts.slice(0, -1).join('/') : ''
}

/** Resolve the data layout and run the one-time bootstrap. */
function resolveDirs(): ResolvedDirs {
  bootstrapWechatData()
  return { decrypted: resolveDecryptedDir(), decoded: resolveDecodedDir() }
}

/**
 * 一个长任务（导出/加密备份）的控制槽（M3）。
 *
 * 为什么不能把 `onProgress` / `AbortSignal` 直接当 RPC 参数传：**两者都过不了 IPC** ——
 * 回调是函数、signal 是宿主对象，序列化时会被丢掉（或被拒）。所以渲染层只带一个自己生成的
 * `jobId`：进度由网关通过 `wechat-export/progress` 事件推出去（与 `wechat-data/updated`、
 * `wechat-ask/delta` 同一种做法），取消走 `cancelExportJob({ jobId })` 唤醒这里的令牌。
 */
export interface StreamJob {
  /** 本轮取消令牌；每次开跑都换新的（否则「取消过一次的 jobId 再也跑不动」）。 */
  ctrl: AbortController
  /** 最近一次进度；终态也留着，供迟到的轮询读到。 */
  progress: { phase: string; done: number; total: number } | null
  finished: boolean
  error?: string
}

/** 控制槽上限：槽位只服务「正在跑 + 刚跑完」的任务，超出先丢最老的。 */
const STREAM_JOB_CAP = 20

/** 导出/备份进度事件名（渲染层按 jobId 过滤）。 */
const EXPORT_PROGRESS_EVENT = 'wechat-export/progress'





/**
 * 解码缓存的扩展名候选（与 `media-image.ts` 的 `RENDERABLE_EXTS` 同集合）。
 * 只用来判「这张图已经有解码产物了吗」——有就别再解一遍。
 */
const CACHED_IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tif']


/**
 * 规整渲染层传来的 jobId：只当**不透明标识**用（不落盘、不回显），所以限长截断即可。
 * @param jobId - 原始值（可能缺省/非字符串）。
 * @returns 可用的标识；不可用时为空串（＝调用方没打算订阅进度）。
 */
function normalizeJobId(jobId?: unknown): string {
  return typeof jobId === 'string' ? jobId.trim().slice(0, 64) : ''
}

export class WechatDataGateway extends TypertRemoteService {
  /** Services this gateway depends on at runtime (LLM + default model). */
  static inject = ['llm', 'agentDefaultModel']

  private readonly _ctx: Context
  private readonly _dirs: ResolvedDirs
  /**
   * 登录账号 wxid 的**带失效**缓存。
   *
   * 不能在构造函数里算一次就固定：`数据配置` 里切换微信账号只改 `db_dir`
   * （解密目录不变），本进程不会重启。缓存住旧 wxid 会让 `isSender` 拿
   * **上一个账号**的 wxid 去比对，于是新账号里每条消息的「我 / 对方」全部反转
   * —— 属于最严重的归属错误。这里按 (解密目录, config.db_dir) 记忆：
   * 账号一换键就变，自动重算。
   */
  private _selfUsername = ''
  private _selfUsernameKey = ''
  private _schedBusy = false
  /**
   * 最近若干轮问答的检索特征画像（retrievalId → 特征/引用映射）。
   * 用户提交反馈时用它把「哪条引用有用」翻译成「哪个特征该加权」。
   * 有界（≤20 轮），不落盘 —— 纯进程内、只在反馈那一刻需要。
   */
  private readonly _askTrace = new Map<string, {
    features: Map<string, RerankWeights>
    citations: string[]
    question: string
    answer: string
    intent: IntentKind
  }>()
  /** Live decrypt progress (polled by the settings panel). */
  private readonly decryptState: DecryptStatus = {
    op: null, active: false, done: 0, total: 0, failed: 0, skipped: 0, message: '',
  }
  /** Active whisper model download (polled by the settings panel). */
  private whisperDownload: WhisperDownloadProgress | null = null
  /** Active voice batch transcription (polled by the settings panel). */
  private whisperTranscribing: WhisperTranscribing = { active: false, done: 0, total: 0, failed: 0, skipped: 0, current: '' }
  /** 导出/加密备份的控制槽：jobId → 取消令牌 + 最近一次进度（见 {@link StreamJob}）。 */
  private readonly _streamJobs = new Map<string, StreamJob>()
  /**
   * 消息搜索的取消槽（N9）：jobId → 取消控制器。
   *
   * 与导出的槽分开：搜索没有进度可言，也不想占用 `wechat-export/progress` 那个事件名。
   * 槽位会在搜索收尾时删掉（见 {@link searchSignal}），所以这里不需要上限。
   */
  private readonly _searchJobs = new Map<string, AbortController>()
  /**
   * 反馈去重窗口（N27）：键 → 到期时间。
   *
   * 为什么不是 `inflightXxx: Set` 那种「在飞合并」的闸：`submitAskFeedback` 是**同步** RPC，
   * 函数体在事件循环里一口气跑完，两个「并发」调用不会交错 ⇒ 在飞表恒为空，那是个假闸。
   * 真正的重复是「同一轮被提交两次」且两次都真跑完（多一条反馈记录 + 按重复特征重算权重 +
   * 两条审计），所以按内容键 + 时间窗去重（见 {@link ASK_FEEDBACK_DEDUPE_MS}）。
   */
  private readonly _askFeedbackSeen = new Map<string, number>()
  /**
   * 按库向量索引的**在飞构建**进度（kbId → 进度），给面板的「语义索引」按钮轮询。
   *
   * 为什么是进程内而不是落库：这是「此刻有没有在跑、跑到哪」的瞬时态，落库就要处理
   * 进程崩溃留下的假进行中（比不显示更糟）。真正的持久事实（多少块、哪个模型、何时建的）
   * 在向量库自己的 meta 与行里，见 `kbVectorIndexStatus`。
   */
  private readonly _kbIndexJobs = new Map<number, { done: number; total: number; startedAt: number; error: string }>()
  /**
   * 已知实体名缓存（问答的「点名识别」用）：按解密目录记忆。
   *
   * 为什么缓存：这份名单要读联系人表 + 会话表（两次 SQLite 打开），而每次提问都要用；
   * 名单在会话存续期内变化极小，记一次就够。换数据目录（换账号）时按 key 自然失效。
   */
  private readonly _knownEntities = new Map<string, string[]>()

  /**
   * 当前登录账号的 wxid（消息 `isSender` 判定的基准）。
   *
   * 按 (解密目录, config.db_dir) 记忆：只要账号没换就直接命中缓存，
   * 换了账号（`data 配置` 里选另一个账号的 db_storage）或换了数据目录则重算。
   * 每次取用时只多读一次 `getConfig`（带文件签名缓存的 JSON 读），代价可忽略。
   * @returns 登录账号 wxid；解析不到时为空串。
   */
  private selfUsername(): string {
    let dbDir = ''
    try {
      const cfg = getConfig(this._dirs.decrypted)
      dbDir = typeof cfg['db_dir'] === 'string' ? cfg['db_dir'] : ''
    } catch { /* 配置不可读时退回按目录记忆 */ }
    const key = this._dirs.decrypted + '\u0000' + dbDir
    if (key !== this._selfUsernameKey) {
      this._selfUsername = resolveSelfUsername(this._dirs.decrypted)
      this._selfUsernameKey = key
    }
    return this._selfUsername
  }

  /**
   * 取（或新建）一个长任务的控制槽，并包成 query 层要的 {@link StreamControl}（M3）。
   *
   * 每次调用都换一个**新的** AbortController：同一个 jobId 被复用（先取消、再重跑）时，
   * 复用一个已 abort 的令牌会让新一轮导出刚起步就抛「已取消」。
   * @param jobId - 渲染层生成的标识；缺省/空白时返回空控制（＝无进度、不可取消，
   *   旧调用方的行为完全不变）。
   * @returns 含 `signal` 与 `onProgress` 的控制对象，可直接透传给 query 层。
   */
  private streamControl(jobId?: string): StreamControl {
    const id = normalizeJobId(jobId)
    if (!id) return {}
    if (!this._streamJobs.has(id) && this._streamJobs.size >= STREAM_JOB_CAP) {
      const first = this._streamJobs.keys().next()
      if (!first.done && first.value !== undefined) this._streamJobs.delete(first.value)
    }
    const job: StreamJob = this._streamJobs.get(id) ?? { ctrl: new AbortController(), progress: null, finished: false }
    job.ctrl = new AbortController()
    job.progress = null
    job.finished = false
    delete job.error
    this._streamJobs.set(id, job)
    const ctx = this._ctx
    return {
      signal: job.ctrl.signal,
      onProgress: (p) => {
        job.progress = { phase: p.phase, done: p.done, total: p.total }
        // 事件尽力而为：进度推不出去不该让导出失败（与 wechat-ask/delta 同策略）。
        try { ctx.emit(EXPORT_PROGRESS_EVENT, { jobId: id, phase: p.phase, done: p.done, total: p.total }) } catch { /* ignore */ }
      },
    }
  }

  /**
   * 收尾一个长任务：标记结束（槽位留着，让迟到的 `getExportProgress` 能读到终态与错误）。
   * @param jobId - 任务标识。
   * @param error - 失败/取消原因；成功时省略。
   */
  private finishStreamJob(jobId: string, error?: string): void {
    const job = this._streamJobs.get(jobId)
    if (!job) return
    job.finished = true
    if (error) job.error = error
  }

  constructor(ctx: Context) {
    super(ctx, 'wechatData')
    this._ctx = ctx
    this._dirs = resolveDirs()
    // Real-time sync: watch WeChat's raw message shards and re-decrypt the
    // snapshot so the chat panel sees new messages (st_control monitor style).
    const decrypted = this._dirs.decrypted
    const rawDbDir = (): string => {
      const cfg = getConfig(decrypted)
      return typeof cfg['db_dir'] === 'string' ? cfg['db_dir'] : ''
    }
    const stopSync = startRealtimeSync(rawDbDir, () => decrypted, (synced) => {
      console.log('[wechat-sync] updated:', synced.join(', '))
      // 这里**不再**整体清空进程内缓存（M8）：那会让每个约 10s 一次的同步事件把
      // 「没变的分片」也一起丢掉，下次查询又得为全部分片重开库读元数据。
      // 现在分两类失效：
      //   · 签名完整的条目（按所读文件 mtime+size）自己就会失效 —— 同步两种模式最终都走
      //     `atomicReplace` 原子替换目标文件，mtime 必然变化；
      //   · 依赖「整棵树都可能变了」的条目用 `bumpDataGeneration()` 显式失效
      //     （它们没法用单个文件的签名表达，见 meta.ts 的说明）。
      // 整棵树被替换的场合（全量解密）仍用 `invalidateWechatMeta()`。
      bumpDataGeneration()
      try { ctx.emit('wechat-data/updated', synced) } catch { /* event best-effort */ }
    })
    ctx.effect(() => stopSync, 'wechat-data: realtime sync')
    // Daily-summary scheduler: every 30s, run any enabled task whose schedule
    // time (HH:MM) matches the current minute and has not run in the last minute.
    const schedTimer = setInterval(() => { void this.maybeRunDueTasks() }, 30_000)
    ctx.effect(() => () => { clearInterval(schedTimer) }, 'wechat-data: summary scheduler')
    // 知识库文件库的崩溃恢复：把上一个进程留下的 parsing / chunking / embedding 打回 queued。
    // **只在启动时做这一次** —— `recoverInterrupted` 自己按数据根记住「本进程已做过」，
    // 重复调用直接跳过。把这件事放进「读列表」的路径是这类功能最常见的走捷径写法，
    // 它的 bug 是：用户正在上传一个大文件（parse_state = parsing）时，任何一次列表刷新
    // 都会把它判成「崩溃残留」并打断一次正常的解析（计划 R7，由用例钉住）。
    const recovered = recoverInterrupted(this._dirs.decrypted)
    if (recovered.reset > 0) console.log('[kb-files] 崩溃恢复：' + recovered.reset + ' 个文件已重新排队')
    if (recovered.readError !== undefined) console.warn('[kb-files] 崩溃恢复失败：' + recovered.readError)
    /**
     * 紧接着把解析队列排干净：上个进程留下的 `queued` 行、以及刚被 `recoverInterrupted`
     * 打回 `queued` 的那些，在这里才被真正解掉。
     *
     * **顺序不能反**（先恢复、后清扫）：反了的话，被重置的那一行要等下一次启动才会被解，
     * 而用户看到的是「明明解过一半、重开之后还是等待解析」。`recoverInterrupted` 自己
     * 保证「本进程只做一次」，所以这里可以直接跟着调。
     *
     * 用 `void` 而不是 `await`：这是启动路径，等它等于把「窗口出现」绑在
     * 「把用户上次没解完的文件全解完」上 —— 几十份 PDF 能让窗口几十秒不出现。
     * 解不完不会丢：每轮都把进度写进 `parse_state`（用户看得见），真被中断了，
     * 下一次启动的崩溃恢复会把它们捡回来。
     */
    void drainKbQueue(this._dirs.decrypted).then((r) => {
      if (r.processed > 0) {
        console.log('[kb-queue] 启动清扫：处理 ' + r.processed + ' 个文件（就绪 ' + r.ready
          + ' / 无正文 ' + r.unsupported + ' / 失败 ' + r.failed + '）')
      }
    }).catch((e: unknown) => {
      console.warn('[kb-queue] 启动清扫异常：' + (e instanceof Error ? e.message : String(e)))
    })
  }

  /**
   * Append one operation-log row. Metadata only — never message bodies or
   * image/file contents — so an export stays safe to share. Best-effort: a
   * logging failure never affects the operation it records.
   */
  private op(category: OperationCategory, action: string, status: OperationStatus, target = '', detail = ''): void {
    recordOperation(this._dirs.decrypted, { category, action, target, status, detail })
  }

  /**
   * 「出站拦截」是否已开启；开启时返回给用户看的说明，否则 null。
   *
   * 为什么要单独有这个提前检查：出站调用点前面还有「未配置默认模型」这类**早退分支**，
   * 不开拦截时它是对的；但用户先把「禁止 AI 出网」打开、再点每日总结时，
   * 早退分支会先返回「AI 不可用（未配置默认模型）」，把隐私拦截真实生效这件事盖掉
   * （第 59 轮实测：开关明明写着「开」，总结里却完全不提拦截）。所以拦截要在**最前面**判。
   * @param feature - 功能名，出现在提示文案里。
   * @returns 提示文案，或 null。
   */
  /**
   * 「出站拦截」当前是否开启。
   *
   * 与 `privacyBlocked` 的分工：那个是 LLM 出站点用的（要返回给用户看的文案），
   * 这里只回答一个是非问题 —— 批量头像会给远端 URL 兜底，而拉那张图属于出站，
   * 开关打开时就不该下发这类 URL。读不到设置时按「未开启」处理，与其它读取点一致。
   * @returns 是否禁止出站。
   */
  private outboundBlocked(): boolean {
    try {
      return readPrivacySettings(this._dirs.decrypted).blockOutbound
    } catch {
      // 读不到就按「禁止出站」处理。这是权限判断，失败方向只能是**拦下**：
      // 用户开了「出站拦截」而库损坏/被锁的那一刻，静默放行是最糟的结果。
      // 与 `privacyBlocked` 的文案分支同一取向（那边会告诉用户为什么被拦）。
      return true
    }
  }

  private privacyBlocked(feature: string, detail = '把数据发送给模型'): string | null {
    let blocked: boolean
    try {
      blocked = readPrivacySettings(this._dirs.decrypted).blockOutbound
    } catch {
      return privacyStoreUnreadable(feature, detail)
    }
    return blocked ? `隐私设置已开启「出站拦截」，已阻止「${feature}」${detail}` : null
  }

  /**
   * 隐私闸门：**所有**出站 LLM 调用都必须先过这里（第 59 轮）。
   *
   * 背景：`readPrivacySettings` / `recordPrivacyAudit` 这两个能力原本**谁都没调用** ——
   * 「出站拦截」「敏感字段脱敏」两个开关只写进 sqlite 就没人读，`privacy_audit` 表
   * 实测 0 行（运行期 bundle 里连 INSERT 都没有）。把闸门收敛成一个私有方法，四处
   * 出站调用（问答／每日总结／群总结任务／周期总结）统一走它，避免「以后加了新 AI
   * 功能又忘了过隐私」这类漏网。
   *
   * @param feature - 审计里的功能名（ask_wechat / daily_summary / summary_task / period_summary）。
   * @param stats - 本次出站涉及的数据量（会话数、消息数），写进审计。
   * @param texts - 即将发出去的文本；开启脱敏时返回脱敏后的副本。
   * @returns 允许出站时 `{ ok: true, texts }`；被拦截时 `{ ok: false, error }`。
   */
  private privacyGate(
    feature: string,
    stats: { sessions: number; messages: number },
    texts: string[],
  ): { ok: true; texts: string[] } | { ok: false; error: string } {
    const blocked = this.privacyBlocked(feature)
    if (blocked !== null) return { ok: false, error: blocked }
    let settings: { redactSensitive: boolean; blockOutbound: boolean }
    try {
      settings = readPrivacySettings(this._dirs.decrypted)
    } catch {
      // 竞态兜底：`privacyBlocked` 那次读成功了、这一次失败（库刚被锁上或删掉）。
      // 方向同上 —— 判断不了就拦下，不能带着「默认不脱敏」把原文发出去。
      return { ok: false, error: privacyStoreUnreadable(feature, '把数据发送给模型') }
    }
    const out = settings.redactSensitive ? texts.map(redactSensitiveText) : texts
    const chars = out.reduce((a, t) => a + t.length, 0)
    // 审计是 best-effort：recordPrivacyAudit 内部已是 try/catch，失败不影响功能本身
    recordPrivacyAudit(this._dirs.decrypted, feature, chars, stats.sessions, stats.messages)
    return { ok: true, texts: out }
  }

  /**
   * Session list (search/filter/limit).
   * @param options - Filter options: keyword fuzzy search, limit max rows.
   * @returns SessionsSnapshot: sessions list (items + total).
   */
  /**
   * 问答用的已知实体名（点名识别）：联系人备注/昵称 + 会话标题，按数据目录缓存。
   *
   * 为什么问答需要它：规划器（LLM）是**尽力而为**的 —— 它偶尔会把问题里明确点到的人
   * 漏掉（或整段规划失败），此时检索就退化成纯 bigram 词法匹配，「问某人的事」很容易
   * 捞回一堆同名同姓/无关会话。把真实名单交给检索层（`classifyIntent` / `buildQueryPlan`
   * / 实体通道），点名识别就变成**确定性**的，不依赖模型这一跳。
   * @returns 已知实体名（读取失败时返回空数组，问答照常可用）。
   */
  private askKnownEntities(): string[] {
    const key = this._dirs.decrypted
    const hit = this._knownEntities.get(key)
    if (hit) return hit
    let names: string[] = []
    try {
      names = knownEntityNames(key)
    } catch {
      names = []
    }
    this._knownEntities.set(key, names)
    return names
  }

  /**
   * 构造「过隐私闸门」的 embedding 函数。
   *
   * 所有 embedding 调用都必须先过与 chat 出站同一道闸门：开启「出站拦截」时抛错
   * （流水线自动降级为纯稀疏），开启「敏感字段脱敏」时发送脱敏后的文本，并写审计。
   *
   * ⚠ `feature` 为什么是**参数**而不是写死 `ask_embed`：审计表按功能名分列，而这几处
   * embedding 的**数据范围完全不同** —— 消息侧（`ask_embed`）只发检索到的聊天片段，
   * 知识库侧（`kb_embed`）发的是用户选进知识库的**文件正文**，链接建议（`kb_link_suggest`）
   * 发的是**用户正在写的笔记正文**加本库候选标题。写死同一个名字，
   * 「我到底把哪一类东西发出去了」在审计里就分不开 —— 而用户完全可能只对其中一类给过同意。
   * @param model - 向量模型名（空则回退 chat model）。
   * @param feature - 审计里的功能名（`ask_embed` 聊天片段 / `kb_embed` 知识库文件正文 /
   *   `kb_link_suggest` 笔记正文与候选标题）。
   * @returns embedding 函数；底层 LLM 桥未提供 embed 时返回 undefined。
   */
  private makeEmbedFn(model: string, feature: 'ask_embed' | 'kb_embed' | 'kb_link_suggest' = 'ask_embed'): EmbedFn | undefined {
    const llmAny = this._ctx.llm as unknown as { embed?: (texts: string[], opts?: { model?: string }) => Promise<number[][]> }
    if (typeof llmAny?.embed !== 'function') return undefined
    return async (texts: string[]): Promise<number[][]> => {
      const gate = this.privacyGate(feature, { sessions: 0, messages: texts.length }, texts)
      if (!gate.ok) throw new Error(gate.error)
      return llmAny.embed!(gate.texts, model ? { model } : undefined)
    }
  }

  /**
   * 「这次 embedding 实际用的模型名」—— 由 LLM 桥回答，与它自己发请求时用的是**同一个解析**。
   *
   * 为什么不在这里自己拼一遍优先级：那等于第二次实现宿主侧的 `override || embeddingModel || model`
   * 规则，而两处规则一旦漂移，向量库里记的模型名就成了一个没人用得上的字符串 ——
   * 「换没换嵌入模型」的判定恰恰读的就是它（`§7 F1`：此前这边记 `'default'`、那边发 llm.json 的值，
   * 于是换模型永远不触发重建，旧向量被当成新模型的用）。所以记账名**必须**由发送方给出。
   * 桥未提供该方法时（测试桩）退回 override 本身。
   * @param override - 显式指定的模型名（可空）。
   * @returns 生效模型名；未配置时为空串。
   */
  private embedModelName(override = ''): string {
    const llmAny = this._ctx.llm as unknown as { embeddingModelName?: (o?: string) => string }
    if (typeof llmAny?.embeddingModelName !== 'function') return override
    return String(llmAny.embeddingModelName(override) ?? '')
  }

  /**
   * 某个角色的**全局**生效模型名（还没叠库级覆盖）。
   *
   * 三个角色都从宿主桥取值：桥是唯一知道「实际会发出去什么」的地方，
   * 网关自己再拼一遍优先级就会重新制造 §7 F1 那种两条链各算一次的局面。
   * @param role - 语言 / 嵌入 / 重排序。
   * @returns 模型名；空串 = 这个角色没配。
   */
  private globalModelName(role: KbModelRole): string {
    if (role === 'embed') return this.embedModelName(loadRetrievalConfig(this._dirs.decrypted).embedding.model)
    const llmAny = this._ctx.llm as unknown as { rerankModelName?: () => string; config?: { model?: string; rerankModel?: string } }
    if (role === 'rerank') {
      if (typeof llmAny?.rerankModelName === 'function') return String(llmAny.rerankModelName() ?? '')
      return String(llmAny?.config?.rerankModel ?? '')
    }
    const sel = (this._ctx as unknown as {
      agentDefaultModel?: { currentSelection(): { model?: string } }
    }).agentDefaultModel?.currentSelection?.()
    return String(sel?.model ?? llmAny?.config?.model ?? '')
  }

  /**
   * 某个库、某个角色**实际该用的**模型名（库级覆盖叠在全局之上）。
   *
   * 每次调用都重读设置：`llm.json` 那条链就是「改完下一次生效、不必重启」的语义，
   * 这里缓存住就会让库级覆盖比全局配置更难改。一次 SQLite 主键查是微秒级，不心疼。
   * @param kbId - 知识库 id（非法时等价于「没有库级覆盖」）。
   * @param role - 哪个角色。
   * @returns 解析结果（含来源，界面与审计都要用它说话）。
   */
  private kbModel(kbId: number, role: KbModelRole): ResolvedModel {
    const s = readKbModelSettings(this._dirs.decrypted, kbId)
    const ref = role === 'chat' ? s.chatRef : role === 'embed' ? s.embedRef : s.rerankRef
    return resolveModelRef(ref, this.globalModelName(role))
  }

  /**
   * 造一个「提示词 → 模型文本」的一次性调用（实体抽取、链接建议这类结构化小任务用）。
   *
   * 与 `summarizeKbFile` 同一套纪律：`privacyGate` 过闸 + `BlockAssembler` 收流 +
   * 失败抛出。为什么不复用摘要那条路径：那些地方各自要拼自己的 prompt 与 system，
   * 抽出来只共享「过闸 → 发 → 收文本」这三步，比造一个带一堆选项的大泛型函数诚实。
   * @param kbId - 当前库（取语言模型的库级覆盖）。
   * @param feature - 审计里登记的功能名。
   * @returns 调用函数；桥不支持流式时 undefined（调用方据此报「模型通道不可用」）。
   */
  private makeChatAsker(kbId: number, feature: string): ((prompt: string) => Promise<string>) | undefined {
    const ctx = this._ctx
    const llmAny = ctx.llm as unknown as { stream?: (o: unknown) => AsyncIterable<unknown> }
    if (typeof llmAny?.stream !== 'function') return undefined
    const model = this.kbModel(kbId, 'chat').model
    const sel = (ctx as unknown as {
      agentDefaultModel?: { currentSelection(): { provider: string; model: string } }
    }).agentDefaultModel?.currentSelection()
    const provider = String(sel?.provider ?? '')
    return async (prompt: string): Promise<string> => {
      const blocked = this.privacyBlocked(feature)
      if (blocked !== null) throw new Error(blocked)
      const gate = this.privacyGate(feature, { sessions: 0, messages: 0 }, [prompt])
      if (!gate.ok) throw new Error(gate.error)
      const assembler = new BlockAssembler()
      const opts: GenerateOptions = {
        provider,
        model,
        messages: [createUserMessage({
          content: [{ type: 'text', text: gate.texts[0] ?? prompt }],
          source: { kind: 'plugin', plugin: 'dsh-wechat-data' },
        })],
        system: '你是一名严格的信息抽取器。只输出要求的行格式，不解释、不寒暄、不补全文档里没有的名字。',
        maxTokens: 500,
      }
      for await (const c of ctx.llm.stream(opts)) assembler.push(c)
      return assembler.blocks().map(b => (b.type === 'text' ? b.text : '')).join('').trim()
    }
  }

  /**
   * 构造「过隐私闸门」的模型精排函数（问答检索的候选重排）。
   *
   * 三条纪律，少一条都是实质性的漏洞：
   *   ① `privacyBlocked` 判在**任何出网之前**（早于「没配模型」那类早退 —— 顺序错了
   *      用户看到的会是「AI 不可用」，把「拦截生效了」这件事盖掉）；
   *   ② `privacyGate` 必须一次过 `[query, ...documents]`。rerank 的入参天然是一批文档，
   *      只 gate 查询词等于把 N 条正文**裸发出去**，而审计表还会记成「已脱敏」；
   *   ③ 失败一律抛出而不是吞掉：调用方（pipeline）负责退回本地加权，并在 `rerankInfo`
   *      里说清这次为什么没精排。
   * 功能名叫 `ask_rerank` 而不是 `kb_rerank`：这一阶段跑在整个问答检索管道上，
   * 候选既可能来自聊天记录也可能来自知识库文件 —— 按知识库命名会让审计里那一列
   * 看起来只与文件有关，而它实际覆盖的是全部候选。
   * @param kbId - 当前库（用于取库级覆盖；0 = 没有库上下文）。
   * @returns 精排函数；没配模型或桥不支持时返回 undefined（管道据此跳过这一段）。
   */
  private makeRerankFn(kbId: number): ((query: string, documents: string[]) => Promise<number[]>) | undefined {
    const llmAny = this._ctx.llm as unknown as {
      rerank?: (q: string, docs: string[], o?: { model?: string }) => Promise<number[]>
    }
    if (typeof llmAny?.rerank !== 'function') return undefined
    const model = this.kbModel(kbId, 'rerank').model
    if (model === '') return undefined
    return async (query: string, documents: string[]): Promise<number[]> => {
      const blocked = this.privacyBlocked('ask_rerank')
      if (blocked !== null) throw new Error(blocked)
      const gate = this.privacyGate('ask_rerank', { sessions: 0, messages: documents.length }, [query, ...documents])
      if (!gate.ok) throw new Error(gate.error)
      const [q, ...rest] = gate.texts
      return llmAny.rerank!(q ?? query, rest, { model })
    }
  }

  /**
   * 读取「自动获取原图（CDN）」与「原图解密方式」两个开关（N24）。
   *
   * 这两个键在界面上可见（设置 → 图片解码），此前**没有任何消费者** —— 关掉后取图路径照旧
   * 出网，用户看到的是「开关说是关的、行为却不是」。所有远端取媒体（表情 / 公众号封面 /
   * 朋友圈视频与封面）都在这里统一取值再传进 query 层，保证「关掉 = 不发请求」。
   * @returns cdnEnabled=false 时 query 层会在发请求前返回；localDecrypt=false 表示服务端解密。
   */
  private cdnSwitches(): { cdnEnabled: boolean; localDecrypt: boolean } {
    try {
      const cfg = getConfig(this._dirs.decrypted)
      return {
        cdnEnabled: cfg['cdn_enabled'] !== false,
        localDecrypt: cfg['cdn_local_decrypt'] !== false,
      }
    } catch {
      // 读不到配置时**不拦**：这两个键的默认值本就是开启，读失败不该变成「静默断功能」
      return { cdnEnabled: true, localDecrypt: true }
    }
  }

  private _kbRemotes?: ReturnType<typeof createKbRemotes>

  /** KB 域的处理器（体在 remotes/kb.ts）；这里只组装 ctx 与转发。 */
  private kbRemotes(): ReturnType<typeof createKbRemotes> {
    return (this._kbRemotes ??= createKbRemotes({
      dirs: () => this._dirs,
      ctx: this._ctx,
      kbIndexJobs: this._kbIndexJobs,
      op: (category, action, status, target, detail) => this.op(category, action, status, target, detail),
      privacyBlocked: (feature, detail) => this.privacyBlocked(feature, detail),
      privacyGate: (feature, stats, texts) => this.privacyGate(feature, stats, texts),
      makeEmbedFn: (model, feature) => this.makeEmbedFn(model, feature),
      globalModelName: (role) => this.globalModelName(role),
      kbModel: (kbId, role) => this.kbModel(kbId, role),
      makeChatAsker: (kbId, feature) => this.makeChatAsker(kbId, feature),
    }))
  }

  private _mediaRemotes?: ReturnType<typeof createMediaRemotes>

  /** 媒体域的处理器（体在 remotes/media.ts）；这里只组装 ctx 与转发。 */
  private mediaRemotes(): ReturnType<typeof createMediaRemotes> {
    return (this._mediaRemotes ??= createMediaRemotes({
      dirs: () => this._dirs,
      op: (category, action, status, target, detail) => this.op(category, action, status, target, detail),
      privacyBlocked: (feature, detail) => this.privacyBlocked(feature, detail),
      cdnSwitches: () => this.cdnSwitches(),
      outboundBlocked: () => this.outboundBlocked(),
      rawWechatBase: (decrypted) => rawWechatBase(decrypted),
      warmDecodedImages: (decryptedDir, decodedDir, baseDir, items, aesKey, xorKey) => this.warmDecodedImages(decryptedDir, decodedDir, baseDir, items, aesKey, xorKey),
    }))
  }

  private _exportRemotes?: ReturnType<typeof createExportRemotes>

  /** 导出域的处理器（体在 remotes/export.ts）；这里只组装 ctx 与转发。 */
  private exportRemotes(): ReturnType<typeof createExportRemotes> {
    return (this._exportRemotes ??= createExportRemotes({
      dirs: () => this._dirs,
      ctx: () => this._ctx,
      op: (category, action, status, target, detail) => this.op(category, action, status, target, detail),
      recordExport: (input) => this.recordExport(input),
      streamControl: (jobId) => this.streamControl(jobId),
      finishStreamJob: (jobId, error) => this.finishStreamJob(jobId, error),
      normalizeJobId: (jobId) => normalizeJobId(jobId),
      streamJobs: this._streamJobs,
    }))
  }

  private _tasksRemotes?: ReturnType<typeof createTasksRemotes>

  /** 任务与笔记（待办 / 笔记 / 交接提醒） 的处理器（体在 remotes/tasks.ts）；这里只组装 ctx 与转发。 */
  private tasksRemotes(): ReturnType<typeof createTasksRemotes> {
    return (this._tasksRemotes ??= createTasksRemotes({
      dirs: () => this._dirs,
      op: (category, action, status, target, detail) => this.op(category, action, status, target, detail),
    }))
  }

  private _opsLogRemotes?: ReturnType<typeof createOpsLogRemotes>

  /** 操作日志与隐私审计（含隐私开关读数） 的处理器（体在 remotes/opslog.ts）；这里只组装 ctx 与转发。 */
  private opsLogRemotes(): ReturnType<typeof createOpsLogRemotes> {
    return (this._opsLogRemotes ??= createOpsLogRemotes({
      dirs: () => this._dirs,
      op: (category, action, status, target, detail) => this.op(category, action, status, target, detail),
    }))
  }

  private _backupRemotes?: ReturnType<typeof createBackupRemotes>

  /** 备份与恢复（含加密备份） 的处理器（体在 remotes/backup.ts）；这里只组装 ctx 与转发。 */
  private backupRemotes(): ReturnType<typeof createBackupRemotes> {
    return (this._backupRemotes ??= createBackupRemotes({
      dirs: () => this._dirs,
      op: (category, action, status, target, detail) => this.op(category, action, status, target, detail),
      streamControl: (jobId) => this.streamControl(jobId),
      finishStreamJob: (jobId, error) => this.finishStreamJob(jobId, error),
      normalizeJobId: (jobId) => normalizeJobId(jobId),
    }))
  }

  private _configRemotes?: ReturnType<typeof createConfigRemotes>

  /** 数据配置与密钥状态（含解密/数据库状态） 的处理器（体在 remotes/config.ts）；这里只组装 ctx 与转发。 */
  private configRemotes(): ReturnType<typeof createConfigRemotes> {
    return (this._configRemotes ??= createConfigRemotes({
      dirs: () => this._dirs,
      op: (category, action, status, target, detail) => this.op(category, action, status, target, detail),
      decryptState: this.decryptState,
    }))
  }

  private _summaryRemotes?: ReturnType<typeof createSummaryRemotes>

  /** 总结任务（每日/周期总结的排程与运行） 的处理器（体在 remotes/summary.ts）；这里只组装 ctx 与转发。 */
  private summaryRemotes(): ReturnType<typeof createSummaryRemotes> {
    return (this._summaryRemotes ??= createSummaryRemotes({
      dirs: () => this._dirs,
      op: (category, action, status, target, detail) => this.op(category, action, status, target, detail),
      ctx: () => this._ctx,
      privacyBlocked: (feature, detail) => this.privacyBlocked(feature, detail),
      privacyGate: (feature, stats, texts) => this.privacyGate(feature, stats, texts),
    }))
  }

  private _askRemotes?: ReturnType<typeof createAskRemotes>

  /** 问答反馈与检索配置（画像表 / 反馈表 / 配置） 的处理器（体在 remotes/ask.ts）；这里只组装 ctx 与转发。 */
  private askRemotes(): ReturnType<typeof createAskRemotes> {
    return (this._askRemotes ??= createAskRemotes({
      dirs: () => this._dirs,
      op: (category, action, status, target, detail) => this.op(category, action, status, target, detail),
      askFeedbackSeen: this._askFeedbackSeen,
      askTrace: this._askTrace,
    }))
  }

  private _keysDecryptRemotes?: ReturnType<typeof createKeysDecryptRemotes>

  /** 密钥获取与全库/全图解密（图片密钥自动获取、验证、解密状态） 的处理器（体在 remotes/keysdec.ts）；这里只组装 ctx 与转发。 */
  private keysDecryptRemotes(): ReturnType<typeof createKeysDecryptRemotes> {
    return (this._keysDecryptRemotes ??= createKeysDecryptRemotes({
      dirs: () => this._dirs,
      op: (category, action, status, target, detail) => this.op(category, action, status, target, detail),
      decryptState: this.decryptState,
      rawWechatBase: (decrypted) => rawWechatBase(decrypted),
    }))
  }

  private _graphSearchRemotes?: ReturnType<typeof createGraphSearchRemotes>

  /** 知识图谱、消息检索与索引（含编辑历史复位） 的处理器（体在 remotes/graphsearch.ts）；这里只组装 ctx 与转发。 */
  private graphSearchRemotes(): ReturnType<typeof createGraphSearchRemotes> {
    return (this._graphSearchRemotes ??= createGraphSearchRemotes({
      dirs: () => this._dirs,
      op: (category, action, status, target, detail) => this.op(category, action, status, target, detail),
      searchJobs: this._searchJobs,
      searchSignal: (jobId) => this.searchSignal(jobId),
    }))
  }

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
   * Custom emoticons.
   * @param options - Optional limit/offset for incremental loading.
   * @returns EmoticonsSnapshot: emoticon items.
   */
  @Remote('getEmoticons')
  getEmoticons(options?: { limit?: number; offset?: number }): EmoticonsSnapshot {
  return this.mediaRemotes().getEmoticons(options)
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
   * Relationship graph.
   * @returns GraphSnapshot: chat relationship graph data.
   */
  @Remote('getGraph')
  getGraph(): GraphSnapshot {
    return queryGraph(this._dirs.decrypted, this.selfUsername())
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
   * Knowledge graph: note nodes, `[[…]]` edges, unresolved stubs, **plus the
   * document entity layer** (registered files and their normalized sections).
   *
   * 与 `getGraph` 分开而不是合并：社交图谱的节点口径（联系人/群/我）和知识图谱
   * （笔记/未解析目标）是两套语义，合并会让两个面板都变脆。
   * 两份快照**不在前端拼**：知识图谱的节点必须只来自知识库，人/群是通讯录数据，
   * 因此曾经的「融合视图」已删除（见前端 panels/graph-model.ts 的文件头约束）。
   *
   * **一库一图**：`kbId` 必填且没有默认值可给 —— 改前这张图是全库合并的，
   * 多库之后会把两个库里同名的笔记并成一个节点，`[[链接]]` 也会指错库。
   *
   * 文档实体在这里合流，而不是在 `notes.ts` 里：笔记库与文件库是**两个 db 文件**，
   * `notes.ts` 那一层物理上看不见文件（它自己的注释就写着 `fileCount` 恒为 0）。
   * 与 `getKbs` 的 fileCount 合流是同一个理由、同一个位置。
   * 文件库读不到时图谱照常返回笔记部分，但把原因并进 `readError` ——
   * 「这个库没登记过文件」与「文件库打不开」必须是两句话（N1）。
   * @param kbId - the knowledge base to build from.
   * @returns KnowledgeSnapshot（含运行期可能带上的 `readError`，见 `KnowledgeSnapshotRead`）。
   */
  @Remote('getKnowledgeGraph')
  getKnowledgeGraph(kbId: number): KnowledgeSnapshotRead {
    return this.graphSearchRemotes().getKnowledgeGraph(kbId)
  }

  /**
   * 让模型读一遍本库的文件，抽出实体（推断层）。
   *
   * 三条纪律：
   *   ① `privacyBlocked('kb_extract')` 判在任何模型调用之前；
   *   ② 只处理 `include_in_rag = 1` 的文件 —— 关掉出网开关的文件连一次抽取都不该被发出去
   *      （条件在 SQL 里，见 `extract.ts` 的 `readDigestForExtract`）；
   *   ③ 按文件、不按 chunk，且**整批替换**上一次结果（重跑不是追加）。
   * @param options - `kbId`；`fileIds` 限定范围（默认整库）；`limit` 单次最多几个文件。
   * @returns 逐文件结果 + 汇总（失败的逐个带原因，不因一个失败就整批失败）。
   */
  @Remote('extractKbEntities')
  async extractKbEntities(options: { kbId: number; fileIds?: number[]; limit?: number }): Promise<{
    ok: boolean
    error?: string
    files: number
    saved: number
    failed: Array<{ id: number; error: string }>
    model: string
  }> {
  return this.kbRemotes().extractKbEntities(options)
  }

  /**
   * 笔记编辑器里的「模型建议的链接」—— 返回候选，**不写任何东西**。
   *
   * 三条纪律（V6 的全部内容）：
   *   ① `privacyBlocked('kb_link_suggest')` 判在所有早退之前 —— 「没配嵌入模型」不能
   *      盖掉「用户明确说过不要出网」，否则审计里看不到那次被拦下的尝试；
   *   ② 出去的是**正文 + 候选标题**，所以 gate 的 texts 必须一次带上两边
   *      （`makeEmbedFn` 内部对整批文本过一次闸，漏一半就等于漏的那半没脱敏）；
   *   ③ 本方法**没有任何写路径**：连一行正文都不碰。边只在用户点芯片之后由
   *      `parseWikiLinks` 从正文里派生 —— 模型判断错的代价因此是「没人点」，
   *      而不是「图谱里多了一条用户没写过的边」。
   * @param options - `kbId`、正在编辑的 `text`、可选 `topK` 与自身标题 `excludeTitle`。
   * @returns 候选（按相似度降序）+ 参与排序的池大小 + 说明。
   */
  @Remote('suggestKbLinks')
  async suggestKbLinks(options: { kbId: number; text?: string; topK?: number; excludeTitle?: string }): Promise<{
    ok: boolean
    error?: string
    candidates: Array<{ label: string; kind: 'note' | 'entity'; score: number }>
    pool: number
    model: string
    note?: string
  }> {
  return this.kbRemotes().suggestKbLinks(options)
  }

  /**
   * Knowledge base list — the scope selector's data source.
   *
   * 两个库文件在这里**合流**：笔记数来自笔记库（`listKbs`），文件数来自文件库
   * （`countKbFilesByKb`，一次 GROUP BY）。合并只能写在这一层 —— `notes.ts` 看不到文件库。
   *
   * 少了这次合并，界面上的 `fileCount` 会恒为 0，于是删库弹层对一个「0 条笔记 / 5 个文件」
   * 的库说「这个库是空的」（真机探针实测）。文件库读失败时 `countKbFilesByKb` 返回空表 ⇒
   * 退化成 0，与本次改动前的行为一致，不是新增风险。
   * @returns KbListSnapshot: every kb with its note count **and** file count. An
   *   unreadable note store yields an empty list **plus** `readError`; callers must
   *   not read that as "there is no kb at all" and create one over the top.
   */
  @Remote('getKbs')
  getKbs(): KbListSnapshot {
  return this.kbRemotes().getKbs()
  }

  /**
   * Create one knowledge base.
   * @param options - `name`: required, normalized-unique, at most `KB_NAME_MAX` chars.
   * @returns KbMutationResult: `{ ok, id }`, or `{ ok: false, error }`.
   */
  @Remote('createKb')
  createKb(options: { name: string }): KbMutationResult {
  return this.kbRemotes().createKb(options)
  }

  /**
   * Rename one knowledge base.
   *
   * 笔记**不动**：归属存在 `kb_id` 上，库名只是显示名。用库名当外键的话，
   * 「改名」会退化成「迁移全部笔记」，还要处理迁移到一半崩掉。
   * @param options - `id` plus the new `name`.
   * @returns KbMutationResult.
   */
  @Remote('renameKb')
  renameKb(options: { id: number; name: string }): KbMutationResult {
  return this.kbRemotes().renameKb(options)
  }

  /**
   * Delete one knowledge base.
   *
   * `action` **必填、无默认值**：库里的笔记是「搬到别的库」还是「一起删掉」只有调用方
   * 能决定，而这里最危险的默认值恰好是「一起删」—— 一次「我以为只是删个空壳库」的点击
   * 会直接把几十条笔记带走。默认库本身也不可删（它是迁移兜底）。
   * @param options - `id` plus `action` (`{kind:'reassign',targetKbId}` or `{kind:'purge'}`).
   * @returns KbMutationResult carrying `movedNotes` / `removedNotes`.
   */
  @Remote('deleteKb')
  deleteKb(options: { id: number; action: KbDeleteAction }): KbMutationResult {
  return this.kbRemotes().deleteKb(options)
  }

  /**
   * 一个知识库里的文件列表（新上传的在前）。
   *
   * 与 `getNotes` 同口径，`kbId` 必填：文件、分块、检索全部按库划作用域，
   * **没有**「所有库的文件」这种视图 —— 那正是多库之后最容易出现的串数据。
   * @param kbId - the knowledge base to read; required, there is no "all kbs" mode.
   * @param options - Pagination (limit/offset).
   * @returns KbFileListSnapshot. 库读不到时给 `readError` 而不是空列表，
   *   好让面板说「读不到」而不是「还没有文件」。
   */
  @Remote('getKbFiles')
  getKbFiles(kbId: number, options?: { limit?: number; offset?: number }): KbFileListSnapshot {
  return this.kbRemotes().getKbFiles(kbId, options)
  }

  /**
   * 读某个文件解析出来的正文（分页）。界面上「就地展开看内容」走这一条。
   *
   * 与 `getKbFiles` 同样：`kbId` 必填、没有「所有库」模式，而且这一条**还多一道**
   * `fileId` 必须属于该库的确认 —— 它返回的是内容而不是计数，跨库串起来的后果重得多。
   * 返回的是解析文本，不是原文件排版（表格 / 图片 / 页眉页脚在解析阶段已丢），
   * 界面上必须这样标注，别让人以为在看原稿。
   * @param kbId - 目标库（必填）。
   * @param fileId - 目标文件。
   * @param options - 分页（limit 上限 200 块）。
   * @returns KbFileChunkPage。
   */
  @Remote('getKbFileChunks')
  getKbFileChunks(kbId: number, fileId: number, options?: { limit?: number; offset?: number }): KbFileChunkPage {
  return this.kbRemotes().getKbFileChunks(kbId, fileId, options)
  }

  /**
   * 登记一批文件（原生对话框多选的结果）。
   *
   * 逐个登记、逐个回执：每个文件各自一个事务，中途某一个失败不影响已经进来的那些。
   * 于是一次多选的部分失败（重复 / 类型不支持 / 太大）是**可解释**的，
   * 而不是一句笼统的「添加失败」。
   * @param options - `kbId`、`paths`（绝对路径数组）、`includeInRag`（不给按 true）。
   * @returns KbFileAddResult：`ok` = 至少进来一个；逐项原因在 `results` 里。
   */
  @Remote('addKbFiles')
  addKbFiles(options: { kbId: number; paths: string[]; includeInRag?: boolean }): KbFileAddResult {
  return this.kbRemotes().addKbFiles(options)
  }

  /**
   * 删除一个文件（连带它的分块 / FTS 行 / 向量 / blob 副本）。
   *
   * **不碰用户电脑上的原文件** —— 删的是知识库里的这一份，那份原文件仍然在他的盘上。
   * `kbId` 是**守卫**：文件 id 全局自增，拿甲库的 id 调乙库会删掉甲库那一条，
   * 而删除是物理的、没有撤销（与 `deleteNote` 同一条纪律）。
   * @param options - `kbId` plus the file row id.
   * @returns KbFileMutationResult（回执里带连带清掉的分块数与副本是否被删）。
   */
  @Remote('deleteKbFile')
  deleteKbFile(options: { kbId: number; id: number }): KbFileMutationResult {
  return this.kbRemotes().deleteKbFile(options)
  }

  /**
   * 切换一个文件是否参与向量化（出网）。
   *
   * 关掉之后该文件**完全不出网**，但仍然留在 FTS 索引里可被关键词搜到 ——
   * 这正是「库里有合同，但我还想搜到它」的实现方式（设计稿 §9.2）。
   * 全局「禁止 AI 出网」仍然是同一道闸门，一起拦下。
   * @param options - `kbId`、文件 id、是否参与。
   * @returns KbFileMutationResult.
   */
  @Remote('setKbFileRag')
  setKbFileRag(options: { kbId: number; id: number; includeInRag: boolean }): KbFileMutationResult {
  return this.kbRemotes().setKbFileRag(options)
  }

  /**
   * 用模型给某个知识库文件生成摘要。**这是一条出网调用**，与问答同一套闸门。
   *
   * 顺序是硬性的（照 `optimizeAskQuestion` 的口径，理由写在它头上）：
   *   ① `privacyBlocked` 判在**最前面**，早于「未配置模型」那类早退 ——
   *      否则用户开了「禁止 AI 出网」又没配模型时，看到的是「未配置模型」，
   *      把「拦截真的生效了」这件事盖掉了。
   *   ② `include_in_rag = 0` 直接拒绝：那个开关的语义是「这份文件永不出网」，
   *      给它做摘要等于推翻用户已经做过的决定，不是「再确认一下」能补的。
   *   ③ 发出去之前过一次 `privacyGate`（脱敏 + 审计）。
   *
   * ⚠ 只喂得下前若干字：一份文件最多两万块、约一千万字，一次请求装不进去。
   *   所以按 `SUMMARY_INPUT_CHARS` 截断，并把**实际覆盖的字符数**一起返回并落库 ——
   *   界面必须据此标出「这只是前 N 字的摘要」。不标就是让一个局部摘要
   *   顶着「摘要」的名字被当成整份文件的概括读，那是界面在骗人。
   * @param options - `kbId`（守卫）与 `id`（目标文件）。
   * @returns KbSummaryResult。
   */
  @Remote('summarizeKbFile')
  async summarizeKbFile(options: { kbId: number; id: number }): Promise<KbSummaryResult> {
  return this.kbRemotes().summarizeKbFile(options)
  }

  /**
   * 在某个知识库里做检索 —— 稀疏（FTS5 bm25）+ 稠密（向量余弦）两路，RRF 名次融合。
   *
   * 为什么稠密这一路要在网关做而不下沉进 `searchKbRows`：稠密要**出网**（把查询词送去
   * embedding），而隐私闸门与模型名解析都住在这一层；query 层保持「给什么函数用什么函数」，
   * 才能被问答管道与面板同时复用（`retrieval/kb-channel.ts` 走的就是同一个 `searchKbDense`）。
   *
   * `degraded` 现在说的是**本次真话**（原来是一句硬编码的「未建向量索引」）：
   * 未配模型 / 索引过期 / embedding 失败 / 稠密跑成功，四种情形的出路完全不同，
   * 混成一句会让用户以为「知识库里没有这个东西」。
   * @param options - `kbId`、查询词、可选条数（上限 `MAX_KB_TOP_K`）。
   * @returns KbSearchResult：命中 + 统计 + 降级说明。
   */
  @Remote('searchKb')
  async searchKb(options: { kbId: number; query?: string; topK?: number }): Promise<KbSearchResult> {
  return this.kbRemotes().searchKb(options)
  }

  /**
   * 某个知识库的**模型设置**（三个角色的引用 + 各自实际生效的名字）。
   *
   * 回包里同时给「引用串」和「解析结果」：下拉框要回填前者（用户改过什么），
   * 而界面要说的是后者（现在到底在用哪个模型）。只给一个就会出现
   * 「显示的是全局值、实际用的是覆盖值」这类看起来无害的错位。
   * @param options - `kbId`。
   * @returns 设置 + 三角色的解析结果 + 全局值（下拉里「继承全局：xxx」那半句要用）
   *   + 实体抽取的进度（同一个回包：弹层开一次要读三样，分开读会让首帧分三次跳）。
   */
  @Remote('getKbModelConfig')
  getKbModelConfig(options: { kbId: number }): {
    kbId: number
    settings: KbModelSettings
    global: Record<KbModelRole, string>
    resolved: Record<KbModelRole, ResolvedModel>
    entities: KbEntitySummary
  } {
  return this.kbRemotes().getKbModelConfig(options)
  }

  /**
   * 写某个知识库的模型覆盖（只改传进来的那几项；传空串 = 取消覆盖、回到继承）。
   *
   * 这一层**不写凭据**：引用串只能是「继承」或「m:<模型名>」，端点与 Key 永远只在 `llm.json`。
   * 为什么收窄到这样：一条 profile 是一套同厂商的连接参数，按库引用它就会把
   * 「A 家地址 + B 家 Key」这种 401 陷阱重新请回来（见 `model-config.ts` 头注）。
   * @param options - `kbId` 加可选的 `chatRef` / `embedRef` / `rerankRef`。
   * @returns 最新设置；引用串不合法时 `{ ok: false, error }`（不静默改成继承）。
   */
  @Remote('setKbModelConfig')
  setKbModelConfig(options: { kbId: number; chatRef?: string; embedRef?: string; rerankRef?: string }):
    { ok: true; settings: KbModelSettings } | { ok: false; error: string } {
  return this.kbRemotes().setKbModelConfig(options)
  }

  /**
   * 某个知识库的**向量索引状态**（面板的「语义索引」按钮与状态 chip 读这个）。
   *
   * 为什么要单独一个读接口：向量索引此前只有一个隐式入口 —— 提问时顺手补齐
   * （`askWechat` 里那段），于是界面上既**触发不了**它也**看不见**它：
   * 用户只知道「有时能语义搜到、有时搜不到」，而差别其实只是这个库建没建过。
   * @param options - `kbId`。
   * @returns 当前生效的模型名、是否配了通道、按库状态、以及本进程内的在飞构建进度。
   */
  @Remote('getKbVectorIndex')
  getKbVectorIndex(options: { kbId: number }): {
    kbId: number
    model: string
    source: 'inherit' | 'inline'
    configured: boolean
    status: KbVectorIndexStatus
    job: { done: number; total: number; startedAt: number; error: string } | null
  } {
  return this.kbRemotes().getKbVectorIndex(options)
  }

  /**
   * 为**某个库**构建 / 增量更新向量索引（面板上那个「语义索引」按钮）。
   *
   * 三条纪律：
   *   ① 出站拦截判在**任何 embedding 之前**（`privacyBlocked` 先于「未配置模型」那类早退）；
   *   ② 只建本库 —— 出网范围必须与用户此刻的意图一致，一次建全库会把别的库的正文也发出去；
   *   ③ 语料只取 `include_in_rag = 1` 的文件，且写在 SQL 里（见 `kb-vectors.ts` 头注）。
   * @param options - `kbId`；`force` 时清空本库重算。
   * @returns 构建结果（`ok` 为假时带 `error`）。
   */
  @Remote('buildKbVectorIndex')
  async buildKbVectorIndex(options: { kbId: number; force?: boolean }): Promise<KbVectorBuildResult & { ok: boolean; error?: string }> {
  return this.kbRemotes().buildKbVectorIndex(options)
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
   * Resource files.
   * @param options - Optional limit/offset and category filter for incremental loading.
   * @returns FilesSnapshot: resource file items.
   */
  @Remote('getFiles')
  getFiles(options?: { limit?: number; offset?: number; category?: string; q?: string }): FilesSnapshot {
  return this.mediaRemotes().getFiles(options)
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
   * Build (or rebuild) the FTS5 message search index.
   * @param options - force: rebuild even when the index already exists.
   * @returns SearchBuildResult: build outcome with row counts.
   */
  @Remote('buildSearchIndex')
  async buildSearchIndex(options?: { force?: boolean }): Promise<SearchBuildResult> {
    return this.graphSearchRemotes().buildSearchIndex(options)
  }

  /**
   * Full-text search over text messages (index first, scan fallback).
   *
   * N9：可取消。渲染层每次搜索生成一个 `jobId`，切换面板/发起新搜索时用 `cancelSearch({ jobId })`
   * 打断上一次 —— 兜底扫描会在百毫秒内收尾并返回部分结果（见 `query/search.ts` 的 `SearchControl`）。
   * 不带 jobId 时行为与从前一致（跑完为止）。
   * @param options - query string, optional result limit and optional talker scope.
   * @returns SearchSnapshot: matched message items（被取消时带 `cancelled: true`）。
   */
  @Remote('searchMessages')
  async searchMessages(options: { query: string; limit?: number; username?: string; jobId?: string }): Promise<SearchSnapshot> {
    return this.graphSearchRemotes().searchMessages(options)
  }

  /**
   * 取一个搜索任务的取消信号（N9）。
   * @param jobId - 渲染层生成的不透明标识；缺省/空白时返回 undefined（＝不可取消）。
   * @returns 信号与收尾函数；收尾只在槽里还是自己这一枚控制器时才删 —— 否则会把「先取消、再重跑」
   *   的新令牌一起删掉。
   */
  private searchSignal(jobId?: string): { signal: AbortSignal; done: () => void } | undefined {
    const id = normalizeJobId(jobId)
    if (id === '') return undefined
    const ctrl = new AbortController()
    this._searchJobs.set(id, ctrl)
    return {
      signal: ctrl.signal,
      done: () => { if (this._searchJobs.get(id) === ctrl) this._searchJobs.delete(id) },
    }
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
  }): Promise<ExportResult> {
  return this.exportRemotes().exportSessionMessages(options)
  }

  /**
   * 记一条导出历史（best-effort）。
   *
   * 为什么放在网关而不是各导出函数内部：`recordExport` 需要「解密数据根」来定位历史库，
   * 而各 `export*.ts` 函数都拿到了 `decryptedDir` —— 但重跑参数只有网关这一层完整掌握
   * （客户端传什么原样存下来），所以在网关这层记录最不容易漏字段。
   * @param input - 本次导出的事实。
   */
  private recordExport(input: {
    kind: string
    label?: string
    format?: string
    path: string
    rows?: number
    status: ExportStatus
    error?: string
    params?: unknown
  }): void {
    try {
      recordExport(this._dirs.decrypted, input)
    } catch { /* 历史记录失败绝不影响导出本身 */ }
  }

  /**
   * 构造「回答增量」事件推送器。
   *
   * 为什么节流：每个增量都要跨 IPC → 渲染进程 → React setState，模型一秒能吐几十个
   * delta，不节流会把开销压到生成本身上。80ms 约等于 12fps，视觉上已足够连续。
   * @param streamId - 客户端生成的流式标识；为空表示不推送（非流式调用方）。
   * @returns 增量回调（text 为**已生成的全文**）。
   */
  private makeDeltaEmitter(streamId?: string): ((text: string) => void) | undefined {
    const id = typeof streamId === 'string' ? streamId.slice(0, 64) : ''
    if (!id) return undefined
    const ctx = this._ctx
    let last = 0
    return (text: string): void => {
      const now = Date.now()
      if (now - last < 80) return
      last = now
      try { ctx.emit('wechat-ask/delta', { id, text }) } catch { /* 事件尽力而为，失败不影响生成 */ }
    }
  }

  /**
   * AI Q&A over WeChat data: retrieve context + DSH LLM answer with citations.
   * @param options - question to ask over the WeChat data.
   * @returns AskResult: LLM answer with citations.
   */
  @Remote('askWechat')
  async askWechat(options: {
    question: string
    username?: string
    from?: string
    to?: string
    history?: Array<{ role: 'user' | 'assistant'; content: string }>
    /** 客户端生成的流式标识：带上它才会推送 wechat-ask/delta 增量事件。 */
    streamId?: string
    /**
     * 入口来源，写进问答历史：`ask` = 「微信问答」页签，`session` = 会话内问答。
     * 缺省按 `ask` 处理 —— 旧客户端不带这个字段时也能正常落库。
     */
    source?: string
    /** 会话显示名：历史列表直接显示，省掉面板再查一次会话表。 */
    usernameName?: string
    /**
     * 当前知识库 id：本次提问会把该库的文件块一并纳入检索。
     *
     * 缺省不检索知识库（而不是「搜所有库」）—— 与其余知识库接口同一纪律：
     * `kbId` 是作用域，没有「所有库」这种模式；漏传应当表现为「没检索到文件」，
     * 而不是把别的库的内容也端上来。
     */
    kbId?: number
  }): Promise<AskResult> {
    const ctx = this._ctx
    /** 端到端耗时基准（提问 → 回答生成结束），写进历史记录供用户回看时判断快慢。 */
    const askStartedAt = Date.now()
    // 先判「出站拦截」：它比「未配置模型」更该被用户看到（见 privacyBlocked 的注释）
    const blocked = this.privacyBlocked('ask_wechat')
    if (blocked !== null) {
      this.op('task', 'ask_wechat', 'skip', '', blocked)
      throw new Error(blocked)
    }
    const defaultModel = (ctx as unknown as {
      agentDefaultModel?: { currentSelection(): { provider: string; model: string; reasoningEffort?: string } }
    }).agentDefaultModel
    const sel = defaultModel?.currentSelection()
    if (!sel || !sel.provider || !sel.model) {
      this.op('task', 'ask_wechat', 'fail', '', '未配置默认模型（agentDefaultModel）')
      throw new Error('未配置默认模型（agentDefaultModel），无法调用 AI 问答')
    }
    /** 写进历史的回答模型标签（与面板底部「片段会发给谁」同一口径）。 */
    const modelLabel = `${sel.provider} · ${sel.model}`
    // 检索范围：会话范围 / 时间范围必须真的参与检索。
    // 从前这里只传 question，用户选了「会话范围」也仍然全库检索（本次修复）。
    const scope: { username?: string; from?: string; to?: string } = {
      username: typeof options.username === 'string' && options.username ? options.username : undefined,
      from: typeof options.from === 'string' && options.from ? options.from : undefined,
      to: typeof options.to === 'string' && options.to ? options.to : undefined,
    }
    // 多轮：最多携带最近 16 条（8 轮），并按**总字数预算**截断 ——
    // 单条截断不够：8 轮长回答各 2000 字会把 prompt 撑到 1.6 万字，把检索结果挤到末尾。
    const history = (Array.isArray(options.history) ? options.history : [])
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim().length > 0)
      .slice(-16)
    const HISTORY_BUDGET = 4000
    let historyUsed = 0
    const trimmedHistory: Array<{ role: 'user' | 'assistant'; content: string }> = []
    for (const m of [...history].reverse()) {
      const room = HISTORY_BUDGET - historyUsed
      if (room <= 80) break
      const text = m.content.trim().slice(0, Math.min(m.role === 'assistant' ? 1200 : 400, room))
      trimmedHistory.unshift({ role: m.role, content: text })
      historyUsed += text.length
    }
    const llm = ctx.llm
    /**
     * 跑一次对话。`onDelta` 存在时，把**已生成的全文**在生成过程中回传 ——
     * 传全文而不是增量片段：渲染进程只需整体替换，丢一两个事件也不会串行错乱。
     */
    const runChat = async (system: string, userText: string, maxTokens: number, onDelta?: (text: string) => void): Promise<string> => {
      const assembler = new BlockAssembler()
      const opts: GenerateOptions = {
        provider: sel.provider,
        model: sel.model,
        messages: [createUserMessage({
          content: [{ type: 'text', text: userText }],
          source: { kind: 'plugin', plugin: 'dsh-wechat-data' },
        })],
        system,
        maxTokens,
      }
      let acc = ''
      let emitted = false
      for await (const chunk of llm.stream(opts)) {
        assembler.push(chunk)
        const c = chunk as { type?: string; text?: string }
        if (onDelta && c.type === 'text-delta' && typeof c.text === 'string') {
          acc += c.text
          emitted = true
          onDelta(acc)
        }
      }
      // 厂商不支持 SSE 时 stream() 只 yield 一次完整 text-delta，上面已覆盖；
      // 若一个 delta 都没拿到（极端情况），最后补发一次完整文本，保证界面不会空着。
      if (onDelta && !emitted) {
        const finalText = assembler.blocks().map(b => (b.type === 'text' ? b.text : '')).join('').trim()
        if (finalText) onDelta(finalText)
      }
      return assembler.blocks().map(b => (b.type === 'text' ? b.text : '')).join('').trim()
    }

    // ── 第 1 步：意图分析与拆解（LLM → JSON 规划） ──
    // 规划器同时负责**把相对时间换算成绝对日期**（「上周三」→ 2026-09-02）与
    // **点名的人**（「李四」）—— 旧实现只取 subQueries，这两个线索全丢，
    // 于是「上周三我和李四聊了什么」只能靠通用词在全库瞎撞。
    const today = new Date()
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][today.getDay()]
    const scopeDesc = `会话=${scope.username ?? '全部'}${scope.from ? `，起始=${scope.from}` : ''}${scope.to ? `，截止=${scope.to}` : ''}`
    const historyBrief = history.length > 0
      ? '\n对话历史（最近）：\n' + trimmedHistory.map(m => (m.role === 'user' ? '用户：' : '助手：') + m.content.slice(0, 300)).join('\n')
      : ''
    const planPrompt = `今天是 ${todayStr}（${weekday}）。\n用户问题：${options.question}\n当前筛选范围：${scopeDesc}${historyBrief}\n\n请输出 JSON（不要输出其他内容）。`
    const gatePlan = this.privacyGate('ask_wechat', { sessions: 0, messages: 0 }, [planPrompt])
    if (!gatePlan.ok) {
      this.op('task', 'ask_wechat', 'skip', '', gatePlan.error)
      throw new Error(gatePlan.error)
    }
    let plan: { intent: string; subQueries: string[]; from: string; to: string; person: string }
    try {
      const planText = await runChat(
        '你是微信本地聊天记录的检索规划器。任务：分析用户问题，输出**检索关键词**与**隐含条件**。'
        + '要求：① subQueries 给 1-4 个真正有区分度的中文关键词或短语（人名、事物、动作、专有名词），'
        + '不要输出「什么/怎么/我的/给我/最近/一次」这类疑问词、停用词或泛化时间词；'
        + '② 问题里出现相对时间（上周三/昨天/上个月）时，按给定的今天日期换算成绝对日期填 from/to（YYYY-MM-DD，单日则 from=to），'
        + '识别不出就留空字符串；③ 问题点名了某个人就填 person，否则留空字符串。'
        + '只输出一行 JSON：{"intent":"一句话意图","subQueries":["关键词1","关键词2"],"from":"YYYY-MM-DD","to":"YYYY-MM-DD","person":"人名"}',
        gatePlan.texts[0] ?? planPrompt,
        512,
      )
      plan = parseAskPlan(planText)
      if (plan.subQueries.length === 0 && options.question.trim()) plan.subQueries = [options.question.trim()]
    } catch (e) {
      // 规划失败不阻断：退化为直接用原问题做 bigram 检索，保证问答始终可用。
      plan = { intent: '（规划失败，直接检索原问题）', subQueries: options.question.trim() ? [options.question.trim()] : [], from: '', to: '', person: '' }
      this.op('task', 'ask_wechat', 'fail', 'intent_plan', (e as Error).message)
    }

    // ── 第 2 步：多词召回 → 打分排序 → 展开成对话窗口（chunk 级 RAG 检索）──
    // 自建 BM25 索引是「相关度排序」的前提：没有它就得退回 LIKE 扫描，
    // 每个词只能看到按行号倒序的前 20 条（实测 `合同` 全库 4062 条 → 召回率 0.49%）。
    // 全量构建实测 5.4s / 13.5 万条，因此首次提问时自动建一次。
    //
    // **关键（本轮修）**：只有「首次构建」是不够的。「索引存在且版本对」跟「索引里有
    // 没有今天刚聊的消息」是两件事 —— 微信是持续写入的，而构建完就不再更新，于是索引
    // 会**永久**停在构建那一刻。实测生产索引 built_at=2026-09-13、库内最新消息 09-11，
    // 而消息分片里已经有 09-18 的对话（09-17 一天 139 条）：问「今天聊了啥」时当天数据
    // 根本不在检索空间里，BM25 只能召回正文恰好写着「今天」的旧消息（同年 2/3/7 月），
    // 这就是「回复内容不正确 + 消息列表冒出其他日期」的根源。
    // `ensureSearchIndex` 因此分两种情形：缺失/版本不符 → 全量构建；只是落后 →
    // 按分片水位线增量补录（代价与新增条数同阶，实测毫秒级）。
    try {
      const ensured = await ensureSearchIndex(this._dirs.decrypted)
      if (ensured.action === 'build') {
        this.op('task', 'ask_wechat', 'ok', 'build_index', `检索索引全量构建 · ${ensured.rows ?? 0} 条 · ${ensured.elapsed_ms}ms`)
      } else if (ensured.action === 'sync') {
        this.op('task', 'ask_wechat', 'ok', 'build_index', `检索索引增量同步 · 新增 ${ensured.added ?? 0} 条 · ${ensured.elapsed_ms}ms`)
      } else if (ensured.message) {
        this.op('task', 'ask_wechat', 'fail', 'build_index', ensured.message)
      }
    } catch (e) {
      // 索引不可用不阻断提问：退回 LIKE 召回（准确率低但可用）
      this.op('task', 'ask_wechat', 'fail', 'build_index', (e as Error).message)
    }
    // ── 第 2 步：多阶段检索 ──
    // 顺序：意图路由 → 查询改写 → 混合召回（稀疏 BM25 + 稠密向量 + 结构化）→
    //       RRF 融合去重 → 交叉特征重排 → 上下文压缩。
    // config.enabled=false 时退回旧的单通道检索（灰度/回滚开关）。
    const retrConfig = loadRetrievalConfig(this._dirs.decrypted)
    const scopeDescText = [
      scope.username ? '会话限定' : '',
      scope.from ? `起 ${scope.from}` : '',
      scope.to ? `止 ${scope.to}` : '',
    ].filter(Boolean).join(' ') || '全库'
    // 这五个都在这段下方的两条路径里被赋值（legacyRetrieve 闭包 / 流水线分支），
    // 而 TS 的确定性赋值分析看不穿闭包调用，会报 50 条 TS2454。这里给**真实默认值**
    // 而不是用 `!` 断言：万一哪条路径漏了赋值，宁可退化成「没有原文 → 不调模型」
    // （硬约束一），也不要带着未定义值继续往下跑。
    let citations: ReturnType<typeof retrieveAskCitations>['citations'] = []
    let chunks: ReturnType<typeof retrieveAskCitations>['chunks'] = []
    let terms: string[] = []
    let statsCompat: {
      candidates: number; kept: number; scope: string; recency: boolean
      timeHint: string; hintHits: number; chunks: number; windowMessages: number
      intent?: string; denseActive?: boolean; elapsedMs?: number
      channels?: Array<{ channel: string; count: number; active: boolean; note?: string }>
      funnel?: { recalled: number; fused: number; ranked: number }
    } = {
      candidates: 0, kept: 0, scope: scopeDescText, recency: false,
      timeHint: '', hintHits: 0, chunks: 0, windowMessages: 0,
    }
    let rankedFeatures: Array<{ docKey: string; features: RerankWeights }> = []
    let retrievalId = ''

    /** 旧单通道检索：灰度对照 / 回滚 / 流水线异常时的降级路径。 */
    const legacyRetrieve = (): void => {
      const legacy = retrieveAskCitations(
        this._dirs.decrypted,
        options.question,
        { subQueries: plan.subQueries, from: plan.from, to: plan.to, person: plan.person },
        scope,
        24,
      )
      citations = legacy.citations
      chunks = legacy.chunks
      terms = legacy.terms
      statsCompat = { ...legacy.stats }
      rankedFeatures = []
      retrievalId = ''
    }

    // 依据行里那句「精排用了什么」：管道跑完才有值，而 `basisLine` 在 if 之外拼装，
    // 所以在外层占位。走不到管道（检索被关闭）时它保持空串，那句话也就不出现 ——
    // 比硬写一句「没精排」诚实：那次确实没有排序这回事，是**没检索**。
    let rerankLine = ''
    if (retrConfig.enabled) {
      try {
      // 稠密通道是**新增的出网点**：embedding 调用统一过隐私闸门（见 makeEmbedFn），
      // 未配置 / 被「出站拦截」时抛错，流水线自动降级为纯稀疏，不影响问答可用性。
      // 模型名只解析**一次**并复用：`makeEmbedFn` 发出去的是它，向量库记的也是它。
      // （此前两边各算一遍，这边算出 `'default'`、那边发的是 llm.json 的值 —— 见 §7 F1。）
      const embedModel = this.embedModelName(retrConfig.embedding.model)
      const embedFn = this.makeEmbedFn(embedModel)
      // 向量索引：首次（或增量）在提问时补齐；失败只记录，不阻断（退化为纯稀疏）。
      if (embedFn && retrConfig.embedding.enabled) {
        const vst = vectorIndexStatus(this._dirs.decrypted)
        if (!vst.ready) {
          try {
            const built = await buildVectorIndex(this._dirs.decrypted, embedFn, {
              model: embedModel,
              batchSize: retrConfig.embedding.batchSize,
              concurrency: retrConfig.embedding.concurrency,
              maxCharsPerDoc: retrConfig.embedding.maxCharsPerDoc,
              maxDocsPerBuild: retrConfig.embedding.maxDocsPerBuild,
            })
            this.op('task', 'ask_wechat', 'ok', 'build_vectors', `向量索引 ${built.status} · ${built.rows} 条（本次 ${built.embedded}）· ${built.elapsed_ms}ms`)
          } catch (e) {
            this.op('task', 'ask_wechat', 'fail', 'build_vectors', (e as Error).message)
          }
        }
      }
      const adapted = loadAdaptedWeights(this._dirs.decrypted)
      // 已知实体名：让「点名识别」走本地确定性名单，而不是只靠规划器这一跳。
      const known = this.askKnownEntities()
      // 知识库作用域：只有传了合法 id 才开 kb 通道。非法值（0 / 负数 / NaN）当「没传」
      // 处理并留一条操作日志 —— 静默变成「搜了整个库」才是危险的，变成「没搜文件」不是。
      const kbId = Number.isFinite(options.kbId) && (options.kbId ?? 0) > 0 ? Math.trunc(options.kbId as number) : undefined
      if (options.kbId !== undefined && kbId === undefined) {
        this.op('task', 'ask_wechat', 'fail', 'kb_scope', `忽略非法的知识库标识：${String(options.kbId)}`)
      }
      // 知识库向量索引：与消息侧同款「提问时按需补齐」，但**按库**建。
      // 为什么要按库而不是一次建全库：出网范围必须与用户此刻的意图一致 —— 用户在这个库里
      // 提问，就只把这个库的正文送去 embedding；一次建全库会把**别的库**的正文也发出去，
      // 而「文件级 RAG 开关」只表达得了文件意愿、表达不了库意愿（见 kb-vectors.ts 头注）。
      // 失败只记录、不阻断：稠密不可用时通道如实降级为纯关键词，问答照常可用。
      // 库级覆盖**只作用于知识库这一路**：消息域的向量不属于任何库，跟着全局走。
      const kbEmbedModel = kbId === undefined ? embedModel : this.kbModel(kbId, 'embed').model
      // 精排只构造一次：`makeRerankFn` 里含一次 SQLite 读（库级覆盖），调两遍就是白读一次，
      // 而且两次结果理论上可以不一致（中间正好有人改了设置）。
      const rerankModelName = this.kbModel(kbId ?? 0, 'rerank').model
      const rerankFn = this.makeRerankFn(kbId ?? 0)
      if (kbId !== undefined && retrConfig.embedding.enabled) {
        const kbSt = kbVectorIndexStatus(this._dirs.decrypted, kbId, kbEmbedModel)
        if (!kbSt.ready) {
          try {
            const kbEmbed = this.makeEmbedFn(kbEmbedModel, 'kb_embed')
            if (kbEmbed) {
              const built = await buildKbVectorIndex(this._dirs.decrypted, kbId, kbEmbed, {
                model: kbEmbedModel,
                batchSize: retrConfig.embedding.batchSize,
                concurrency: retrConfig.embedding.concurrency,
                maxCharsPerDoc: retrConfig.embedding.maxCharsPerDoc,
                maxDocsPerBuild: retrConfig.embedding.maxDocsPerBuild,
              })
              this.op('task', 'ask_wechat', 'ok', 'build_kb_vectors',
                `知识库向量 ${built.status} · ${built.rows} 条（本次 ${built.embedded}）· ${built.elapsed_ms}ms`)
            }
          } catch (e) {
            this.op('task', 'ask_wechat', 'fail', 'build_kb_vectors', (e as Error).message)
          }
        }
      }
      const out = await runRetrievalPipeline({
        decryptedDir: this._dirs.decrypted,
        question: options.question,
        subQueries: plan.subQueries,
        entity: plan.person,
        from: plan.from,
        to: plan.to,
        scope,
        limit: 24,
        config: retrConfig,
        ...(embedFn ? { embedFn } : {}),
        // 与 embedFn 同一个解析出来的模型名：稠密召回靠它判「库里那批向量是不是本次模型算的」。
        // 传 kbEmbedModel 而不是 embedModel —— 知识库这一路可能被库级覆盖改过名字。
        embedModel: kbEmbedModel,
        // 精排：没配 rerank 模型时这里就是 undefined，管道整段跳过并按本地加权排序。
        ...(rerankFn ? { rerank: rerankFn } : {}),
        rerankModel: rerankModelName,
        // 名单里已有的就不重复；规划器额外点出的名字也一并带上（可能不在通讯录里）。
        knownEntities: plan.person && !known.includes(plan.person) ? [...known, plan.person] : known,
        ...(adapted ? { weightsOverride: adapted } : {}),
        ...(kbId !== undefined ? { kbId } : {}),
      })
      rerankLine = out.rerankInfo.used
        ? ` · 精排：${out.rerankInfo.model || '未知模型'}（候选 ${out.rerankInfo.candidates} → 取 ${out.rerankInfo.kept}）`
        : ` · 精排：${out.rerankInfo.note}`
      citations = out.citations
      chunks = out.chunks
      terms = out.terms
      rankedFeatures = out.rankedFeatures
      retrievalId = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
      statsCompat = {
        candidates: out.stats.recalled,
        kept: out.stats.kept,
        scope: scopeDescText,
        recency: out.stats.recency,
        timeHint: out.stats.timeHint,
        hintHits: out.stats.hintHits,
        chunks: out.stats.compressed,
        windowMessages: out.stats.windowMessages,
        intent: out.stats.intent,
        denseActive: out.stats.denseActive,
        elapsedMs: out.stats.elapsedMs,
        channels: out.stats.channels.map(c => ({ channel: c.channel, count: c.count, active: c.active, ...(c.note ? { note: c.note } : {}) })),
        funnel: { recalled: out.stats.recalled, fused: out.stats.fused, ranked: out.stats.ranked },
      }
      this.op('task', 'ask_wechat', 'ok', 'route',
        `意图 ${out.stats.intent} · 通道[${out.stats.channels.map(c => `${c.channel}:${c.count}${c.active ? '' : '(off)'}`).join(' ')}] · 召回 ${out.stats.recalled} → 融合 ${out.stats.fused} → 重排 ${out.stats.ranked} → 窗口 ${out.stats.compressed} · ${out.stats.elapsedMs}ms`)
      } catch (e) {
        // 流水线自身异常（非通道降级）→ 回退旧检索，绝不让问答整体不可用。
        this.op('task', 'ask_wechat', 'fail', 'retrieval_pipeline', (e as Error).message)
        legacyRetrieve()
      }
    } else {
      legacyRetrieve()
    }

    // ── 硬约束一：没有任何原文就**不调模型** ──
    // 提示词里写「没找到就说明没找到」只是软约束；模型完全有可能凭常识编一段。
    // 这里直接短路：没有可引用的原文，就没有可核实的回答。
    // 精排这一句必须出现在依据行里：`used:true` 与 `used:false` 是两种不同的可信度 ——
    // 前者说明「有个模型读过这批候选并给了顺序」，后者说明「顺序是本地启发式给的」。
    // 不写出来，用户就会把「没配模型」读成「模型认为这些最相关」。
    const basisLine = askBasisLine(citations) + rerankLine
    if (citations.length === 0) {
      this.op('task', 'ask_wechat', 'skip', '', '未检索到任何原文，未调用模型')
      // 「没检索到」也是一次问答（用户确实问了、也确实拿到了回答），必须进历史 ——
      // 否则回看历史时这一段是空的，用户会以为当时根本没问过。
      const emptyResult: AskResult = {
        answer: '本机记录里没有检索到与这个问题相关的原文，因此不作回答（不会基于常识推测）。可以试试：换关键词、收窄时间范围，或指定某个会话再问。',
        citations: [],
        plan: { intent: plan.intent, subQueries: plan.subQueries, from: plan.from, to: plan.to, person: plan.person, terms },
        citedIndexes: [],
        basis: '',
        insufficient: true,
        retrieval: {
          candidates: statsCompat.candidates, kept: statsCompat.kept, scope: statsCompat.scope,
          recency: statsCompat.recency, chunks: statsCompat.chunks, windowMessages: statsCompat.windowMessages,
        },
      }
      this.saveAskHistory(options, emptyResult, Date.now() - askStartedAt, modelLabel)
      return emptyResult
    }

    const contextBlock = formatAskContext(citations, {
      intent: plan.intent,
      terms,
      scope: statsCompat.scope,
      recency: statsCompat.recency,
      timeHint: statsCompat.timeHint,
      hintHits: statsCompat.hintHits,
    }, chunks)

    // ── 第 3 步：综合对话历史与检索结果生成回答 ──
    const historyBlock = trimmedHistory.length > 0
      ? '此前的对话（保持多轮连贯，但答案必须以本次检索结果为准）：\n' + trimmedHistory.map(m => (m.role === 'user' ? '用户：' : '助手：') + m.content).join('\n') + '\n\n'
      : ''
    // 提示词的取舍：
    //  · 「只用材料里的事实 / 找不到就直说」是**内容**底线（配合后端的两道硬约束：无原文不调模型、
    //    无引用不予采用）；
    //  · 「像微信聊天那样自然说话」是**语气**要求 —— 早先写的是「简洁分点」，模型会写成报告腔
    //    （「综上所述」「根据数据分析」），而这是个聊天记录问答工具，用户想听的是「谁说了什么」。
    // 时间线索护栏（本轮修）：检索侧给出时间线索却 0 命中时，材料里剩下的**全是别的
    // 日期**的记录。旧实现只在上下文头写了一句「不要声称限定在该日期」，模型于是如实
    // 回答「今天没找到，放宽都是别的日子」—— 但这几条别日期的片段仍被当作「唯一事实
    // 依据」并列了出来，用户看到的就是「回复不正确 + 冒出其他日期的消息」。
    // 这里把它写成不可绕过的行为规则，并要求逐条标出真实日期。
    const timeGuardRule = statsCompat.timeHint
      ? (statsCompat.hintHits > 0
        ? `\n7. **时间范围**：材料都落在 ${statsCompat.timeHint} 内，可以按该范围陈述。`
        : `\n7. **时间范围（重要）**：检索在 ${statsCompat.timeHint} 内**一条都没找到**，下面列出的片段全部来自**其他日期**。必须先明确说一句「${statsCompat.timeHint} 这段时间没有找到相关聊天记录」，然后才可以说「另外在 X 月 X 日聊过……」并**逐条写出这些内容的真实日期**。绝对不要把其他日期的内容说成是该时间范围内发生的。`)
      : ''
    const synthPrompt = `${historyBlock}用户本次问题：${options.question}

${contextBlock}

请按以下要求回答：
1. **只用材料里的事实**：上面检索结果里没有的信息一律不要补充，尤其不要凭常识推测人名、金额、日期、时间。宁可少说，也不要编。金额、日期、电话/卡号这类值**只能原样照抄**材料里的写法 —— 要说合计就写明由哪几条相加（如「3500+3500=7000」），不要自行换算单位或推算日期。
2. **像微信里跟人说话那样自然**：口语化中文，直接把事情讲清楚，不要写成报告或分析（不要「综上所述」「根据数据分析」「经梳理」这类腔调），也不要复述检索过程。要罗列多条时可以分点，但每条都要像在转述聊天内容。
3. **每条事实后面标 [n]**：例如「小何说收到转账 13.00 元 [1]」，多个来源写 [1][3]。材料里形如「群名 · 某人」的，要说清是谁说的。
4. **时间写绝对日期**（如 2026-09-05），不要写「上周」「前几天」这类相对表述。
5. **找不到就直说**：材料不足以回答时，直接说明「聊天记录里没有找到……」，再给 1-2 条改问建议（换关键词、收窄时间或指定会话）。不要用推测填空。
6. 只引用真正支持结论的那几条来源，不要罗列全部；也不用写「依据本机记录」这类来源说明，界面上已单独显示。${timeGuardRule}`
    const gateAnswer = this.privacyGate(
      'ask_wechat',
      { sessions: new Set(citations.map(c => c.username)).size, messages: citations.length },
      [synthPrompt],
    )
    if (!gateAnswer.ok) {
      this.op('task', 'ask_wechat', 'skip', '', gateAnswer.error)
      throw new Error(gateAnswer.error)
    }
    const answer = await runChat(
      '你是用户微信聊天记录里的问答助手。只用下面给出的检索结果回答，说话自然、口语化，像在微信里跟人转述聊天内容；每句事实后面用 [n] 标注来源；记录里没有的就说没找到，绝不推测或编造。',
      gateAnswer.texts[0] ?? synthPrompt,
      1600,
      // 必须走 this.：makeDeltaEmitter 是实例方法。裸调用会抛
      // 「ReferenceError: makeDeltaEmitter is not defined」—— 它出现在**综合生成那一刻**，
      // 于是每次提问都在出答案前崩掉（UI 自动化验收实测捕捉到）。
      this.makeDeltaEmitter(options.streamId),
    )
    /** 回答「自己引用的」那些来源的正文：优先窗口全文，退化用引用卡片里的片段。
     *  接地审计必须拿**同一条证据**去核对 —— 用窗口全文而不是列表里的 120 字摘要，
     *  是为了避免「值明明在窗口里、只是没进摘要」被误判成编造。 */
    const evidenceFor = (cited: number[]): string[] => {
      const idx = cited.length > 0 ? cited : citations.map((_, i) => i + 1)
      return idx.map((n) => {
        const ch = chunks[n - 1]
        if (ch) {
          const head = `${ch.name} ${ch.anchor.sender ?? ''} ${ch.anchor.time}`
          return head + '\n' + ch.lines.map(l => `${l.day ?? ''} ${l.time} ${l.sender} ${l.text}`).join('\n')
        }
        const c = citations[n - 1]
        return c ? `${c.name} ${c.sender ?? ''} ${c.time} ${c.snippet}` : ''
      })
    }
    const groundingAuditFor = (text: string, cited: number[]): ReturnType<typeof auditGrounding> =>
      auditGrounding(text, evidenceFor(cited), citations.length)

    // ── 硬约束二：回答必须能对应到原文，否则不采用 ──
    // 三道检查，任一不通过都带着**具体问题**回炉重写一次：
    //   ① 一个 [n] 都没有 → 整段内容无法逐条核实（可能是模型凭常识补的）；
    //   ② 接地审计发现「引用原文里没有的金额/日期/长数字」→ 典型编造；
    //   ③ 带这些高风险值的句子没标 [n]（软问题，只触发重写）。
    // 重写后仍然没有任何引用才**不予采用**。金额类不做硬拦截 —— 合计是模型可以正当
    // 算出来的，拦住它会把「一共转了多少」直接变成无法回答（与前端
    // panels/utils/grounding.ts 的同一取舍：那里只提示、不拦截）。重写通过时用重写稿，
    // 没有变得更差才替换 —— 免得「越改越糟」把已经能核实的内容丢掉。
    let citedIndexes = parseCitedIndexes(answer, citations.length)
    let finalAnswer = answer
    let withheld = false
    let grounding = groundingAuditFor(answer, citedIndexes)
    let repaired = false
    if (citedIndexes.length === 0 || grounding.unsupported.length > 0 || grounding.uncited > 0) {
      const repairHint = groundingRepairHint(grounding)
      const strictPrompt = `${synthPrompt}

【重要】请重写上一次的回答，逐条修掉下面的问题。
${citedIndexes.length === 0 ? ' · 上一次的回答**没有标注任何 [n] 来源**。\n' : ''}${repairHint ? repairHint + '\n' : ''} · 每一句事实性陈述后面都必须紧跟对应的 [n]，且只标真正支持这句话的那几条；
 · 语气保持自然口语化，像在微信里转述聊天内容；
 · 如果检索结果不足以回答，只输出一句话：「本机记录中没有找到可据以回答的证据」。`
      const second = await runChat(
        '你是用户微信聊天记录里的问答助手。只用给定检索结果回答，自然口语化，每句事实标注 [n]；记录里没有就直说没找到，不要推测或编造。',
        strictPrompt,
        1600,
      )
      const secondCited = parseCitedIndexes(second, citations.length)
      const secondAudit = groundingAuditFor(second, secondCited)
      const better = secondCited.length > 0 && (
        secondAudit.unsupported.length < grounding.unsupported.length
        || (secondAudit.unsupported.length === grounding.unsupported.length && secondCited.length > citedIndexes.length)
      )
      if (better) {
        finalAnswer = second
        citedIndexes = secondCited
        grounding = secondAudit
        repaired = true
      }
    }
    if (citedIndexes.length === 0) {
      withheld = true
      finalAnswer = '本机记录中没有找到可据以回答的证据（模型给出的内容无法对应到任何一条原文，已不予采用）。可以换关键词、收窄时间范围或指定会话后重试。'
    }
    const answer_basis = citedIndexes.length > 0
      ? `${basisLine}（回答引用了其中 ${citedIndexes.length} 条：[${citedIndexes.join('][')}]）`
      : basisLine
    // 记录本次检索的特征画像，供用户反馈时做「特征归因 → 权重微调」。
    if (retrievalId && rankedFeatures.length > 0) {
      this._askTrace.set(retrievalId, {
        features: new Map(rankedFeatures.map(r => [r.docKey, r.features])),
        // 归因键**必须**与检索侧 docKey 逐字相同，否则「这条引用有用」对应不到任何
        // 特征向量 —— 而且不报错，只是调参永远不动。知识库引用的键是
        // `kb:<kbId>:<chunkId>`（由 citationDocKey 产出，是这条格式的唯一来源）；
        // 从前这里手写 `username + ':' + local_id`，KB 引用会塌成 `:`，
        // 同一轮里的多个文件引用还会**互相覆盖**，把反馈记到不存在的消息上。
        citations: citations.map(c => citationDocKey(c)),
        question: options.question,
        answer: finalAnswer,
        intent: (statsCompat.intent ?? 'open_qa') as IntentKind,
      })
      // 有界缓存：只保留最近 20 轮，避免长会话把内存撑大。
      while (this._askTrace.size > 20) {
        const oldest = this._askTrace.keys().next()
        if (oldest.done) break
        this._askTrace.delete(oldest.value)
      }
    }
    this.op(
      'task', 'ask_wechat', withheld ? 'fail' : 'ok', '',
      `意图「${statsCompat.intent ?? plan.intent}」· 关键词 ${terms.length} 个 · 召回 ${statsCompat.candidates} 条 → 窗口 ${statsCompat.chunks} 段（${statsCompat.windowMessages} 条消息）· 回答引用 ${citedIndexes.length} 段${withheld ? ' · 未引用任何来源，已不予采用' : ''}${grounding.checked > 0 ? ` · 接地核对 ${grounding.checked} 项（无出处的 ${grounding.unsupported.length} 项）` : ''}${repaired ? ' · 已按核对结果重写' : ''}${statsCompat.timeHint ? ` · 时间线索 ${statsCompat.timeHint}（命中 ${statsCompat.hintHits}）` : ''}`,
    )
    const result: AskResult = {
      answer: finalAnswer || '（模型未返回有效回答。可点「优化提问」改写问题，或收窄会话/时间范围后重试。）',
      citations,
      plan: { intent: plan.intent, subQueries: plan.subQueries, from: plan.from, to: plan.to, person: plan.person, terms },
      citedIndexes,
      basis: answer_basis,
      withheld: withheld || undefined,
      // 接地核对结果：界面上「回答里某某在原文里没有出现」的提示与操作日志共用它，
      // 也让「这轮到底核对了什么」可被追问。
      grounding: {
        checked: grounding.checked,
        unsupported: grounding.unsupported.map(v => v.value),
        cited: citedIndexes.length,
        repaired,
      },
      retrievalId: retrievalId || undefined,
      retrieval: {
        candidates: statsCompat.candidates, kept: statsCompat.kept, scope: statsCompat.scope,
        recency: statsCompat.recency, timeHint: statsCompat.timeHint, hintHits: statsCompat.hintHits,
        chunks: statsCompat.chunks, windowMessages: statsCompat.windowMessages,
        ...(statsCompat.intent ? { intent: statsCompat.intent } : {}),
        ...(statsCompat.denseActive !== undefined ? { denseActive: statsCompat.denseActive } : {}),
        ...(statsCompat.channels ? { channels: statsCompat.channels } : {}),
        ...(statsCompat.elapsedMs !== undefined ? { elapsedMs: statsCompat.elapsedMs } : {}),
        ...(statsCompat.funnel ? { funnel: statsCompat.funnel } : {}),
      },
    }
    // 自动落进「问答历史」。这是两个写入点里的第二个（另一个在上面「没检索到原文」
    // 的短路返回处）—— 只要走到 return，就有一次可回看的问答。
    // best-effort：存历史失败绝不能把已经生成好的回答变成一次报错。
    this.saveAskHistory(options, result, Date.now() - askStartedAt, modelLabel)
    return result
  }

  /**
   * 把一次问答落进「历史记录」。
   *
   * 为什么放在网关而不是前端：前端只持有**当前线程**的 turns（清空对话即丢），
   * 而且窗口一关就没了。历史要求「每一次都留下」，只能由**后端在回答产出的那一刻**写。
   *
   * 只记成功产出的回答（含「没检索到原文」这种正常短路）；调用**报错**的轮次不写本表 ——
   * 它们没有可回看的正文，且已经在操作日志里留痕（`op('task','ask_wechat','fail',…)`），
   * 往历史里塞一行空回答只会让「历史记录」变成错误列表。
   * @param options - 本次提问的入参（取范围与会话名）。
   * @param result - 已经产出的回答。
   * @param elapsedMs - 端到端耗时。
   * @param model - 回答模型标签（provider · model）。
   */
  private saveAskHistory(
    options: { question: string; username?: string; from?: string; to?: string; source?: string; usernameName?: string },
    result: AskResult,
    elapsedMs: number,
    model: string,
  ): void {
    try {
      const source = typeof options.source === 'string' && options.source.trim() ? options.source.trim() : 'ask'
      const citations = Array.isArray(result.citations) ? result.citations : []
      recordAsk(this._dirs.decrypted, {
        question: typeof options.question === 'string' ? options.question : '',
        answer: typeof result.answer === 'string' ? result.answer : '',
        source,
        ...(options.username ? { username: options.username } : {}),
        ...(options.usernameName ? { usernameName: options.usernameName } : {}),
        ...(options.from ? { from: options.from } : {}),
        ...(options.to ? { to: options.to } : {}),
        ...(model ? { model } : {}),
        intent: result.plan?.intent ?? '',
        terms: result.plan?.terms ?? [],
        citations,
        citedIndexes: result.citedIndexes ?? [],
        basis: result.basis ?? '',
        insufficient: result.insufficient === true,
        withheld: result.withheld === true,
        ...(result.retrieval ? { retrieval: result.retrieval } : {}),
        elapsedMs,
      })
    } catch (e) {
      // recordAsk 自身已经吞掉异常；这里再兜一层，保证历史写入永远不影响问答主链路。
      this.op('task', 'ask_history', 'fail', '', (e as Error).message)
    }
  }

  /**
   * 提问优化：把用户问题改写为更利于本机检索的形式，并给出改进建议。
   * 供「微信问答」面板的「优化提问」按钮调用；出站前同样过隐私闸门。
   * @param options - question（必填）+ 可选 scope/history 作上下文。
   * @returns AskOptimizeResult: optimized + suggestions。
   */
  @Remote('optimizeAskQuestion')
  async optimizeAskQuestion(options: {
    question: string
    username?: string
    from?: string
    to?: string
    history?: Array<{ role: 'user' | 'assistant'; content: string }>
  }): Promise<AskOptimizeResult> {
    const ctx = this._ctx
    const blocked = this.privacyBlocked('ask_optimize')
    if (blocked !== null) {
      this.op('task', 'ask_optimize', 'skip', '', blocked)
      throw new Error(blocked)
    }
    const question = String(options?.question || '').trim()
    if (!question) throw new Error('请先输入问题，再进行优化')
    const defaultModel = (ctx as unknown as {
      agentDefaultModel?: { currentSelection(): { provider: string; model: string; reasoningEffort?: string } }
    }).agentDefaultModel
    const sel = defaultModel?.currentSelection()
    if (!sel || !sel.provider || !sel.model) {
      this.op('task', 'ask_optimize', 'fail', '', '未配置默认模型（agentDefaultModel）')
      throw new Error('未配置默认模型（agentDefaultModel），无法优化提问')
    }
    const scopeDesc = `会话=${options.username || '全部'}${options.from ? `，起始=${options.from}` : ''}${options.to ? `，截止=${options.to}` : ''}`
    const history = (Array.isArray(options.history) ? options.history : [])
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-6)
    const historyBrief = history.length > 0
      ? '\n最近对话背景：\n' + history.map(m => (m.role === 'user' ? '用户：' : '助手：') + m.content.slice(0, 200)).join('\n')
      : ''
    const prompt = `用户原始问题：${question}\n当前检索范围：${scopeDesc}${historyBrief}\n\n请输出 JSON（不要输出其他内容）。`
    const gate = this.privacyGate('ask_optimize', { sessions: 0, messages: 0 }, [prompt])
    if (!gate.ok) {
      this.op('task', 'ask_optimize', 'skip', '', gate.error)
      throw new Error(gate.error)
    }
    const assembler = new BlockAssembler()
    const opts: GenerateOptions = {
      provider: sel.provider,
      model: sel.model,
      messages: [createUserMessage({
        content: [{ type: 'text', text: gate.texts[0] ?? prompt }],
        source: { kind: 'plugin', plugin: 'dsh-wechat-data' },
      })],
      system: '你是微信聊天记录的提问优化器。把用户问题改写得更清晰、更利于全文检索（保留原意，补充隐含的时间/对象等限定，去掉口语口水词），并给出至多 3 条具体的改进建议。只输出一行 JSON：{"optimized":"优化后的问题","suggestions":["建议1","建议2"]}',
      maxTokens: 512,
    }
    for await (const chunk of ctx.llm.stream(opts)) assembler.push(chunk)
    const text = assembler.blocks().map(b => (b.type === 'text' ? b.text : '')).join('').trim()
    const parsed = parseAskOptimize(text)
    const optimized = parsed.optimized || text.slice(0, 300)
    this.op('task', 'ask_optimize', 'ok', '', optimized.slice(0, 80))
    return { optimized, suggestions: parsed.suggestions }
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
   * RAG 检索层状态：配置 + 向量库 + 反馈统计 + 当前调参权重 + 意图分类自评。
   * @returns 供「数据健康」面板与诊断脚本展示（原「检索设置」面板已于 2026-09-17 下线）。
   */
  @Remote('getRetrievalStatus')
  getRetrievalStatus(): {
    enabled: boolean
    config: unknown
    vector: { rows: number; dim: number; model: string }
    feedback: { total: number; up: number; down: number }
    weights: RerankWeights
    intentAccuracy: { correct: number; total: number; accuracy: number }
  } {
    return this.askRemotes().getRetrievalStatus()
  }

  /**
   * 保存检索参数（阈值/权重/容量）。
   * **界面已不再暴露该入口**（面板下线，参数固化为产品默认值）——仅供诊断与自动化测试参考使用。
   * @param options - 形如 `{ patch: {...} }`，或直接给字段子集。
   * @returns 落盘后的完整配置。
   */
  @Remote('saveRetrievalConfig')
  saveRetrievalConfig(options?: { patch?: unknown } | unknown): { ok: boolean; config: unknown } {
    return this.askRemotes().saveRetrievalConfig(options)
  }

  /**
   * 立即构建/增量更新稠密向量索引。
   * 界面已不暴露该入口：首次提问时网关会自动增量构建（失败则降级纯稀疏），
   * 本方法留给诊断与自动化测试使用。
   * @param options - force=true 时清空重建。
   * @returns 构建结果。
   */
  @Remote('buildRagVectorIndex')
  async buildRagVectorIndex(options?: { force?: boolean }): Promise<{ ok: boolean; status: string; rows: number; embedded: number; elapsed_ms: number; message?: string }> {
    const cfg = loadRetrievalConfig(this._dirs.decrypted)
    const embedModel = this.embedModelName()
    const embedFn = this.makeEmbedFn(embedModel)
    if (!embedFn) return { ok: false, status: 'no-embedder', rows: 0, embedded: 0, elapsed_ms: 0, message: '未配置 embedding（请在模型配置里填写向量模型或 API Key）' }
    // 向量库是按「搜索索引里的文档」建的，所以先保证索引最新（缺失→构建，落后→增量）。
    try { await ensureSearchIndex(this._dirs.decrypted) } catch { /* 交给下面状态判定 */ }
    try {
      const r = await buildVectorIndex(this._dirs.decrypted, embedFn, {
        model: embedModel,
        batchSize: cfg.embedding.batchSize,
        concurrency: cfg.embedding.concurrency,
        maxCharsPerDoc: cfg.embedding.maxCharsPerDoc,
        maxDocsPerBuild: cfg.embedding.maxDocsPerBuild,
        force: Boolean(options?.force),
      })
      this.op('task', 'build_vectors', 'ok', '', `${r.status} rows=${r.rows} embedded=${r.embedded} ${r.elapsed_ms}ms`)
      return { ok: true, ...r }
    } catch (e) {
      this.op('task', 'build_vectors', 'fail', '', (e as Error).message)
      return { ok: false, status: 'error', rows: 0, embedded: 0, elapsed_ms: 0, message: (e as Error).message }
    }
  }

  /**
   * 提交问答反馈（目标 5 的闭环入口）。
   *
   * 反馈 → 特征归因 → 权重微调 → 落盘。权重**由全部历史反馈重算**（幂等、可重放），
   * 而不是在旧权重上累加 —— 累加会因为重复提交同一条反馈而漂移。
   *
   * N27：同一轮反馈在 10 秒窗口内的重复提交会被挡掉并返回可读的「已在处理」，
   * 不再产生第二条反馈记录 / 第二次权重适配（前端闸门只管同一个面板的连点，
   * 两个面板同时提交、旧版客户端重试、直接 RPC 调用都落到这里）。
   * @param options - retrievalId（AskResult 里回传）+ rating + 有用/无用引用序号。
   * @returns 调参后的权重；重复提交时 `ok:false` + `message`。
   */
  @Remote('submitAskFeedback')
  submitAskFeedback(options: {
    retrievalId?: string
    rating: 'up' | 'down'
    useful?: number[]
    useless?: number[]
    question?: string
    answer?: string
  }): { ok: boolean; adaptedWeights?: RerankWeights; features?: string[]; message?: string } {
    return this.askRemotes().submitAskFeedback(options)
  }

  /**
   * 列出最近的问答反馈 + 汇总统计。
   * @param options - limit。
   */
  @Remote('listRetrievalFeedback')
  listRetrievalFeedback(options?: { limit?: number }): {
    items: FeedbackRecord[]
    stats: { total: number; up: number; down: number }
  } {
    return this.askRemotes().listRetrievalFeedback(options)
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
   * 跑离线召回评估（合成评测集），并给出「混合 vs 纯稀疏」的消融对比。
   *
   * 不依赖真实数据，因此可以随时直连调一次就看到当前算法的 P/R/MRR/NDCG
   * （界面无入口），也可以在 CI 里断言「混合不低于纯稀疏」防止退化。
   * @param options - k（截断位置，默认 10）。
   * @returns 可读报告 + 结构化指标。
   */
  @Remote('evaluateRetrieval')
  evaluateRetrieval(options?: { k?: number }): {
    report: string
    hybrid: { precision: number; recall: number; mrr: number; ndcg: number; map: number; cases: number; hits: number }
    sparseOnly: { precision: number; recall: number; mrr: number; ndcg: number; map: number; cases: number; hits: number }
    intentAccuracy: { correct: number; total: number; accuracy: number }
  } {
    return this.graphSearchRemotes().evaluateRetrieval(options)
  }

  /**
   * Generate a daily chat summary for one date via DSH LLM.
   * @param options - date (YYYY-MM-DD) to summarize.
   * @returns DailySummaryResult: summary text with session/message counts.
   */
  @Remote('generateDailySummary')
  async generateDailySummary(options: { date: string; provider?: string; model?: string }): Promise<DailySummaryResult> {
    const { lines, count, sessions, total, types, hourly, topSessions } = collectDayMessages(this._dirs.decrypted, options.date)
    // 出站拦截要在这里判：再往下就是「未配置默认模型」的早退分支，它会盖掉拦截提示
    const blockedDay = this.privacyBlocked('daily_summary')
    if (blockedDay !== null) {
      this.op('task', 'generate_daily_summary', 'skip', options.date, blockedDay)
      return {
        summary: '⛔ ' + blockedDay + '\n\n当日统计：共 ' + String(total) + ' 条消息 / ' + String(sessions) + ' 个活跃会话。' + (compactDailyDigest(lines) || '\n（当天无文本消息）'),
        date: options.date, sessions, messages: count, total, types, hourly, topSessions,
      }
    }
    const ctx = this._ctx
    const defaultModel = (ctx as unknown as {
      agentDefaultModel?: { currentSelection(): { provider: string; model: string; reasoningEffort?: string } }
    }).agentDefaultModel
    const sel = defaultModel?.currentSelection()
    const useProvider = (options.provider && options.provider.trim()) ? options.provider.trim() : (sel?.provider ?? '')
    let useModel = (options.model && options.model.trim()) ? options.model.trim() : (sel?.model ?? '')
    const llm = ctx.llm
    // Plain-text summarization: avoid a default vision/experimental model that returns empty text. Respect an explicit selection.
    if (!options.model && useModel && /vision|-exp/i.test(useModel)) {
      try {
        const ms = await llm.listModels(useProvider)
        const chatModelRe = /chat|flash|pro|v4/i
        const pick = ms.find(m => chatModelRe.test(m.id) && !/vision|image|exp/i.test(m.id))
          ?? ms.find(m => !/vision|image|exp/i.test(m.id))
          ?? ms[0]
        if (pick && pick.id) useModel = pick.id
      } catch { /* keep */ }
    }
    if (!useProvider || !useModel) {
      const fallback = 'AI 不可用（未配置默认模型或 LLM 服务）。\n\n当日统计：共 ' + String(total) + ' 条消息 / ' + String(sessions) + ' 个活跃会话。' + (compactDailyDigest(lines) || '\n（当天无文本消息）')
      this.op('task', 'generate_daily_summary', 'fail', options.date, '未配置默认模型或 LLM 服务')
      return { summary: fallback, date: options.date, sessions, messages: count, total, types, hourly, topSessions }
    }
    const prompt = '请总结 ' + options.date + ' 当天的微信聊天内容，输出简洁的中文要点：\n\n' + lines.join('\n')
    const gate = this.privacyGate('daily_summary', { sessions, messages: count }, [prompt])
    if (!gate.ok) {
      this.op('task', 'generate_daily_summary', 'skip', options.date, gate.error)
      return {
        summary: '⛔ ' + gate.error + '\n\n当日统计：共 ' + String(total) + ' 条消息 / ' + String(sessions) + ' 个活跃会话。' + (compactDailyDigest(lines) || '\n（当天无文本消息）'),
        date: options.date, sessions, messages: count, total, types, hourly, topSessions,
      }
    }
    const userMsg = createUserMessage({
      content: [{ type: 'text', text: gate.texts[0] ?? prompt }],
      source: { kind: 'plugin', plugin: 'dsh-wechat-data' },
    })
    const assembler = new BlockAssembler()
    const opts: GenerateOptions = {
      provider: useProvider,
      model: useModel,
      messages: [userMsg],
      system: '你是微信每日总结助手，用中文输出简洁的当日聊天要点总结。',
      maxTokens: 1024,
    }
    let summary = ''
    try {
      for await (const chunk of llm.stream(opts)) assembler.push(chunk)
      summary = assembler.blocks().map(b => (b.type === 'text' ? b.text : '')).join('').trim()
    } catch (e) {
      summary = 'LLM 调用失败: ' + (e as Error).message
    }
    const finalSummary = summary ||
      (lines.length > 0
        ? '模型未返回内容（请为默认模型配置 DEEPSEEK_API_KEY 或其它 LLM 密钥）。\n\n当日统计：共 ' + String(total) + ' 条消息 / ' + String(sessions) + ' 个活跃会话。' + (compactDailyDigest(lines) || '\n（当天无文本消息）')
        : '（当天没有可用的文本消息）')
    const ok = !finalSummary.startsWith('LLM 调用失败')
    this.op('task', 'generate_daily_summary', ok ? 'ok' : 'fail', options.date, ok ? `共 ${count} 条消息` : finalSummary.slice(0, 120))
    return { summary: finalSummary, date: options.date, sessions, messages: count, total, types, hourly, topSessions }
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
   * Restore a message to its original content.
   * @param options - username and localId of the edited message.
   * @returns EditMutationResult: ok, or error on failure.
   */
  @Remote('resetEditedMessage')
  resetEditedMessage(options: { username: string; localId: number }): EditMutationResult {
    return this.graphSearchRemotes().resetEditedMessage(options)
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
    const ctx = this._ctx as unknown as {
      settings?: { get(ns: string): unknown }
      llm?: { listConfigurableProviders(): Array<{ provider: string; displayName: string }> }
    }
    let provider = ''
    try {
      const am = (ctx.settings?.get('agent-default-model') ?? {}) as { provider?: string }
      provider = am.provider ?? ''
    } catch { /* ignore */ }
    if (!provider) {
      try {
        const adm = (this._ctx as unknown as {
          agentDefaultModel?: { currentSelection?: () => { provider: string } | undefined }
        }).agentDefaultModel
        const sel = adm && adm.currentSelection ? adm.currentSelection() : undefined
        provider = sel?.provider ?? ''
      } catch { /* ignore */ }
    }
    if (!provider) return { providers: [] }
    const name = (() => {
      try {
        const found = ctx.llm?.listConfigurableProviders().find(p => p.provider === provider)
        return found?.displayName ?? provider
      } catch {
        return provider
      }
    })()
    return { providers: [{ id: provider, name }] }
  }

  /** List the provider's configured models (from the "设置 → 模型" settings section), falling back to the provider catalog. */
  @Remote('listLlmModels')
  async listLlmModels(options: { provider: string }): Promise<{ models: Array<{ id: string; name: string }> }> {
    const ctx = this._ctx as unknown as {
      llm?: {
        listConfigurableProviders(): Array<{ provider: string; settingsNs: string; settingsPath: string[] }>
        listModels(provider: string): Promise<Array<{ id: string; name: string }>>
      }
      settings?: { get(ns: string): unknown }
    }
    // 1) read the configured models from the provider's settings section.
    let ns = ''
    let settingsPath: string[] = []
    try {
      const conf = (ctx.llm?.listConfigurableProviders() ?? []).find(p => p.provider === options.provider)
      if (conf) { ns = conf.settingsNs; settingsPath = conf.settingsPath }
    } catch { /* ignore */ }
    if (ns) {
      try {
        const doc = (ctx.settings?.get(ns) ?? {}) as Record<string, unknown>
        let profile: Record<string, unknown> = doc
        if (settingsPath.length > 0) {
          profile = settingsPath.reduce<Record<string, unknown>>((acc, k) => {
            const v = acc[k] as Record<string, unknown> | undefined
            return v ?? {}
          }, doc)
        }
        const ms = (profile.models ?? []) as Array<{ id?: string; name?: string } | string>
        if (Array.isArray(ms) && ms.length > 0) {
          return { models: ms.map(m => ({ id: typeof m === 'string' ? m : (m.id ?? ''), name: typeof m === 'string' ? m : (m.name ?? m.id ?? '') })).filter(m => m.id) }
        }
      } catch { /* ignore */ }
    }
    // 2) fallback: provider catalog.
    try {
      const ms = (await ctx.llm?.listModels(options.provider)) ?? []
      return { models: ms.map(m => ({ id: m.id, name: m.name })).filter(m => m.id) }
    } catch {
      return { models: [] }
    }
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
   * 读取问答历史（供「微信问答 → 历史记录」弹窗）。
   *
   * 与 `getExportHistory` 同样**不走**宿主的结果缓存：历史是「按当前事实」的数据，
   * 刚问完就打开列表必须能看到那一条，缓存住的旧结果会表现成「问答没被保存」。
   * @param options - 搜索 / 来源筛选 / 状态筛选 / 时间范围 / 排序 / 分页。
   * @returns 一页条目 + 命中总数 + 各聚合计数。
   */
  @Remote('getAskHistory')
  getAskHistory(options?: AskHistoryQuery): AskHistorySnapshot {
    return this.askRemotes().getAskHistory(options)
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
   * List daily-summary tasks.
   * @returns SummaryTaskSnapshot: summary tasks (items + total).
   */
  @Remote('listSummaryTasks')
  listSummaryTasks(): SummaryTaskSnapshot {
    return this.summaryRemotes().listSummaryTasks()
  }

  /**
   * Save (insert/update) a daily-summary task.
   * @param options - task payload (id present = update, absent = insert).
   * @returns SummaryTaskMutationResult: ok + id, or error.
   */
  @Remote('saveSummaryTask')
  saveSummaryTask(options: { task: Omit<SummaryTask, 'id' | 'createdAt' | 'updatedAt'> & { id?: number } }): SummaryTaskMutationResult {
    return this.summaryRemotes().saveSummaryTask(options)
  }

  /**
   * Delete a daily-summary task.
   * @param options - id of the task to delete.
   * @returns SummaryTaskMutationResult: ok, or error on failure.
   */
  @Remote('deleteSummaryTask')
  deleteSummaryTask(options: { id: number }): SummaryTaskMutationResult {
    return this.summaryRemotes().deleteSummaryTask(options)
  }

  /**
   * Toggle a daily-summary task enabled state.
   * @param options - task id and the new enabled flag.
   * @returns SummaryTaskMutationResult: ok, or error on failure.
   */
  @Remote('toggleSummaryTask')
  toggleSummaryTask(options: { id: number; enabled: boolean }): SummaryTaskMutationResult {
    return this.summaryRemotes().toggleSummaryTask(options)
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
   * Delete one generated summary record.
   * @param options - id of the record to delete.
   * @returns SummaryTaskMutationResult: ok, or error on failure.
   */
  @Remote('deleteSummaryRecord')
  deleteSummaryRecord(options: { id: number }): SummaryTaskMutationResult {
    const r = delRec(this._dirs.decrypted, options.id)
    this.op('delete', 'delete_summary_record', r.ok ? 'ok' : 'fail', `id=${options.id}`, r.error ?? '')
    return r
  }

  /**
   * Run a summary task: collect the group previous-day messages + LLM summary + record.
   * @param options - id of the task to run.
   * @returns SummaryTaskRunResult: ok + summary + message count, or error.
   */
  /**
   * 同一分钟到期的摘要任务并发上限（N15）。
   *
   * 为什么是 2：受「同一分钟到期」约束，这一批通常只有 1~2 项，上限本身只是「别一次把一堆
   * LLM 请求打出去」的保险。不做成配置项：加一个没人会改的旋钮只是多一处待验证的输入面
   * （`embedding.concurrency` 那套夹取是因为它来自可手改的 `rag-config.json`）。
   */
  private static readonly DUE_SUMMARY_CONCURRENCY = 2

  /** Run any enabled daily-summary task whose schedule time matches the current minute. */
  private async maybeRunDueTasks(): Promise<void> {
    if (this._schedBusy) return
    this._schedBusy = true
    try {
      const now = new Date()
      const hhmm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0')
      const tasks = listTasks(this._dirs.decrypted).items
      const due: number[] = []
      for (const t of tasks) {
        if (!t.enabled) continue
        const sched = (t.scheduleTime || '08:00').slice(0, 5)
        // 「一分钟内没跑过」：`Number(t.lastRunAt)` 对从未跑过的任务是 NaN，`NaN > 60000` 恒 false
        // ⇒ 新任务永远等不到第一次调度（last_run_at 只在跑过一次之后才被写）。缺值按 0 处理。
        const lastRun = Number(t.lastRunAt ?? 0)
        if (sched === hhmm && now.getTime() - lastRun > 60_000) due.push(t.id)
      }
      /**
       * 有界并发 + 失败不连坐（N15，worker 池形态照搬 M10）。
       *
       * 改前是 `for (const t of tasks) await this.runSummaryTask(...)`：N 次**串行**的完整流式
       * 往返，而且前一个任务失败会中断后面所有任务 —— 那正是「失败半写」在摘要任务上的形态：
       * 同一分钟到期的一批只落地一部分，且没有任何地方会补跑剩下的。
       * 现在 worker 原子认领下一个到期任务；单个任务抛错只记下原因，不影响其它任务跑完，
       * 全部结束后再把首个错误抛给外层 catch（保留原来的 summary_scheduler_error 日志）。
       *
       * 并发本身不会引入写冲突：这批唯一的共享资源是 `daily_summary.db`，而 node:sqlite 是同步 API、
       * `saveSummaryRecord` / `updateSummaryTaskRunState` 都是**单语句 autocommit** —— 从加锁到提交
       * 不让出事件循环，两次调用在 JS 层不可能交错（实测 500 次交叉单语句写 0 次 SQLITE_BUSY；
       * 只有把事务开着跨 await 才会撞锁，那是 N10 的病）。
       */
      let next = 0
      let failure: unknown = null
      const worker = async (): Promise<void> => {
        for (;;) {
          const i = next
          next += 1
          if (i >= due.length) return
          try {
            await this.runSummaryTask({ id: due[i] })
          } catch (e) {
            failure = failure ?? e
          }
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(WechatDataGateway.DUE_SUMMARY_CONCURRENCY, due.length) }, () => worker()),
      )
      if (failure) throw failure
    } catch (e) {
      this.op('error', 'summary_scheduler_error', 'fail', '', (e as Error).message)
    } finally { this._schedBusy = false }
  }

  @Remote('runSummaryTask')
  async runSummaryTask(options: { id: number }): Promise<SummaryTaskRunResult> {
    return this.summaryRemotes().runSummaryTask(options)
  }

  /**
   * 「推荐回复」：按**当前会话**的上下文（+ 用户选中的知识库）给出候选回复。
   *
   * 与问答的区别是**不检索全库**：上下文只取这个会话最近若干条，知识库片段也只在用户
   * 显式选了库时才取。会话级功能不该把别处的聊天悄悄端上来 —— 这正是「单聊里冒出别人
   * 消息」那类报障的教训。
   *
   * 出站顺序与当日总结一致：**拦截优先于「模型不可用」**，否则用户开了「禁止 AI 出网」
   * 却只看到一句「模型不可用」，会以为是配置问题而不是隐私设置生效。
   * @param options - `username` 会话；`kbId` 当前选中的库（可缺省）；`count` 想要几条（默认 3，上限 5）。
   * @returns 候选回复；被拦下或模型不可用时 `ok=false` 且 `error` 说明原因。
   */
  @Remote('suggestReplies')
  async suggestReplies(options: { username?: string; kbId?: number; count?: number }): Promise<ReplySuggestResult> {
    const talker = String(options.username ?? '').trim()
    if (talker === '') return { ok: false, error: '缺少会话' }
    const want = Math.max(1, Math.min(Math.trunc(options.count ?? 3), 5))
    const { lines, latestPeer, count } = collectReplyContext(this._dirs.decrypted, talker, this.selfUsername())
    if (count === 0) return { ok: false, error: '这个会话还没有可用的对话内容' }
    const kbId = Math.trunc(Number(options.kbId ?? 0))
    const snippets = kbId > 0
      ? collectReplyKbSnippets(this._dirs.decrypted, kbId, latestPeer || lines[lines.length - 1] || '', 3)
      : []
    const blocked = this.privacyBlocked('suggest_reply')
    if (blocked !== null) return { ok: false, error: blocked }
    const llm = this._ctx.llm
    const defaultModel = (this._ctx as unknown as {
      agentDefaultModel?: { currentSelection(): { provider: string; model: string } }
    }).agentDefaultModel
    const sel = defaultModel?.currentSelection()
    if (!sel || !sel.provider || !sel.model) return { ok: false, error: 'LLM/模型不可用' }
    const prompt = buildReplyPrompt(lines, snippets, want)
    const gate = this.privacyGate('suggest_reply', { sessions: 1, messages: count }, [prompt])
    if (!gate.ok) return { ok: false, error: gate.error }
    const userMsg = createUserMessage({
      content: [{ type: 'text', text: gate.texts[0] ?? prompt }],
      source: { kind: 'plugin', plugin: 'dsh-wechat-data' },
    })
    const assembler = new BlockAssembler()
    const opts: GenerateOptions = {
      provider: sel.provider, model: sel.model, messages: [userMsg],
      system: '你是微信聊天助手。只输出候选回复本身，不要解释、不要客套，也不要复述上下文。',
    }
    try {
      for await (const chunk of llm.stream(opts)) assembler.push(chunk)
    } catch (e) {
      this.op('task', 'suggest_replies', 'fail', talker, (e as Error).message)
      return { ok: false, error: (e as Error).message }
    }
    const raw = assembler.blocks().map(b => (b.type === 'text' ? b.text : '')).join('').trim()
    const replies = parseReplyCandidates(raw, want)
    if (replies.length === 0) {
      this.op('task', 'suggest_replies', 'fail', talker, '模型没给出可用的候选')
      return { ok: false, error: '模型没给出可用的候选回复' }
    }
    this.op('task', 'suggest_replies', 'ok', talker, `${replies.length} 条 · 上下文 ${count} 条 · 知识库 ${snippets.length} 段`)
    const base: ReplySuggestResult = { ok: true, replies, messageCount: count, kbSnippetCount: snippets.length }
    return snippets.length === 0 && kbId > 0
      ? { ...base, degraded: '知识库里没有相关内容，这次只用了会话上下文' }
      : base
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
    const cfg = getConfig(this._dirs.decrypted)
    const configured = resolveWhisperModelsDir(cfg['whisper_models_dir'] as string | undefined, this._dirs.decrypted)
    const configBin = typeof cfg['whisper_bin'] === 'string' ? cfg['whisper_bin'] : ''
    const engine = whisperEnginePath(configBin, configured)
    const result: WhisperStatus = {
      engine,
      hasCuda: whisperHasCuda(),
      modelsDir: configured,
      models: whisperModelsStatus(configured),
      downloading: this.whisperDownload,
      transcribing: this.whisperTranscribing,
    }
    if (engine) result.enginePath = engine
    return result
  }

  /**
   * Download one official whisper.cpp ggml model into the models dir
   * (streamed, atomic publish; huggingface.co with hf-mirror fallback).
   * @param options - model id to download.
   * @returns WhisperDownloadResult: ok + file/bytes, or an error.
   */
  @Remote('downloadWhisperModel')
  async downloadWhisperModel(options: { model: string }): Promise<WhisperDownloadResult> {
    if (this.whisperDownload !== null) { this.op('settings', 'download_whisper_model', 'fail', options.model, '已有模型下载任务进行中'); return { ok: false, error: '已有模型下载任务进行中' } }
    const cfg = getConfig(this._dirs.decrypted)
    const modelsDir = resolveWhisperModelsDir(cfg['whisper_models_dir'] as string | undefined, this._dirs.decrypted)
    this.whisperDownload = { model: options.model, file: '', received: 0, total: 0 }
    try {
      const result = await whisperDownloadModel(options.model, modelsDir, (received, total) => {
        if (this.whisperDownload !== null) {
          this.whisperDownload.received = received
          this.whisperDownload.total = total
        }
      })
      // whisperDownload 在本方法开头必然已赋非空值，直到 finally 才清空。
      this.whisperDownload.file = WHISPER_DOWNLOAD_FILES.find(([id]) => id === options.model)?.[1] ?? options.model
      this.op('settings', 'download_whisper_model', result.ok ? 'ok' : 'fail', options.model, result.error ?? `bytes=${result.bytes ?? 0}`)
      return result
    } finally {
      this.whisperDownload = null
    }
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
    if (this.whisperDownload !== null) { this.op('settings', 'install_whisper_engine', 'fail', '', '已有下载任务进行中'); return { ok: false, error: '已有下载任务进行中' } }
    const cfg = getConfig(this._dirs.decrypted)
    const modelsDir = resolveWhisperModelsDir(cfg['whisper_models_dir'] as string | undefined, this._dirs.decrypted)
    const configBin = typeof cfg['whisper_bin'] === 'string' ? cfg['whisper_bin'] : ''
    const existing = whisperEnginePath(configBin, modelsDir)
    if (existing) { this.op('settings', 'install_whisper_engine', 'skip', '', '引擎已存在'); return { ok: true, file: 'whisper-cli.exe', bytes: 0 } }
    this.whisperDownload = { model: 'engine', file: 'whisper-bin-x64.zip', received: 0, total: 0 }
    try {
      const result = await installWhisperEngine(modelsDir, (received, total) => {
        if (this.whisperDownload !== null) {
          this.whisperDownload.received = received
          this.whisperDownload.total = total
        }
      })
      if (result.ok && result.path) {
        saveConfig(this._dirs.decrypted, { whisper_bin: result.path })
      }
      const out: WhisperDownloadResult = { ok: result.ok, file: 'whisper-cli.exe' }
      if (result.error) out.error = result.error
      this.op('settings', 'install_whisper_engine', out.ok ? 'ok' : 'fail', '', out.error ?? '引擎已安装')
      return out
    } finally {
      this.whisperDownload = null
    }
  }

  /**
   * Batch-transcribe the most recent voice messages: silk → WAV (bundled
   * wx_silk) → whisper-cli with the selected model → text cached per message.
   * @param options - optional message count (default 50, clamped 1..200).
   * @returns VoiceTranscribeResult: done/failed/skipped counts.
   */
  @Remote('transcribeVoiceBatch')
  async transcribeVoiceBatch(options: { limit?: number }): Promise<VoiceTranscribeResult> {
    if (this.whisperTranscribing.active) { this.op('task', 'transcribe_voice_batch', 'fail', '', '已有转写任务进行中'); return { ok: false, total: 0, done: 0, failed: 0, skipped: 0, errors: [], engine: '', error: '已有转写任务进行中' } }
    const cfg = getConfig(this._dirs.decrypted)
    const modelsDir = resolveWhisperModelsDir(cfg['whisper_models_dir'] as string | undefined, this._dirs.decrypted)
    const configBin = typeof cfg['whisper_bin'] === 'string' ? cfg['whisper_bin'] : ''
    const engine = whisperEnginePath(configBin, modelsDir)
    if (!engine) { this.op('task', 'transcribe_voice_batch', 'fail', '', '未检测到 whisper.cpp 引擎'); return { ok: false, total: 0, done: 0, failed: 0, skipped: 0, errors: [], engine, error: '未检测到 whisper.cpp 引擎（可在第 5 步点击「下载引擎」，或设 DSH_WECHAT_WHISPER_BIN）' } }
    const modelId = typeof cfg['whisper_model'] === 'string' && cfg['whisper_model'] ? cfg['whisper_model'] : 'medium'
    const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 50), 200))
    this.whisperTranscribing = { active: true, done: 0, total: 0, failed: 0, skipped: 0, current: '' }
    try {
      const result = await transcribeVoiceBatch(
        this._dirs.decrypted,
        this._dirs.decoded,
        modelsDir,
        modelId,
        engine,
        limit,
        (done, total, failed, current) => {
          this.whisperTranscribing.done = done
          this.whisperTranscribing.total = total
          this.whisperTranscribing.failed = failed
          this.whisperTranscribing.current = current
        },
      )
      this.whisperTranscribing.skipped = result.skipped
      this.op('task', 'transcribe_voice_batch', result.ok ? 'ok' : 'fail', '', result.error ?? `成功 ${result.done}/${result.total}，失败 ${result.failed}`)
      return result
    } finally {
      this.whisperTranscribing.active = false
      this.whisperTranscribing.current = ''
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
   * 诚实边界：① 单张的 md5 仍要各查一次消息分片（`resolveImageResourceHint`，`WHERE
   * local_id = ?`，不是那个全表扫）；② 拿不到原始微信目录（`wechatBaseDir` 未知）时批量
   * 路径查不出东西，行为与逐张调用完全一致。
   * @param options - `items`: 一批 (username, localId)；超过 {@link IMAGE_BATCH_MAX} 的截断。
   * @returns 与传入顺序一一对应的条目（`url` 或 `error`，语义同单张入口）。
   */
  @Remote('getImageDataUrlsBatch')
  getImageDataUrlsBatch(options: { items: Array<{ username: string; localId: number }> }): { items: ImageBatchItem[] } {
  return this.mediaRemotes().getImageDataUrlsBatch(options)
  }

  /**
   * 批量预热「按用户」解码缓存（N16 的接线点，见 `getImageDataUrlsBatch`）。
   *
   * 为什么是「预热」而不是「在这里返回结果」：解码产物与单张入口共用同一份缓存目录/命名
   * （`<decoded>/<username>/<md5>.<ext>`），写进去之后单张入口命中缓存、不再查路径表 ——
   * 于是错误语义、`data_index` 兜底、hevc 判定这些**全部沿用单张入口**，不必在这里复制一份
   * 解码逻辑（`media-image.ts` 不在本轮写集内，也没有导出「按已知路径解码」的入口）。
   *
   * 全程 best-effort：任何一处失败都只是「那张图回退到原来的逐张路径」，不影响其余张；
   * 命中已有缓存的文件不重写。
   * @param decryptedDir - 解密库目录（hardlink.db 所在）。
   * @param decodedDir - 解码缓存根。
   * @param baseDir - 微信原始目录（候选路径的根）。
   * @param items - 待预热的 (username, localId) 列表。
   * @param aesKey - V2 AES key。
   * @param xorKey - XOR key 字节。
   */
  private warmDecodedImages(
    decryptedDir: string,
    decodedDir: string,
    baseDir: string,
    items: ReadonlyArray<{ username: string; localId: number }>,
    aesKey: string | undefined,
    xorKey: number,
  ): void {
    try {
      const md5ByItem: string[] = []
      for (const it of items) {
        const hint = resolveImageResourceHint(decryptedDir, it.username, it.localId)
        md5ByItem.push(hint.md5 ?? '')
      }
      const wanted = md5ByItem.filter(m => m.length === 32)
      if (wanted.length === 0) return
      // 唯一一次「按 md5 找 .dat」的查询（N16 的收益点：N 张图从 N 次全表扫降到 1 次 IN）。
      const paths = resolveImageFilePathsByMd5(decryptedDir, baseDir, wanted)
      if (paths.size === 0) return
      const aesBytes = typeof aesKey === 'string' && aesKey.length > 0 ? Buffer.from(aesKey, 'ascii') : null
      for (let i = 0; i < items.length; i += 1) {
        const md5 = md5ByItem[i] ?? ''
        // 批量结果是按小写键存的（`resolveImageFilePathsByMd5` 会归一化），这里也归一化，
        // 免得「消息里存的是大写 md5」那一条悄悄退回逐张查询。
        const src = md5 ? paths.get(md5.toLowerCase()) : undefined
        if (!src) continue
        const it = items[i]!
        const outDir = join(decodedDir, it.username)
        const cached = CACHED_IMAGE_EXTS.some(ext => existsSync(join(decodedDir, md5 + '.' + ext)) || existsSync(join(outDir, md5 + '.' + ext)))
        if (cached) continue
        try {
          const dec = decodeDatBytes(new Uint8Array(readFileSync(src)), aesBytes, xorKey)
          if ('error' in dec || dec.format === 'hevc') continue
          mkdirSync(outDir, { recursive: true })
          writeFileSync(join(outDir, md5 + '.' + dec.format), Buffer.from(dec.bytes))
        } catch { /* 单张解码失败：回退到单张入口的原路径 */ }
      }
    } catch { /* 预热是优化，失败不影响正确性 */ }
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
   * Resolve a 公众号 article cover (og:image) to a base64 data URL.
   * @param options - mp.weixin.qq.com article URL.
   * @returns ImageDataUrlResult: base64 data URL or error.
   */
  @Remote('getArticleCover')
  async getArticleCover(options: { contentUrl: string }): Promise<ImageDataUrlResult> {
    return resolveArticleCoverDataUrl(options.contentUrl, this._dirs.decoded, this.cdnSwitches())
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

  @Remote('generatePeriodSummary')
  async generatePeriodSummary(options: { from: string; to: string; provider?: string; model?: string }): Promise<PeriodSummaryResult> {
    const collected = collectPeriodMessages(this._dirs.decrypted, options.from, options.to)
    const { lines, count, sessions, total, types, hourly, topSessions } = collected
    // 同每日总结：拦截要在「未配置默认模型」早退之前判
    const blockedPeriod = this.privacyBlocked('period_summary')
    if (blockedPeriod !== null) {
      this.op('task', 'generate_period_summary', 'skip', `${options.from}~${options.to}`, blockedPeriod)
      return {
        summary: '⛔ ' + blockedPeriod + '\n\n周期统计：共 ' + String(total) + ' 条消息 / ' + String(sessions) + ' 个活跃会话。' + (compactDailyDigest(lines) || ''),
        from: options.from, to: options.to, sessions, messages: count, total, types, hourly, topSessions,
      }
    }
    const ctx = this._ctx
    const defaultModel = (ctx as unknown as {
      agentDefaultModel?: { currentSelection(): { provider: string; model: string; reasoningEffort?: string } }
    }).agentDefaultModel
    const sel = defaultModel?.currentSelection()
    const useProvider = (options.provider && options.provider.trim()) ? options.provider.trim() : (sel?.provider ?? '')
    let useModel = (options.model && options.model.trim()) ? options.model.trim() : (sel?.model ?? '')
    const llm = ctx.llm
    if (!options.model && useModel && /vision|-exp/i.test(useModel)) {
      try {
        const ms = await llm.listModels(useProvider)
        const chatModelRe = /chat|flash|pro|v4/i
        const pick = ms.find(m => chatModelRe.test(m.id) && !/vision|image|exp/i.test(m.id))
          ?? ms.find(m => !/vision|image|exp/i.test(m.id))
          ?? ms[0]
        if (pick && pick.id) useModel = pick.id
      } catch { /* keep */ }
    }
    if (!useProvider || !useModel) {
      const fallback = 'AI 不可用（未配置默认模型或 LLM 服务）。\n\n周期统计：共 ' + String(total) + ' 条消息 / ' + String(sessions) + ' 个活跃会话。' + (compactDailyDigest(lines) || '')
      this.op('task', 'generate_period_summary', 'fail', `${options.from}~${options.to}`, '未配置默认模型或 LLM 服务')
      return { summary: fallback, from: options.from, to: options.to, sessions, messages: count, total, types, hourly, topSessions }
    }
    const prompt = '请总结 ' + options.from + ' 至 ' + options.to + ' 的微信聊天内容，输出简洁的中文要点：\n\n' + lines.join('\n')
    const gate = this.privacyGate('period_summary', { sessions, messages: count }, [prompt])
    if (!gate.ok) {
      this.op('task', 'generate_period_summary', 'skip', `${options.from}~${options.to}`, gate.error)
      return {
        summary: '⛔ ' + gate.error + '\n\n周期统计：共 ' + String(total) + ' 条消息 / ' + String(sessions) + ' 个活跃会话。' + (compactDailyDigest(lines) || ''),
        from: options.from, to: options.to, sessions, messages: count, total, types, hourly, topSessions,
      }
    }
    const userMsg = createUserMessage({ content: [{ type: 'text', text: gate.texts[0] ?? prompt }], source: { kind: 'plugin', plugin: 'dsh-wechat-data' } })
    const assembler = new BlockAssembler()
    const opts: GenerateOptions = { provider: useProvider, model: useModel, messages: [userMsg], system: '你是微信周期总结助手，用中文输出简洁的要点总结。', maxTokens: 1024 }
    let summary = ''
    try { for await (const chunk of llm.stream(opts)) assembler.push(chunk); summary = assembler.blocks().map(b => (b.type === 'text' ? b.text : '')).join('').trim() } catch (e) { summary = 'LLM 调用失败: ' + (e as Error).message }
    const finalSummary = summary || (lines.length > 0 ? '模型未返回内容。\n\n周期统计：共 ' + String(total) + ' 条消息 / ' + String(sessions) + ' 个活跃会话。' + (compactDailyDigest(lines) || '') : '（该周期没有可用的文本消息）')
    const ok = !finalSummary.startsWith('LLM 调用失败')
    this.op('task', 'generate_period_summary', ok ? 'ok' : 'fail', `${options.from}~${options.to}`, ok ? `共 ${count} 条消息` : finalSummary.slice(0, 120))
    return { summary: finalSummary, from: options.from, to: options.to, sessions, messages: count, total, types, hourly, topSessions }
  }

  @Remote('getAssetInsights')
  getAssetInsights(): AssetInsightsSnapshot {
    return queryAssetInsights(this._dirs.decrypted)
  }

  @Remote('getContact360')
  getContact360(options: { username: string }): Contact360Snapshot {
    return queryContact360(this._dirs.decrypted, options.username)
  }

  @Remote('getDbHealth')
  getDbHealth(): DbHealthSnapshot {
    return this.configRemotes().getDbHealth()
  }

  @Remote('getCalls')
  getCalls(options?: { topPeers?: number; recentLimit?: number }): CallsSnapshot {
    return queryCalls(this._dirs.decrypted, this.selfUsername(), options?.topPeers, options?.recentLimit)
  }

  @Remote('getGroupInsights')
  getGroupInsights(options: { username: string }): GroupInsightsSnapshot {
    return queryGroupInsights(this._dirs.decrypted, options.username)
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

  @Remote('searchUnified')
  searchUnified(options: { query: string; limit?: number }): UnifiedSearchSnapshot {
    return searchUnified(this._dirs.decrypted, options.query, options.limit)
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

export default WechatDataGateway
