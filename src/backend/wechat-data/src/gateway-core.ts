/**
 * GatewayCore —— `WechatDataGateway` 的「核」：运行时状态、构造与实时同步接线、跨域共享的
 * 私有辅助（隐私闸 / 操作日志 / 流控槽 / 模型选择…），以及 16 个域处理器的 ctx 装配。
 *
 * 为什么拆成继承链（M21 结构刀）：`gateway.ts` 里 214 个 `@Remote` 方法**必须留在同一个类**
 * ——协议层按「最派生原型的自有描述子」枚举方法面（见 `tests/remote-inheritance.spec.ts`），
 * 所以方法壳可以放在任何一层的基类里、而对外接口一字不变；把「核」先分出去，
 * 方法面才能继续按域往下拆。
 */

import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import type { AskResult, DecryptStatus, ExportStatus, SummaryTaskRunResult, WhisperDownloadProgress, WhisperTranscribing, OperationCategory, OperationStatus } from './types.ts'
import { resolveSelfUsername } from './query/config.ts'
import { warmDecodedImages } from './query/image-warm.ts'
import { startRealtimeSync } from './query/sync.ts'
import { SYNC_INTERVAL_MS } from './query/sync-pacing.ts'
import { createTasksRemotes } from './remotes/tasks.ts'
import { createOpsLogRemotes } from './remotes/opslog.ts'
import { createWordcloudRemotes } from './remotes/wordcloud.ts'
import { createBackupRemotes } from './remotes/backup.ts'
import { createConfigRemotes } from './remotes/config.ts'
import { createSummaryRemotes } from './remotes/summary.ts'
import { createAskRemotes } from './remotes/ask.ts'
import { createKeysDecryptRemotes } from './remotes/keysdec.ts'
import { createGraphSearchRemotes } from './remotes/graphsearch.ts'
import { createSummaryRecordRemotes } from './remotes/summaryrec.ts'
import { createVoiceLlmRemotes } from './remotes/voicellm.ts'
import { createAnnualNarrRemotes } from './remotes/annual-narr.ts'
import { createAskDeepRemotes } from './remotes/askdeep.ts'
import { createKbRemotes } from './remotes/kb.ts'
import { createMediaRemotes } from './remotes/media.ts'
import { createExportRemotes } from './remotes/export.ts'
import { knownEntityNames } from './query/search.ts'
import type { StreamControl } from './query/zip.ts'
import { getConfig } from './query/config.ts'
import { recordExport } from './query/export-history.ts'
import { recordAsk } from './query/ask-history.ts'
import { type EmbedFn } from './query/retrieval/embedding.ts'
import {
  kbModelOverrideCounts,
  kbModelsOnKbDelete,
  touchKbEntitiesAt,
  writeKbModelSettings,
} from './query/kb/model-config.ts'
import type { KbModelRole, ResolvedModel } from './query/kb/model-config.ts'
import type { IntentKind, RerankWeights } from './query/retrieval/types.ts'
import { recordOperation } from './query/operation-log.ts'
import { bumpDataGeneration, invalidateWechatMeta } from './query/meta.ts'
import { publishDataRevision } from './query/sync-status.ts'
import { recoverInterrupted } from './query/kb-files.ts'
import { drainKbQueue } from './query/kb-queue.ts'
import { createSummaryScheduler, type SummaryScheduler } from './gateway-scheduler.ts'
import { EXPORT_PROGRESS_EVENT, ResolvedDirs, StreamJob, normalizeJobId, rawWechatBase, resolveDirs } from './gateway-support.ts'
import { finishStreamJobIn, streamControlFor } from './gateway-jobs.ts'
import { cancelJobIn, jobSignalFor } from './gateway-job-signals.ts'
import { embedModelNameOf, globalModelNameOf, kbModelOf } from './gateway-models.ts'
import type { EmbedFeature, LlmFactoryDeps } from './gateway-llm-factory.ts'
import { makeChatAskerOf, makeEmbedFnOf, makeRerankFnOf } from './gateway-llm-factory.ts'
import { privacyGateAt, redactModeAt } from './gateway-privacy.ts'
import { archiveMessages } from './query/revoke-retain.ts'
import { PREWARM_PROBE_MS, prewarmBudgetMs, pumpSnsDecodeCache } from './query/sns-image.ts'
import { prewarmAfterInit, prewarmIsNotable } from './query/startup-prewarm.ts'
import { resolveImageKeyPair } from './query/image-key.ts'

/** 网关的「核」：状态、生命周期、共享私有辅助与 16 个域处理器的 ctx 装配（M21 自 gateway.ts 拆出）。 */
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
  /**
   * 摘要任务的定时器调度（#20 第七刀拆出去的协作者）。
   *
   * 走 `slot()` 装配：构造期间 `setInterval` 那一颗就已经会调它，而 `_dirs` 是构造里
   * 晚一步才赋的 —— 装配放进惰性槽里，第一次真正用到时才读 `_dirs`。
   */
  protected summaryScheduler(): SummaryScheduler {
    return this.slot('summaryScheduler', () => createSummaryScheduler({
      decryptedDir: () => this._dirs.decrypted,
      op: (category, action, status, target, detail) => this.op(category, action, status, target, detail),
      runTask: (options) => this.runSummaryTask(options),
    }))
  }
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
    op: null, active: false, done: 0, total: 0, failed: 0, skipped: 0, message: '', failures: [],
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
   * 问答的取消槽（W3-6.1）：jobId → 取消控制器。
   *
   * 为什么与搜索/导出都分开：三者的生命周期不同 —— 搜索是「一次扫描」、导出是「一个 job」，
   * 问答是「一轮生成」。共用一个槽会让「取消搜索」顺手掐死正在生成的回答（或反过来），
   * 那是比不能取消更坏的行为。做法与 {@link searchSignal} 同款：jobId 由渲染层生成
   * （就是那轮的 streamId），取消走独立的 `cancelAsk` Remote。
   */
  protected readonly _askJobs = new Map<string, AbortController>()
  /** W3-11.5：逐条分析的取消槽（与问答分开放，原因见 `layaSignal` 的注释）。 */
  protected readonly _layaJobs = new Map<string, AbortController>()
  /** W3-11.5：搜索索引构建的取消槽（与搜索分开放，原因见 `searchIndexSignal` 的注释）。 */
  protected readonly _searchIndexJobs = new Map<string, AbortController>()
  /** W3-5.5：下载的取消槽（与其余几种各占一格）。 */
  protected readonly _whisperDownloadJobs = new Map<string, AbortController>()
  /** W3-11.5：知识库向量构建的取消槽（与消息域的构建各占一格，互相不会打断）。 */
  protected readonly _kbIndexCancelJobs = new Map<string, AbortController>()
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
   * 取（或新建）一个长任务的控制槽 —— 槽位管理在 `gateway-jobs.ts#streamControlFor`
   * （#20 第四个协作者：令牌复用 / 终态残留 / 上限淘汰这三条规则只有单独测才钉得住）。
   * 那张槽表仍由本类持有，并原样交给 remotes（避免出现第二个"进度视图"）。
   * @param jobId - 渲染层生成的标识；缺省/空白时返回空控制（＝无进度、不可取消）。
   * @returns 含 `signal` 与 `onProgress` 的控制对象，可直接透传给 query 层。
   */
  protected streamControl(jobId?: string): StreamControl {
    return streamControlFor(this._streamJobs, (detail) => { this._ctx.emit(EXPORT_PROGRESS_EVENT, detail) }, jobId)
  }

  /**
   * 收尾一个长任务：标记结束（槽位留着，让迟到的 `getExportProgress` 能读到终态与错误）。
   * @param jobId - 任务标识。
   * @param error - 失败/取消原因；成功时省略。
   */
  protected finishStreamJob(jobId: string, error?: string): void {
    finishStreamJobIn(this._streamJobs, jobId, error)
  }

  /**
   * 子类钩子：网关构造完成后（`setImmediate` 里）拉起 ClawBot 接收通道
   * （体在 `gateway-clawbot.ts`；默认实现什么都不做 —— ClawBot 组装在更派生的层）。
   */
  protected bootClawbotChannel(): void { /* 默认无 */ }

  /**
   * 子类钩子：任务触发扫描的一拍（体在 `gateway-taskcenter.ts`；默认实现什么都不做 ——
   * 任务信息域的组装在更派生的层）。
   *
   * 由实时同步回调（有新分片变化时）与 10s 兜底定时器调用。与 `bootClawbotChannel` 分开的理由：那个是「拉起长轮询」，
   * 这个是「周期扫描」，生命周期与失败语义都不同（前者启动一次，后者每拍都可能失败）。
   */
  protected scanTaskTriggersBackground(): void { /* 默认无 */ }

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
      // 对外修订（2026-10-18）：心跳级轻量读，renderer 轮询它决定要不要拉消息增量。
      // 必须在 emit 之前发布：事件到达前端时，前端马上读修订就能读到同一拍。
      publishDataRevision(synced)
      // 事件先发（2026-10-18）：聊天窗口/会话列表的可见延迟只取决于这一行；
      // 归档、SNS 预热、密钥解析都排在它后面，不许挡在通知前面。
      try { ctx.emit('wechat-data/updated', synced) } catch { /* event best-effort */ }
      /**
       * 任务触发扫描（2026-10-19 提速）：新分片到达即刻扫，不再等 30s 定时器。
       * 放在 `emit` 之后 + `setTimeout(0)`：聊天刷新事件先出去，扫描的 SQL 不挡它；
       * 单飞/合并见 `GatewayTaskCenter.scheduleTaskTriggerScan`，重复触发不会并发。
       */
      if (synced.length > 0) {
        setTimeout(() => {
          try { this.scanTaskTriggersBackground() } catch (e) {
            console.warn('[task-trigger] 扫描触发失败:', (e as Error).message)
          }
        }, 0)
      }
      /**
       * 撤回原文归档（2026-09-29，用户选 C：全量归档）——**挂在同步 tick 上，而不是读路径**。
       *
       * 为什么：`queryRevoked` 里那份"先归档再出列表"在首次会扫全部历史（19 万行 ≈2.4s），
       * 压在"打开面板"上太慢。归档本身按**源库签名**整库跳过，空闲时只有几次 stat，
       * 所以放在这里最合适；且**只在本 tick 真有分片变化时**才做，避免拖慢别的查询。
       * 失败只记日志，绝不影响同步主流程。
       */
      if (synced.length > 0) {
        try { archiveMessages(decrypted) } catch (e) { console.warn('[revoke-archive] 归档失败:', (e as Error).message) }
      }
      /**
       * **预热解码缓存**（2026-09-29「有的图片加载不出来」的治本一步）。
       *
       * 真机自检：解码缓存 **154 张** vs 媒体资源 **175,963 项** —— 因为解密推进
       * (`drainAttach`) 此前只在"用户点到某张图"时被驱动，空闲时缓存完全不涨；
       * 未命中的那张要走 12–21s 的重路径，失败就是我们看到的空白。
       *
       * 这里把驱动权交给同步节拍（约每 10s 一拍）：**不加 `synced.length > 0` 条件**，
       * 因为 WeChat 空闲时也需要继续预热。安全性由 pump 自身保证 —— 它复用请求路径
       * 同一个 150ms 突发闸门与文件数/毫秒双预算，**不会把 worker 拖住、也不会挤掉正在等图的请求**。
       *
       * 密钥走 `resolveImageKeyPair(decrypted)`：与设置页/自检面板**同一份被校验过的键**
       * （配置优先，其次自动密钥且校验归属），绝不在这里自己拼密钥。
       */
      try {
        const pair = resolveImageKeyPair(decrypted)
        // 每拍最多占用 300ms（约 12 步 / 400+ 张）——占每 10s 节拍的 3%，
        // 但把 3,262 张的积压从"约 13 分钟"压到"约 1 分钟"级。
        void pumpSnsDecodeCache(rawDbDir(), pair.aesKey, pair.xorKey, { maxMs: 300 })
          .catch((e) => console.warn('[sns-prewarm] 预热失败:', (e as Error).message))
      } catch (e) { console.warn('[sns-prewarm] 预热失败:', (e as Error).message) }
    })
    ctx.effect(() => stopSync, 'wechat-data: realtime sync')
    // Daily-summary scheduler: every 30s, run any enabled task whose schedule
    // time (HH:MM) matches the current minute and has not run in the last minute.
    const schedTimer = setInterval(() => { void this.maybeRunDueTasks() }, 30_000)
    ctx.effect(() => () => { clearInterval(schedTimer) }, 'wechat-data: summary scheduler')
    // 任务触发扫描（2026-10-19）：正常由上面的同步回调**事件驱动**（分片一变就扫），
    // 这颗 10s 定时器只是兜底：WAL 监听没挂上（网络盘 / fs.watch 报错）时仍有新鲜度，
    // 也顺带重试失败的 pending 回调（`scanAndDispatch` 会投递一批）。
    // 独立一颗而不是塞进摘要调度：摘要按 HH:MM 判到点，触发按 sort_seq 判新消息，语义无关；
    // 共用一颗时任何一侧的异常/长耗时都会把另一侧一起拖住。
    const taskScanTimer = setInterval(() => { this.scanTaskTriggersBackground() }, SYNC_INTERVAL_MS)
    ctx.effect(() => () => { clearInterval(taskScanTimer) }, 'wechat-data: task trigger scanner')
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
    /**
     * W3-1.3 / W3-3.4：启动后的**低优先级预热**。
     *
     * 两件事从前都是「第一次用到时当场算」：分片目录（逐张分片开库、
     * 枚举 Msg_* 表）与成员搜索的 FTS 表。后者体验差得具体：用户点「搜索人」时
     * 才发现没建，那一次搜索就要等整份 contact.db 灌进去。
     *
     * 三条约束：
     *  · **不阻塞启动**：`setImmediate` 排到当前 tick 之后 + `void`（不 await）。
     *    窗口出现的路径上不该绑着一次可能几百毫秒的预热。
     *  · **不抢写闸**：contact_fts 真要建表时跟搜索路径跟同一个
     *    `withIndexWrite`；拿不到就本次跳过（busy）。
     *  · **失败只留痕**：预热是优化，不是功能。
     */
    setImmediate(() => {
      try {
        const r = prewarmAfterInit(this._dirs.decrypted)
        if (prewarmIsNotable(r)) {
          const bits = ['[prewarm] 分片 ' + String(r.shards) + ' 张', 'contact_fts=' + r.fts]
          if (r.ftsError !== '') bits.push('FTS 失败：' + r.ftsError)
          console.log(bits.join(' · '))
        }
      } catch (e) {
        console.warn('[prewarm] 预热失败:', (e as Error).message)
      }
    })
    void drainKbQueue(this._dirs.decrypted).then((r) => {
      if (r.processed > 0) {
        console.log('[kb-queue] 启动清扫：处理 ' + r.processed + ' 个文件（就绪 ' + r.ready
          + ' / 无正文 ' + r.unsupported + ' / 失败 ' + r.failed + '）')
      }
    }).catch((e: unknown) => {
      console.warn('[kb-queue] 启动清扫异常：' + (e instanceof Error ? e.message : String(e)))
    })
    /**
     * ClawBot 接收通道：绑定后随网关常驻（收消息是宿主职责，不该等用户打开面板）。
     *
     * 放进 `setImmediate` 的理由与上面的预热同款 —— 启动路径不该为了「读一次绑定库、
     * 起一条长轮询」多等一下；晚一拍也确保继承链上的组装槽已就绪。
     * 未绑定/无凭证时钩子内部直接返回，**不会有任何出网**。
     */
    setImmediate(() => {
      try {
        this.bootClawbotChannel()
      } catch (e) {
        console.warn('[clawbot] 通道启动失败：' + (e instanceof Error ? e.message : String(e)))
      }
    })
  }

  /**
   * Append one operation-log row. Metadata only — never message bodies or
   * image/file contents — so an export stays safe to share. Best-effort: a
   * logging failure never affects the operation it records.
   *
   * @param durationMs - 本次操作耗时（H2）。**不传就是不记**（`undefined`），
   *   与传 `0` 是两回事：`0` 会被 `storedDuration` 当成「不到阈值」丢掉，
   *   而「没量过」与「量出来很快」在审计表里都落 NULL。绝大多数 `op()` 调用点
   *   记录的是「开始做某件事」而不是「做完」，本来就没有耗时可言 —— 不要为了
   *   填满这一列去给每个调用点掐表。
   */
  protected op(category: OperationCategory, action: string, status: OperationStatus, target = '', detail = '', durationMs?: number): void {
    recordOperation(this._dirs.decrypted, { category, action, target, status, detail, durationMs })
  }

  /**
   * 隐私闸门：**所有**出站 LLM 调用都必须先过这里（实现见 `gateway-privacy.ts`）。
   * 它只做脱敏与审计 —— 2026-09-30 起不再有任何拦截逻辑。
   * @param feature - 审计里的功能名。
   * @param stats - 本次出站涉及的数据量（会话数、消息数）。
   * @param texts - 即将发出去的文本；开启脱敏时返回脱敏后的副本。
   * @returns 可以直接发出去的文本。
   */
  protected privacyGate(
    feature: string,
    stats: { sessions: number; messages: number },
    texts: string[],
  ): string[] {
    return privacyGateAt(this._dirs.decrypted, feature, stats, texts)
  }

  /**
   * 当前数据根是否开启敏感字段脱敏（W3-6.2：embedding 缓存键的命名空间）。
   *
   * 与 `privacyGateAt` 读的是**同一个** `readPrivacySettings`，容错口径也相同
   *（读不到按 false 继续）—— 两边不一致会让缓存跨口径取用，所以这里刻意不另找数据源。
   * @returns 开启为 true。
   */
  protected privacyRedactMode(): boolean {
    return redactModeAt(this._dirs.decrypted)
  }

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
   * 构造「过隐私闸门」的 embedding 函数 —— 工厂在 `gateway-llm-factory.ts`
   * （#20 第三个协作者，文件头写着那三条出站纪律）。
   * @param model - 向量模型名（空则不带 model 选项）。
   * @param feature - 审计里的功能名（三种数据范围必须分得开）。
   * @returns embedding 函数；桥未提供 embed 时 undefined。
   */
  protected makeEmbedFn(model: string, feature: EmbedFeature = 'ask_embed'): EmbedFn | undefined {
    return makeEmbedFnOf(this.llmFactoryDeps(), model, feature)
  }

  /**
   * 「这次 embedding 实际用的模型名」—— 解析在 `gateway-models.ts#embedModelNameOf`
   * （#20 第二个协作者）。记账名必须由发送方给出，见那份模块里 §7 F1 那段。
   * @param override - 显式指定的模型名（可空）。
   * @returns 生效模型名；未配置时为空串。
   */
  protected embedModelName(override = ''): string {
    return embedModelNameOf(this._ctx.llm, override)
  }

  /**
   * 某个角色的**全局**生效模型名（还没叠库级覆盖）；实现见 `gateway-models.ts`。
   * @param role - 语言 / 嵌入 / 重排序。
   * @returns 模型名；空串 = 这个角色没配。
   */
  protected globalModelName(role: KbModelRole): string {
    return globalModelNameOf({ bridge: this._ctx.llm, host: this._ctx, decryptedDir: this._dirs.decrypted }, role)
  }

  /**
   * 某个库、某个角色**实际该用的**模型名（库级覆盖叠在全局之上）；实现见 `gateway-models.ts`。
   * @param kbId - 知识库 id（非法时等价于「没有库级覆盖」）。
   * @param role - 哪个角色。
   * @returns 解析结果（含来源，界面与审计都要用它说话）。
   */
  protected kbModel(kbId: number, role: KbModelRole): ResolvedModel {
    return kbModelOf({ bridge: this._ctx.llm, host: this._ctx, decryptedDir: this._dirs.decrypted }, kbId, role)
  }

    /**
   * 造一个「提示词 → 模型文本」的一次性调用（实体抽取、链接建议这类结构化小任务用）；
   * 实现见 `gateway-llm-factory.ts#makeChatAskerOf`。
   * @param kbId - 当前库（取语言模型的库级覆盖）。
   * @param feature - 审计里登记的功能名。
   * @returns 调用函数；桥不支持流式时 undefined（调用方据此报「模型通道不可用」）。
   */
  protected makeChatAsker(kbId: number, feature: string): ((prompt: string) => Promise<string>) | undefined {
    return makeChatAskerOf(this.llmFactoryDeps(), kbId, feature)
  }

    /**
   * 构造「过隐私闸门」的模型精排函数（问答检索的候选重排）；
   * 实现见 `gateway-llm-factory.ts#makeRerankFnOf`（含「整批过一次闸」那条纪律）。
   * @param kbId - 当前库（用于取库级覆盖；0 = 没有库上下文）。
   * @returns 精排函数；没配模型或桥不支持时 undefined（管道据此跳过这一段）。
   */
  protected makeRerankFn(kbId: number): ((query: string, documents: string[]) => Promise<number[]>) | undefined {
    return makeRerankFnOf(this.llmFactoryDeps(), kbId)
  }

    /**
   * 三个 LLM 工厂共用的依赖袋。
   *
   * 每次调用现凑：`_dirs.decrypted` 会在换数据根时变，缓存这份对象就会让隐私闸
   * 指向**上一个**数据根的库（读到旧设置 = 用旧同意范围发新数据）。
   * @returns 桥、宿主上下文与两个前置协作者的入口。
   */
  private llmFactoryDeps(): LlmFactoryDeps {
    return {
      llm: this._ctx.llm,
      host: this._ctx,
      kbModel: (kbId, role) => this.kbModel(kbId, role),
      privacyGate: (feature, stats, texts) => this.privacyGate(feature, stats, texts),
      // W3-6.2：embedding 缓存要落在当前数据根（换根时自动改道），
      // 键的命名空间取当前脱敏口径（理由见 LlmFactoryDeps 的注释）。
      decryptedDir: () => this._dirs.decrypted,
      redactMode: () => this.privacyRedactMode(),
    }
  }

  /**
   * 装配槽：同一个域的处理器**只装配一次**（`WechatDataGateway` 的壳每次调用都转发到同一份对象，
   * 那份"壳转给的就是这件"的判据见 `gateway-read-shell.spec.ts` 里的 spy 用例）。
   * #20 第六刀之前这里是十五个「下划线字段 + `??=`」各写一遍 —— 报告 §P2-2 第 1 条要 core 只保留
   * `_ctx` / `_dirs` 与装配，于是把"复用装配产物"这一件事收成一处，实例状态一次少十五格。
   */
  private readonly _remoteSlots = new Map<string, unknown>()

  /** 取（或第一次装配）某个键对应的处理器。 */
  protected slot<T>(key: string, build: () => T): T {
    if (this._remoteSlots.has(key)) return this._remoteSlots.get(key) as T
    const made = build()
    this._remoteSlots.set(key, made)
    return made
  }

  /** KB 域的处理器（体在 remotes/kb.ts）；这里只组装 ctx 与转发。 */
  protected kbRemotes(): ReturnType<typeof createKbRemotes> {
    return this.slot('kb', () => createKbRemotes({
      dirs: () => this._dirs,
      ctx: this._ctx,
      kbIndexJobs: this._kbIndexJobs,
      // W3-11.5：本库向量构建的取消槽。
      kbIndexSignal: (jobId) => this.kbIndexSignal(jobId),
      cancelKbIndexJob: (jobId) => this.cancelKbIndexJob(jobId),
      op: (category, action, status, target, detail) => this.op(category, action, status, target, detail),
      privacyGate: (feature, stats, texts) => this.privacyGate(feature, stats, texts),
      makeEmbedFn: (model, feature) => this.makeEmbedFn(model, feature),
      globalModelName: (role) => this.globalModelName(role),
      kbModel: (kbId, role) => this.kbModel(kbId, role),
      makeChatAsker: (kbId, feature) => this.makeChatAsker(kbId, feature),
    }))
  }

  /** 媒体域的处理器（体在 remotes/media.ts）；这里只组装 ctx 与转发。 */
  protected mediaRemotes(): ReturnType<typeof createMediaRemotes> {
    return this.slot('media', () => createMediaRemotes({
      dirs: () => this._dirs,
      op: (category, action, status, target, detail) => this.op(category, action, status, target, detail),
      rawWechatBase: (decrypted) => rawWechatBase(decrypted),
      // fs 读写都在 query 层那颗里（#20 第五刀下沉的），这里只是把它交给处理器。
      warmDecodedImages,
      // 「批量取原图」是长任务，要写解密状态机的进度的**同一个对象**（同一时刻只允许一个
      // 解密类任务：批量取原图与批量解密/升级共用 `active` 这道忙闲闸门）。
      decryptState: this.decryptState,
    }))
  }

  /** 导出域的处理器（体在 remotes/export.ts）；这里只组装 ctx 与转发。 */
  protected exportRemotes(): ReturnType<typeof createExportRemotes> {
    return this.slot('export', () => createExportRemotes({
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

  /** 任务与笔记（待办 / 笔记 / 交接提醒） 的处理器（体在 remotes/tasks.ts）；这里只组装 ctx 与转发。 */
  protected tasksRemotes(): ReturnType<typeof createTasksRemotes> {
    return this.slot('tasks', () => createTasksRemotes({
      dirs: () => this._dirs,
      op: (category, action, status, target, detail) => this.op(category, action, status, target, detail),
    }))
  }

  /** 操作日志与隐私审计（含隐私开关读数） 的处理器（体在 remotes/opslog.ts）；这里只组装 ctx 与转发。 */
  protected opsLogRemotes(): ReturnType<typeof createOpsLogRemotes> {
    return this.slot('opsLog', () => createOpsLogRemotes({
      dirs: () => this._dirs,
      op: (category, action, status, target, detail) => this.op(category, action, status, target, detail),
    }))
  }

  /** 词云词频（界面优化阶段 4） 的处理器（体在 remotes/wordcloud.ts）；这里只组装 ctx 与转发。 */
  protected wordcloudRemotes(): ReturnType<typeof createWordcloudRemotes> {
    return this.slot('wordcloud', () => createWordcloudRemotes({
      dirs: () => this._dirs,
    }))
  }

  /** 备份与恢复（含加密备份） 的处理器（体在 remotes/backup.ts）；这里只组装 ctx 与转发。 */
  protected backupRemotes(): ReturnType<typeof createBackupRemotes> {
    return this.slot('backup', () => createBackupRemotes({
      dirs: () => this._dirs,
      op: (category, action, status, target, detail) => this.op(category, action, status, target, detail),
      streamControl: (jobId) => this.streamControl(jobId),
      finishStreamJob: (jobId, error) => this.finishStreamJob(jobId, error),
      normalizeJobId: (jobId) => normalizeJobId(jobId),
    }))
  }

  /** 数据配置与密钥状态（含解密/数据库状态） 的处理器（体在 remotes/config.ts）；这里只组装 ctx 与转发。 */
  protected configRemotes(): ReturnType<typeof createConfigRemotes> {
    return this.slot('config', () => createConfigRemotes({
      dirs: () => this._dirs,
      op: (category, action, status, target, detail) => this.op(category, action, status, target, detail),
      decryptState: this.decryptState,
    }))
  }

  /** 总结任务（每日/周期总结的排程与运行） 的处理器（体在 remotes/summary.ts）；这里只组装 ctx 与转发。 */
  protected summaryRemotes(): ReturnType<typeof createSummaryRemotes> {
    return this.slot('summary', () => createSummaryRemotes({
      dirs: () => this._dirs,
      op: (category, action, status, target, detail) => this.op(category, action, status, target, detail),
      ctx: () => this._ctx,
      privacyGate: (feature, stats, texts) => this.privacyGate(feature, stats, texts),
    }))
  }

  /** 问答反馈与检索配置（画像表 / 反馈表 / 配置） 的处理器（体在 remotes/ask.ts）；这里只组装 ctx 与转发。 */
  protected askRemotes(): ReturnType<typeof createAskRemotes> {
    return this.slot('ask', () => createAskRemotes({
      dirs: () => this._dirs,
      op: (category, action, status, target, detail) => this.op(category, action, status, target, detail),
      askFeedbackSeen: this._askFeedbackSeen,
      askTrace: this._askTrace,
    }))
  }

  /** 密钥获取与全库/全图解密（图片密钥自动获取、验证、解密状态） 的处理器（体在 remotes/keysdec.ts）；这里只组装 ctx 与转发。 */
  protected keysDecryptRemotes(): ReturnType<typeof createKeysDecryptRemotes> {
    return this.slot('keysDecrypt', () => createKeysDecryptRemotes({
      dirs: () => this._dirs,
      op: (category, action, status, target, detail) => this.op(category, action, status, target, detail),
      decryptState: this.decryptState,
      rawWechatBase: (decrypted) => rawWechatBase(decrypted),
    }))
  }

  /** 知识图谱、消息检索与索引（含编辑历史复位） 的处理器（体在 remotes/graphsearch.ts）；这里只组装 ctx 与转发。 */
  protected graphSearchRemotes(): ReturnType<typeof createGraphSearchRemotes> {
    return this.slot('graphSearch', () => createGraphSearchRemotes({
      dirs: () => this._dirs,
      op: (category, action, status, target, detail) => this.op(category, action, status, target, detail),
      searchJobs: this._searchJobs,
      searchSignal: (jobId) => this.searchSignal(jobId),
      // W3-11.5：索引构建的进度事件出口与取消槽。
      ctx: () => this._ctx,
      searchIndexSignal: (jobId) => this.searchIndexSignal(jobId),
      cancelSearchIndexJob: (jobId) => this.cancelSearchIndexJob(jobId),
    }))
  }

  /** 总结记录（每日/周期总结生成、记录删除、推荐回复） 的处理器（体在 remotes/summaryrec.ts）；这里只组装 ctx 与转发。 */
  protected summaryRecordRemotes(): ReturnType<typeof createSummaryRecordRemotes> {
    return this.slot('summaryRecord', () => createSummaryRecordRemotes({
      dirs: () => this._dirs,
      op: (category, action, status, target, detail) => this.op(category, action, status, target, detail),
      ctx: () => this._ctx,
      privacyGate: (feature, stats, texts) => this.privacyGate(feature, stats, texts),
      runSummaryTask: (options) => this.runSummaryTask(options),
      selfUsername: () => this.selfUsername(),
      getSchedBusy: () => this.summaryScheduler().busy(),
      setSchedBusy: (v) => { this.summaryScheduler().setBusy(v) },
    }))
  }

  /** AI 年报叙述（W2-8.6：分段取材 + 逐段 LLM + 进度/取消） 的处理器（体在 remotes/annual-narr.ts）。 */
  protected annualNarrRemotes(): ReturnType<typeof createAnnualNarrRemotes> {
    return this.slot('annualNarr', () => createAnnualNarrRemotes({
      dirs: () => this._dirs,
      op: (category, action, status, target, detail) => this.op(category, action, status, target, detail),
      streamControl: (jobId) => this.streamControl(jobId),
      finishStreamJob: (jobId, error) => this.finishStreamJob(jobId, error),
      normalizeJobId: (jobId) => normalizeJobId(jobId),
      ctx: () => this._ctx,
      privacyGate: (feature, stats, texts) => this.privacyGate(feature, stats, texts),
    }))
  }

  /** 语音转写与模型清单（whisper 安装/下载/状态、可用模型与提供方） 的处理器（体在 remotes/voicellm.ts）；这里只组装 ctx 与转发。 */
  protected voiceLlmRemotes(): ReturnType<typeof createVoiceLlmRemotes> {
    return this.slot('voiceLlm', () => createVoiceLlmRemotes({
      dirs: () => this._dirs,
      op: (category, action, status, target, detail) => this.op(category, action, status, target, detail),
      ctx: () => this._ctx,
      getWhisperDownload: () => this.whisperDownload,
      setWhisperDownload: (v) => { this.whisperDownload = v },
      getWhisperTranscribing: () => this.whisperTranscribing,
      setWhisperTranscribing: (v) => { this.whisperTranscribing = v },
      // W3-5.5：下载取消槽。
      whisperDownloadSignal: (jobId) => this.whisperDownloadSignal(jobId),
      cancelWhisperDownloadJob: (jobId) => this.cancelWhisperDownloadJob(jobId),
    }))
  }

  /** 问答主链路（提问检索生成、问题优化、向量索引重建） 的处理器（体在 remotes/askdeep.ts）；这里只组装 ctx 与转发。 */
  protected askDeepRemotes(): ReturnType<typeof createAskDeepRemotes> {
    return this.slot('askDeep', () => createAskDeepRemotes({
      dirs: () => this._dirs,
      op: (category, action, status, target, detail) => this.op(category, action, status, target, detail),
      ctx: () => this._ctx,
      askTrace: this._askTrace,
      privacyGate: (feature, stats, texts) => this.privacyGate(feature, stats, texts),
      embedModelName: (override) => this.embedModelName(override),
      makeEmbedFn: (model, feature) => this.makeEmbedFn(model, feature),
      makeRerankFn: (kbId) => this.makeRerankFn(kbId),
      makeDeltaEmitter: (streamId) => this.makeDeltaEmitter(streamId),
      makeReasoningEmitter: (streamId) => this.makeReasoningEmitter(streamId),
      makeStageEmitter: (streamId) => this.makeStageEmitter(streamId),
      kbModel: (kbId, role) => this.kbModel(kbId, role),
      askKnownEntities: () => this.askKnownEntities(),
      saveAskHistory: (options, result, elapsedMs, model) => this.saveAskHistory(options, result, elapsedMs, model),
      // W3-6.1：可取消的一轮生成。信号与取消把手都由 gateway 持有（与搜索同一套打法），
      // remotes 只消费 —— 否则「谁持有令牌」会出现第二个出处。
      askSignal: (jobId) => this.askSignal(jobId),
      cancelAskJob: (jobId) => this.cancelAskJob(jobId),
    }))
  }

  /**
   * 取一个搜索任务的取消信号（N9）。
   * @param jobId - 渲染层生成的不透明标识；缺省/空白时返回 undefined（＝不可取消）。
   * @returns 信号与收尾函数；收尾只在槽里还是自己这一枚控制器时才删 —— 否则会把「先取消、再重跑」
   *   的新令牌一起删掉。
   */
  protected searchSignal(jobId?: string): { signal: AbortSignal; done: () => void } | undefined {
    return jobSignalFor(this._searchJobs, jobId)
  }

  /**
   * 取一个问答任务的取消信号（W3-6.1）。语义与 {@link searchSignal} 一致：
   * 槽位只认「自己这一枚控制器」，先取消再重跑的令牌不会互相删。
   * @param jobId - 渲染层传来的轮次标识（就是 streamId）；缺省/空白时 undefined（不可取消）。
   */
  protected askSignal(jobId?: string): { signal: AbortSignal; done: () => void } | undefined {
    return jobSignalFor(this._askJobs, jobId)
  }

  /**
   * 取消一轮问答。返回是否真的找到了在跑的那一轮 —— 找不到（已结束 / jobId 不认识）时
   * 给调用方一个可读的 false，而不是静默成功（那会让用户以为取消生效了，回答还在继续跑）。
   * @param jobId - 要取消的轮次标识。
   */
  protected cancelAskJob(jobId?: string): boolean {
    return cancelJobIn(this._askJobs, jobId)
  }

  /**
   * 取一批逐条分析的取消信号（W3-11.5）。语义与 {@link searchSignal} / {@link askSignal} 一致：
   * 槽位只认「自己这一枚控制器」，先取消再重跑的令牌不会互相删。
   *
   * 为什么单独一格而不复用 `_askJobs`：分析批与问答轮次会同时在跑，共用一个 Map 的话
   * 两个毫不相干的 jobId 会互相顶掉对方的令牌，取消会打到错误的批次上。
   * @param jobId - 渲染层生成的批次标识；缺省/空白时 undefined（不可取消）。
   */
  protected layaSignal(jobId?: string): { signal: AbortSignal; done: () => void } | undefined {
    return jobSignalFor(this._layaJobs, jobId)
  }

  /**
   * 取消一批逐条分析。返回是否真的找到了在跑的那一批 —— 找不到（已算完 / jobId 不认识）
   * 时给调用方一个可读的 false，而不是静默成功。
   * @param jobId - 要取消的批次标识。
   */
  protected cancelLayaJob(jobId?: string): boolean {
    return cancelJobIn(this._layaJobs, jobId)
  }

  /**
   * 取一次搜索索引构建的取消信号（W3-11.5）。语义与前两个 `xxxSignal` 一致。
   *
   * 为什么单独一格：搜索与构建会同时在跑（搜索兜底扫描期间用户就能点「构建索引」），
   * 共用 `_searchJobs` 的话「停止构建」会打到在跑的搜索上、把搜索打断。
   * @param jobId - 渲染层生成的批次标识；缺省/空白时 undefined（不可取消）。
   */
  protected searchIndexSignal(jobId?: string): { signal: AbortSignal; done: () => void } | undefined {
    return jobSignalFor(this._searchIndexJobs, jobId)
  }

  /**
   * 取消一次搜索索引构建。返回是否真的找到了在跑的那一次。
   * @param jobId - 要取消的批次标识。
   */
  protected cancelSearchIndexJob(jobId?: string): boolean {
    return cancelJobIn(this._searchIndexJobs, jobId)
  }

  /**
   * 取一次知识库向量构建的取消信号（W3-11.5）。语义同前三个 `xxxSignal`。
   *
   * 单独一格而不是复用 `_searchIndexJobs`：消息域索引与某个库的向量索引会同时在跑，
   * 共用一格的话，停掉一个会把另一个也打断。
   * @param jobId - 渲染层生成的批次标识；缺省/空白时 undefined（不可取消）。
   */
  protected kbIndexSignal(jobId?: string): { signal: AbortSignal; done: () => void } | undefined {
    return jobSignalFor(this._kbIndexCancelJobs, jobId)
  }

  /**
   * 取消一次知识库向量构建。返回是否真的找到了在跑的那一次。
   * @param jobId - 要取消的批次标识。
   */
  protected cancelKbIndexJob(jobId?: string): boolean {
    return cancelJobIn(this._kbIndexCancelJobs, jobId)
  }

  /**
   * 取一次模型/引擎下载的取消信号（W3-5.5）。语义与前几个 `xxxSignal` 一致。
   *
   * 移植到 download 上的原因：模型 1.5–3.1 GB，一旦开下就是几分钟到十几分钟的等待，
   * 而用户常常是“点错了模型”或者窗口要关了”——— 那一刻他
   * 唯一能做的就是等。取消不删局部文件，下次续传仍然有效。
   * @param jobId - 渲染层生成的下载标识；缺省/空白时 undefined（不可取消）。
   */
  protected whisperDownloadSignal(jobId?: string): { signal: AbortSignal; done: () => void } | undefined {
    return jobSignalFor(this._whisperDownloadJobs, jobId)
  }

  /**
   * 取消一次下载。返回是否真的找到了在下的那一次。
   * @param jobId - 要取消的下载标识。
   */
  protected cancelWhisperDownloadJob(jobId?: string): boolean {
    return cancelJobIn(this._whisperDownloadJobs, jobId)
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
   * 构造「思考过程增量」事件推送器（2026-10-16 新增）。
   *
   * 与 {@link makeDeltaEmitter} 同一套节流与「推全文」约定，只是走另一条事件名 ——
   * 思考内容与可见正文是**两条独立的流**（模型可能先吐一大段 reasoning 再吐正文），
   * 混在一条里前端就没法把它们分开展示。
   *
   * 为什么需要：问答产品里「思考过程」是可折叠的一块，用户据此判断模型有没有跑偏。
   * 后端此前把 `reasoning-delta` 直接丢掉（`runChat` 只认 `text-delta`），
   * 于是界面上永远看不到思考 —— 不是没生成，是没接。
   * @param streamId - 客户端生成的流式标识；为空表示不推送。
   * @returns 增量回调（text 为**已生成的思考全文**）。
   */
  protected makeReasoningEmitter(streamId?: string): ((text: string) => void) | undefined {
    const id = typeof streamId === 'string' ? streamId.slice(0, 64) : ''
    if (!id) return undefined
    const ctx = this._ctx
    let last = 0
    return (text: string): void => {
      const now = Date.now()
      if (now - last < 80) return
      last = now
      try { ctx.emit('wechat-ask/reasoning', { id, text }) } catch { /* 尽力而为 */ }
    }
  }

  /**
   * 构造「阶段」事件推送器（2026-10-16 新增）。
   *
   * 问答是一条多阶段流水线（规划 → 检索 → 精排 → 生成 → 接地核对），
   * 每个阶段都有可展示的结果（意图、召回条数、精排模型、引用条数…）。
   * 把这些**在发生的那一刻**推给前端，界面才能像问答产品那样显示
   * 「🔍 检索本机记录 · 召回 128 条」这样的过程行，而不是等全部跑完再一次性平铺。
   *
   * 不节流：阶段是离散事件（一轮最多 6 条），节流只会让「进行中」的状态跳帧。
   * @param streamId - 客户端生成的流式标识；为空表示不推送。
   * @returns 阶段回调。
   */
  protected makeStageEmitter(streamId?: string): ((stage: { key: string; label: string; status: 'running' | 'done' | 'skipped'; detail?: string }) => void) | undefined {
    const id = typeof streamId === 'string' ? streamId.slice(0, 64) : ''
    if (!id) return undefined
    const ctx = this._ctx
    return (stage): void => {
      try { ctx.emit('wechat-ask/stage', { id, ...stage }) } catch { /* 尽力而为 */ }
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

  /** Run any enabled daily-summary task whose schedule time matches the current minute. */
  protected async maybeRunDueTasks(): Promise<void> {
    await this.summaryScheduler().runDue()
  }

}
