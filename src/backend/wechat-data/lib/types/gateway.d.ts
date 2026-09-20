/**
 * WeChatDataGateway — Host Remote service exposing st_control's decrypted
 * WeChat SQLite through the DSH Typert RPC. The browser client calls
 * ctx.remote.wechatData.* instead of an HTTP API.
 */
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { Context } from '@deepseek-ai/cordis';
import type { AccountsSnapshot, AnnualReport, AnnualSnapshot, AskHistoryClearResult, AskHistoryDeleteResult, AskHistoryQuery, AskHistorySnapshot, AskOptimizeResult, AskResult, AutoDbKeyResult, AutoImageKeyResult, AvatarResult, BackupMutationResult, BackupPreviewSnapshot, BackupSnapshot, CalendarSnapshot, CallsSnapshot, ChatHistoryResolveResult, ConfigSnapshot, ContactsSnapshot, DailySummaryResult, DbStatusSnapshot, DecryptAllResult, DecryptImagesResult, DecryptStatus, DeleteFavoriteResult, DraftClearResult, DraftsClearResult, EditMutationResult, EditedListSnapshot, EmoticonsSnapshot, ExportResult, ExportHistoryDeleteResult, ExportHistoryQuery, ExportHistorySnapshot, ExportHistoryPruneOptions, FavoritesSnapshot, FilesSnapshot, GenerateKeysResult, GraphSnapshot, GroupInfoSnapshot, ImageDataUrlResult, KeysInfoResult, MemberSearchSnapshot, MessagesSnapshot, MomentsSnapshot, OverviewInsights, OverviewSnapshot, PaymentStatus, PrivacySnapshot, RecordsSnapshot, RevokedSnapshot, SearchBuildResult, SearchIndexStatus, SearchSnapshot, SessionsSnapshot, SimpleResult, StorageSnapshot, SummaryRecordSnapshot, SummaryTask, SummaryTaskMutationResult, SummaryTaskRunResult, SummaryTaskSnapshot, VerifyImageKeyResult, VerifyKeyResult, VideoInfoResult, VoiceDataUrlResult, VoiceInfoResult, VoiceTranscriptResult, VoiceTranscribeOneResult, VoiceTranscribeResult, WechatConfigFull, WechatConfigPatch, WhisperDownloadResult, WhisperStatus, AssetInsightsSnapshot, BackupRestoreResult, Contact360Snapshot, DbHealthSnapshot, GroupInsightsSnapshot, HandoffRemindsSnapshot, LedgerSnapshot, MediaAssetsSnapshot, MomentsInsightsSnapshot, MomentsMonthlyRow, OfficialAssetsSnapshot, OperationLogClearResult, OperationLogQuery, OperationLogSnapshot, PeriodSummaryResult, PrivacyAuditClearResult, PrivacyAuditRow, PrivacyStateSnapshot, RegionMapSnapshot, TaskMutationResult, TasksSnapshot, UnifiedSearchSnapshot, NotesSnapshot, NoteMutationResult, KbDeleteAction, KbListSnapshot, KbMutationResult } from './types.ts';
import type { KbFileAddResult, KbFileChunkPage, KbFileListSnapshot, KbFileMutationResult, KbSearchResult, KbSummaryResult } from './types.ts';
import type { KbVectorBuildResult, KbVectorIndexStatus } from './query/kb-vectors.ts';
import type { KbModelRole, KbModelSettings, ResolvedModel } from './query/kb/model-config.ts';
import { type KbEntitySummary } from './query/kb/extract.ts';
import type { FeedbackRecord, RerankWeights } from './query/retrieval/types.ts';
import { type AnnualReview } from './query/annual-review.ts';
import type { KnowledgeSnapshotRead } from './query/notes.ts';
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
     * 按库向量索引的**在飞构建**进度（kbId → 进度），给面板的「语义索引」按钮轮询。
     *
     * 为什么是进程内而不是落库：这是「此刻有没有在跑、跑到哪」的瞬时态，落库就要处理
     * 进程崩溃留下的假进行中（比不显示更糟）。真正的持久事实（多少块、哪个模型、何时建的）
     * 在向量库自己的 meta 与行里，见 `kbVectorIndexStatus`。
     */
    private readonly _kbIndexJobs;
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
    private makeEmbedFn;
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
    private embedModelName;
    /**
     * 某个角色的**全局**生效模型名（还没叠库级覆盖）。
     *
     * 三个角色都从宿主桥取值：桥是唯一知道「实际会发出去什么」的地方，
     * 网关自己再拼一遍优先级就会重新制造 §7 F1 那种两条链各算一次的局面。
     * @param role - 语言 / 嵌入 / 重排序。
     * @returns 模型名；空串 = 这个角色没配。
     */
    private globalModelName;
    /**
     * 某个库、某个角色**实际该用的**模型名（库级覆盖叠在全局之上）。
     *
     * 每次调用都重读设置：`llm.json` 那条链就是「改完下一次生效、不必重启」的语义，
     * 这里缓存住就会让库级覆盖比全局配置更难改。一次 SQLite 主键查是微秒级，不心疼。
     * @param kbId - 知识库 id（非法时等价于「没有库级覆盖」）。
     * @param role - 哪个角色。
     * @returns 解析结果（含来源，界面与审计都要用它说话）。
     */
    private kbModel;
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
    private makeChatAsker;
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
    private makeRerankFn;
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
        q?: string;
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
     * Knowledge notes list of **one** knowledge base.
     *
     * 命中集与 `total` 都只统计本库：改前 `total` 是全表 `COUNT(*)`，多库之后
     * 会显示成「12 / 37」这种跨库数字。
     * @param kbId - the knowledge base to read; required, there is no "all kbs" mode.
     * @param options - Optional case-insensitive search query and row cap.
     * @returns NotesSnapshot: notes (newest first) plus the same-kb unpaged total.
     */
    getNotes(kbId: number, options?: {
        query?: string;
        limit?: number;
    }): NotesSnapshot;
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
    saveNote(kbId: number, options: {
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
     *
     * `kbId` 不是「附加信息」而是**守卫**：笔记 id 全局自增，拿着甲库的 id 调乙库
     * 会删掉甲库那一篇（数据直接没了）。归属不符时返回「笔记不存在」。
     * @param kbId - expected owner; a row belonging to another kb is **not** deleted.
     * @param options - Note id.
     * @returns NoteMutationResult.
     */
    deleteNote(kbId: number, options: {
        id: number;
    }): NoteMutationResult;
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
    getKnowledgeGraph(kbId: number): KnowledgeSnapshotRead;
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
    extractKbEntities(options: {
        kbId: number;
        fileIds?: number[];
        limit?: number;
    }): Promise<{
        ok: boolean;
        error?: string;
        files: number;
        saved: number;
        failed: Array<{
            id: number;
            error: string;
        }>;
        model: string;
    }>;
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
    suggestKbLinks(options: {
        kbId: number;
        text?: string;
        topK?: number;
        excludeTitle?: string;
    }): Promise<{
        ok: boolean;
        error?: string;
        candidates: Array<{
            label: string;
            kind: 'note' | 'entity';
            score: number;
        }>;
        pool: number;
        model: string;
        note?: string;
    }>;
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
    getKbs(): KbListSnapshot;
    /**
     * Create one knowledge base.
     * @param options - `name`: required, normalized-unique, at most `KB_NAME_MAX` chars.
     * @returns KbMutationResult: `{ ok, id }`, or `{ ok: false, error }`.
     */
    createKb(options: {
        name: string;
    }): KbMutationResult;
    /**
     * Rename one knowledge base.
     *
     * 笔记**不动**：归属存在 `kb_id` 上，库名只是显示名。用库名当外键的话，
     * 「改名」会退化成「迁移全部笔记」，还要处理迁移到一半崩掉。
     * @param options - `id` plus the new `name`.
     * @returns KbMutationResult.
     */
    renameKb(options: {
        id: number;
        name: string;
    }): KbMutationResult;
    /**
     * Delete one knowledge base.
     *
     * `action` **必填、无默认值**：库里的笔记是「搬到别的库」还是「一起删掉」只有调用方
     * 能决定，而这里最危险的默认值恰好是「一起删」—— 一次「我以为只是删个空壳库」的点击
     * 会直接把几十条笔记带走。默认库本身也不可删（它是迁移兜底）。
     * @param options - `id` plus `action` (`{kind:'reassign',targetKbId}` or `{kind:'purge'}`).
     * @returns KbMutationResult carrying `movedNotes` / `removedNotes`.
     */
    deleteKb(options: {
        id: number;
        action: KbDeleteAction;
    }): KbMutationResult;
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
    getKbFiles(kbId: number, options?: {
        limit?: number;
        offset?: number;
    }): KbFileListSnapshot;
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
    getKbFileChunks(kbId: number, fileId: number, options?: {
        limit?: number;
        offset?: number;
    }): KbFileChunkPage;
    /**
     * 登记一批文件（原生对话框多选的结果）。
     *
     * 逐个登记、逐个回执：每个文件各自一个事务，中途某一个失败不影响已经进来的那些。
     * 于是一次多选的部分失败（重复 / 类型不支持 / 太大）是**可解释**的，
     * 而不是一句笼统的「添加失败」。
     * @param options - `kbId`、`paths`（绝对路径数组）、`includeInRag`（不给按 true）。
     * @returns KbFileAddResult：`ok` = 至少进来一个；逐项原因在 `results` 里。
     */
    addKbFiles(options: {
        kbId: number;
        paths: string[];
        includeInRag?: boolean;
    }): KbFileAddResult;
    /**
     * 删除一个文件（连带它的分块 / FTS 行 / 向量 / blob 副本）。
     *
     * **不碰用户电脑上的原文件** —— 删的是知识库里的这一份，那份原文件仍然在他的盘上。
     * `kbId` 是**守卫**：文件 id 全局自增，拿甲库的 id 调乙库会删掉甲库那一条，
     * 而删除是物理的、没有撤销（与 `deleteNote` 同一条纪律）。
     * @param options - `kbId` plus the file row id.
     * @returns KbFileMutationResult（回执里带连带清掉的分块数与副本是否被删）。
     */
    deleteKbFile(options: {
        kbId: number;
        id: number;
    }): KbFileMutationResult;
    /**
     * 切换一个文件是否参与向量化（出网）。
     *
     * 关掉之后该文件**完全不出网**，但仍然留在 FTS 索引里可被关键词搜到 ——
     * 这正是「库里有合同，但我还想搜到它」的实现方式（设计稿 §9.2）。
     * 全局「禁止 AI 出网」仍然是同一道闸门，一起拦下。
     * @param options - `kbId`、文件 id、是否参与。
     * @returns KbFileMutationResult.
     */
    setKbFileRag(options: {
        kbId: number;
        id: number;
        includeInRag: boolean;
    }): KbFileMutationResult;
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
    summarizeKbFile(options: {
        kbId: number;
        id: number;
    }): Promise<KbSummaryResult>;
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
    searchKb(options: {
        kbId: number;
        query?: string;
        topK?: number;
    }): Promise<KbSearchResult>;
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
    getKbModelConfig(options: {
        kbId: number;
    }): {
        kbId: number;
        settings: KbModelSettings;
        global: Record<KbModelRole, string>;
        resolved: Record<KbModelRole, ResolvedModel>;
        entities: KbEntitySummary;
    };
    /**
     * 写某个知识库的模型覆盖（只改传进来的那几项；传空串 = 取消覆盖、回到继承）。
     *
     * 这一层**不写凭据**：引用串只能是「继承」或「m:<模型名>」，端点与 Key 永远只在 `llm.json`。
     * 为什么收窄到这样：一条 profile 是一套同厂商的连接参数，按库引用它就会把
     * 「A 家地址 + B 家 Key」这种 401 陷阱重新请回来（见 `model-config.ts` 头注）。
     * @param options - `kbId` 加可选的 `chatRef` / `embedRef` / `rerankRef`。
     * @returns 最新设置；引用串不合法时 `{ ok: false, error }`（不静默改成继承）。
     */
    setKbModelConfig(options: {
        kbId: number;
        chatRef?: string;
        embedRef?: string;
        rerankRef?: string;
    }): {
        ok: true;
        settings: KbModelSettings;
    } | {
        ok: false;
        error: string;
    };
    /**
     * 某个知识库的**向量索引状态**（面板的「语义索引」按钮与状态 chip 读这个）。
     *
     * 为什么要单独一个读接口：向量索引此前只有一个隐式入口 —— 提问时顺手补齐
     * （`askWechat` 里那段），于是界面上既**触发不了**它也**看不见**它：
     * 用户只知道「有时能语义搜到、有时搜不到」，而差别其实只是这个库建没建过。
     * @param options - `kbId`。
     * @returns 当前生效的模型名、是否配了通道、按库状态、以及本进程内的在飞构建进度。
     */
    getKbVectorIndex(options: {
        kbId: number;
    }): {
        kbId: number;
        model: string;
        source: 'inherit' | 'inline';
        configured: boolean;
        status: KbVectorIndexStatus;
        job: {
            done: number;
            total: number;
            startedAt: number;
            error: string;
        } | null;
    };
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
    buildKbVectorIndex(options: {
        kbId: number;
        force?: boolean;
    }): Promise<KbVectorBuildResult & {
        ok: boolean;
        error?: string;
    }>;
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
        q?: string;
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
        q?: string;
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
        /**
         * 入口来源，写进问答历史：`ask` = 「微信问答」页签，`session` = 会话内问答。
         * 缺省按 `ask` 处理 —— 旧客户端不带这个字段时也能正常落库。
         */
        source?: string;
        /** 会话显示名：历史列表直接显示，省掉面板再查一次会话表。 */
        usernameName?: string;
        /**
         * 当前知识库 id：本次提问会把该库的文件块一并纳入检索。
         *
         * 缺省不检索知识库（而不是「搜所有库」）—— 与其余知识库接口同一纪律：
         * `kbId` 是作用域，没有「所有库」这种模式；漏传应当表现为「没检索到文件」，
         * 而不是把别的库的内容也端上来。
         */
        kbId?: number;
    }): Promise<AskResult>;
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
    private saveAskHistory;
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
     * @returns 供「数据健康」面板与诊断脚本展示（原「检索设置」面板已于 2026-09-17 下线）。
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
     * 保存检索参数（阈值/权重/容量）。
     * **界面已不再暴露该入口**（面板下线，参数固化为产品默认值）——仅供诊断与自动化测试参考使用。
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
     * 立即构建/增量更新稠密向量索引。
     * 界面已不暴露该入口：首次提问时网关会自动增量构建（失败则降级纯稀疏），
     * 本方法留给诊断与自动化测试使用。
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
     * 不依赖真实数据，因此可以随时直连调一次就看到当前算法的 P/R/MRR/NDCG
     * （界面无入口），也可以在 CI 里断言「混合不低于纯稀疏」防止退化。
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
     * 读取问答历史（供「微信问答 → 历史记录」弹窗）。
     *
     * 与 `getExportHistory` 同样**不走**宿主的结果缓存：历史是「按当前事实」的数据，
     * 刚问完就打开列表必须能看到那一条，缓存住的旧结果会表现成「问答没被保存」。
     * @param options - 搜索 / 来源筛选 / 状态筛选 / 时间范围 / 排序 / 分页。
     * @returns 一页条目 + 命中总数 + 各聚合计数。
     */
    getAskHistory(options?: AskHistoryQuery): AskHistorySnapshot;
    /**
     * 删除若干条问答历史。
     *
     * 与导出历史不同，这里**没有**「连带删除外部文件」这个选项 —— 问答记录的内容全部在库里，
     * 删记录就是删全部，没有第二个动作会顺手动到用户磁盘上的东西。
     * @param options - ids。
     * @returns 实际删除条数。
     */
    deleteAskHistory(options: {
        ids: number[];
    }): AskHistoryDeleteResult;
    /**
     * 清空全部问答历史（由界面上的显式入口 + 二次确认触发，不做任何自动清理）。
     * @returns 实际删除条数。
     */
    clearAskHistory(): AskHistoryClearResult;
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
