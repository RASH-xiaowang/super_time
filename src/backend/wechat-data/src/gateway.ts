/**
 * WeChatDataGateway — Host Remote service exposing st_control's decrypted
 * WeChat SQLite through the DSH Typert RPC. The browser client calls
 * ctx.remote.wechatData.* instead of an HTTP API.
 */
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type { Context } from '@deepseek-ai/cordis'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AccountsSnapshot, AnnualReport, AnnualSnapshot, AskOptimizeResult, AskResult, AutoDbKeyResult, AutoImageKeyResult, AvatarResult, BackupMutationResult, BackupPreviewSnapshot, BackupSnapshot, CalendarSnapshot, CallsSnapshot, ChatHistoryResolveResult, ConfigSnapshot, ContactsSnapshot, DailySummaryResult, DbStatusSnapshot, DecryptAllResult, DecryptImagesResult, DecryptStatus, DeleteFavoriteResult, DraftClearResult, DraftsClearResult, EditMutationResult, EditedListSnapshot, EmoticonsSnapshot, ExportResult, ExportStatus, ExportHistoryDeleteResult, ExportHistoryQuery, ExportHistorySnapshot, ExportHistoryPruneOptions, FavoritesSnapshot, FilesSnapshot, GenerateKeysResult, GraphSnapshot, GroupInfoSnapshot, ImageDataUrlResult, KeysInfoResult, MemberSearchSnapshot, MessagesSnapshot, MomentsSnapshot, OverviewInsights, OverviewSnapshot, PaymentStatus, PrivacySnapshot, RecordsSnapshot, RevokedSnapshot, SearchBuildResult, SearchIndexStatus, SearchSnapshot, SessionsSnapshot, SimpleResult, StorageSnapshot, SummaryRecord, SummaryRecordSnapshot, SummaryTask, SummaryTaskMutationResult, SummaryTaskRunResult, SummaryTaskSnapshot, VerifyImageKeyResult, VerifyKeyResult, VideoInfoResult, VoiceDataUrlResult, VoiceInfoResult, VoiceTranscriptResult, VoiceTranscribeOneResult, VoiceTranscribeResult, WechatAccount, WechatConfigFull, WechatConfigPatch, WhisperDownloadProgress, WhisperDownloadResult, WhisperStatus, WhisperTranscribing, AssetInsightsSnapshot, BackupRestoreResult, Contact360Snapshot, DbHealthSnapshot, GroupInsightsSnapshot, HandoffRemindsSnapshot, LedgerSnapshot, MediaAssetsSnapshot, MomentsInsightsSnapshot, MomentsMonthlyRow, OfficialAssetsSnapshot, OperationCategory, OperationLogClearResult, OperationLogQuery, OperationLogSnapshot, OperationStatus, PeriodSummaryResult, PrivacyAuditClearResult, PrivacyAuditRow, PrivacyStateSnapshot, RegionMapSnapshot, TaskMutationResult, TasksSnapshot, UnifiedSearchSnapshot, KnowledgeSnapshot, NotesSnapshot, NoteMutationResult } from './types.ts'
import { querySessions } from './query/sessions.ts'
import { queryGroupInfo } from './query/group-info.ts'
import { queryPaymentStatus } from './query/payments.ts'
import { queryContacts } from './query/contacts.ts'
import { queryRegionMap } from './query/region-map.ts'
import { queryMessageByServerId, queryMessages, queryNewMessages } from './query/messages.ts'
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
import { openNativePath } from '@deepseek-ai/dsh-native-command'
import { queryPrivacyScan } from './query/privacy.ts'
import { queryCalls } from './query/calls.ts'
import { queryGraph } from './query/graph.ts'
import { getDailyCounts } from './query/calendar.ts'
import { buildSearchIndex, getSearchIndexStatus, knownEntityNames, searchIndexMessages } from './query/search.ts'
import { searchMembers } from './query/members.ts'
import { decodeDatBytes, decodeEmoticonDataUrl, decodeFileImageDataUrl, decodeImageDataUrl, fetchEmoticonRemote, resolveImageFilePathsByMd5, resolveImageResourceHint } from './query/media-image.ts'
import type { StreamControl } from './query/zip.ts'
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
import { formatAskContext, parseAskOptimize, parseAskPlan, parseCitedIndexes, retrieveAskCitations } from './query/ask.ts'
import { auditGrounding, groundingRepairHint } from './query/grounding.ts'
import { loadRetrievalConfig, saveRetrievalConfig as saveRetrievalConfigFile, defaultRetrievalConfig } from './query/retrieval/config.ts'
import { runRetrievalPipeline } from './query/retrieval/pipeline.ts'
import { buildVectorIndex, vectorIndexStatus, vectorIndexSummary, type EmbedFn } from './query/retrieval/embedding.ts'
import { adaptWeights, attributeFeatures, feedbackStats, listFeedback, loadAdaptedWeights, recordFeedback, saveAdaptedWeights } from './query/retrieval/feedback.ts'
import { runSyntheticEval, syntheticIntentAccuracy } from './query/retrieval/eval-dataset.ts'
import { formatEvalReport } from './query/retrieval/eval.ts'
import type { FeedbackRecord, IntentKind, RerankWeights } from './query/retrieval/types.ts'
import { createBackup as createBackupEntry, deleteBackup as deleteBackupEntry, listBackups as listBackupEntries, previewBackup as previewBackupEntry } from './query/backup.ts'
import { collectDayMessages, collectPeriodMessages } from './query/daily-summary.ts'
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
import { buildKnowledgeGraph, deleteNote as deleteNoteRow, listNotes, saveNote as saveNoteRow } from './query/notes.ts'
import { deleteSummaryRecord as delRec, deleteSummaryTask as delTask, listSummaryRecords as listRecs, listSummaryTasks as listTasks, saveSummaryRecord as saveRec, saveSummaryTask as saveTask, toggleSummaryTask as toggleTask, updateSummaryTaskRunState } from './query/summary-tasks.ts'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'

import { bootstrapWechatData, resolveDecodedDir, resolveDecryptedDir } from './dirs.ts'

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
 * @param citations - 本次检索到的原文（引用锚点）。
 * @returns 一行来源说明；没有原文时返回空串。
 */
function askBasisLine(citations: ReadonlyArray<{ time?: string; username?: string }>): string {
  if (citations.length === 0) return ''
  const sessions = new Set(citations.map(c => c.username ?? '')).size
  const days = citations.map(c => (c.time ?? '').slice(0, 10)).filter(Boolean).sort()
  const span = days.length > 0 ? ` · ${days[0]} ~ ${days[days.length - 1]}` : ''
  return `依据本机记录：${citations.length} 条原文 · ${sessions} 个会话${span}`
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
interface StreamJob {
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

/** CSV 导出种类的中文说明（只用于导出历史的可读 label，不参与导出本身）。 */
const CSV_KIND_LABEL: Record<string, string> = {
  contacts: '通讯录',
  favorites: '收藏',
  records: '记录',
  moments: '朋友圈',
  privacy: '隐私扫描',
}

/**
 * N27：同一轮问答反馈的重复提交窗口。
 *
 * 10 秒的依据：真正的重复来自「同一轮被提交两次」——两个面板同时提交、旧版客户端重试、
 * 直接 RPC 调用，间隔都在一次点击的量级；而用户**改变主意重新评分**（up→down、或改了
 * 标注集合）会落到另一个键（键含 rating 与引用序号），不受这个窗口影响。
 */
const ASK_FEEDBACK_DEDUPE_MS = 10_000

/** 反馈去重表的键上限（进程内，只记窗口内的键）。 */
const ASK_FEEDBACK_CAP = 200

/** 一次批量取图最多几张（IPC 载荷与单次解码耗时的折中；超出的条目按单张语义回错误）。 */
const IMAGE_BATCH_MAX = 200

/**
 * 解码缓存的扩展名候选（与 `media-image.ts` 的 `RENDERABLE_EXTS` 同集合）。
 * 只用来判「这张图已经有解码产物了吗」——有就别再解一遍。
 */
const CACHED_IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tif']

/** 批量取图的返回条目（`url`/`error` 与单张入口同义）。 */
interface ImageBatchItem {
  username: string
  localId: number
  url?: string
  format?: string
  error?: string
}

/**
 * 规整渲染层传来的 jobId：只当**不透明标识**用（不落盘、不回显），所以限长截断即可。
 * @param jobId - 原始值（可能缺省/非字符串）。
 * @returns 可用的标识；不可用时为空串（＝调用方没打算订阅进度）。
 */
function normalizeJobId(jobId?: unknown): string {
  return typeof jobId === 'string' ? jobId.trim().slice(0, 64) : ''
}

/** Coerce a config cell to a string (null -> '', else String()). */
function cellStr(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === null || v === undefined) return ''
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol') return String(v)
  return ''
}

/** Remote-only service exposing WeChat data queries. */
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
   * 反馈去重窗口（N27）：键 → 到期时间。
   *
   * 为什么不是 `inflightXxx: Set` 那种「在飞合并」的闸：`submitAskFeedback` 是**同步** RPC，
   * 函数体在事件循环里一口气跑完，两个「并发」调用不会交错 ⇒ 在飞表恒为空，那是个假闸。
   * 真正的重复是「同一轮被提交两次」且两次都真跑完（多一条反馈记录 + 按重复特征重算权重 +
   * 两条审计），所以按内容键 + 时间窗去重（见 {@link ASK_FEEDBACK_DEDUPE_MS}）。
   */
  private readonly _askFeedbackSeen = new Map<string, number>()
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
      return false
    }
  }

  private privacyBlocked(feature: string, detail = '把数据发送给模型'): string | null {
    try {
      return readPrivacySettings(this._dirs.decrypted).blockOutbound
        ? `隐私设置已开启「出站拦截」，已阻止「${feature}」${detail}`
        : null
    } catch {
      return null
    }
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
    const settings = readPrivacySettings(this._dirs.decrypted)
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
   * 构造「过隐私闸门」的 embedding 函数（稠密检索通道用）。
   *
   * 所有 embedding 调用都必须先过与 chat 出站同一道闸门：开启「出站拦截」时抛错
   * （流水线自动降级为纯稀疏），开启「敏感字段脱敏」时发送脱敏后的文本，并写审计。
   * @param model - 向量模型名（空则回退 chat model）。
   * @returns embedding 函数；底层 LLM 桥未提供 embed 时返回 undefined。
   */
  private makeEmbedFn(model: string): EmbedFn | undefined {
    const llmAny = this._ctx.llm as unknown as { embed?: (texts: string[], opts?: { model?: string }) => Promise<number[][]> }
    if (typeof llmAny?.embed !== 'function') return undefined
    return async (texts: string[]): Promise<number[][]> => {
      const gate = this.privacyGate('ask_embed', { sessions: 0, messages: texts.length }, texts)
      if (!gate.ok) throw new Error(gate.error)
      return llmAny.embed!(gate.texts, model ? { model } : undefined)
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
  getRevoked(options?: { limit?: number; offset?: number }): RevokedSnapshot {
    return queryRevoked(this._dirs.decrypted, options?.limit, options?.offset)
  }

  /**
   * Custom emoticons.
   * @param options - Optional limit/offset for incremental loading.
   * @returns EmoticonsSnapshot: emoticon items.
   */
  @Remote('getEmoticons')
  getEmoticons(options?: { limit?: number; offset?: number }): EmoticonsSnapshot {
    return queryEmoticons(this._dirs.decrypted, options?.limit, options?.offset)
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
    return queryWechatConfig(this._dirs.decrypted)
  }

  /**
   * Privacy scan.
   * @returns PrivacySnapshot: privacy scan result.
   */
  @Remote('getPrivacyScan')
  getPrivacyScan(): PrivacySnapshot {
    return queryPrivacyScan(this._dirs.decrypted)
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
   * Knowledge notes list.
   * @param options - Optional case-insensitive search query and row cap.
   * @returns NotesSnapshot: notes (newest first) plus the unpaged total.
   */
  @Remote('getNotes')
  getNotes(options?: { query?: string; limit?: number }): NotesSnapshot {
    return listNotes(this._dirs.decrypted, options)
  }

  /**
   * Create (no `id`) or update (`id` given) one knowledge note.
   *
   * `sourceKind: 'ask'` marks a note distilled from a WeChat Q&A answer — that
   * is the join point with the social graph: the panel draws an edge from the
   * note to its source chat instead of leaving knowledge nodes floating.
   * @param options - Note fields; title is required and unique (case-insensitive).
   * @returns NoteMutationResult: `{ ok, id }`, or `{ ok: false, error }`.
   */
  @Remote('saveNote')
  saveNote(options: {
    id?: number
    title: string
    body?: string
    tags?: string[] | string
    sourceKind?: 'manual' | 'ask'
    sourceUsername?: string
    sourceQuestion?: string
  }): NoteMutationResult {
    const r = saveNoteRow(this._dirs.decrypted, options)
    this.op('edit', 'save_note', r.ok ? 'ok' : 'fail', options.title, r.error ?? `id=${r.id ?? ''}`)
    return r
  }

  /**
   * Delete one knowledge note.
   * @param options - Note id.
   * @returns NoteMutationResult.
   */
  @Remote('deleteNote')
  deleteNote(options: { id: number }): NoteMutationResult {
    const r = deleteNoteRow(this._dirs.decrypted, options.id)
    this.op('delete', 'delete_note', r.ok ? 'ok' : 'fail', `id=${options.id}`, r.error ?? '')
    return r
  }

  /**
   * Knowledge graph: note nodes, `[[…]]` edges and unresolved stubs.
   *
   * 与 `getGraph` 分开而不是合并：社交图谱的节点口径（联系人/群/我）和知识图谱
   * （笔记/未解析目标）是两套语义，合并会让两个面板都变脆；融合视图交给前端把
   * 两份快照按 `sourceUsername` 拼起来（笔记 → 来源会话）。
   * @returns KnowledgeSnapshot.
   */
  @Remote('getKnowledgeGraph')
  getKnowledgeGraph(): KnowledgeSnapshot {
    const names = contactMeta(this._dirs.decrypted).names
    return buildKnowledgeGraph(this._dirs.decrypted, names)
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
  getFavorites(options?: { limit?: number; offset?: number }): FavoritesSnapshot {
    return queryFavorites(this._dirs.decrypted, options?.limit, options?.offset)
  }

  /**
   * Resource files.
   * @param options - Optional limit/offset and category filter for incremental loading.
   * @returns FilesSnapshot: resource file items.
   */
  @Remote('getFiles')
  getFiles(options?: { limit?: number; offset?: number; category?: string }): FilesSnapshot {
    return queryFiles(this._dirs.decrypted, options?.limit, options?.offset, options?.category)
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
    try {
      const r = await buildSearchIndex(this._dirs.decrypted, options?.force)
      this.op('sync', 'build_search_index', r.status === 'ok' ? 'ok' : 'skip', '', r.message ?? `rows=${r.rows ?? 0}`)
      return r
    } catch (e) {
      this.op('sync', 'build_search_index', 'fail', '', (e as Error).message)
      throw e
    }
  }

  /**
   * Full-text search over text messages (index first, scan fallback).
   * @param options - query string, optional result limit and optional talker scope.
   * @returns SearchSnapshot: matched message items.
   */
  @Remote('searchMessages')
  searchMessages(options: { query: string; limit?: number; username?: string }): SearchSnapshot {
    return searchIndexMessages(this._dirs.decrypted, options.query, options.limit, options.username)
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
    return resolveVoiceInfo(this._dirs.decrypted, options.username, options.localId)
  }

  /**
   * Resolve one voice message to an inline-playable wav data URL.
   * 语音实体是 silk，需要解码成 wav 才能播；产物落在转写链路同一份缓存里。
   * @param options - username and localId of the voice message.
   * @returns VoiceDataUrlResult: base64 wav data URL (+ duration) or error.
   */
  @Remote('getVoiceDataUrl')
  getVoiceDataUrl(options: { username: string; localId: number }): VoiceDataUrlResult {
    return resolveVoiceDataUrl(this._dirs.decrypted, this._dirs.decoded, options.username, options.localId)
  }

  /**
   * Look up one video message: cover thumbnail + the on-disk video path.
   * 封面与实体都在真实微信目录 `msg/video` 下，所以要带上数据根目录。
   * @param options - username and localId of the video message.
   * @returns VideoInfoResult: video cover/thumbnail info.
   */
  @Remote('getVideoInfo')
  getVideoInfo(options: { username: string; localId: number }): VideoInfoResult {
    return resolveVideoInfo(
      this._dirs.decrypted, this._dirs.decoded, options.username, options.localId,
      rawWechatBase(this._dirs.decrypted) || undefined,
    )
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
    try {
      const r = await exportSessionMessagesStreamed(this._dirs.decrypted, { ...options })
      this.op('export', 'export_session_messages', 'ok', options.username, `共 ${r.count} 条`)
      this.recordExport({
        kind: 'session',
        label: options.sessionName ? `会话 · ${options.sessionName}` : `会话 · ${options.username}`,
        format: options.zip ? 'zip' : options.format,
        path: r.path,
        rows: r.count,
        status: 'ok',
        // 重跑所需的**全部**入参：少了 from/to 之类的范围条件，重新导出就会得到不同结果。
        params: options,
      })
      return r
    } catch (e) {
      this.op('export', 'export_session_messages', 'fail', options.username, (e as Error).message)
      // 失败也记一条：用户要能看到「这次没成功」，而不是以为没发生过。
      this.recordExport({
        kind: 'session',
        label: options.sessionName ? `会话 · ${options.sessionName}` : `会话 · ${options.username}`,
        format: options.zip ? 'zip' : options.format,
        path: '',
        status: 'fail',
        error: (e as Error).message,
        params: options,
      })
      throw e
    }
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
  }): Promise<AskResult> {
    const ctx = this._ctx
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
    // 全量构建实测 5.4s / 13.5 万条，因此首次提问时自动建一次，之后直接复用。
    const indexStatus = getSearchIndexStatus(this._dirs.decrypted)
    if (!indexStatus.ready) {
      try {
        const built = await buildSearchIndex(this._dirs.decrypted, false)
        this.op('task', 'ask_wechat', 'ok', 'build_index', `检索索引 ${built.status} · ${built.rows ?? 0} 条 · ${built.elapsed_ms ?? 0}ms`)
      } catch (e) {
        // 建索引失败不阻断提问：退回 LIKE 召回（准确率低但可用）
        this.op('task', 'ask_wechat', 'fail', 'build_index', (e as Error).message)
      }
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

    if (retrConfig.enabled) {
      try {
      // 稠密通道是**新增的出网点**：embedding 调用统一过隐私闸门（见 makeEmbedFn），
      // 未配置 / 被「出站拦截」时抛错，流水线自动降级为纯稀疏，不影响问答可用性。
      const embedFn = this.makeEmbedFn(retrConfig.embedding.model)
      // 向量索引：首次（或增量）在提问时补齐；失败只记录，不阻断（退化为纯稀疏）。
      if (embedFn && retrConfig.embedding.enabled) {
        const vst = vectorIndexStatus(this._dirs.decrypted)
        if (!vst.ready) {
          try {
            const built = await buildVectorIndex(this._dirs.decrypted, embedFn, {
              model: retrConfig.embedding.model || 'default',
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
        // 名单里已有的就不重复；规划器额外点出的名字也一并带上（可能不在通讯录里）。
        knownEntities: plan.person && !known.includes(plan.person) ? [...known, plan.person] : known,
        ...(adapted ? { weightsOverride: adapted } : {}),
      })
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
    const basisLine = askBasisLine(citations)
    if (citations.length === 0) {
      this.op('task', 'ask_wechat', 'skip', '', '未检索到任何原文，未调用模型')
      return {
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
    const synthPrompt = `${historyBlock}用户本次问题：${options.question}

${contextBlock}

请按以下要求回答：
1. **只用材料里的事实**：上面检索结果里没有的信息一律不要补充，尤其不要凭常识推测人名、金额、日期、时间。宁可少说，也不要编。金额、日期、电话/卡号这类值**只能原样照抄**材料里的写法 —— 要说合计就写明由哪几条相加（如「3500+3500=7000」），不要自行换算单位或推算日期。
2. **像微信里跟人说话那样自然**：口语化中文，直接把事情讲清楚，不要写成报告或分析（不要「综上所述」「根据数据分析」「经梳理」这类腔调），也不要复述检索过程。要罗列多条时可以分点，但每条都要像在转述聊天内容。
3. **每条事实后面标 [n]**：例如「小何说收到转账 13.00 元 [1]」，多个来源写 [1][3]。材料里形如「群名 · 某人」的，要说清是谁说的。
4. **时间写绝对日期**（如 2026-09-05），不要写「上周」「前几天」这类相对表述。
5. **找不到就直说**：材料不足以回答时，直接说明「聊天记录里没有找到……」，再给 1-2 条改问建议（换关键词、收窄时间或指定会话）。不要用推测填空。
6. 只引用真正支持结论的那几条来源，不要罗列全部；也不用写「依据本机记录」这类来源说明，界面上已单独显示。`
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
        citations: citations.map(c => c.username + ':' + c.local_id),
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
    return {
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
    return listBackupEntries(this._dirs.decrypted)
  }

  /**
   * Preview a backup's contents (bounded file list) before restore.
   * @param options - backup name.
   * @returns BackupPreviewSnapshot: items + total.
   */
  @Remote('previewBackup')
  previewBackup(options: { name: string }): BackupPreviewSnapshot {
    return previewBackupEntry(this._dirs.decrypted, options.name)
  }

  /**
   * Create a local backup snapshot.
   * @returns BackupMutationResult: ok + backup name, or error.
   */
  @Remote('createBackup')
  createBackup(): BackupMutationResult {
    try {
      const e = createBackupEntry(this._dirs.decrypted)
      this.op('backup', 'create_backup', 'ok', e.name)
      return { ok: true, name: e.name }
    } catch (err) {
      this.op('backup', 'create_backup', 'fail', '', (err as Error).message)
      return { ok: false, error: (err as Error).message }
    }
  }

  /**
   * Delete one backup by name.
   * @param options - name of the backup to delete.
   * @returns BackupMutationResult: ok, or error on failure.
   */
  @Remote('deleteBackup')
  deleteBackup(options: { name: string }): BackupMutationResult {
    const r = deleteBackupEntry(this._dirs.decrypted, options.name)
    this.op('delete', 'delete_backup', r.ok ? 'ok' : 'fail', options.name, r.error ?? '')
    return r
  }

  /**
   * RAG 检索层状态：配置 + 向量库 + 反馈统计 + 当前调参权重 + 意图分类自评。
   * @returns 供「数据健康 / 检索设置」面板展示。
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
    const cfg = loadRetrievalConfig(this._dirs.decrypted)
    const adapted = loadAdaptedWeights(this._dirs.decrypted)
    return {
      enabled: cfg.enabled,
      config: cfg,
      vector: vectorIndexSummary(this._dirs.decrypted),
      feedback: feedbackStats(this._dirs.decrypted),
      weights: adapted ?? cfg.rerank.weights,
      intentAccuracy: syntheticIntentAccuracy(),
    }
  }

  /**
   * 保存检索参数（阈值/权重/容量）。前端面板改一个开关也走这里。
   * @param options - 形如 `{ patch: {...} }`，或直接给字段子集。
   * @returns 落盘后的完整配置。
   */
  @Remote('saveRetrievalConfig')
  saveRetrievalConfig(options?: { patch?: unknown } | unknown): { ok: boolean; config: unknown } {
    const patch = (options && typeof options === 'object' && 'patch' in (options as Record<string, unknown>))
      ? (options as { patch?: unknown }).patch
      : options
    const saved = saveRetrievalConfigFile(this._dirs.decrypted, patch)
    this.op('settings', 'save_retrieval_config', 'ok', '', JSON.stringify(patch ?? {}).slice(0, 200))
    return { ok: true, config: saved }
  }

  /**
   * 立即构建/增量更新稠密向量索引（设置面板的「重建向量索引」按钮）。
   * @param options - force=true 时清空重建。
   * @returns 构建结果。
   */
  @Remote('buildRagVectorIndex')
  async buildRagVectorIndex(options?: { force?: boolean }): Promise<{ ok: boolean; status: string; rows: number; embedded: number; elapsed_ms: number; message?: string }> {
    const cfg = loadRetrievalConfig(this._dirs.decrypted)
    const embedFn = this.makeEmbedFn(cfg.embedding.model)
    if (!embedFn) return { ok: false, status: 'no-embedder', rows: 0, embedded: 0, elapsed_ms: 0, message: '未配置 embedding（请在模型配置里填写向量模型或 API Key）' }
    if (!getSearchIndexStatus(this._dirs.decrypted).ready) {
      try { await buildSearchIndex(this._dirs.decrypted, false) } catch { /* 交给下面状态判定 */ }
    }
    try {
      const r = await buildVectorIndex(this._dirs.decrypted, embedFn, {
        model: cfg.embedding.model || 'default',
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
    const cfg = loadRetrievalConfig(this._dirs.decrypted)
    if (!cfg.feedback.enabled) return { ok: false, message: '反馈闭环已在检索配置里关闭' }
    // N27：同一轮反馈的重复提交在这里挡掉。放在副作用之前 —— 挡晚了（比如在 recordFeedback
    // 之后）就等于「只去重审计、副作用照样跑两遍」。
    //
    // 键含 rating 与引用序号：用户改主意（up→down、或改标注集合）是**另一次**反馈，必须放行；
    // 键里的 answer 片段用于「客户端没给 retrievalId 也没给 question」时区分不同轮次
    // （否则两轮不同的问答会共用 `''` 这个键，被窗口误挡）。
    const dedupeKey = [
      options.retrievalId ?? '',
      options.question ?? '',
      String(options.answer ?? '').slice(0, 120),
      options.rating,
      (options.useful ?? []).join(','),
      (options.useless ?? []).join(','),
    ].join('\u0000')
    const now = Date.now()
    const until = this._askFeedbackSeen.get(dedupeKey)
    if (until !== undefined && until > now) {
      this.op('task', 'ask_feedback', 'ok', options.rating, '重复提交（同一轮，已忽略）')
      return { ok: false, message: '该反馈已在处理（同一轮重复提交已忽略，未重复记录）' }
    }
    boundedSet(this._askFeedbackSeen, dedupeKey, now + ASK_FEEDBACK_DEDUPE_MS, ASK_FEEDBACK_CAP)
    const trace = options.retrievalId ? this._askTrace.get(options.retrievalId) : undefined
    const keyOf = (i: number): string | null => (trace && i >= 1 && i <= trace.citations.length) ? trace.citations[i - 1] : null
    const pick = (idx: number[] | undefined): RerankWeights[] => {
      if (!trace) return []
      const out: RerankWeights[] = []
      for (const i of idx ?? []) {
        const k = keyOf(i)
        const f = k ? trace.features.get(k) : undefined
        if (f) out.push(f)
      }
      return out
    }
    const features = attributeFeatures(pick(options.useful), pick(options.useless))
    const rec: FeedbackRecord = {
      id: 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      question: options.question ?? trace?.question ?? '',
      answer: options.answer ?? trace?.answer ?? '',
      rating: options.rating === 'down' ? 'down' : 'up',
      citedUseful: options.useful ?? [],
      citedUseless: options.useless ?? [],
      intent: trace?.intent ?? 'open_qa',
      createdAt: Date.now(),
      features,
    }
    recordFeedback(this._dirs.decrypted, rec, cfg.feedback.maxRecords)
    const all = listFeedback(this._dirs.decrypted, cfg.feedback.maxRecords)
    const adapted = adaptWeights(cfg.rerank.weights, all, cfg.feedback.learningRate)
    saveAdaptedWeights(this._dirs.decrypted, adapted)
    this.op('task', 'ask_feedback', 'ok', options.rating, `features=${features.join(',')} total=${all.length}`)
    return { ok: true, adaptedWeights: adapted, features }
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
    return {
      items: listFeedback(this._dirs.decrypted, options?.limit ?? 50),
      stats: feedbackStats(this._dirs.decrypted),
    }
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
   * 不依赖真实数据，因此可以随时在设置面板点一下就看到当前算法的 P/R/MRR/NDCG，
   * 也可以在 CI 里断言「混合不低于纯稀疏」防止退化。
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
    const k = options?.k ?? 10
    const hybrid = runSyntheticEval({ k })
    const sparseOnly = runSyntheticEval({ k, denseEnabled: false, structuredEnabled: false })
    const intentAccuracy = syntheticIntentAccuracy()
    const brief = (r: typeof hybrid): { precision: number; recall: number; mrr: number; ndcg: number; map: number; cases: number; hits: number } => ({
      precision: r.precision, recall: r.recall, mrr: r.mrr, ndcg: r.ndcg, map: r.map, cases: r.cases, hits: r.hits,
    })
    const report = [
      formatEvalReport('合成评测集（混合：稀疏+稠密+结构化）', hybrid, k),
      formatEvalReport('消融对照（仅稀疏）', sparseOnly, k),
      `意图分类准确率：${intentAccuracy.correct}/${intentAccuracy.total} = ${(intentAccuracy.accuracy * 100).toFixed(1)}%`,
    ].join('\n')
    this.op('task', 'evaluate_retrieval', 'ok', '', `MRR ${hybrid.mrr.toFixed(3)} vs 稀疏 ${sparseOnly.mrr.toFixed(3)}`)
    return { report, hybrid: brief(hybrid), sparseOnly: brief(sparseOnly), intentAccuracy }
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
    const r = resetEdit(this._dirs.decrypted, options.username, options.localId)
    this.op('edit', 'reset_edited_message', r.ok ? 'ok' : 'fail', options.username, r.error ?? `localId=${options.localId}`)
    return r
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
    try {
      const r = exportAnnualReport(this._dirs.decrypted, options.year, options.format, options.dir, options.filename)
      this.op('export', 'export_annual_report', 'ok', String(options.year), `共 ${r.count} 条`)
      this.recordExport({
        kind: 'annual',
        label: `年度报告 · ${options.year} 年`,
        format: options.format,
        path: r.path,
        rows: r.count,
        status: 'ok',
        params: options,
      })
      return r
    } catch (e) {
      this.op('export', 'export_annual_report', 'fail', String(options.year), (e as Error).message)
      this.recordExport({
        kind: 'annual',
        label: `年度报告 · ${options.year} 年`,
        format: options.format,
        path: '',
        status: 'fail',
        error: (e as Error).message,
        params: options,
      })
      throw e
    }
  }

  /**
   * Export ALL sessions as a single txt ZIP archive (账号归档).
   * @param options - optional dir/filename（+ 可选的 jobId：订阅 `wechat-export/progress` 进度并允许取消）.
   * @returns ExportResult: written zip path + total messages.
   */
  @Remote('exportAllSessions')
  async exportAllSessions(options?: { dir?: string; filename?: string; jobId?: string }): Promise<ExportResult> {
    const jobId = normalizeJobId(options?.jobId)
    try {
      // M3：进度/取消三件套（jobId → 本地 onProgress + AbortController）在本层接上，
      // 参数原样透传给 query 层（`& StreamControl`）—— 取消后写盘走 temp+rename，
      // 所以「取消」不会留下半成品文件。
      const r = await exportAllSessions(this._dirs.decrypted, {
        ...(options?.dir !== undefined ? { dir: options.dir } : {}),
        ...(options?.filename !== undefined ? { filename: options.filename } : {}),
        ...this.streamControl(jobId),
      })
      this.finishStreamJob(jobId)
      this.op('export', 'export_all_sessions', 'ok', '', `共 ${r.count} 条`)
      this.recordExport({
        kind: 'all_sessions',
        label: '全部会话归档',
        format: 'zip',
        path: r.path,
        rows: r.count,
        status: 'ok',
        params: options ?? {},
      })
      return r
    } catch (e) {
      this.finishStreamJob(jobId, (e as Error).message)
      this.op('export', 'export_all_sessions', 'fail', '', (e as Error).message)
      // 取消也是一种正常结局，与「失败」分开记：用户主动取消不该在历史里显示成红叉。
      const canceled = /cancel|取消|abort/i.test((e as Error).message)
      this.recordExport({
        kind: 'all_sessions',
        label: '全部会话归档',
        format: 'zip',
        path: '',
        status: canceled ? 'canceled' : 'fail',
        error: canceled ? '' : (e as Error).message,
        params: options ?? {},
      })
      throw e
    }
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
    const id = normalizeJobId(options?.jobId)
    const job = id ? this._streamJobs.get(id) : undefined
    if (!job) return { ok: false, error: '没有该导出任务（jobId 不存在，或进程已重启）' }
    if (job.finished) return { ok: false, error: '该导出任务已结束' }
    job.ctrl.abort()
    this.op('export', 'cancel_export_job', 'ok', id)
    return { ok: true }
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
    const id = normalizeJobId(options?.jobId)
    const job = id ? this._streamJobs.get(id) : undefined
    if (!job) return { found: false, phase: '', done: 0, total: 0, finished: true }
    return {
      found: true,
      phase: job.progress?.phase ?? '',
      done: job.progress?.done ?? 0,
      total: job.progress?.total ?? 0,
      finished: job.finished,
      ...(job.error ? { error: job.error } : {}),
    }
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
    const jobId = normalizeJobId(options?.jobId)
    try {
      // 与 exportAllSessions 同一套接线：进度事件 + 取消令牌都由 streamControl 提供。
      const r = await exportMoments(this._dirs.decrypted, {
        ...(options?.format !== undefined ? { format: options.format } : {}),
        ...(options?.username !== undefined ? { username: options.username } : {}),
        ...(options?.authorName !== undefined ? { authorName: options.authorName } : {}),
        ...(options?.q !== undefined ? { q: options.q } : {}),
        ...(options?.images !== undefined ? { images: options.images } : {}),
        ...(options?.media !== undefined ? { media: options.media } : {}),
        ...(options?.month !== undefined ? { month: options.month } : {}),
        ...(options?.mine !== undefined ? { mine: options.mine } : {}),
        ...(options?.zip !== undefined ? { zip: options.zip } : {}),
        ...(options?.from !== undefined ? { from: options.from } : {}),
        ...(options?.to !== undefined ? { to: options.to } : {}),
        ...(options?.dir !== undefined ? { dir: options.dir } : {}),
        ...(options?.filename !== undefined ? { filename: options.filename } : {}),
        ...this.streamControl(jobId),
      })
      this.finishStreamJob(jobId)
      this.op('export', 'export_moments', 'ok', options?.username ?? '', `共 ${r.count} 条`)
      this.recordExport({
        kind: 'moments',
        label: options?.username ? `朋友圈 · ${options.authorName ?? options.username}` : '朋友圈 · 全部',
        format: options?.zip ? 'zip' : (options?.format ?? 'txt'),
        path: r.path,
        rows: r.count,
        status: 'ok',
        params: options ?? {},
      })
      return r
    } catch (e) {
      this.finishStreamJob(jobId, (e as Error).message)
      this.op('export', 'export_moments', 'fail', options?.username ?? '', (e as Error).message)
      const canceled = /cancel|取消|abort/i.test((e as Error).message)
      this.recordExport({
        kind: 'moments',
        label: options?.username ? `朋友圈 · ${options.authorName ?? options.username}` : '朋友圈 · 全部',
        format: options?.zip ? 'zip' : (options?.format ?? 'txt'),
        path: '',
        status: canceled ? 'canceled' : 'fail',
        error: canceled ? '' : (e as Error).message,
        params: options ?? {},
      })
      throw e
    }
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
    const label = CSV_KIND_LABEL[options.kind] ?? options.kind
    try {
      const r = exportCsv(this._dirs.decrypted, options.kind, options.recordsKind, options.dest, options.category)
      this.op('export', 'export_csv', 'ok', options.kind, `共 ${r.count} 行`)
      this.recordExport({
        kind: options.kind,
        label: options.category && options.category !== 'all' ? `${label} · ${options.category}` : label,
        format: 'csv',
        path: r.path,
        rows: r.count,
        status: 'ok',
        params: options,
      })
      return r
    } catch (e) {
      this.op('export', 'export_csv', 'fail', options.kind, (e as Error).message)
      this.recordExport({
        kind: options.kind,
        label,
        format: 'csv',
        path: '',
        status: 'fail',
        error: (e as Error).message,
        params: options,
      })
      throw e
    }
  }

  /**
   * 读取导出历史（供「导出记录」弹窗）。
   * @param options - 搜索 / 种类筛选 / 状态筛选 / 时间范围 / 排序 / 分页。
   * @returns 一页条目 + 命中总数 + 各聚合计数。
   */
  @Remote('getExportHistory')
  getExportHistory(options?: ExportHistoryQuery): ExportHistorySnapshot {
    return listExportHistory(this._dirs.decrypted, options ?? {})
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
    const ids = Array.isArray(options?.ids) ? options.ids : []
    const r = deleteExportHistory(this._dirs.decrypted, ids, options?.deleteFiles === true)
    this.op('delete', 'delete_export_history', r.removed > 0 ? 'ok' : 'skip', String(r.removed),
      `${r.removed} 条记录${options?.deleteFiles ? `，${r.filesDeleted} 个文件` : ''}`)
    return r
  }

  /**
   * 按策略清理导出历史（按天数 / 保留最近 N 条 / 只清失效记录）。
   * @param options - 清理策略；三项都缺省时**什么都不删**（安全闸）。
   * @returns 删除计数与文件删除失败清单。
   */
  @Remote('pruneExportHistory')
  pruneExportHistory(options?: ExportHistoryPruneOptions): ExportHistoryDeleteResult {
    const r = pruneExportHistory(this._dirs.decrypted, options ?? {})
    this.op('delete', 'prune_export_history', r.removed > 0 ? 'ok' : 'skip', String(r.removed),
      `${r.removed} 条记录${options?.deleteFiles ? `，${r.filesDeleted} 个文件` : ''}`)
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
    return listTasks(this._dirs.decrypted)
  }

  /**
   * Save (insert/update) a daily-summary task.
   * @param options - task payload (id present = update, absent = insert).
   * @returns SummaryTaskMutationResult: ok + id, or error.
   */
  @Remote('saveSummaryTask')
  saveSummaryTask(options: { task: Omit<SummaryTask, 'id' | 'createdAt' | 'updatedAt'> & { id?: number } }): SummaryTaskMutationResult {
    const r = saveTask(this._dirs.decrypted, options.task)
    this.op('task', 'save_summary_task', r.ok ? 'ok' : 'fail', options.task.groupUsername, r.error ?? `id=${r.id ?? ''}`)
    return r
  }

  /**
   * Delete a daily-summary task.
   * @param options - id of the task to delete.
   * @returns SummaryTaskMutationResult: ok, or error on failure.
   */
  @Remote('deleteSummaryTask')
  deleteSummaryTask(options: { id: number }): SummaryTaskMutationResult {
    const r = delTask(this._dirs.decrypted, options.id)
    this.op('delete', 'delete_summary_task', r.ok ? 'ok' : 'fail', `id=${options.id}`, r.error ?? '')
    return r
  }

  /**
   * Toggle a daily-summary task enabled state.
   * @param options - task id and the new enabled flag.
   * @returns SummaryTaskMutationResult: ok, or error on failure.
   */
  @Remote('toggleSummaryTask')
  toggleSummaryTask(options: { id: number; enabled: boolean }): SummaryTaskMutationResult {
    const r = toggleTask(this._dirs.decrypted, options.id, options.enabled)
    this.op('task', 'toggle_summary_task', r.ok ? 'ok' : 'fail', `id=${options.id}`, r.error ?? (options.enabled ? '启用' : '停用'))
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
    const tasks = listTasks(this._dirs.decrypted).items
    const task = tasks.find(t => t.id === options.id)
    if (!task) return { ok: false, error: '任务不存在' }
    const prev = new Date()
    prev.setDate(prev.getDate() - 1)
    const date = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}-${String(prev.getDate()).padStart(2, '0')}`
    const { lines, count } = collectDayMessages(this._dirs.decrypted, date, 50, task.groupUsername)
    const ctx = this._ctx
    const llm = ctx.llm
    const defaultModel = (ctx as unknown as {
      agentDefaultModel?: { currentSelection(): { provider: string; model: string; reasoningEffort?: string } }
    }).agentDefaultModel
    const sel = defaultModel?.currentSelection()
    let summary = ''
    let status = 'done'
    let errMsg = ''
    // 拦截优先于「模型不可用」：否则用户开了「禁止 AI 出网」却只看到「LLM/模型不可用」
    const blockedTask = this.privacyBlocked('summary_task')
    if (blockedTask !== null) {
      status = 'error'
      errMsg = blockedTask
    } else if (!sel || !sel.provider || !sel.model) {
      status = 'error'
      errMsg = 'LLM/模型不可用'
    } else {
      // build the prompt from the task's format (mirror daily_summary.rs summary_formats)
      const targets = task.targetUsers.length > 0 ? task.targetUsers.join('、') : '全部成员'
      const formats: Record<string, string> = {
        brief: '请用简洁的中文概括当天聊天记录的重点，3-5 句话以内，不要分点。',
        detailed: '请对当天聊天记录做详细总结：按主题分点（Markdown 列表），包含关键事件、讨论的话题、达成的共识与结论；只依据记录内容，不编造。',
        bullets: '请用 Markdown 无序列表提炼当天聊天记录的核心要点，每条一句话，控制在 10 条以内。',
        story: '请以第三人称、叙事的方式回顾当天聊天记录：谁和谁聊了什么、发生了什么、有什么进展或插曲，读起来像一篇日记。',
        custom: (task.customPrompt || '').replace(/\{date\}/g, date).replace(/\{group\}/g, task.groupName || task.groupUsername).replace(/\{targets\}/g, targets),
      }
      const fmtPrompt = formats[task.format || 'brief'] || formats['brief'] || ''
      const prompt = '群聊【' + task.groupName + '】(' + task.groupUsername + ') ' + date + ' 的聊天记录如下：\n\n' + lines.join('\n') + '\n\n' + fmtPrompt
      const gate = this.privacyGate('summary_task', { sessions: 1, messages: count }, [prompt])
      if (!gate.ok) {
        // 群总结任务不抛错：状态写进任务运行状态与记录里，界面能看到「被隐私设置拦下」
        status = 'error'
        errMsg = gate.error
      } else {
        const userMsg = createUserMessage({ content: [{ type: 'text', text: gate.texts[0] ?? prompt }], source: { kind: 'plugin', plugin: 'dsh-wechat-data' } })
        const assembler = new BlockAssembler()
        const opts: GenerateOptions = { provider: sel.provider, model: sel.model, messages: [userMsg], system: '你是微信每日总结助手，按要求的格式输出总结。', maxTokens: 1024 }
        try {
          for await (const chunk of llm.stream(opts)) assembler.push(chunk)
          summary = assembler.blocks().map(b => (b.type === 'text' ? b.text : '')).join('').trim()
        } catch (e) {
          status = 'error'
          errMsg = (e as Error).message
        }
      }
    }
    const rec: SummaryRecord = {
      id: 0,
      taskId: task.id,
      groupUsername: task.groupUsername,
      summaryDate: date,
      summary,
      messageCount: count,
      status,
      error: errMsg,
      createdAt: Date.now(),
    }
    saveRec(this._dirs.decrypted, rec)
    // update task last run state
    updateSummaryTaskRunState(this._dirs.decrypted, task.id, Date.now(), status, errMsg)
    const done = status === 'done'
    this.op('task', 'run_summary_task', done ? 'ok' : 'fail', task.groupUsername, errMsg || `共 ${count} 条消息`)
    return done ? { ok: true, summary, messageCount: count } : { ok: false, error: errMsg || '生成失败' }
  }

  /**
   * Resolve a user avatar (head_image.db data or contact URL).
   * @param options - username to resolve the avatar for.
   * @returns AvatarResult: avatar data URL or fallback info.
   */
  @Remote('getAvatar')
  getAvatar(options: { username: string; nickname?: string }): AvatarResult {
    return resolveAvatar(this._dirs.decrypted, options.username, rawWechatBase(this._dirs.decrypted) || undefined, options.nickname)
  }

  /**
   * 批量读取头像(head_image.db 优先,未命中再用 contact 表 URL 兜底;一次 RPC)。
   * @param options - usernames 列表。
   * @returns username → data URL(本地)或 https URL(远端兜底)映射;未命中的不在其中。
   */
  @Remote('getAvatarsLocal')
  getAvatarsLocal(options: { usernames: string[] }): Record<string, string> {
    return resolveAvatarsLocal(this._dirs.decrypted, options.usernames, {
      wechatBaseDir: rawWechatBase(this._dirs.decrypted) || undefined,
      allowRemote: !this.outboundBlocked(),
    })
  }

  /**
   * Read the full WeChat config (incl. keys + resolved paths).
   * @returns WechatConfigFull: complete config with resolved paths.
   */
  @Remote('getWechatConfigFull')
  getWechatConfigFull(): WechatConfigFull {
    const cfg = getConfig(this._dirs.decrypted)
    const resolved = (cfg['resolved'] as Record<string, string> | undefined) ?? {}
    return {
      db_dir: cellStr(cfg['db_dir'] ?? ''),
      wechat_process: cellStr(cfg['wechat_process'] ?? 'Weixin.exe'),
      key_format: cellStr(cfg['key_format'] ?? 'wx_key_v4.1'),
      db_enc_key: cellStr(cfg['db_enc_key'] ?? ''),
      image_aes_key: cellStr(cfg['image_aes_key'] ?? ''),
      image_xor_key: Number(cfg['image_xor_key'] ?? 136),
      api_enabled: Boolean(cfg['api_enabled'] ?? true),
      api_port: Number(cfg['api_port'] ?? 5032),
      api_token: cellStr(cfg['api_token'] ?? ''),
      cdn_enabled: Boolean(cfg['cdn_enabled'] ?? true),
      cdn_local_decrypt: Boolean(cfg['cdn_local_decrypt'] ?? true),
      whisper_device: cfg['whisper_device'] === 'gpu' ? 'gpu' : 'cpu',
      whisper_model: cellStr(cfg['whisper_model'] ?? 'medium'),
      whisper_threads: Number(cfg['whisper_threads'] ?? 0),
      whisper_models_dir: cellStr(cfg['whisper_models_dir'] ?? ''),
      whisper_bin: cellStr(cfg['whisper_bin'] ?? ''),
      resolved,
    }
  }

  /**
   * Save the WeChat config (merge patch).
   * @param options - patch of config fields to merge.
   * @returns SimpleResult: ok, or error on failure.
   */
  @Remote('saveWechatConfig')
  saveWechatConfig(options: { patch: WechatConfigPatch }): SimpleResult {
    const before = getConfig(this._dirs.decrypted)
    // Models/engine may live in the default dir even when none was persisted.
    const oldDirRaw = resolveWhisperModelsDir(before['whisper_models_dir'] as string | undefined, this._dirs.decrypted)
    const oldBin = typeof before['whisper_bin'] === 'string' ? before['whisper_bin'] : ''
    // Resolved before the switch: engines found by search (e.g. Release/ layout)
    // also need to move to the new dir, even when whisper_bin was never persisted.
    const oldEngine = whisperEnginePath(oldBin, oldDirRaw)
    const res = saveConfig(this._dirs.decrypted, options.patch as unknown as Record<string, unknown>)
    if (res.ok && typeof options.patch.whisper_models_dir === 'string') {
      const newDir = (options.patch.whisper_models_dir ?? '').trim()
      if (newDir && newDir.toLowerCase() !== oldDirRaw.toLowerCase()) {
        // Move previously downloaded models + engine install into the new dir.
        migrateWhisperModels(oldDirRaw, newDir)
        const after = getConfig(this._dirs.decrypted)
        const bin = typeof after['whisper_bin'] === 'string' ? after['whisper_bin'] : ''
        const relocated = migrateWhisperEngineDir(bin || oldEngine, oldDirRaw, newDir)
        if (relocated && relocated !== (bin || oldEngine)) saveConfig(this._dirs.decrypted, { whisper_bin: relocated })
      }
    }
    this.op('settings', 'save_wechat_config', res.ok ? 'ok' : 'fail', '', res.error ?? '配置已保存')
    return res
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
    const r = generateKeysFile(options.dbDir, options.keysFile, options.encKeyHex, options.keyFormat)
    this.op('keys', 'generate_keys_file', r.ok ? 'ok' : 'fail', options.keysFile, r.error ?? `通过 ${r.verified}/${r.total}`)
    return r
  }

  /**
   * Read all_keys.json info.
   * @returns KeysInfoResult: key format/count/loaded state.
   */
  @Remote('getWechatKeysInfo')
  getWechatKeysInfo(): KeysInfoResult {
    return getKeysInfo(this._dirs.decrypted)
  }

  /**
   * Auto-recover the V4 database key from the running WeChat process
   * (key_v4 memory scan + Weixin.dll internal-key unmask).
   * @param options - optional probe db path and install dir.
   * @returns AutoDbKeyResult: ok + 64-hex key, or an error.
   */
  @Remote('autoGetDbKey')
  async autoGetDbKey(options: { dbPath?: string; wechatInstallDir?: string }): Promise<AutoDbKeyResult> {
    const r = await fetchDbKey(options)
    this.op('keys', 'auto_get_db_key', r.ok ? 'ok' : 'fail', options.dbPath ?? '', r.error ?? (r.source ?? ''))
    return r
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
    const accountDir = normalizeAccountDir(options.accountDir ?? '')
    if (accountDir && existsSync(accountDir)) {
      const cfg = getConfig(this._dirs.decrypted)
      const savedAes = typeof cfg['image_aes_key'] === 'string' ? cfg['image_aes_key'].trim() : ''
      if (savedAes) {
        const scan = scanV2Templates(accountDir)
        if (scan.templates.length > 0) {
          const xor = trustedXorForVerifiedAesKey(savedAes, scan)
          if (xor !== null) {
            const result: AutoImageKeyResult = { ok: true, aesKey: savedAes, xorKey: xor, verified: true }
            const template = scan.templates[0]
            if (template) result.templatePath = template.path
            this.op('keys', 'auto_get_image_key', 'ok', accountDir, '使用已保存并验证的图片密钥')
            return result
          }
        }
      }
    }
    const fetchOpts: { accountDir?: string; pid?: number } = { accountDir }
    if (options.pid !== undefined) fetchOpts.pid = options.pid
    const r = await fetchImageKey(fetchOpts)
    this.op('keys', 'auto_get_image_key', r.ok ? 'ok' : 'fail', accountDir, r.error ?? (r.verified ? '内存扫描成功' : ''))
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
   * 保留理由：与「数据配置」面板现有那条路径等价 —— 界面用 `getWechatPathConfig()` 拿到路径后
   *   再 `openPath()` 打开（Settings.tsx）。这里保留一份「直接打开 config.json」的接口给宿主调用。
   */
  @Remote('openConfig')
  async openConfig(signal: AbortSignal): Promise<{ ok: boolean; path: string }> {
    const p = join(this._dirs.decrypted, '..', 'config.json')
    try {
      await openNativePath(p, signal)
      return { ok: true, path: p }
    } catch {
      return { ok: false, path: p }
    }
  }

  @Remote('verifyImageKey')
  verifyImageKey(): VerifyImageKeyResult {
    const cfg = getConfig(this._dirs.decrypted)
    const aesKey = typeof cfg['image_aes_key'] === 'string' ? cfg['image_aes_key'].trim() : ''
    if (!aesKey) { this.op('keys', 'verify_image_key', 'fail', '', '尚未配置图片 AES 密钥'); return { verified: false, error: '尚未配置图片 AES 密钥' } }
    const rawRoot = rawWechatBase(this._dirs.decrypted)
    if (!rawRoot) { this.op('keys', 'verify_image_key', 'fail', '', '未配置数据库目录，无法定位账号数据'); return { verified: false, error: '未配置数据库目录，无法定位账号数据' } }
    const scan = scanV2Templates(rawRoot)
    if (scan.templates.length === 0) { this.op('keys', 'verify_image_key', 'fail', '', '未找到 V2 图片模板（_t.dat）'); return { verified: false, error: '未找到 V2 图片模板（_t.dat）' } }
    const xor = trustedXorForVerifiedAesKey(aesKey, scan)
    const result: VerifyImageKeyResult = {
      verified: xor !== null,
      aesKey,
      xorKey: xor ?? Number(cfg['image_xor_key'] ?? 0),
    }
    const template = scan.templates[0]
    if (template) result.templatePath = template.path
    this.op('keys', 'verify_image_key', result.verified ? 'ok' : 'fail', '', result.error ?? (result.verified ? '已通过' : '验证失败'))
    return result
  }

  /**
   * Full SQLCipher decryption: every .db under db_storage is re-decrypted
   * into the decrypted snapshot (逐库原子发布,单库失败不中断)。实时进度
   * 通过 getDecryptStatus 轮询读取。
   * @returns DecryptAllResult: total/ok/failed counts.
   */
  @Remote('decryptAllDatabases')
  async decryptAllDatabases(): Promise<DecryptAllResult> {
    if (this.decryptState.active) { this.op('sync', 'decrypt_databases', 'fail', '', '已有解密任务进行中'); return { ok: false, total: 0, okCount: 0, failed: [], error: '已有解密任务进行中' } }
    const cfg = getConfig(this._dirs.decrypted)
    const rawDbDir = typeof cfg['db_dir'] === 'string' ? cfg['db_dir'] : ''
    this.decryptState.op = 'databases'
    this.decryptState.active = true
    this.decryptState.done = 0
    this.decryptState.total = 0
    this.decryptState.failed = 0
    this.decryptState.skipped = 0
    this.decryptState.message = ''
    try {
      const r = await decryptAllDbs(rawDbDir, this._dirs.decrypted, (done, total, failed, message) => {
        this.decryptState.done = done
        this.decryptState.total = total
        this.decryptState.failed = failed
        this.decryptState.message = message
      })
      // 全部解密库被原子替换：进程内元数据/统计缓存必须整体失效。
      invalidateWechatMeta()
      this.op('sync', 'decrypt_databases', r.ok ? 'ok' : 'fail', '', r.error ?? `成功 ${r.okCount}/${r.total}${r.failed.length > 0 ? `，失败 ${r.failed.length}` : ''}`)
      return r
    } finally {
      this.decryptState.active = false
      this.decryptState.message = ''
    }
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
    if (this.decryptState.active) { this.op('sync', 'decrypt_images', 'fail', '', '已有解密任务进行中'); return { ok: false, total: 0, okCount: 0, failed: 0, skipped: 0, errors: [], error: '已有解密任务进行中' } }
    const cfg = getConfig(this._dirs.decrypted)
    const aesKey = typeof cfg['image_aes_key'] === 'string' ? cfg['image_aes_key'] : undefined
    const xorKey = Number(cfg['image_xor_key'] ?? 0xff)
    const rawRoot = rawWechatBase(this._dirs.decrypted)
    if (!rawRoot) { this.op('sync', 'decrypt_images', 'fail', '', '未配置数据库目录，无法定位图片数据'); return { ok: false, total: 0, okCount: 0, failed: 0, skipped: 0, errors: [], error: '未配置数据库目录，无法定位图片数据' } }
    const concurrency = Math.floor(options.concurrency ?? 8) || 8
    this.decryptState.op = 'images'
    this.decryptState.active = true
    this.decryptState.done = 0
    this.decryptState.total = 0
    this.decryptState.failed = 0
    this.decryptState.skipped = 0
    this.decryptState.message = ''
    try {
      const result = await decryptAllImageDats(rawRoot, this._dirs.decoded, aesKey, xorKey, concurrency,
        (processed, total, failed, message) => {
          this.decryptState.done = processed
          this.decryptState.total = total
          this.decryptState.failed = failed
          this.decryptState.message = message
        })
      this.decryptState.skipped = result.skipped
      this.op('sync', 'decrypt_images', result.failed === 0 ? 'ok' : 'fail', '', `成功 ${result.okCount}/${result.total}${result.failed > 0 ? `，失败 ${result.failed}` : ''}`)
      return { ok: true, ...result }
    } finally {
      this.decryptState.active = false
      this.decryptState.message = ''
    }
  }

  /**
   * Live decryption progress snapshot (polled by the settings panel).
   * @returns DecryptStatus: op/done/total/failed/skipped + current item.
   */
  @Remote('getDecryptStatus')
  getDecryptStatus(): DecryptStatus {
    return {
      op: this.decryptState.op,
      active: this.decryptState.active,
      done: this.decryptState.done,
      total: this.decryptState.total,
      failed: this.decryptState.failed,
      skipped: this.decryptState.skipped,
      message: this.decryptState.message,
    }
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
    return getDbStatus(this._dirs.decrypted)
  }

  /**
   * Decode one message image to a base64 data URL.
   * @param options - username and localId of the message image.
   * @returns ImageDataUrlResult: base64 data URL or error.
   */
  @Remote('getImageDataUrl')
  getImageDataUrl(options: { username: string; localId: number }): ImageDataUrlResult {
    const base = rawWechatBase(this._dirs.decrypted) || undefined
    const cfg = getConfig(this._dirs.decrypted)
    const aesKey = typeof cfg['image_aes_key'] === 'string' && cfg['image_aes_key'].length > 0 ? cfg['image_aes_key'] : undefined
    const xorKey = Number(cfg['image_xor_key'] ?? 0xff)
    return decodeImageDataUrl(this._dirs.decrypted, this._dirs.decoded, options.username, options.localId, base, aesKey, xorKey)
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
    const decrypted = this._dirs.decrypted
    const decoded = this._dirs.decoded
    const base = rawWechatBase(decrypted) || undefined
    const cfg = getConfig(decrypted)
    const aesKey = typeof cfg['image_aes_key'] === 'string' && cfg['image_aes_key'].length > 0 ? cfg['image_aes_key'] : undefined
    const xorKey = Number(cfg['image_xor_key'] ?? 0xff)
    const items = (Array.isArray(options?.items) ? options.items : []).slice(0, IMAGE_BATCH_MAX)
    if (base) this.warmDecodedImages(decrypted, decoded, base, items, aesKey, xorKey)
    return {
      items: items.map((it) => ({
        username: it.username,
        localId: it.localId,
        ...decodeImageDataUrl(decrypted, decoded, it.username, it.localId, base, aesKey, xorKey),
      })),
    }
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
    const base = rawWechatBase(this._dirs.decrypted) || undefined
    const cfg = getConfig(this._dirs.decrypted)
    const aesKey = typeof cfg['image_aes_key'] === 'string' && cfg['image_aes_key'].length > 0 ? cfg['image_aes_key'] : undefined
    const xorKey = Number(cfg['image_xor_key'] ?? 0xff)
    return resolveSnsImageDataUrl(base, aesKey, xorKey, options.md5, options.timelineId, options.mediaId)
  }

  /**
   * Resolve a file-library image (hardlink md5) to an offline base64 data URL.
   * 优先读已解密缓存，否则通过 hardlink.db 定位 .dat 原图解密。
   * @param options - file md5.
   * @returns ImageDataUrlResult: base64 data URL or error.
   */
  @Remote('getFileImageDataUrl')
  getFileImageDataUrl(options: { md5: string }): ImageDataUrlResult {
    const base = rawWechatBase(this._dirs.decrypted) || undefined
    const cfg = getConfig(this._dirs.decrypted)
    const aesKey = typeof cfg['image_aes_key'] === 'string' && cfg['image_aes_key'].length > 0 ? cfg['image_aes_key'] : undefined
    const xorKey = Number(cfg['image_xor_key'] ?? 0xff)
    return decodeFileImageDataUrl(this._dirs.decrypted, this._dirs.decoded, base, options.md5, aesKey, xorKey)
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
    const base = rawWechatBase(this._dirs.decrypted) || undefined
    const cfg = getConfig(this._dirs.decrypted)
    const aesKey = typeof cfg['image_aes_key'] === 'string' && cfg['image_aes_key'].length > 0 ? cfg['image_aes_key'] : undefined
    const xorKey = Number(cfg['image_xor_key'] ?? 0xff)
    const local = decodeEmoticonDataUrl(this._dirs.decrypted, this._dirs.decoded, base, options.md5, aesKey, xorKey)
    if (local.url) return local
    if (!options.emojiUrl) return local
    const remote = await fetchEmoticonRemote(options.emojiUrl, this._dirs.decoded, options.md5.toLowerCase(), this.cdnSwitches())
    // 远端也失败时把两条原因都带上，便于区分「没走远端」与「远端失败」
    return remote.url ? remote : { error: (local.error ?? '本地解码失败') + '；' + (remote.error ?? '远端取图失败') }
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
    // size/createTime 来自消息本体（appmsg `<totallen>` 与 create_time），
    // 用于在「同名文件」里挑出属于这条消息的那一份，见 resolveMessageFileDataUrl。
    return resolveMessageFileDataUrl(rawWechatBase(this._dirs.decrypted) || undefined, options.fileName, {
      ...(options.size !== undefined ? { size: options.size } : {}),
      ...(options.createTime !== undefined ? { createTime: options.createTime } : {}),
    })
  }
  /**
   * Add a WeChat task.
   * @param options - title + optional dueAt.
   * @returns TaskMutationResult.
   */
  @Remote('addTask')
  addTask(options: { title: string; dueAt?: number }): TaskMutationResult {
    const r = insertTask(this._dirs.decrypted, options)
    this.op('task', 'add_task', r.ok ? 'ok' : 'fail', options.title, r.error ?? '')
    return r
  }

  @Remote('clearOperationLog')
  clearOperationLog(): OperationLogClearResult {
    const r = clearOperationLog(this._dirs.decrypted)
    this.op('delete', 'clear_operation_log', r.ok ? 'ok' : 'fail', '', r.ok ? `已清除 ${r.removed} 条` : '清除失败')
    return r
  }

  @Remote('clearPrivacyAudit')
  clearPrivacyAudit(): PrivacyAuditClearResult {
    const r = clearPrivacyAudit(this._dirs.decrypted)
    this.op('delete', 'clear_privacy_audit', r.ok ? 'ok' : 'fail', '', r.ok ? `已清除 ${r.removed} 条` : '清除失败')
    return r
  }

  @Remote('createEncryptedBackup')
  async createEncryptedBackup(options: { password: string; jobId?: string }): Promise<BackupMutationResult> {
    const jobId = normalizeJobId(options?.jobId)
    try {
      // M3：加密备份同样支持进度/取消（同一套 jobId → 本地 onProgress + AbortController）。
      const entry = await createEncryptedBackup(this._dirs.decrypted, options.password, this.streamControl(jobId))
      this.finishStreamJob(jobId)
      this.op('backup', 'create_encrypted_backup', 'ok', entry.name)
      return { ok: true, name: entry.name }
    } catch (e) {
      this.finishStreamJob(jobId, (e as Error).message)
      this.op('backup', 'create_encrypted_backup', 'fail', '', (e as Error).message)
      // 注意：这里**不能**把失败吞掉 —— `createBackup` 现在对「部分子目录复制失败」直接抛错
      // （不再是「静默报成功」），所以本 catch 是那条错误的唯一出口，转成可读的 { ok:false }。
      return { ok: false, error: (e as Error).message }
    }
  }

  @Remote('deleteTask')
  deleteTask(options: { id: number }): TaskMutationResult {
    const r = deleteTask(this._dirs.decrypted, options.id)
    this.op('delete', 'delete_task', r.ok ? 'ok' : 'fail', `id=${options.id}`, r.error ?? '')
    return r
  }

  @Remote('extractTasks')
  extractTasks(options?: { days?: number }): TaskMutationResult {
    const days = options?.days ?? 7
    const to = new Date()
    const from = new Date(to.getTime() - days * 86400000)
    const { lines } = collectPeriodMessages(this._dirs.decrypted, from.toISOString().slice(0, 10), to.toISOString().slice(0, 10), 50)
    const re = /(记得|待办|要做|提醒|别忘了|稍后|待处理|deadline)/i
    let added = 0
    for (const line of lines) {
      if (re.test(line)) {
        const title = line.trim().slice(0, 60) || '待办'
        const r = insertTask(this._dirs.decrypted, { title })
        if (r.ok) added += 1
      }
    }
    this.op('task', 'extract_tasks', 'ok', '', `新增 ${added} 条待办`)
    return { ok: true, added }
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
    return queryDbHealth(this._dirs.decrypted)
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
    return listHandoffReminds(this._dirs.decrypted)
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
    return listOperations(this._dirs.decrypted, options)
  }

  @Remote('getPrivacyAuditRows')
  getPrivacyAuditRows(): PrivacyAuditRow[] {
    return listPrivacyAudit(this._dirs.decrypted)
  }

  @Remote('getPrivacyState')
  getPrivacyState(): PrivacyStateSnapshot {
    return getPrivacyStateSnapshot(this._dirs.decrypted)
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
    const base = rawWechatBase(this._dirs.decrypted) || undefined
    const local = resolveSnsVideoCoverDataUrl(base, options.md5, options.timelineId, options.mediaId)
    if (local.url) return local
    const remote = typeof options.thumb === 'string' ? options.thumb.trim() : ''
    if (!remote || !/^https?:\/\//i.test(remote)) return local
    const blocked = this.privacyBlocked('sns_cover_fetch', '从微信 CDN 取回封面')
    if (blocked) return { error: `${local.error}；${blocked}` }
    const fetched = await fetchSnsCoverDataUrl(remote, { version: weixinVersion(), seed: options.key, ...this.cdnSwitches() })
    if (fetched.url) return fetched
    this.op('task', 'sns_cover_fetch', 'fail', '', fetched.error ?? '')
    return { error: fetched.error }
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
    const base = rawWechatBase(this._dirs.decrypted) || undefined
    const local = resolveSnsVideoDataUrl(base, options.md5, options.timelineId, options.mediaId)
    if (local.url) return local
    const remote = typeof options.url === 'string' ? options.url.trim() : ''
    if (!remote || !/^https?:\/\//i.test(remote)) return local
    const blocked = this.privacyBlocked('sns_video_fetch', '从微信 CDN 取回视频')
    if (blocked) return { error: `${local.error}；${blocked}` }
    const fetched = await fetchSnsVideoDataUrl(remote, options.md5, { version: weixinVersion(), seed: options.key, ...this.cdnSwitches() })
    if (fetched.url) {
      this.op('task', 'sns_video_fetch', 'ok', '', `从 CDN 取回并解密朋友圈视频（${options.md5?.slice(0, 8) ?? '?'}…）`)
      return fetched
    }
    this.op('task', 'sns_video_fetch', 'fail', '', fetched.error ?? '')
    return { error: fetched.error }
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
    const dest = typeof options.dest === 'string' ? options.dest.trim() : ''
    if (!dest) return { ok: false, error: '未指定保存路径' }
    const loaded = await loadSnsVideoBytes({
      base: rawWechatBase(this._dirs.decrypted) || undefined,
      md5: options.md5,
      timelineId: options.timelineId,
      mediaId: options.mediaId,
      url: options.url,
      seed: options.key,
      version: weixinVersion(),
      ...this.cdnSwitches(),
    })
    if (loaded.error || !loaded.bytes) {
      this.op('task', 'export_sns_video', 'fail', options.md5?.slice(0, 8) ?? '', loaded.error ?? '')
      return { ok: false, error: loaded.error ?? '取不到视频字节' }
    }
    try {
      writeFileSync(dest, loaded.bytes)
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e)
      this.op('task', 'export_sns_video', 'fail', options.md5?.slice(0, 8) ?? '', msg)
      return { ok: false, error: `写入失败：${msg}` }
    }
    this.op('task', 'export_sns_video', 'ok', options.md5?.slice(0, 8) ?? '', `${loaded.bytes.length} 字节 · ${loaded.source}`)
    return { ok: true, bytes: loaded.bytes.length, source: loaded.source }
  }

  @Remote('listTasks')
  listTasks(): TasksSnapshot {
    return listWechatTasks(this._dirs.decrypted)
  }

  @Remote('restoreBackup')
  restoreBackup(options: { name: string; password: string }): BackupRestoreResult {
    const r = restoreEncryptedBackup(this._dirs.decrypted, options.name, options.password)
    this.op('backup', 'restore_backup', r.ok ? 'ok' : 'fail', options.name, r.path ?? r.error ?? '')
    return r
  }

  @Remote('searchUnified')
  searchUnified(options: { query: string; limit?: number }): UnifiedSearchSnapshot {
    return searchUnified(this._dirs.decrypted, options.query, options.limit)
  }

  @Remote('setPrivacyState')
  setPrivacyState(options: { redactSensitive?: boolean; blockOutbound?: boolean }): PrivacyStateSnapshot {
    try {
      writePrivacySettings(this._dirs.decrypted, options)
      const snapshot = getPrivacyStateSnapshot(this._dirs.decrypted)
      this.op('settings', 'set_privacy_state', 'ok', '', `脱敏=${options.redactSensitive ?? '不变'}，出站拦截=${options.blockOutbound ?? '不变'}`)
      return snapshot
    } catch (e) {
      this.op('settings', 'set_privacy_state', 'fail', '', (e as Error).message)
      throw e
    }
  }

  @Remote('setTaskStatus')
  setTaskStatus(options: { id: number; status: 'open' | 'done' }): TaskMutationResult {
    const r = setTaskStatus(this._dirs.decrypted, options.id, options.status)
    this.op('task', 'set_task_status', r.ok ? 'ok' : 'fail', `id=${options.id}`, r.error ?? options.status)
    return r
  }

  @Remote('syncHandoffTasks')
  syncHandoffTasks(): TaskMutationResult {
    const r = importHandoffTasks(this._dirs.decrypted)
    this.op('task', 'sync_handoff_tasks', r.ok ? 'ok' : 'fail', '', r.error ?? `导入 ${r.added ?? 0} 条`)
    return r
  }

}

export default WechatDataGateway
