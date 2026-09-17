/**
 * WeChatDataGateway — Host Remote service exposing st_control's decrypted
 * WeChat SQLite through the DSH Typert RPC. The browser client calls
 * ctx.remote.wechatData.* instead of an HTTP API.
 */
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { Context } from '@deepseek-ai/cordis';
import type { AccountsSnapshot, AnnualReport, AnnualSnapshot, AskOptimizeResult, AskResult, AutoDbKeyResult, AutoImageKeyResult, AvatarResult, BackupMutationResult, BackupPreviewSnapshot, BackupSnapshot, CalendarSnapshot, CallsSnapshot, ChatHistoryResolveResult, ConfigSnapshot, ContactsSnapshot, DailySummaryResult, DbStatusSnapshot, DecryptAllResult, DecryptImagesResult, DecryptStatus, DeleteFavoriteResult, DraftClearResult, DraftsClearResult, EditMutationResult, EditedListSnapshot, EmoticonsSnapshot, ExportResult, ExportHistoryDeleteResult, ExportHistoryQuery, ExportHistorySnapshot, ExportHistoryPruneOptions, FavoritesSnapshot, FilesSnapshot, GenerateKeysResult, GraphSnapshot, GroupInfoSnapshot, ImageDataUrlResult, KeysInfoResult, MemberSearchSnapshot, MessagesSnapshot, MomentsSnapshot, OverviewInsights, OverviewSnapshot, PaymentStatus, PrivacySnapshot, RecordsSnapshot, RevokedSnapshot, SearchBuildResult, SearchIndexStatus, SearchSnapshot, SessionsSnapshot, SimpleResult, StorageSnapshot, SummaryRecordSnapshot, SummaryTask, SummaryTaskMutationResult, SummaryTaskRunResult, SummaryTaskSnapshot, VerifyImageKeyResult, VerifyKeyResult, VideoInfoResult, VoiceDataUrlResult, VoiceInfoResult, VoiceTranscriptResult, VoiceTranscribeOneResult, VoiceTranscribeResult, WechatConfigFull, WechatConfigPatch, WhisperDownloadResult, WhisperStatus, AssetInsightsSnapshot, BackupRestoreResult, Contact360Snapshot, DbHealthSnapshot, GroupInsightsSnapshot, HandoffRemindsSnapshot, LedgerSnapshot, MediaAssetsSnapshot, MomentsInsightsSnapshot, MomentsMonthlyRow, OfficialAssetsSnapshot, OperationLogClearResult, OperationLogQuery, OperationLogSnapshot, PeriodSummaryResult, PrivacyAuditClearResult, PrivacyAuditRow, PrivacyStateSnapshot, RegionMapSnapshot, TaskMutationResult, TasksSnapshot, UnifiedSearchSnapshot, KnowledgeSnapshot, NotesSnapshot, NoteMutationResult } from './types.ts';
import type { FeedbackRecord, RerankWeights } from './query/retrieval/types.ts';
import { type AnnualReview } from './query/annual-review.ts';
/** 批量取图的返回条目（`url`/`error` 与单张入口同义）。 */
interface ImageBatchItem {
    username: string;
    localId: number;
    url?: string;
    format?: string;
    error?: string;
}
/** Remote-only service exposing WeChat data queries. */
export declare class WechatDataGateway extends TypertRemoteService {
    /** Services this gateway depends on at runtime (LLM + default model). */
    static inject: string[];
    private readonly _ctx;
    private readonly _dirs;
    /**
     * 登录账号 wxid 的**带失效**缓存。
     *
     * 不能在构造函数里算一次就固定：`数据配置` 里切换微信账号只改 `db_dir`
     * （解密目录不变），本进程不会重启。缓存住旧 wxid 会让 `isSender` 拿
     * **上一个账号**的 wxid 去比对，于是新账号里每条消息的「我 / 对方」全部反转
     * —— 属于最严重的归属错误。这里按 (解密目录, config.db_dir) 记忆：
     * 账号一换键就变，自动重算。
     */
    private _selfUsername;
    private _selfUsernameKey;
    private _schedBusy;
    /**
     * 最近若干轮问答的检索特征画像（retrievalId → 特征/引用映射）。
     * 用户提交反馈时用它把「哪条引用有用」翻译成「哪个特征该加权」。
     * 有界（≤20 轮），不落盘 —— 纯进程内、只在反馈那一刻需要。
     */
    private readonly _askTrace;
    /** Live decrypt progress (polled by the settings panel). */
    private readonly decryptState;
    /** Active whisper model download (polled by the settings panel). */
    private whisperDownload;
    /** Active voice batch transcription (polled by the settings panel). */
    private whisperTranscribing;
    /** 导出/加密备份的控制槽：jobId → 取消令牌 + 最近一次进度（见 {@link StreamJob}）。 */
    private readonly _streamJobs;
    /**
     * 反馈去重窗口（N27）：键 → 到期时间。
     *
     * 为什么不是 `inflightXxx: Set` 那种「在飞合并」的闸：`submitAskFeedback` 是**同步** RPC，
     * 函数体在事件循环里一口气跑完，两个「并发」调用不会交错 ⇒ 在飞表恒为空，那是个假闸。
     * 真正的重复是「同一轮被提交两次」且两次都真跑完（多一条反馈记录 + 按重复特征重算权重 +
     * 两条审计），所以按内容键 + 时间窗去重（见 {@link ASK_FEEDBACK_DEDUPE_MS}）。
     */
    private readonly _askFeedbackSeen;
    /**
     * 已知实体名缓存（问答的「点名识别」用）：按解密目录记忆。
     *
     * 为什么缓存：这份名单要读联系人表 + 会话表（两次 SQLite 打开），而每次提问都要用；
     * 名单在会话存续期内变化极小，记一次就够。换数据目录（换账号）时按 key 自然失效。
     */
    private readonly _knownEntities;
    /**
     * 当前登录账号的 wxid（消息 `isSender` 判定的基准）。
     *
     * 按 (解密目录, config.db_dir) 记忆：只要账号没换就直接命中缓存，
     * 换了账号（`data 配置` 里选另一个账号的 db_storage）或换了数据目录则重算。
     * 每次取用时只多读一次 `getConfig`（带文件签名缓存的 JSON 读），代价可忽略。
     * @returns 登录账号 wxid；解析不到时为空串。
     */
    private selfUsername;
    /**
     * 取（或新建）一个长任务的控制槽，并包成 query 层要的 {@link StreamControl}（M3）。
     *
     * 每次调用都换一个**新的** AbortController：同一个 jobId 被复用（先取消、再重跑）时，
     * 复用一个已 abort 的令牌会让新一轮导出刚起步就抛「已取消」。
     * @param jobId - 渲染层生成的标识；缺省/空白时返回空控制（＝无进度、不可取消，
     *   旧调用方的行为完全不变）。
     * @returns 含 `signal` 与 `onProgress` 的控制对象，可直接透传给 query 层。
     */
    private streamControl;
    /**
     * 收尾一个长任务：标记结束（槽位留着，让迟到的 `getExportProgress` 能读到终态与错误）。
     * @param jobId - 任务标识。
     * @param error - 失败/取消原因；成功时省略。
     */
    private finishStreamJob;
    constructor(ctx: Context);
    /**
     * Append one operation-log row. Metadata only — never message bodies or
     * image/file contents — so an export stays safe to share. Best-effort: a
     * logging failure never affects the operation it records.
     */
    private op;
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
    private outboundBlocked;
    private privacyBlocked;
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
    private privacyGate;
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
    private askKnownEntities;
    /**
     * 构造「过隐私闸门」的 embedding 函数（稠密检索通道用）。
     *
     * 所有 embedding 调用都必须先过与 chat 出站同一道闸门：开启「出站拦截」时抛错
     * （流水线自动降级为纯稀疏），开启「敏感字段脱敏」时发送脱敏后的文本，并写审计。
     * @param model - 向量模型名（空则回退 chat model）。
     * @returns embedding 函数；底层 LLM 桥未提供 embed 时返回 undefined。
     */
    private makeEmbedFn;
    /**
     * 读取「自动获取原图（CDN）」与「原图解密方式」两个开关（N24）。
     *
     * 这两个键在界面上可见（设置 → 图片解码），此前**没有任何消费者** —— 关掉后取图路径照旧
     * 出网，用户看到的是「开关说是关的、行为却不是」。所有远端取媒体（表情 / 公众号封面 /
     * 朋友圈视频与封面）都在这里统一取值再传进 query 层，保证「关掉 = 不发请求」。
     * @returns cdnEnabled=false 时 query 层会在发请求前返回；localDecrypt=false 表示服务端解密。
     */
    private cdnSwitches;
    getSessions(options?: {
        keyword?: string;
        limit?: number;
        offset?: number;
    }): SessionsSnapshot;
    /**
     * Contact book.
     * @param options - Optional page size + offset for incremental loading, plus a
     *   category filter (friend/group/official/service/enterprise/member/system/deleted).
     *   The filter is applied **before** pagination so a category tab shows its own
     *   complete list and an accurate `total`.
     * @returns ContactsSnapshot: contacts list (items + total) + per-category stats.
     */
    getContacts(options?: {
        limit?: number;
        offset?: number;
        category?: string;
    }): ContactsSnapshot;
    /**
     * One-screen data overview.
     * @returns OverviewSnapshot: aggregate counts for the overview screen.
     */
    getOverviewInsights(): OverviewInsights;
    getOverview(): OverviewSnapshot;
    /**
     * Friend-region map (世界板块地图): world → country → province → city → friends.
     * @returns RegionMapSnapshot.
     */
    getRegionMap(): RegionMapSnapshot;
    /**
     * Records (revokes/transfers/redpackets/finder/miniprograms/friendverifications).
     * @param options - Record kind to query plus pagination/filter options.
     * @returns RecordsSnapshot: record items (items + total).
     */
    getRecords(options: {
        kind: string;
        limit?: number;
        offset?: number;
        q?: string;
        from?: number;
        to?: number;
        direction?: 'asc' | 'desc';
    }): RecordsSnapshot;
    /**
     * Contact / group-member search.
     * @param options - search term, optional limit and room scope.
     * @returns MemberSearchSnapshot: matching members (items + total + source).
     * 保留理由：界面暂无入口（全局搜索走 searchUnified），保留给宿主/后续的群成员选择器。
     *   第 96 轮补上了群内路径漏掉的 `quan_pin`/`alias`（此前「按备注全拼在群里搜人」永远搜不到），
     *   由 `scripts/check-members-search.js` 对着真实库把关。
     */
    searchMembers(options: {
        q: string;
        limit?: number;
        roomUsername?: string;
    }): MemberSearchSnapshot;
    /**
     * Revoked messages.
     * @param options - Optional limit for the number of rows returned.
     * @returns RevokedSnapshot: revoked message items.
     */
    getRevoked(options?: {
        limit?: number;
        offset?: number;
    }): RevokedSnapshot;
    /**
     * Custom emoticons.
     * @param options - Optional limit/offset for incremental loading.
     * @returns EmoticonsSnapshot: emoticon items.
     */
    getEmoticons(options?: {
        limit?: number;
        offset?: number;
    }): EmoticonsSnapshot;
    /**
     * Storage stats.
     * @returns StorageSnapshot: per-category storage usage stats.
     */
    getStorageStats(): StorageSnapshot;
    /**
     * Annual years.
     * @returns AnnualSnapshot: available yearly overview data.
     */
    getAnnual(): AnnualSnapshot;
    /**
     * WeChat config summary.
     * @returns ConfigSnapshot: current WeChat config summary.
     */
    getWechatConfig(): ConfigSnapshot;
    /**
     * Privacy scan.
     * @returns PrivacySnapshot: privacy scan result.
     */
    getPrivacyScan(): PrivacySnapshot;
    /**
     * Relationship graph.
     * @returns GraphSnapshot: chat relationship graph data.
     */
    getGraph(): GraphSnapshot;
    /**
     * Knowledge notes list.
     * @param options - Optional case-insensitive search query and row cap.
     * @returns NotesSnapshot: notes (newest first) plus the unpaged total.
     */
    getNotes(options?: {
        query?: string;
        limit?: number;
    }): NotesSnapshot;
    /**
     * Create (no `id`) or update (`id` given) one knowledge note.
     *
     * `sourceKind: 'ask'` marks a note distilled from a WeChat Q&A answer — that
     * is the join point with the social graph: the panel draws an edge from the
     * note to its source chat instead of leaving knowledge nodes floating.
     * @param options - Note fields; title is required and unique (case-insensitive).
     * @returns NoteMutationResult: `{ ok, id }`, or `{ ok: false, error }`.
     */
    saveNote(options: {
        id?: number;
        title: string;
        body?: string;
        tags?: string[] | string;
        sourceKind?: 'manual' | 'ask';
        sourceUsername?: string;
        sourceQuestion?: string;
    }): NoteMutationResult;
    /**
     * Delete one knowledge note.
     * @param options - Note id.
     * @returns NoteMutationResult.
     */
    deleteNote(options: {
        id: number;
    }): NoteMutationResult;
    /**
     * Knowledge graph: note nodes, `[[…]]` edges and unresolved stubs.
     *
     * 与 `getGraph` 分开而不是合并：社交图谱的节点口径（联系人/群/我）和知识图谱
     * （笔记/未解析目标）是两套语义，合并会让两个面板都变脆；融合视图交给前端把
     * 两份快照按 `sourceUsername` 拼起来（笔记 → 来源会话）。
     * @returns KnowledgeSnapshot.
     */
    getKnowledgeGraph(): KnowledgeSnapshot;
    /**
     * Moments page.
     * @param options - Pagination (offset/limit) and optional author filter.
     * @returns MomentsSnapshot: moments items (items + total).
     */
    getMoments(options?: {
        offset?: number;
        limit?: number;
        author?: string;
    }): MomentsSnapshot;
    /**
     * Return the current account's own WeChat username (user_name).
     * @returns { username } - used by the panel to filter "我" authored comments.
     */
    getSelfUsername(): {
        username: string;
    };
    /**
     * Full-history author activity counts (ranked desc).
     * @returns Array of { name, count } for every moments author.
     */
    getMomentsAuthors(): Array<{
        name: string;
        count: number;
    }>;
    /**
     * Favorites list.
     * @param options - Optional limit for the number of rows returned.
     * @returns FavoritesSnapshot: favorite items (items + total).
     */
    getFavorites(options?: {
        limit?: number;
        offset?: number;
    }): FavoritesSnapshot;
    /**
     * Resource files.
     * @param options - Optional limit/offset and category filter for incremental loading.
     * @returns FilesSnapshot: resource file items.
     */
    getFiles(options?: {
        limit?: number;
        offset?: number;
        category?: string;
    }): FilesSnapshot;
    /**
     * Messages of one talker.
     * @param options - Talker username, optional limit and pagination cursor.
     * @returns MessagesSnapshot: message items for the talker.
     */
    getMessages(options: {
        talker: string;
        limit?: number;
        cursor?: number;
        cursorLocalId?: number;
    }): MessagesSnapshot;
    /**
     * Incremental messages newer than a sort_seq watermark (real-time polling).
     * @param options - talker, after watermark, optional limit.
     * @returns MessagesSnapshot with only the newer messages.
     */
    getNewMessages(options: {
        talker: string;
        after: number;
        limit?: number;
    }): MessagesSnapshot;
    /**
     * Search index status.
     * @returns SearchIndexStatus: whether the FTS5 index exists and its row count.
     */
    getSearchIndexStatus(): SearchIndexStatus;
    /**
     * Build (or rebuild) the FTS5 message search index.
     * @param options - force: rebuild even when the index already exists.
     * @returns SearchBuildResult: build outcome with row counts.
     */
    buildSearchIndex(options?: {
        force?: boolean;
    }): Promise<SearchBuildResult>;
    /**
     * Full-text search over text messages (index first, scan fallback).
     * @param options - query string, optional result limit and optional talker scope.
     * @returns SearchSnapshot: matched message items.
     */
    searchMessages(options: {
        query: string;
        limit?: number;
        username?: string;
    }): SearchSnapshot;
    /**
     * Group chat info (群聊信息): name/remark, announcement, own alias, member
     * grid and local settings mirror.
     * @param options - chatroom username.
     * @returns GroupInfoSnapshot: the group (null when unknown).
     */
    getGroupInfo(options: {
        username: string;
    }): GroupInfoSnapshot;
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
    getPaymentStatus(options: {
        serverId: string;
    }): PaymentStatus;
    resolveChatHistory(options: {
        serverId: string;
    }): ChatHistoryResolveResult;
    /**
     * Per-day message counts for one month (chat calendar heatmap).
     * @param options - username, year and month to aggregate.
     * @returns CalendarSnapshot: per-day message counts.
     */
    getDailyCounts(options: {
        username: string;
        year: number;
        month: number;
    }): CalendarSnapshot;
    /**
     * Look up one voice message (silk decode degrades in Node).
     * @param options - username and localId of the voice message.
     * @returns VoiceInfoResult: voice metadata / decoded file info.
     */
    getVoiceInfo(options: {
        username: string;
        localId: number;
    }): VoiceInfoResult;
    /**
     * Resolve one voice message to an inline-playable wav data URL.
     * 语音实体是 silk，需要解码成 wav 才能播；产物落在转写链路同一份缓存里。
     * @param options - username and localId of the voice message.
     * @returns VoiceDataUrlResult: base64 wav data URL (+ duration) or error.
     */
    getVoiceDataUrl(options: {
        username: string;
        localId: number;
    }): VoiceDataUrlResult;
    /**
     * Look up one video message: cover thumbnail + the on-disk video path.
     * 封面与实体都在真实微信目录 `msg/video` 下，所以要带上数据根目录。
     * @param options - username and localId of the video message.
     * @returns VideoInfoResult: video cover/thumbnail info.
     */
    getVideoInfo(options: {
        username: string;
        localId: number;
    }): VideoInfoResult;
    /**
     * Export a conversation messages to txt/csv/excel/html.
     *
     * M3：本入口改为 `async` 并走**流式**实现 —— 同步版必须「先把整份 xlsx 拼进内存」，
     * 行数一大峰值就与行数成正比；`exportSessionMessagesStreamed` 把 sheet 逐块写进 zip 条目
     * （峰值与行数无关）。契约没变：仍是 `Promise<ExportResult>`，客户端镜像无需改。
     * @param options - username, export format and optional message count.
     * @returns ExportResult: exported file path/count info.
     */
    exportSessionMessages(options: {
        username: string;
        format: string;
        count?: number;
        dir?: string;
        types?: number[];
        richTypes?: string[];
        from?: number;
        to?: number;
        filename?: string;
        zip?: boolean;
        /** 会话显示名，仅用于导出历史的可读说明（不参与导出本身）。 */
        sessionName?: string;
    }): Promise<ExportResult>;
    /**
     * 记一条导出历史（best-effort）。
     *
     * 为什么放在网关而不是各导出函数内部：`recordExport` 需要「解密数据根」来定位历史库，
     * 而各 `export*.ts` 函数都拿到了 `decryptedDir` —— 但重跑参数只有网关这一层完整掌握
     * （客户端传什么原样存下来），所以在网关这层记录最不容易漏字段。
     * @param input - 本次导出的事实。
     */
    private recordExport;
    /**
     * 构造「回答增量」事件推送器。
     *
     * 为什么节流：每个增量都要跨 IPC → 渲染进程 → React setState，模型一秒能吐几十个
     * delta，不节流会把开销压到生成本身上。80ms 约等于 12fps，视觉上已足够连续。
     * @param streamId - 客户端生成的流式标识；为空表示不推送（非流式调用方）。
     * @returns 增量回调（text 为**已生成的全文**）。
     */
    private makeDeltaEmitter;
    /**
     * AI Q&A over WeChat data: retrieve context + DSH LLM answer with citations.
     * @param options - question to ask over the WeChat data.
     * @returns AskResult: LLM answer with citations.
     */
    askWechat(options: {
        question: string;
        username?: string;
        from?: string;
        to?: string;
        history?: Array<{
            role: 'user' | 'assistant';
            content: string;
        }>;
        /** 客户端生成的流式标识：带上它才会推送 wechat-ask/delta 增量事件。 */
        streamId?: string;
    }): Promise<AskResult>;
    /**
     * 提问优化：把用户问题改写为更利于本机检索的形式，并给出改进建议。
     * 供「微信问答」面板的「优化提问」按钮调用；出站前同样过隐私闸门。
     * @param options - question（必填）+ 可选 scope/history 作上下文。
     * @returns AskOptimizeResult: optimized + suggestions。
     */
    optimizeAskQuestion(options: {
        question: string;
        username?: string;
        from?: string;
        to?: string;
        history?: Array<{
            role: 'user' | 'assistant';
            content: string;
        }>;
    }): Promise<AskOptimizeResult>;
    /**
     * List local WeChat backups.
     * @returns BackupSnapshot: backup entries (items + total).
     */
    listBackups(): BackupSnapshot;
    /**
     * Preview a backup's contents (bounded file list) before restore.
     * @param options - backup name.
     * @returns BackupPreviewSnapshot: items + total.
     */
    previewBackup(options: {
        name: string;
    }): BackupPreviewSnapshot;
    /**
     * Create a local backup snapshot.
     * @returns BackupMutationResult: ok + backup name, or error.
     */
    createBackup(): BackupMutationResult;
    /**
     * Delete one backup by name.
     * @param options - name of the backup to delete.
     * @returns BackupMutationResult: ok, or error on failure.
     */
    deleteBackup(options: {
        name: string;
    }): BackupMutationResult;
    /**
     * RAG 检索层状态：配置 + 向量库 + 反馈统计 + 当前调参权重 + 意图分类自评。
     * @returns 供「数据健康 / 检索设置」面板展示。
     */
    getRetrievalStatus(): {
        enabled: boolean;
        config: unknown;
        vector: {
            rows: number;
            dim: number;
            model: string;
        };
        feedback: {
            total: number;
            up: number;
            down: number;
        };
        weights: RerankWeights;
        intentAccuracy: {
            correct: number;
            total: number;
            accuracy: number;
        };
    };
    /**
     * 保存检索参数（阈值/权重/容量）。前端面板改一个开关也走这里。
     * @param options - 形如 `{ patch: {...} }`，或直接给字段子集。
     * @returns 落盘后的完整配置。
     */
    saveRetrievalConfig(options?: {
        patch?: unknown;
    } | unknown): {
        ok: boolean;
        config: unknown;
    };
    /**
     * 立即构建/增量更新稠密向量索引（设置面板的「重建向量索引」按钮）。
     * @param options - force=true 时清空重建。
     * @returns 构建结果。
     */
    buildRagVectorIndex(options?: {
        force?: boolean;
    }): Promise<{
        ok: boolean;
        status: string;
        rows: number;
        embedded: number;
        elapsed_ms: number;
        message?: string;
    }>;
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
    submitAskFeedback(options: {
        retrievalId?: string;
        rating: 'up' | 'down';
        useful?: number[];
        useless?: number[];
        question?: string;
        answer?: string;
    }): {
        ok: boolean;
        adaptedWeights?: RerankWeights;
        features?: string[];
        message?: string;
    };
    /**
     * 列出最近的问答反馈 + 汇总统计。
     * @param options - limit。
     */
    listRetrievalFeedback(options?: {
        limit?: number;
    }): {
        items: FeedbackRecord[];
        stats: {
            total: number;
            up: number;
            down: number;
        };
    };
    /**
     * 重置调参权重回默认值（丢弃反馈带来的偏移；反馈记录本身保留）。
     */
    resetRetrievalWeights(): {
        ok: boolean;
        weights: RerankWeights;
    };
    /**
     * 跑离线召回评估（合成评测集），并给出「混合 vs 纯稀疏」的消融对比。
     *
     * 不依赖真实数据，因此可以随时在设置面板点一下就看到当前算法的 P/R/MRR/NDCG，
     * 也可以在 CI 里断言「混合不低于纯稀疏」防止退化。
     * @param options - k（截断位置，默认 10）。
     * @returns 可读报告 + 结构化指标。
     */
    evaluateRetrieval(options?: {
        k?: number;
    }): {
        report: string;
        hybrid: {
            precision: number;
            recall: number;
            mrr: number;
            ndcg: number;
            map: number;
            cases: number;
            hits: number;
        };
        sparseOnly: {
            precision: number;
            recall: number;
            mrr: number;
            ndcg: number;
            map: number;
            cases: number;
            hits: number;
        };
        intentAccuracy: {
            correct: number;
            total: number;
            accuracy: number;
        };
    };
    /**
     * Generate a daily chat summary for one date via DSH LLM.
     * @param options - date (YYYY-MM-DD) to summarize.
     * @returns DailySummaryResult: summary text with session/message counts.
     */
    generateDailySummary(options: {
        date: string;
        provider?: string;
        model?: string;
    }): Promise<DailySummaryResult>;
    /**
     * List edited messages (optionally for one session).
     * @param options - optional sessionId filter.
     * @returns EditedListSnapshot: edited message records (items + total).
     */
    listEditedMessages(options?: {
        sessionId?: string;
    }): EditedListSnapshot;
    /**
     * Edit one message content (records the original in the edit store).
     * @param options - username, localId and new content.
     * @returns EditMutationResult: ok, or error on failure.
     */
    editChatMessage(options: {
        username: string;
        localId: number;
        content: string;
    }): EditMutationResult;
    /**
     * Restore a message to its original content.
     * @param options - username and localId of the edited message.
     * @returns EditMutationResult: ok, or error on failure.
     */
    resetEditedMessage(options: {
        username: string;
        localId: number;
    }): EditMutationResult;
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
    listLlmProviders(): {
        providers: Array<{
            id: string;
            name: string;
        }>;
    };
    /** List the provider's configured models (from the "设置 → 模型" settings section), falling back to the provider catalog. */
    listLlmModels(options: {
        provider: string;
    }): Promise<{
        models: Array<{
            id: string;
            name: string;
        }>;
    }>;
    exportAnnualReport(options: {
        year: number;
        format: string;
        dir?: string;
        filename?: string;
    }): ExportResult;
    /**
     * Export ALL sessions as a single txt ZIP archive (账号归档).
     * @param options - optional dir/filename（+ 可选的 jobId：订阅 `wechat-export/progress` 进度并允许取消）.
     * @returns ExportResult: written zip path + total messages.
     */
    exportAllSessions(options?: {
        dir?: string;
        filename?: string;
        jobId?: string;
    }): Promise<ExportResult>;
    /**
     * Cancel one running export/backup job (M3).
     *
     * 渲染层点「取消」时调用：这里只唤醒 AbortController，真正的收尾（不留半成品）由
     * query 层在各耗时循环的检查点完成（`throwIfCancelled` + temp+rename）。
     * @param options - jobId the renderer passed to the export call.
     * @returns ok when a running job was aborted; error otherwise.
     */
    cancelExportJob(options: {
        jobId: string;
    }): {
        ok: boolean;
        error?: string;
    };
    /**
     * Poll one export/backup job's latest progress (M3).
     *
     * 为什么除了事件推送还要有这个轮询入口：进度事件要经过「宿主事件 → 渲染层」的中继，
     * 而中继只对白名单事件名生效（见 `ui-app/ui-entry.tsx`）。轮询不依赖中继，是
     * 「进度确实推得出去」的那条兜底路径。
     * @param options - jobId the renderer passed to the export call.
     * @returns 最近一次进度；`found:false` 表示 jobId 未知（如进程重启过）。
     */
    getExportProgress(options: {
        jobId: string;
    }): {
        found: boolean;
        phase: string;
        done: number;
        total: number;
        finished: boolean;
        error?: string;
    };
    /**
     * Export moments (朋友圈) with author + keyword + time filters.
     * @param options - format/username/authorName/q/from/to/dir/filename (+ 可选的 jobId 订阅进度/取消).
     * @returns ExportResult: written file path + count.
     */
    exportMoments(options?: {
        format?: string;
        username?: string;
        authorName?: string;
        q?: string;
        images?: boolean;
        media?: string;
        month?: string;
        mine?: string;
        zip?: boolean;
        from?: number;
        to?: number;
        dir?: string;
        filename?: string;
        jobId?: string;
    }): Promise<ExportResult>;
    /**
     * Export a CSV table.
     * @param options - `kind` (contacts/favorites/records/moments/privacy); `recordsKind`
     *   when kind=records; `dest` = the full target path the user picked in the save dialog
     *   (falls back to `<dataRoot>/exports/` when omitted); `category` narrows kind=contacts
     *   to one category so the file matches what the panel is showing.
     * @returns ExportResult (path + filename + row count).
     */
    exportCsv(options: {
        kind: string;
        recordsKind?: string;
        dest?: string;
        category?: string;
    }): ExportResult;
    /**
     * 读取导出历史（供「导出记录」弹窗）。
     * @param options - 搜索 / 种类筛选 / 状态筛选 / 时间范围 / 排序 / 分页。
     * @returns 一页条目 + 命中总数 + 各聚合计数。
     */
    getExportHistory(options?: ExportHistoryQuery): ExportHistorySnapshot;
    /**
     * 删除若干条导出历史记录。
     *
     * `deleteFiles` **默认为 false**：删记录与删文件是两件事，风险差一个量级，
     * 必须由界面显式选择（见 `query/export-history.ts` 的说明）。
     * @param options - ids + 是否连带删除磁盘文件。
     * @returns 删除计数与文件删除失败清单。
     */
    deleteExportHistory(options: {
        ids: number[];
        deleteFiles?: boolean;
    }): ExportHistoryDeleteResult;
    /**
     * 按策略清理导出历史（按天数 / 保留最近 N 条 / 只清失效记录）。
     * @param options - 清理策略；三项都缺省时**什么都不删**（安全闸）。
     * @returns 删除计数与文件删除失败清单。
     */
    pruneExportHistory(options?: ExportHistoryPruneOptions): ExportHistoryDeleteResult;
    /**
     * Clear one session draft (decrypted copy only).
     * @param options - username of the session to clear.
     * @returns DraftClearResult: ok, or error on failure.
     */
    clearSessionDraft(options: {
        username: string;
    }): DraftClearResult;
    /**
     * Clear all session drafts, returning the cleared list.
     * @returns DraftsClearResult: cleared session list (items + total).
     */
    clearAllSessionDrafts(): DraftsClearResult;
    /**
     * List daily-summary tasks.
     * @returns SummaryTaskSnapshot: summary tasks (items + total).
     */
    listSummaryTasks(): SummaryTaskSnapshot;
    /**
     * Save (insert/update) a daily-summary task.
     * @param options - task payload (id present = update, absent = insert).
     * @returns SummaryTaskMutationResult: ok + id, or error.
     */
    saveSummaryTask(options: {
        task: Omit<SummaryTask, 'id' | 'createdAt' | 'updatedAt'> & {
            id?: number;
        };
    }): SummaryTaskMutationResult;
    /**
     * Delete a daily-summary task.
     * @param options - id of the task to delete.
     * @returns SummaryTaskMutationResult: ok, or error on failure.
     */
    deleteSummaryTask(options: {
        id: number;
    }): SummaryTaskMutationResult;
    /**
     * Toggle a daily-summary task enabled state.
     * @param options - task id and the new enabled flag.
     * @returns SummaryTaskMutationResult: ok, or error on failure.
     */
    toggleSummaryTask(options: {
        id: number;
        enabled: boolean;
    }): SummaryTaskMutationResult;
    /**
     * List generated summary records.
     * @param options - optional taskId filter.
     * @returns SummaryRecordSnapshot: summary records (items + total).
     */
    listSummaryRecords(options?: {
        taskId?: number;
    }): SummaryRecordSnapshot;
    /**
     * Delete one generated summary record.
     * @param options - id of the record to delete.
     * @returns SummaryTaskMutationResult: ok, or error on failure.
     */
    deleteSummaryRecord(options: {
        id: number;
    }): SummaryTaskMutationResult;
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
    private static readonly DUE_SUMMARY_CONCURRENCY;
    /** Run any enabled daily-summary task whose schedule time matches the current minute. */
    private maybeRunDueTasks;
    runSummaryTask(options: {
        id: number;
    }): Promise<SummaryTaskRunResult>;
    /**
     * Resolve a user avatar (head_image.db data or contact URL).
     * @param options - username to resolve the avatar for.
     * @returns AvatarResult: avatar data URL or fallback info.
     */
    getAvatar(options: {
        username: string;
        nickname?: string;
    }): AvatarResult;
    /**
     * 批量读取头像(head_image.db 优先,未命中再用 contact 表 URL 兜底;一次 RPC)。
     * @param options - usernames 列表。
     * @returns username → data URL(本地)或 https URL(远端兜底)映射;未命中的不在其中。
     */
    getAvatarsLocal(options: {
        usernames: string[];
    }): Record<string, string>;
    /**
     * Read the full WeChat config (incl. keys + resolved paths).
     * @returns WechatConfigFull: complete config with resolved paths.
     */
    getWechatConfigFull(): WechatConfigFull;
    /**
     * Save the WeChat config (merge patch).
     * @param options - patch of config fields to merge.
     * @returns SimpleResult: ok, or error on failure.
     */
    saveWechatConfig(options: {
        patch: WechatConfigPatch;
    }): SimpleResult;
    /**
     * Whisper transcription configuration status: engine detection, CUDA
     * presence, models dir + installed ggml binaries, active download progress
     * (inference itself stays bridge-side).
     * @returns WhisperStatus: engine/hasCuda/models inventory.
     */
    getWhisperStatus(): WhisperStatus;
    /**
     * Download one official whisper.cpp ggml model into the models dir
     * (streamed, atomic publish; huggingface.co with hf-mirror fallback).
     * @param options - model id to download.
     * @returns WhisperDownloadResult: ok + file/bytes, or an error.
     */
    downloadWhisperModel(options: {
        model: string;
    }): Promise<WhisperDownloadResult>;
    /**
     * Detect installed WeChat 4.x accounts.
     * @returns AccountsSnapshot: detected accounts (accounts + total).
     */
    detectWechatAccounts(): AccountsSnapshot;
    /**
     * Verify a database key (SQLCipher PBKDF2 + AES + HMAC).
     * @param options - dbPath and encKeyHex of the key to verify.
     * @returns VerifyKeyResult: valid flag plus optional AES/HMAC checks.
     */
    verifyDatabaseKey(options: {
        dbPath: string;
        encKeyHex: string;
    }): VerifyKeyResult;
    /**
     * Verify all DBs in db_dir and write all_keys.json.
     * @param options - dbDir, keysFile, encKeyHex and optional keyFormat.
     * @returns GenerateKeysResult: generation outcome.
     */
    generateKeysFile(options: {
        dbDir: string;
        keysFile: string;
        encKeyHex: string;
        keyFormat?: string;
    }): GenerateKeysResult;
    /**
     * Read all_keys.json info.
     * @returns KeysInfoResult: key format/count/loaded state.
     */
    getWechatKeysInfo(): KeysInfoResult;
    /**
     * Auto-recover the V4 database key from the running WeChat process
     * (key_v4 memory scan + Weixin.dll internal-key unmask).
     * @param options - optional probe db path and install dir.
     * @returns AutoDbKeyResult: ok + 64-hex key, or an error.
     */
    autoGetDbKey(options: {
        dbPath?: string;
        wechatInstallDir?: string;
    }): Promise<AutoDbKeyResult>;
    /**
     * Auto-recover the image key (V2-verified): a saved-and-valid config key
     * pair is returned first; otherwise the running WeChat process memory is
     * scanned.
     * @param options - account dir (wxid_* 文件夹或其 db_storage) and optional pid.
     * @returns AutoImageKeyResult: ok + xor/aes pair, or an error.
     */
    autoGetImageKey(options: {
        accountDir?: string;
        pid?: number;
    }): Promise<AutoImageKeyResult>;
    /**
     * Verify the saved image key pair against real V2 templates.
     * @returns VerifyImageKeyResult: verified flag + xor/template evidence.
     */
    /** Open the owned WeChat config.json (e.g. for manual edit). @returns the opened path. */
    /** Open an owned path (config/output dir/file) with the system default. @returns the opened path. */
    openPath(options: {
        path: string;
    }, signal: AbortSignal): Promise<{
        ok: boolean;
        path: string;
    }>;
    /**
     * 保留理由：与「数据配置」面板现有那条路径等价 —— 界面用 `getWechatPathConfig()` 拿到路径后
     *   再 `openPath()` 打开（Settings.tsx）。这里保留一份「直接打开 config.json」的接口给宿主调用。
     */
    openConfig(signal: AbortSignal): Promise<{
        ok: boolean;
        path: string;
    }>;
    verifyImageKey(): VerifyImageKeyResult;
    /**
     * Full SQLCipher decryption: every .db under db_storage is re-decrypted
     * into the decrypted snapshot (逐库原子发布,单库失败不中断)。实时进度
     * 通过 getDecryptStatus 轮询读取。
     * @returns DecryptAllResult: total/ok/failed counts.
     */
    decryptAllDatabases(): Promise<DecryptAllResult>;
    /**
     * Batch-decode every md5-prefixed .dat image under msg/attach into the
     * decoded-images cache (并行池,已缓存/HEVC 跳过)。实时进度通过
     * getDecryptStatus 轮询读取。
     * @param options - optional worker concurrency (clamped 1..32).
     * @returns DecryptImagesResult: total/ok/failed/skipped counts.
     */
    decryptAllImages(options: {
        concurrency?: number;
    }): Promise<DecryptImagesResult>;
    /**
     * Live decryption progress snapshot (polled by the settings panel).
     * @returns DecryptStatus: op/done/total/failed/skipped + current item.
     */
    getDecryptStatus(): DecryptStatus;
    /**
     * Download + install the whisper.cpp CLI engine into the models dir
     * (`<modelsDir>/bin/whisper-cli.exe`), persisting the path as whisper_bin.
     * @returns WhisperDownloadResult: ok + path, or an error.
     */
    installWhisperEngine(): Promise<WhisperDownloadResult>;
    /**
     * Batch-transcribe the most recent voice messages: silk → WAV (bundled
     * wx_silk) → whisper-cli with the selected model → text cached per message.
     * @param options - optional message count (default 50, clamped 1..200).
     * @returns VoiceTranscribeResult: done/failed/skipped counts.
     */
    transcribeVoiceBatch(options: {
        limit?: number;
    }): Promise<VoiceTranscribeResult>;
    /**
     * Cached transcript for one voice message (if already transcribed).
     * @param options - message username + local_id.
     * @returns VoiceTranscriptResult: text or an error.
     */
    getVoiceTranscript(options: {
        username: string;
        localId: number;
    }): VoiceTranscriptResult;
    /**
     * Transcribe one voice message on demand (chat bubble 语音转文字).
     * @param options - message username + local_id.
     * @returns VoiceTranscribeOneResult: ok + text, or an error.
     */
    transcribeVoiceMessage(options: {
        username: string;
        localId: number;
    }): VoiceTranscribeOneResult;
    /**
     * Set CDN auto-fetch flag.
     * @param options - enabled: whether CDN auto-fetch is on.
     * @returns SimpleResult: ok, or error on failure.
     */
    setCdnImageEnabled(options: {
        enabled: boolean;
    }): SimpleResult;
    /**
     * Set CDN local/service decrypt flag.
     * @param options - localDecrypt: whether decryption runs locally.
     * @returns SimpleResult: ok, or error on failure.
     */
    setCdnImageLocalDecrypt(options: {
        localDecrypt: boolean;
    }): SimpleResult;
    /**
     * Delete favorite items by local_id.
     * @param options - ids of the favorite items to delete.
     * @returns DeleteFavoriteResult: ok + deleted count, or error.
     */
    deleteFavoriteItems(options: {
        ids: number[];
    }): DeleteFavoriteResult;
    /**
    /**
     * 年度回顾（看板）：15 张卡片所需的完整年度聚合。
     * 「人物类」指标只算我发出的（real_sender_id 归属），「规模类」算全部消息。
     * @param options - year to compute the report for.
     * @returns AnnualReview: 完整看板数据。
     */
    getAnnualReview(options: {
        year: number;
    }): AnnualReview;
    getAnnualReport(options: {
        year: number;
    }): AnnualReport;
    /**
     * Decrypted DB status summary.
     * @returns DbStatusSnapshot: per-database status summary.
     */
    getDbStatus(): DbStatusSnapshot;
    /**
     * Decode one message image to a base64 data URL.
     * @param options - username and localId of the message image.
     * @returns ImageDataUrlResult: base64 data URL or error.
     */
    getImageDataUrl(options: {
        username: string;
        localId: number;
    }): ImageDataUrlResult;
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
    getImageDataUrlsBatch(options: {
        items: Array<{
            username: string;
            localId: number;
        }>;
    }): {
        items: ImageBatchItem[];
    };
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
    private warmDecodedImages;
    /**
     * Resolve one SNS (朋友圈) media md5 to an offline base64 data URL
     * from the WeChat cache/<month>/Sns/Img V2-encrypted blobs.
     * @param options - media md5 from the moments XML.
     * @returns ImageDataUrlResult: base64 data URL or error.
     */
    getSnsImageDataUrl(options: {
        md5: string;
        timelineId?: string;
        mediaId?: string;
    }): ImageDataUrlResult;
    /**
     * Resolve a file-library image (hardlink md5) to an offline base64 data URL.
     * 优先读已解密缓存，否则通过 hardlink.db 定位 .dat 原图解密。
     * @param options - file md5.
     * @returns ImageDataUrlResult: base64 data URL or error.
     */
    getFileImageDataUrl(options: {
        md5: string;
    }): ImageDataUrlResult;
    /**
     * Resolve a custom emoticon (sticker) md5 to an offline base64 data URL.
     * 先读 decoded 缓存 → 扫 msg/attach 与微信的表情缓存目录里解密；
     * 本地解不开时（微信 4.x 的表情缓存是加密文件，项目里没有对应解码器）
     * 用消息 XML 带来的 `cdnurl` 下载一次并落进 decoded 缓存。
     * @param options - emoticon md5 (+ optional CDN url from the message).
     * @returns ImageDataUrlResult: base64 data URL or error.
     */
    getEmoticonDataUrl(options: {
        md5: string;
        emojiUrl?: string;
    }): Promise<ImageDataUrlResult>;
    /**
     * Resolve a 公众号 article cover (og:image) to a base64 data URL.
     * @param options - mp.weixin.qq.com article URL.
     * @returns ImageDataUrlResult: base64 data URL or error.
     */
    getArticleCover(options: {
        contentUrl: string;
    }): Promise<ImageDataUrlResult>;
    /**
     * Resolve a received message file (msg/file) to a base64 data URL.
     * @param options - original file name from the message card.
     * @returns ImageDataUrlResult: data URL or error.
     */
    getMessageFile(options: {
        fileName: string;
        size?: number;
        createTime?: number;
    }): ImageDataUrlResult;
    /**
     * Add a WeChat task.
     * @param options - title + optional dueAt.
     * @returns TaskMutationResult.
     */
    addTask(options: {
        title: string;
        dueAt?: number;
    }): TaskMutationResult;
    clearOperationLog(): OperationLogClearResult;
    clearPrivacyAudit(): PrivacyAuditClearResult;
    createEncryptedBackup(options: {
        password: string;
        jobId?: string;
    }): Promise<BackupMutationResult>;
    deleteTask(options: {
        id: number;
    }): TaskMutationResult;
    extractTasks(options?: {
        days?: number;
    }): TaskMutationResult;
    generatePeriodSummary(options: {
        from: string;
        to: string;
        provider?: string;
        model?: string;
    }): Promise<PeriodSummaryResult>;
    getAssetInsights(): AssetInsightsSnapshot;
    getContact360(options: {
        username: string;
    }): Contact360Snapshot;
    getDbHealth(): DbHealthSnapshot;
    getCalls(options?: {
        topPeers?: number;
        recentLimit?: number;
    }): CallsSnapshot;
    getGroupInsights(options: {
        username: string;
    }): GroupInsightsSnapshot;
    /**
     * 保留理由：读 `general.db` 的 `handoff_remind_v0`（微信自带待办提醒）。本机实测**这张表不存在**
     *   （22 个库里没有任何 `handoff%` 表）⇒ 界面若直接接上去只会永远显示空列表，因此只保留接口；
     *   「待办日程」面板用的是导入路径 `syncHandoffTasks`（把源数据落进插件自己的任务库）。
     */
    getHandoffReminds(): HandoffRemindsSnapshot;
    getLedger(options?: {
        month?: string;
    }): LedgerSnapshot;
    getMediaAssets(): MediaAssetsSnapshot;
    getMomentsInsights(options?: {
        author?: string;
    }): MomentsInsightsSnapshot;
    getMomentsMonthly(options?: {
        author?: string;
        authorName?: string;
    }): MomentsMonthlyRow[];
    getOfficialAssets(): OfficialAssetsSnapshot;
    getOperationLog(options?: OperationLogQuery): OperationLogSnapshot;
    getPrivacyAuditRows(): PrivacyAuditRow[];
    getPrivacyState(): PrivacyStateSnapshot;
    /**
     * Resolve one SNS (朋友圈) video cover.
     *
     * 先本机缓存（明文、离线）；没有缓存再按 XML 里的 `<thumb>` 从微信 CDN 取回，
     * 取回要过隐私闸门，并按 `<enc key>` 解密加密头（封面同样是加密流）。
     *
     * @param options - XML 里的 md5/缓存键，加上 `<thumb>` 地址与 `<enc key>` 种子。
     * @returns ImageDataUrlResult。
     */
    getSnsVideoCoverDataUrl(options: {
        md5?: string;
        timelineId?: string;
        mediaId?: string;
        thumb?: string;
        key?: string;
    }): Promise<ImageDataUrlResult>;
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
    getSnsVideoDataUrl(options: {
        md5?: string;
        timelineId?: string;
        mediaId?: string;
        url?: string;
        key?: string;
    }): Promise<ImageDataUrlResult>;
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
    exportSnsVideo(options: {
        md5?: string;
        timelineId?: string;
        mediaId?: string;
        url?: string;
        key?: string;
        dest: string;
    }): Promise<{
        ok: boolean;
        bytes?: number;
        source?: string;
        error?: string;
    }>;
    listTasks(): TasksSnapshot;
    restoreBackup(options: {
        name: string;
        password: string;
    }): BackupRestoreResult;
    searchUnified(options: {
        query: string;
        limit?: number;
    }): UnifiedSearchSnapshot;
    setPrivacyState(options: {
        redactSensitive?: boolean;
        blockOutbound?: boolean;
    }): PrivacyStateSnapshot;
    setTaskStatus(options: {
        id: number;
        status: 'open' | 'done';
    }): TaskMutationResult;
    syncHandoffTasks(): TaskMutationResult;
}
export default WechatDataGateway;
