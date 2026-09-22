/**
 * GatewayCore —— `WechatDataGateway` 的「核」：运行时状态、构造与实时同步接线、跨域共享的
 * 私有辅助（隐私闸 / 操作日志 / 流控槽 / 模型选择…），以及 14 个域处理器的 ctx 装配。
 *
 * 为什么拆成继承链（M21 结构刀）：`gateway.ts` 里 161 个 `@Remote` 方法**必须留在同一个类**
 * ——协议层按「最派生原型的自有描述子」枚举方法面（见 `tests/remote-inheritance.spec.ts`），
 * 所以方法壳可以放在任何一层的基类里、而对外接口一字不变；把「核」先分出去，
 * 方法面才能继续按域往下拆。
 */

import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { bootstrapWechatData, resolveDecodedDir, resolveDecryptedDir } from './dirs.ts'
import type { Context } from '@deepseek-ai/cordis'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AccountsSnapshot, AnnualReport, AnnualSnapshot, AskHistoryClearResult, AskHistoryDeleteResult, AskHistoryQuery, AskHistorySnapshot, AskOptimizeResult, AskResult, AutoDbKeyResult, AutoImageKeyResult, AvatarResult, BackupMutationResult, BackupPreviewSnapshot, BackupSnapshot, CalendarSnapshot, CallsSnapshot, ChatHistoryResolveResult, ConfigSnapshot, ContactsSnapshot, DailySummaryResult, DbStatusSnapshot, DecryptAllResult, DecryptImagesResult, DecryptStatus, DeleteFavoriteResult, DraftClearResult, DraftsClearResult, EditMutationResult, EditedListSnapshot, EmoticonsSnapshot, ExportResult, ExportStatus, ExportHistoryDeleteResult, ExportHistoryQuery, ExportHistorySnapshot, ExportHistoryPruneOptions, FavoritesSnapshot, FilesSnapshot, GenerateKeysResult, GraphSnapshot, GroupInfoSnapshot, ImageDataUrlResult, KeysInfoResult, MemberSearchSnapshot, MessagesSnapshot, MomentsSnapshot, OverviewInsights, OverviewSnapshot, PaymentStatus, PrivacySnapshot, RecordsSnapshot, RevokedSnapshot, SearchBuildResult, SearchIndexStatus, SearchSnapshot, SessionsSnapshot, SimpleResult, StorageSnapshot, SummaryRecord, SummaryRecordSnapshot, SummaryTask, SummaryTaskMutationResult, SummaryTaskRunResult, SummaryTaskSnapshot, VerifyImageKeyResult, VerifyKeyResult, VideoInfoResult, VoiceDataUrlResult, VoiceInfoResult, VoiceTranscriptResult, VoiceTranscribeOneResult, VoiceTranscribeResult, WechatAccount, WechatConfigFull, WechatConfigPatch, WhisperDownloadProgress, WhisperDownloadResult, WhisperStatus, WhisperTranscribing, AssetInsightsSnapshot, BackupRestoreResult, Contact360Snapshot, DbHealthSnapshot, GroupInsightsSnapshot, HandoffRemindsSnapshot, LedgerSnapshot, MediaAssetsSnapshot, MomentsInsightsSnapshot, MomentsMonthlyRow, OfficialAssetsSnapshot, OperationCategory, OperationLogClearResult, OperationLogQuery, OperationLogSnapshot, OperationStatus, PeriodSummaryResult, PrivacyAuditClearResult, PrivacyAuditRow, PrivacyStateSnapshot, RegionMapSnapshot, TaskMutationResult, TasksSnapshot, UnifiedSearchSnapshot, KnowledgeSnapshot, NotesSnapshot, NoteMutationResult, KbDeleteAction, KbListSnapshot, KbMeta, KbMutationResult } from './types.ts'
import { resolveSelfUsername } from './query/config.ts'
import { startRealtimeSync } from './query/sync.ts'
import { createTasksRemotes } from './remotes/tasks.ts'
import { createOpsLogRemotes } from './remotes/opslog.ts'
import { createBackupRemotes } from './remotes/backup.ts'
import { createConfigRemotes } from './remotes/config.ts'
import { createSummaryRemotes } from './remotes/summary.ts'
import { createAskRemotes } from './remotes/ask.ts'
import { createKeysDecryptRemotes } from './remotes/keysdec.ts'
import { createGraphSearchRemotes } from './remotes/graphsearch.ts'
import { createSummaryRecordRemotes } from './remotes/summaryrec.ts'
import { createVoiceLlmRemotes } from './remotes/voicellm.ts'
import { createAskDeepRemotes } from './remotes/askdeep.ts'
import { createKbRemotes } from './remotes/kb.ts'
import { createMediaRemotes } from './remotes/media.ts'
import { createExportRemotes } from './remotes/export.ts'
import { buildSearchIndex, ensureSearchIndex, getSearchIndexStatus, knownEntityNames, searchIndexMessages, searchIndexMessagesCancellable } from './query/search.ts'
import { clearDecodedImageCache, decodeDatBytes, decodeEmoticonDataUrl, decodeFileImageDataUrl, decodeImageDataUrl, fetchEmoticonRemote, resolveImageFilePathsByMd5, resolveImageResourceHint } from './query/media-image.ts'
import type { StreamControl } from './query/zip.ts'
import { detectWechatAccounts, generateKeysFile, getConfig, getKeysInfo, saveConfig, verifyDatabaseKey, weixinInstallPath, weixinVersion } from './query/config.ts'
import { deleteExportHistory, listExportHistory, pruneExportHistory, recordExport } from './query/export-history.ts'
import { clearAskHistory, deleteAskHistory, listAskHistory, recordAsk } from './query/ask-history.ts'
import { loadRetrievalConfig, saveRetrievalConfig as saveRetrievalConfigFile, defaultRetrievalConfig } from './query/retrieval/config.ts'
import { buildVectorIndex, vectorIndexStatus, vectorIndexSummary, type EmbedFn } from './query/retrieval/embedding.ts'
import {
  kbModelOverrideCounts,
  kbModelsOnKbDelete,
  readKbModelSettings,
  resolveModelRef,
  touchKbEntitiesAt,
  writeKbModelSettings,
} from './query/kb/model-config.ts'
import type { KbModelRole, KbModelSettings, ResolvedModel } from './query/kb/model-config.ts'
import type { FeedbackRecord, IntentKind, RerankWeights } from './query/retrieval/types.ts'
import { clearOperationLog, listOperations, recordOperation } from './query/operation-log.ts'
import { clearPrivacyAudit, getPrivacyStateSnapshot, listPrivacyAudit, readPrivacySettings, recordPrivacyAudit, redactSensitiveText, writePrivacySettings } from './query/privacy-audit.ts'
import { deleteTask, insertTask, listTasks as listWechatTasks, setTaskStatus } from './query/wechat-tasks.ts'
import { bumpDataGeneration, boundedSet, invalidateWechatMeta } from './query/meta.ts'
import { countKbFilesByKb, deleteKbFile as deleteKbFileRow, getKbFile, kbFilesOnKbDelete, listKbFileChunks, listKbFiles, recoverInterrupted, registerKbFile, setKbFileRagFlag, setKbFileSummary } from './query/kb-files.ts'
import { drainKbQueue } from './query/kb-queue.ts'
import { deleteSummaryRecord as delRec, deleteSummaryTask as delTask, listSummaryRecords as listRecs, listSummaryTasks as listTasks, saveSummaryRecord as saveRec, saveSummaryTask as saveTask, toggleSummaryTask as toggleTask, updateSummaryTaskRunState } from './query/summary-tasks.ts'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { CACHED_IMAGE_EXTS, EXPORT_PROGRESS_EVENT, ResolvedDirs, STREAM_JOB_CAP, StreamJob, normalizeJobId, privacyStoreUnreadable, rawWechatBase, resolveDirs } from './gateway-support.ts'

/** 网关的「核」：状态、生命周期、共享私有辅助与 13 个域处理器的 ctx 装配（M21 自 gateway.ts 拆出）。 */
export abstract class GatewayCore extends TypertRemoteService {
  /** 由派生的方法面层实现（`@Remote` 入口）；这里的排程必须经实例派发 —— 见 `summary-run-due.spec.ts` 打的桩。 */
  abstract runSummaryTask(options: { id: number }): Promise<SummaryTaskRunResult>
  /** Services this gateway depends on at runtime (LLM + default model). */
  static inject = ['llm', 'agentDefaultModel']

  protected readonly _ctx: Context
  protected readonly _dirs: ResolvedDirs
  /**
   * 登录账号 wxid 的**带失效**缓存。
   *
   * 不能在构造函数里算一次就固定：`数据配置` 里切换微信账号只改 `db_dir`
   * （解密目录不变），本进程不会重启。缓存住旧 wxid 会让 `isSender` 拿
   * **上一个账号**的 wxid 去比对，于是新账号里每条消息的「我 / 对方」全部反转
   * —— 属于最严重的归属错误。这里按 (解密目录, config.db_dir) 记忆：
   * 账号一换键就变，自动重算。
   */
  protected _selfUsername = ''
  protected _selfUsernameKey = ''
  protected _schedBusy = false
  /**
   * 最近若干轮问答的检索特征画像（retrievalId → 特征/引用映射）。
   * 用户提交反馈时用它把「哪条引用有用」翻译成「哪个特征该加权」。
   * 有界（≤20 轮），不落盘 —— 纯进程内、只在反馈那一刻需要。
   */
  protected readonly _askTrace = new Map<string, {
    features: Map<string, RerankWeights>
    citations: string[]
    question: string
    answer: string
    intent: IntentKind
  }>()
  /** Live decrypt progress (polled by the settings panel). */
  protected readonly decryptState: DecryptStatus = {
    op: null, active: false, done: 0, total: 0, failed: 0, skipped: 0, message: '',
  }
  /** Active whisper model download (polled by the settings panel). */
  protected whisperDownload: WhisperDownloadProgress | null = null
  /** Active voice batch transcription (polled by the settings panel). */
  protected whisperTranscribing: WhisperTranscribing = { active: false, done: 0, total: 0, failed: 0, skipped: 0, current: '' }
  /** 导出/加密备份的控制槽：jobId → 取消令牌 + 最近一次进度（见 {@link StreamJob}）。 */
  protected readonly _streamJobs = new Map<string, StreamJob>()
  /**
   * 消息搜索的取消槽（N9）：jobId → 取消控制器。
   *
   * 与导出的槽分开：搜索没有进度可言，也不想占用 `wechat-export/progress` 那个事件名。
   * 槽位会在搜索收尾时删掉（见 {@link searchSignal}），所以这里不需要上限。
   */
  protected readonly _searchJobs = new Map<string, AbortController>()
  /**
   * 反馈去重窗口（N27）：键 → 到期时间。
   *
   * 为什么不是 `inflightXxx: Set` 那种「在飞合并」的闸：`submitAskFeedback` 是**同步** RPC，
   * 函数体在事件循环里一口气跑完，两个「并发」调用不会交错 ⇒ 在飞表恒为空，那是个假闸。
   * 真正的重复是「同一轮被提交两次」且两次都真跑完（多一条反馈记录 + 按重复特征重算权重 +
   * 两条审计），所以按内容键 + 时间窗去重（见 {@link ASK_FEEDBACK_DEDUPE_MS}）。
   */
  protected readonly _askFeedbackSeen = new Map<string, number>()
  /**
   * 按库向量索引的**在飞构建**进度（kbId → 进度），给面板的「语义索引」按钮轮询。
   *
   * 为什么是进程内而不是落库：这是「此刻有没有在跑、跑到哪」的瞬时态，落库就要处理
   * 进程崩溃留下的假进行中（比不显示更糟）。真正的持久事实（多少块、哪个模型、何时建的）
   * 在向量库自己的 meta 与行里，见 `kbVectorIndexStatus`。
   */
  protected readonly _kbIndexJobs = new Map<number, { done: number; total: number; startedAt: number; error: string }>()
  /**
   * 已知实体名缓存（问答的「点名识别」用）：按解密目录记忆。
   *
   * 为什么缓存：这份名单要读联系人表 + 会话表（两次 SQLite 打开），而每次提问都要用；
   * 名单在会话存续期内变化极小，记一次就够。换数据目录（换账号）时按 key 自然失效。
   */
  protected readonly _knownEntities = new Map<string, string[]>()

  /**
   * 当前登录账号的 wxid（消息 `isSender` 判定的基准）。
   *
   * 按 (解密目录, config.db_dir) 记忆：只要账号没换就直接命中缓存，
   * 换了账号（`data 配置` 里选另一个账号的 db_storage）或换了数据目录则重算。
   * 每次取用时只多读一次 `getConfig`（带文件签名缓存的 JSON 读），代价可忽略。
   * @returns 登录账号 wxid；解析不到时为空串。
   */
  protected selfUsername(): string {
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
  protected streamControl(jobId?: string): StreamControl {
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
  protected finishStreamJob(jobId: string, error?: string): void {
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
  protected op(category: OperationCategory, action: string, status: OperationStatus, target = '', detail = ''): void {
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
  protected outboundBlocked(): boolean {
    try {
      return readPrivacySettings(this._dirs.decrypted).blockOutbound
    } catch {
      // 读不到就按「禁止出站」处理。这是权限判断，失败方向只能是**拦下**：
      // 用户开了「出站拦截」而库损坏/被锁的那一刻，静默放行是最糟的结果。
      // 与 `privacyBlocked` 的文案分支同一取向（那边会告诉用户为什么被拦）。
      return true
    }
  }

  protected privacyBlocked(feature: string, detail = '把数据发送给模型'): string | null {
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
  protected privacyGate(
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
  protected askKnownEntities(): string[] {
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
  protected makeEmbedFn(model: string, feature: 'ask_embed' | 'kb_embed' | 'kb_link_suggest' = 'ask_embed'): EmbedFn | undefined {
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
  protected embedModelName(override = ''): string {
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
  protected globalModelName(role: KbModelRole): string {
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
  protected kbModel(kbId: number, role: KbModelRole): ResolvedModel {
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
  protected makeChatAsker(kbId: number, feature: string): ((prompt: string) => Promise<string>) | undefined {
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
  protected makeRerankFn(kbId: number): ((query: string, documents: string[]) => Promise<number[]>) | undefined {
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
  protected cdnSwitches(): { cdnEnabled: boolean; localDecrypt: boolean } {
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

  protected _kbRemotes?: ReturnType<typeof createKbRemotes>

  /** KB 域的处理器（体在 remotes/kb.ts）；这里只组装 ctx 与转发。 */
  protected kbRemotes(): ReturnType<typeof createKbRemotes> {
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

  protected _mediaRemotes?: ReturnType<typeof createMediaRemotes>

  /** 媒体域的处理器（体在 remotes/media.ts）；这里只组装 ctx 与转发。 */
  protected mediaRemotes(): ReturnType<typeof createMediaRemotes> {
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

  protected _exportRemotes?: ReturnType<typeof createExportRemotes>

  /** 导出域的处理器（体在 remotes/export.ts）；这里只组装 ctx 与转发。 */
  protected exportRemotes(): ReturnType<typeof createExportRemotes> {
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

  protected _tasksRemotes?: ReturnType<typeof createTasksRemotes>

  /** 任务与笔记（待办 / 笔记 / 交接提醒） 的处理器（体在 remotes/tasks.ts）；这里只组装 ctx 与转发。 */
  protected tasksRemotes(): ReturnType<typeof createTasksRemotes> {
    return (this._tasksRemotes ??= createTasksRemotes({
      dirs: () => this._dirs,
      op: (category, action, status, target, detail) => this.op(category, action, status, target, detail),
    }))
  }

  protected _opsLogRemotes?: ReturnType<typeof createOpsLogRemotes>

  /** 操作日志与隐私审计（含隐私开关读数） 的处理器（体在 remotes/opslog.ts）；这里只组装 ctx 与转发。 */
  protected opsLogRemotes(): ReturnType<typeof createOpsLogRemotes> {
    return (this._opsLogRemotes ??= createOpsLogRemotes({
      dirs: () => this._dirs,
      op: (category, action, status, target, detail) => this.op(category, action, status, target, detail),
    }))
  }

  protected _backupRemotes?: ReturnType<typeof createBackupRemotes>

  /** 备份与恢复（含加密备份） 的处理器（体在 remotes/backup.ts）；这里只组装 ctx 与转发。 */
  protected backupRemotes(): ReturnType<typeof createBackupRemotes> {
    return (this._backupRemotes ??= createBackupRemotes({
      dirs: () => this._dirs,
      op: (category, action, status, target, detail) => this.op(category, action, status, target, detail),
      streamControl: (jobId) => this.streamControl(jobId),
      finishStreamJob: (jobId, error) => this.finishStreamJob(jobId, error),
      normalizeJobId: (jobId) => normalizeJobId(jobId),
    }))
  }

  protected _configRemotes?: ReturnType<typeof createConfigRemotes>

  /** 数据配置与密钥状态（含解密/数据库状态） 的处理器（体在 remotes/config.ts）；这里只组装 ctx 与转发。 */
  protected configRemotes(): ReturnType<typeof createConfigRemotes> {
    return (this._configRemotes ??= createConfigRemotes({
      dirs: () => this._dirs,
      op: (category, action, status, target, detail) => this.op(category, action, status, target, detail),
      decryptState: this.decryptState,
    }))
  }

  protected _summaryRemotes?: ReturnType<typeof createSummaryRemotes>

  /** 总结任务（每日/周期总结的排程与运行） 的处理器（体在 remotes/summary.ts）；这里只组装 ctx 与转发。 */
  protected summaryRemotes(): ReturnType<typeof createSummaryRemotes> {
    return (this._summaryRemotes ??= createSummaryRemotes({
      dirs: () => this._dirs,
      op: (category, action, status, target, detail) => this.op(category, action, status, target, detail),
      ctx: () => this._ctx,
      privacyBlocked: (feature, detail) => this.privacyBlocked(feature, detail),
      privacyGate: (feature, stats, texts) => this.privacyGate(feature, stats, texts),
    }))
  }

  protected _askRemotes?: ReturnType<typeof createAskRemotes>

  /** 问答反馈与检索配置（画像表 / 反馈表 / 配置） 的处理器（体在 remotes/ask.ts）；这里只组装 ctx 与转发。 */
  protected askRemotes(): ReturnType<typeof createAskRemotes> {
    return (this._askRemotes ??= createAskRemotes({
      dirs: () => this._dirs,
      op: (category, action, status, target, detail) => this.op(category, action, status, target, detail),
      askFeedbackSeen: this._askFeedbackSeen,
      askTrace: this._askTrace,
    }))
  }

  protected _keysDecryptRemotes?: ReturnType<typeof createKeysDecryptRemotes>

  /** 密钥获取与全库/全图解密（图片密钥自动获取、验证、解密状态） 的处理器（体在 remotes/keysdec.ts）；这里只组装 ctx 与转发。 */
  protected keysDecryptRemotes(): ReturnType<typeof createKeysDecryptRemotes> {
    return (this._keysDecryptRemotes ??= createKeysDecryptRemotes({
      dirs: () => this._dirs,
      op: (category, action, status, target, detail) => this.op(category, action, status, target, detail),
      decryptState: this.decryptState,
      rawWechatBase: (decrypted) => rawWechatBase(decrypted),
    }))
  }

  protected _graphSearchRemotes?: ReturnType<typeof createGraphSearchRemotes>

  /** 知识图谱、消息检索与索引（含编辑历史复位） 的处理器（体在 remotes/graphsearch.ts）；这里只组装 ctx 与转发。 */
  protected graphSearchRemotes(): ReturnType<typeof createGraphSearchRemotes> {
    return (this._graphSearchRemotes ??= createGraphSearchRemotes({
      dirs: () => this._dirs,
      op: (category, action, status, target, detail) => this.op(category, action, status, target, detail),
      searchJobs: this._searchJobs,
      searchSignal: (jobId) => this.searchSignal(jobId),
    }))
  }

  protected _summaryRecordRemotes?: ReturnType<typeof createSummaryRecordRemotes>

  /** 总结记录（每日/周期总结生成、记录删除、推荐回复） 的处理器（体在 remotes/summaryrec.ts）；这里只组装 ctx 与转发。 */
  protected summaryRecordRemotes(): ReturnType<typeof createSummaryRecordRemotes> {
    return (this._summaryRecordRemotes ??= createSummaryRecordRemotes({
      dirs: () => this._dirs,
      op: (category, action, status, target, detail) => this.op(category, action, status, target, detail),
      ctx: () => this._ctx,
      privacyBlocked: (feature, detail) => this.privacyBlocked(feature, detail),
      privacyGate: (feature, stats, texts) => this.privacyGate(feature, stats, texts),
      runSummaryTask: (options) => this.runSummaryTask(options),
      selfUsername: () => this.selfUsername(),
      getSchedBusy: () => this._schedBusy,
      setSchedBusy: (v) => { this._schedBusy = v },
    }))
  }

  protected _voiceLlmRemotes?: ReturnType<typeof createVoiceLlmRemotes>

  /** 语音转写与模型清单（whisper 安装/下载/状态、可用模型与提供方） 的处理器（体在 remotes/voicellm.ts）；这里只组装 ctx 与转发。 */
  protected voiceLlmRemotes(): ReturnType<typeof createVoiceLlmRemotes> {
    return (this._voiceLlmRemotes ??= createVoiceLlmRemotes({
      dirs: () => this._dirs,
      op: (category, action, status, target, detail) => this.op(category, action, status, target, detail),
      ctx: () => this._ctx,
      getWhisperDownload: () => this.whisperDownload,
      setWhisperDownload: (v) => { this.whisperDownload = v },
      getWhisperTranscribing: () => this.whisperTranscribing,
      setWhisperTranscribing: (v) => { this.whisperTranscribing = v },
    }))
  }

  protected _askDeepRemotes?: ReturnType<typeof createAskDeepRemotes>

  /** 问答主链路（提问检索生成、问题优化、向量索引重建） 的处理器（体在 remotes/askdeep.ts）；这里只组装 ctx 与转发。 */
  protected askDeepRemotes(): ReturnType<typeof createAskDeepRemotes> {
    return (this._askDeepRemotes ??= createAskDeepRemotes({
      dirs: () => this._dirs,
      op: (category, action, status, target, detail) => this.op(category, action, status, target, detail),
      ctx: () => this._ctx,
      askTrace: this._askTrace,
      privacyBlocked: (feature, detail) => this.privacyBlocked(feature, detail),
      privacyGate: (feature, stats, texts) => this.privacyGate(feature, stats, texts),
      embedModelName: (override) => this.embedModelName(override),
      makeEmbedFn: (model, feature) => this.makeEmbedFn(model, feature),
      makeRerankFn: (kbId) => this.makeRerankFn(kbId),
      makeDeltaEmitter: (streamId) => this.makeDeltaEmitter(streamId),
      kbModel: (kbId, role) => this.kbModel(kbId, role),
      askKnownEntities: () => this.askKnownEntities(),
      saveAskHistory: (options, result, elapsedMs, model) => this.saveAskHistory(options, result, elapsedMs, model),
    }))
  }

  /**
   * 取一个搜索任务的取消信号（N9）。
   * @param jobId - 渲染层生成的不透明标识；缺省/空白时返回 undefined（＝不可取消）。
   * @returns 信号与收尾函数；收尾只在槽里还是自己这一枚控制器时才删 —— 否则会把「先取消、再重跑」
   *   的新令牌一起删掉。
   */
  protected searchSignal(jobId?: string): { signal: AbortSignal; done: () => void } | undefined {
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
   * 记一条导出历史（best-effort）。
   *
   * 为什么放在网关而不是各导出函数内部：`recordExport` 需要「解密数据根」来定位历史库，
   * 而各 `export*.ts` 函数都拿到了 `decryptedDir` —— 但重跑参数只有网关这一层完整掌握
   * （客户端传什么原样存下来），所以在网关这层记录最不容易漏字段。
   * @param input - 本次导出的事实。
   */
  protected recordExport(input: {
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
  protected makeDeltaEmitter(streamId?: string): ((text: string) => void) | undefined {
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
  protected saveAskHistory(
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
  protected static readonly DUE_SUMMARY_CONCURRENCY = 2

  /** Run any enabled daily-summary task whose schedule time matches the current minute. */
  protected async maybeRunDueTasks(): Promise<void> {
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
        Array.from({ length: Math.min(GatewayCore.DUE_SUMMARY_CONCURRENCY, due.length) }, () => worker()),
      )
      if (failure) throw failure
    } catch (e) {
      this.op('error', 'summary_scheduler_error', 'fail', '', (e as Error).message)
    } finally { this._schedBusy = false }
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
  protected warmDecodedImages(
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
}
