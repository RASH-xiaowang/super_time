/**
 * GatewayCore —— `WechatDataGateway` 的「核」：运行时状态、构造与实时同步接线、跨域共享的
 * 私有辅助（隐私闸 / 操作日志 / 流控槽 / 模型选择…），以及 14 个域处理器的 ctx 装配。
 *
 * 为什么拆成继承链（M21 结构刀）：`gateway.ts` 里 161 个 `@Remote` 方法**必须留在同一个类**
 * ——协议层按「最派生原型的自有描述子」枚举方法面（见 `tests/remote-inheritance.spec.ts`），
 * 所以方法壳可以放在任何一层的基类里、而对外接口一字不变；把「核」先分出去，
 * 方法面才能继续按域往下拆。
 */
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { Context } from '@deepseek-ai/cordis';
import type { AskResult, DecryptStatus, ExportStatus, SummaryTaskRunResult, WhisperDownloadProgress, WhisperTranscribing, OperationCategory, OperationStatus } from './types.ts';
import { createTasksRemotes } from './remotes/tasks.ts';
import { createOpsLogRemotes } from './remotes/opslog.ts';
import { createBackupRemotes } from './remotes/backup.ts';
import { createConfigRemotes } from './remotes/config.ts';
import { createSummaryRemotes } from './remotes/summary.ts';
import { createAskRemotes } from './remotes/ask.ts';
import { createKeysDecryptRemotes } from './remotes/keysdec.ts';
import { createGraphSearchRemotes } from './remotes/graphsearch.ts';
import { createSummaryRecordRemotes } from './remotes/summaryrec.ts';
import { createVoiceLlmRemotes } from './remotes/voicellm.ts';
import { createAskDeepRemotes } from './remotes/askdeep.ts';
import { createKbRemotes } from './remotes/kb.ts';
import { createMediaRemotes } from './remotes/media.ts';
import { createExportRemotes } from './remotes/export.ts';
import type { StreamControl } from './query/zip.ts';
import { type EmbedFn } from './query/retrieval/embedding.ts';
import type { KbModelRole, ResolvedModel } from './query/kb/model-config.ts';
import type { IntentKind, RerankWeights } from './query/retrieval/types.ts';
import { ResolvedDirs, StreamJob } from './gateway-support.ts';
/** 网关的「核」：状态、生命周期、共享私有辅助与 13 个域处理器的 ctx 装配（M21 自 gateway.ts 拆出）。 */
export declare abstract class GatewayCore extends TypertRemoteService {
    /** 由派生的方法面层实现（`@Remote` 入口）；这里的排程必须经实例派发 —— 见 `summary-run-due.spec.ts` 打的桩。 */
    abstract runSummaryTask(options: {
        id: number;
    }): Promise<SummaryTaskRunResult>;
    /** Services this gateway depends on at runtime (LLM + default model). */
    static inject: string[];
    protected readonly _ctx: Context;
    protected readonly _dirs: ResolvedDirs;
    /**
     * 登录账号 wxid 的**带失效**缓存。
     *
     * 不能在构造函数里算一次就固定：`数据配置` 里切换微信账号只改 `db_dir`
     * （解密目录不变），本进程不会重启。缓存住旧 wxid 会让 `isSender` 拿
     * **上一个账号**的 wxid 去比对，于是新账号里每条消息的「我 / 对方」全部反转
     * —— 属于最严重的归属错误。这里按 (解密目录, config.db_dir) 记忆：
     * 账号一换键就变，自动重算。
     */
    protected _selfUsername: string;
    protected _selfUsernameKey: string;
    protected _schedBusy: boolean;
    /**
     * 最近若干轮问答的检索特征画像（retrievalId → 特征/引用映射）。
     * 用户提交反馈时用它把「哪条引用有用」翻译成「哪个特征该加权」。
     * 有界（≤20 轮），不落盘 —— 纯进程内、只在反馈那一刻需要。
     */
    protected readonly _askTrace: Map<string, {
        features: Map<string, RerankWeights>;
        citations: string[];
        question: string;
        answer: string;
        intent: IntentKind;
    }>;
    /** Live decrypt progress (polled by the settings panel). */
    protected readonly decryptState: DecryptStatus;
    /** Active whisper model download (polled by the settings panel). */
    protected whisperDownload: WhisperDownloadProgress | null;
    /** Active voice batch transcription (polled by the settings panel). */
    protected whisperTranscribing: WhisperTranscribing;
    /** 导出/加密备份的控制槽：jobId → 取消令牌 + 最近一次进度（见 {@link StreamJob}）。 */
    protected readonly _streamJobs: Map<string, StreamJob>;
    /**
     * 消息搜索的取消槽（N9）：jobId → 取消控制器。
     *
     * 与导出的槽分开：搜索没有进度可言，也不想占用 `wechat-export/progress` 那个事件名。
     * 槽位会在搜索收尾时删掉（见 {@link searchSignal}），所以这里不需要上限。
     */
    protected readonly _searchJobs: Map<string, AbortController>;
    /**
     * 反馈去重窗口（N27）：键 → 到期时间。
     *
     * 为什么不是 `inflightXxx: Set` 那种「在飞合并」的闸：`submitAskFeedback` 是**同步** RPC，
     * 函数体在事件循环里一口气跑完，两个「并发」调用不会交错 ⇒ 在飞表恒为空，那是个假闸。
     * 真正的重复是「同一轮被提交两次」且两次都真跑完（多一条反馈记录 + 按重复特征重算权重 +
     * 两条审计），所以按内容键 + 时间窗去重（见 {@link ASK_FEEDBACK_DEDUPE_MS}）。
     */
    protected readonly _askFeedbackSeen: Map<string, number>;
    /**
     * 按库向量索引的**在飞构建**进度（kbId → 进度），给面板的「语义索引」按钮轮询。
     *
     * 为什么是进程内而不是落库：这是「此刻有没有在跑、跑到哪」的瞬时态，落库就要处理
     * 进程崩溃留下的假进行中（比不显示更糟）。真正的持久事实（多少块、哪个模型、何时建的）
     * 在向量库自己的 meta 与行里，见 `kbVectorIndexStatus`。
     */
    protected readonly _kbIndexJobs: Map<number, {
        done: number;
        total: number;
        startedAt: number;
        error: string;
    }>;
    /**
     * 已知实体名缓存（问答的「点名识别」用）：按解密目录记忆。
     *
     * 为什么缓存：这份名单要读联系人表 + 会话表（两次 SQLite 打开），而每次提问都要用；
     * 名单在会话存续期内变化极小，记一次就够。换数据目录（换账号）时按 key 自然失效。
     */
    protected readonly _knownEntities: Map<string, string[]>;
    /**
     * 当前登录账号的 wxid（消息 `isSender` 判定的基准）。
     *
     * 按 (解密目录, config.db_dir) 记忆：只要账号没换就直接命中缓存，
     * 换了账号（`data 配置` 里选另一个账号的 db_storage）或换了数据目录则重算。
     * 每次取用时只多读一次 `getConfig`（带文件签名缓存的 JSON 读），代价可忽略。
     * @returns 登录账号 wxid；解析不到时为空串。
     */
    protected selfUsername(): string;
    /**
     * 取（或新建）一个长任务的控制槽，并包成 query 层要的 {@link StreamControl}（M3）。
     *
     * 每次调用都换一个**新的** AbortController：同一个 jobId 被复用（先取消、再重跑）时，
     * 复用一个已 abort 的令牌会让新一轮导出刚起步就抛「已取消」。
     * @param jobId - 渲染层生成的标识；缺省/空白时返回空控制（＝无进度、不可取消，
     *   旧调用方的行为完全不变）。
     * @returns 含 `signal` 与 `onProgress` 的控制对象，可直接透传给 query 层。
     */
    protected streamControl(jobId?: string): StreamControl;
    /**
     * 收尾一个长任务：标记结束（槽位留着，让迟到的 `getExportProgress` 能读到终态与错误）。
     * @param jobId - 任务标识。
     * @param error - 失败/取消原因；成功时省略。
     */
    protected finishStreamJob(jobId: string, error?: string): void;
    constructor(ctx: Context);
    /**
     * Append one operation-log row. Metadata only — never message bodies or
     * image/file contents — so an export stays safe to share. Best-effort: a
     * logging failure never affects the operation it records.
     */
    protected op(category: OperationCategory, action: string, status: OperationStatus, target?: string, detail?: string): void;
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
    protected outboundBlocked(): boolean;
    protected privacyBlocked(feature: string, detail?: string): string | null;
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
    protected privacyGate(feature: string, stats: {
        sessions: number;
        messages: number;
    }, texts: string[]): {
        ok: true;
        texts: string[];
    } | {
        ok: false;
        error: string;
    };
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
    protected askKnownEntities(): string[];
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
    protected makeEmbedFn(model: string, feature?: 'ask_embed' | 'kb_embed' | 'kb_link_suggest'): EmbedFn | undefined;
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
    protected embedModelName(override?: string): string;
    /**
     * 某个角色的**全局**生效模型名（还没叠库级覆盖）。
     *
     * 三个角色都从宿主桥取值：桥是唯一知道「实际会发出去什么」的地方，
     * 网关自己再拼一遍优先级就会重新制造 §7 F1 那种两条链各算一次的局面。
     * @param role - 语言 / 嵌入 / 重排序。
     * @returns 模型名；空串 = 这个角色没配。
     */
    protected globalModelName(role: KbModelRole): string;
    /**
     * 某个库、某个角色**实际该用的**模型名（库级覆盖叠在全局之上）。
     *
     * 每次调用都重读设置：`llm.json` 那条链就是「改完下一次生效、不必重启」的语义，
     * 这里缓存住就会让库级覆盖比全局配置更难改。一次 SQLite 主键查是微秒级，不心疼。
     * @param kbId - 知识库 id（非法时等价于「没有库级覆盖」）。
     * @param role - 哪个角色。
     * @returns 解析结果（含来源，界面与审计都要用它说话）。
     */
    protected kbModel(kbId: number, role: KbModelRole): ResolvedModel;
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
    protected makeChatAsker(kbId: number, feature: string): ((prompt: string) => Promise<string>) | undefined;
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
    protected makeRerankFn(kbId: number): ((query: string, documents: string[]) => Promise<number[]>) | undefined;
    /**
     * 读取「自动获取原图（CDN）」与「原图解密方式」两个开关（N24）。
     *
     * 这两个键在界面上可见（设置 → 图片解码），此前**没有任何消费者** —— 关掉后取图路径照旧
     * 出网，用户看到的是「开关说是关的、行为却不是」。所有远端取媒体（表情 / 公众号封面 /
     * 朋友圈视频与封面）都在这里统一取值再传进 query 层，保证「关掉 = 不发请求」。
     * @returns cdnEnabled=false 时 query 层会在发请求前返回；localDecrypt=false 表示服务端解密。
     */
    protected cdnSwitches(): {
        cdnEnabled: boolean;
        localDecrypt: boolean;
    };
    protected _kbRemotes?: ReturnType<typeof createKbRemotes>;
    /** KB 域的处理器（体在 remotes/kb.ts）；这里只组装 ctx 与转发。 */
    protected kbRemotes(): ReturnType<typeof createKbRemotes>;
    protected _mediaRemotes?: ReturnType<typeof createMediaRemotes>;
    /** 媒体域的处理器（体在 remotes/media.ts）；这里只组装 ctx 与转发。 */
    protected mediaRemotes(): ReturnType<typeof createMediaRemotes>;
    protected _exportRemotes?: ReturnType<typeof createExportRemotes>;
    /** 导出域的处理器（体在 remotes/export.ts）；这里只组装 ctx 与转发。 */
    protected exportRemotes(): ReturnType<typeof createExportRemotes>;
    protected _tasksRemotes?: ReturnType<typeof createTasksRemotes>;
    /** 任务与笔记（待办 / 笔记 / 交接提醒） 的处理器（体在 remotes/tasks.ts）；这里只组装 ctx 与转发。 */
    protected tasksRemotes(): ReturnType<typeof createTasksRemotes>;
    protected _opsLogRemotes?: ReturnType<typeof createOpsLogRemotes>;
    /** 操作日志与隐私审计（含隐私开关读数） 的处理器（体在 remotes/opslog.ts）；这里只组装 ctx 与转发。 */
    protected opsLogRemotes(): ReturnType<typeof createOpsLogRemotes>;
    protected _backupRemotes?: ReturnType<typeof createBackupRemotes>;
    /** 备份与恢复（含加密备份） 的处理器（体在 remotes/backup.ts）；这里只组装 ctx 与转发。 */
    protected backupRemotes(): ReturnType<typeof createBackupRemotes>;
    protected _configRemotes?: ReturnType<typeof createConfigRemotes>;
    /** 数据配置与密钥状态（含解密/数据库状态） 的处理器（体在 remotes/config.ts）；这里只组装 ctx 与转发。 */
    protected configRemotes(): ReturnType<typeof createConfigRemotes>;
    protected _summaryRemotes?: ReturnType<typeof createSummaryRemotes>;
    /** 总结任务（每日/周期总结的排程与运行） 的处理器（体在 remotes/summary.ts）；这里只组装 ctx 与转发。 */
    protected summaryRemotes(): ReturnType<typeof createSummaryRemotes>;
    protected _askRemotes?: ReturnType<typeof createAskRemotes>;
    /** 问答反馈与检索配置（画像表 / 反馈表 / 配置） 的处理器（体在 remotes/ask.ts）；这里只组装 ctx 与转发。 */
    protected askRemotes(): ReturnType<typeof createAskRemotes>;
    protected _keysDecryptRemotes?: ReturnType<typeof createKeysDecryptRemotes>;
    /** 密钥获取与全库/全图解密（图片密钥自动获取、验证、解密状态） 的处理器（体在 remotes/keysdec.ts）；这里只组装 ctx 与转发。 */
    protected keysDecryptRemotes(): ReturnType<typeof createKeysDecryptRemotes>;
    protected _graphSearchRemotes?: ReturnType<typeof createGraphSearchRemotes>;
    /** 知识图谱、消息检索与索引（含编辑历史复位） 的处理器（体在 remotes/graphsearch.ts）；这里只组装 ctx 与转发。 */
    protected graphSearchRemotes(): ReturnType<typeof createGraphSearchRemotes>;
    protected _summaryRecordRemotes?: ReturnType<typeof createSummaryRecordRemotes>;
    /** 总结记录（每日/周期总结生成、记录删除、推荐回复） 的处理器（体在 remotes/summaryrec.ts）；这里只组装 ctx 与转发。 */
    protected summaryRecordRemotes(): ReturnType<typeof createSummaryRecordRemotes>;
    protected _voiceLlmRemotes?: ReturnType<typeof createVoiceLlmRemotes>;
    /** 语音转写与模型清单（whisper 安装/下载/状态、可用模型与提供方） 的处理器（体在 remotes/voicellm.ts）；这里只组装 ctx 与转发。 */
    protected voiceLlmRemotes(): ReturnType<typeof createVoiceLlmRemotes>;
    protected _askDeepRemotes?: ReturnType<typeof createAskDeepRemotes>;
    /** 问答主链路（提问检索生成、问题优化、向量索引重建） 的处理器（体在 remotes/askdeep.ts）；这里只组装 ctx 与转发。 */
    protected askDeepRemotes(): ReturnType<typeof createAskDeepRemotes>;
    /**
     * 取一个搜索任务的取消信号（N9）。
     * @param jobId - 渲染层生成的不透明标识；缺省/空白时返回 undefined（＝不可取消）。
     * @returns 信号与收尾函数；收尾只在槽里还是自己这一枚控制器时才删 —— 否则会把「先取消、再重跑」
     *   的新令牌一起删掉。
     */
    protected searchSignal(jobId?: string): {
        signal: AbortSignal;
        done: () => void;
    } | undefined;
    /**
     * 记一条导出历史（best-effort）。
     *
     * 为什么放在网关而不是各导出函数内部：`recordExport` 需要「解密数据根」来定位历史库，
     * 而各 `export*.ts` 函数都拿到了 `decryptedDir` —— 但重跑参数只有网关这一层完整掌握
     * （客户端传什么原样存下来），所以在网关这层记录最不容易漏字段。
     * @param input - 本次导出的事实。
     */
    protected recordExport(input: {
        kind: string;
        label?: string;
        format?: string;
        path: string;
        rows?: number;
        status: ExportStatus;
        error?: string;
        params?: unknown;
    }): void;
    /**
     * 构造「回答增量」事件推送器。
     *
     * 为什么节流：每个增量都要跨 IPC → 渲染进程 → React setState，模型一秒能吐几十个
     * delta，不节流会把开销压到生成本身上。80ms 约等于 12fps，视觉上已足够连续。
     * @param streamId - 客户端生成的流式标识；为空表示不推送（非流式调用方）。
     * @returns 增量回调（text 为**已生成的全文**）。
     */
    protected makeDeltaEmitter(streamId?: string): ((text: string) => void) | undefined;
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
    protected saveAskHistory(options: {
        question: string;
        username?: string;
        from?: string;
        to?: string;
        source?: string;
        usernameName?: string;
    }, result: AskResult, elapsedMs: number, model: string): void;
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
    protected static readonly DUE_SUMMARY_CONCURRENCY = 2;
    /** Run any enabled daily-summary task whose schedule time matches the current minute. */
    protected maybeRunDueTasks(): Promise<void>;
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
    protected warmDecodedImages(decryptedDir: string, decodedDir: string, baseDir: string, items: ReadonlyArray<{
        username: string;
        localId: number;
    }>, aesKey: string | undefined, xorKey: number): void;
}
