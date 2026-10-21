/**
 * GatewayCore —— `WechatDataGateway` 的「核」：运行时状态、构造与实时同步接线、跨域共享的
 * 私有辅助（隐私闸 / 操作日志 / 流控槽 / 模型选择…），以及 16 个域处理器的 ctx 装配。
 *
 * 为什么拆成继承链（M21 结构刀）：`gateway.ts` 里 214 个 `@Remote` 方法**必须留在同一个类**
 * ——协议层按「最派生原型的自有描述子」枚举方法面（见 `tests/remote-inheritance.spec.ts`），
 * 所以方法壳可以放在任何一层的基类里、而对外接口一字不变；把「核」先分出去，
 * 方法面才能继续按域往下拆。
 */
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { Context } from '@deepseek-ai/cordis';
import type { AskResult, DecryptStatus, ExportStatus, SummaryTaskRunResult, WhisperDownloadProgress, WhisperTranscribing, OperationCategory, OperationStatus } from './types.ts';
import { createTasksRemotes } from './remotes/tasks.ts';
import { createOpsLogRemotes } from './remotes/opslog.ts';
import { createWordcloudRemotes } from './remotes/wordcloud.ts';
import { createBackupRemotes } from './remotes/backup.ts';
import { createConfigRemotes } from './remotes/config.ts';
import { createSummaryRemotes } from './remotes/summary.ts';
import { createAskRemotes } from './remotes/ask.ts';
import { createKeysDecryptRemotes } from './remotes/keysdec.ts';
import { createGraphSearchRemotes } from './remotes/graphsearch.ts';
import { createSummaryRecordRemotes } from './remotes/summaryrec.ts';
import { createVoiceLlmRemotes } from './remotes/voicellm.ts';
import { createAnnualNarrRemotes } from './remotes/annual-narr.ts';
import { createAskDeepRemotes } from './remotes/askdeep.ts';
import { createKbRemotes } from './remotes/kb.ts';
import { createMediaRemotes } from './remotes/media.ts';
import { createExportRemotes } from './remotes/export.ts';
import type { StreamControl } from './query/zip.ts';
import { type EmbedFn } from './query/retrieval/embedding.ts';
import type { KbModelRole, ResolvedModel } from './query/kb/model-config.ts';
import type { IntentKind, RerankWeights } from './query/retrieval/types.ts';
import { type SummaryScheduler } from './gateway-scheduler.ts';
import { ResolvedDirs, StreamJob } from './gateway-support.ts';
import type { EmbedFeature } from './gateway-llm-factory.ts';
/** 网关的「核」：状态、生命周期、共享私有辅助与 16 个域处理器的 ctx 装配（M21 自 gateway.ts 拆出）。 */
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
    /**
     * 摘要任务的定时器调度（#20 第七刀拆出去的协作者）。
     *
     * 走 `slot()` 装配：构造期间 `setInterval` 那一颗就已经会调它，而 `_dirs` 是构造里
     * 晚一步才赋的 —— 装配放进惰性槽里，第一次真正用到时才读 `_dirs`。
     */
    protected summaryScheduler(): SummaryScheduler;
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
     * 问答的取消槽（W3-6.1）：jobId → 取消控制器。
     *
     * 为什么与搜索/导出都分开：三者的生命周期不同 —— 搜索是「一次扫描」、导出是「一个 job」，
     * 问答是「一轮生成」。共用一个槽会让「取消搜索」顺手掐死正在生成的回答（或反过来），
     * 那是比不能取消更坏的行为。做法与 {@link searchSignal} 同款：jobId 由渲染层生成
     * （就是那轮的 streamId），取消走独立的 `cancelAsk` Remote。
     */
    protected readonly _askJobs: Map<string, AbortController>;
    /** W3-11.5：逐条分析的取消槽（与问答分开放，原因见 `layaSignal` 的注释）。 */
    protected readonly _layaJobs: Map<string, AbortController>;
    /** W3-11.5：搜索索引构建的取消槽（与搜索分开放，原因见 `searchIndexSignal` 的注释）。 */
    protected readonly _searchIndexJobs: Map<string, AbortController>;
    /** W3-5.5：下载的取消槽（与其余几种各占一格）。 */
    protected readonly _whisperDownloadJobs: Map<string, AbortController>;
    /** W3-11.5：知识库向量构建的取消槽（与消息域的构建各占一格，互相不会打断）。 */
    protected readonly _kbIndexCancelJobs: Map<string, AbortController>;
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
     * 取（或新建）一个长任务的控制槽 —— 槽位管理在 `gateway-jobs.ts#streamControlFor`
     * （#20 第四个协作者：令牌复用 / 终态残留 / 上限淘汰这三条规则只有单独测才钉得住）。
     * 那张槽表仍由本类持有，并原样交给 remotes（避免出现第二个"进度视图"）。
     * @param jobId - 渲染层生成的标识；缺省/空白时返回空控制（＝无进度、不可取消）。
     * @returns 含 `signal` 与 `onProgress` 的控制对象，可直接透传给 query 层。
     */
    protected streamControl(jobId?: string): StreamControl;
    /**
     * 收尾一个长任务：标记结束（槽位留着，让迟到的 `getExportProgress` 能读到终态与错误）。
     * @param jobId - 任务标识。
     * @param error - 失败/取消原因；成功时省略。
     */
    protected finishStreamJob(jobId: string, error?: string): void;
    /**
     * 子类钩子：网关构造完成后（`setImmediate` 里）拉起 ClawBot 接收通道
     * （体在 `gateway-clawbot.ts`；默认实现什么都不做 —— ClawBot 组装在更派生的层）。
     */
    protected bootClawbotChannel(): void;
    /**
     * 子类钩子：任务触发扫描的一拍（体在 `gateway-taskcenter.ts`；默认实现什么都不做 ——
     * 任务信息域的组装在更派生的层）。
     *
     * 由实时同步回调（有新分片变化时）与 10s 兜底定时器调用。与 `bootClawbotChannel` 分开的理由：那个是「拉起长轮询」，
     * 这个是「周期扫描」，生命周期与失败语义都不同（前者启动一次，后者每拍都可能失败）。
     */
    protected scanTaskTriggersBackground(): void;
    constructor(ctx: Context);
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
    protected op(category: OperationCategory, action: string, status: OperationStatus, target?: string, detail?: string, durationMs?: number): void;
    /**
     * 隐私闸门：**所有**出站 LLM 调用都必须先过这里（实现见 `gateway-privacy.ts`）。
     * 它只做脱敏与审计 —— 2026-09-30 起不再有任何拦截逻辑。
     * @param feature - 审计里的功能名。
     * @param stats - 本次出站涉及的数据量（会话数、消息数）。
     * @param texts - 即将发出去的文本；开启脱敏时返回脱敏后的副本。
     * @returns 可以直接发出去的文本。
     */
    protected privacyGate(feature: string, stats: {
        sessions: number;
        messages: number;
    }, texts: string[]): string[];
    /**
     * 当前数据根是否开启敏感字段脱敏（W3-6.2：embedding 缓存键的命名空间）。
     *
     * 与 `privacyGateAt` 读的是**同一个** `readPrivacySettings`，容错口径也相同
     *（读不到按 false 继续）—— 两边不一致会让缓存跨口径取用，所以这里刻意不另找数据源。
     * @returns 开启为 true。
     */
    protected privacyRedactMode(): boolean;
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
   * 构造「过隐私闸门」的 embedding 函数 —— 工厂在 `gateway-llm-factory.ts`
   * （#20 第三个协作者，文件头写着那三条出站纪律）。
   * @param model - 向量模型名（空则不带 model 选项）。
   * @param feature - 审计里的功能名（三种数据范围必须分得开）。
   * @returns embedding 函数；桥未提供 embed 时 undefined。
   */
    protected makeEmbedFn(model: string, feature?: EmbedFeature): EmbedFn | undefined;
    /**
     * 「这次 embedding 实际用的模型名」—— 解析在 `gateway-models.ts#embedModelNameOf`
     * （#20 第二个协作者）。记账名必须由发送方给出，见那份模块里 §7 F1 那段。
     * @param override - 显式指定的模型名（可空）。
     * @returns 生效模型名；未配置时为空串。
     */
    protected embedModelName(override?: string): string;
    /**
     * 某个角色的**全局**生效模型名（还没叠库级覆盖）；实现见 `gateway-models.ts`。
     * @param role - 语言 / 嵌入 / 重排序。
     * @returns 模型名；空串 = 这个角色没配。
     */
    protected globalModelName(role: KbModelRole): string;
    /**
     * 某个库、某个角色**实际该用的**模型名（库级覆盖叠在全局之上）；实现见 `gateway-models.ts`。
     * @param kbId - 知识库 id（非法时等价于「没有库级覆盖」）。
     * @param role - 哪个角色。
     * @returns 解析结果（含来源，界面与审计都要用它说话）。
     */
    protected kbModel(kbId: number, role: KbModelRole): ResolvedModel;
    /**
   * 造一个「提示词 → 模型文本」的一次性调用（实体抽取、链接建议这类结构化小任务用）；
   * 实现见 `gateway-llm-factory.ts#makeChatAskerOf`。
   * @param kbId - 当前库（取语言模型的库级覆盖）。
   * @param feature - 审计里登记的功能名。
   * @returns 调用函数；桥不支持流式时 undefined（调用方据此报「模型通道不可用」）。
   */
    protected makeChatAsker(kbId: number, feature: string): ((prompt: string) => Promise<string>) | undefined;
    /**
   * 构造「过隐私闸门」的模型精排函数（问答检索的候选重排）；
   * 实现见 `gateway-llm-factory.ts#makeRerankFnOf`（含「整批过一次闸」那条纪律）。
   * @param kbId - 当前库（用于取库级覆盖；0 = 没有库上下文）。
   * @returns 精排函数；没配模型或桥不支持时 undefined（管道据此跳过这一段）。
   */
    protected makeRerankFn(kbId: number): ((query: string, documents: string[]) => Promise<number[]>) | undefined;
    /**
   * 三个 LLM 工厂共用的依赖袋。
   *
   * 每次调用现凑：`_dirs.decrypted` 会在换数据根时变，缓存这份对象就会让隐私闸
   * 指向**上一个**数据根的库（读到旧设置 = 用旧同意范围发新数据）。
   * @returns 桥、宿主上下文与两个前置协作者的入口。
   */
    private llmFactoryDeps;
    /**
     * 装配槽：同一个域的处理器**只装配一次**（`WechatDataGateway` 的壳每次调用都转发到同一份对象，
     * 那份"壳转给的就是这件"的判据见 `gateway-read-shell.spec.ts` 里的 spy 用例）。
     * #20 第六刀之前这里是十五个「下划线字段 + `??=`」各写一遍 —— 报告 §P2-2 第 1 条要 core 只保留
     * `_ctx` / `_dirs` 与装配，于是把"复用装配产物"这一件事收成一处，实例状态一次少十五格。
     */
    private readonly _remoteSlots;
    /** 取（或第一次装配）某个键对应的处理器。 */
    protected slot<T>(key: string, build: () => T): T;
    /** KB 域的处理器（体在 remotes/kb.ts）；这里只组装 ctx 与转发。 */
    protected kbRemotes(): ReturnType<typeof createKbRemotes>;
    /** 媒体域的处理器（体在 remotes/media.ts）；这里只组装 ctx 与转发。 */
    protected mediaRemotes(): ReturnType<typeof createMediaRemotes>;
    /** 导出域的处理器（体在 remotes/export.ts）；这里只组装 ctx 与转发。 */
    protected exportRemotes(): ReturnType<typeof createExportRemotes>;
    /** 任务与笔记（待办 / 笔记 / 交接提醒） 的处理器（体在 remotes/tasks.ts）；这里只组装 ctx 与转发。 */
    protected tasksRemotes(): ReturnType<typeof createTasksRemotes>;
    /** 操作日志与隐私审计（含隐私开关读数） 的处理器（体在 remotes/opslog.ts）；这里只组装 ctx 与转发。 */
    protected opsLogRemotes(): ReturnType<typeof createOpsLogRemotes>;
    /** 词云词频（界面优化阶段 4） 的处理器（体在 remotes/wordcloud.ts）；这里只组装 ctx 与转发。 */
    protected wordcloudRemotes(): ReturnType<typeof createWordcloudRemotes>;
    /** 备份与恢复（含加密备份） 的处理器（体在 remotes/backup.ts）；这里只组装 ctx 与转发。 */
    protected backupRemotes(): ReturnType<typeof createBackupRemotes>;
    /** 数据配置与密钥状态（含解密/数据库状态） 的处理器（体在 remotes/config.ts）；这里只组装 ctx 与转发。 */
    protected configRemotes(): ReturnType<typeof createConfigRemotes>;
    /** 总结任务（每日/周期总结的排程与运行） 的处理器（体在 remotes/summary.ts）；这里只组装 ctx 与转发。 */
    protected summaryRemotes(): ReturnType<typeof createSummaryRemotes>;
    /** 问答反馈与检索配置（画像表 / 反馈表 / 配置） 的处理器（体在 remotes/ask.ts）；这里只组装 ctx 与转发。 */
    protected askRemotes(): ReturnType<typeof createAskRemotes>;
    /** 密钥获取与全库/全图解密（图片密钥自动获取、验证、解密状态） 的处理器（体在 remotes/keysdec.ts）；这里只组装 ctx 与转发。 */
    protected keysDecryptRemotes(): ReturnType<typeof createKeysDecryptRemotes>;
    /** 知识图谱、消息检索与索引（含编辑历史复位） 的处理器（体在 remotes/graphsearch.ts）；这里只组装 ctx 与转发。 */
    protected graphSearchRemotes(): ReturnType<typeof createGraphSearchRemotes>;
    /** 总结记录（每日/周期总结生成、记录删除、推荐回复） 的处理器（体在 remotes/summaryrec.ts）；这里只组装 ctx 与转发。 */
    protected summaryRecordRemotes(): ReturnType<typeof createSummaryRecordRemotes>;
    /** AI 年报叙述（W2-8.6：分段取材 + 逐段 LLM + 进度/取消） 的处理器（体在 remotes/annual-narr.ts）。 */
    protected annualNarrRemotes(): ReturnType<typeof createAnnualNarrRemotes>;
    /** 语音转写与模型清单（whisper 安装/下载/状态、可用模型与提供方） 的处理器（体在 remotes/voicellm.ts）；这里只组装 ctx 与转发。 */
    protected voiceLlmRemotes(): ReturnType<typeof createVoiceLlmRemotes>;
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
     * 取一个问答任务的取消信号（W3-6.1）。语义与 {@link searchSignal} 一致：
     * 槽位只认「自己这一枚控制器」，先取消再重跑的令牌不会互相删。
     * @param jobId - 渲染层传来的轮次标识（就是 streamId）；缺省/空白时 undefined（不可取消）。
     */
    protected askSignal(jobId?: string): {
        signal: AbortSignal;
        done: () => void;
    } | undefined;
    /**
     * 取消一轮问答。返回是否真的找到了在跑的那一轮 —— 找不到（已结束 / jobId 不认识）时
     * 给调用方一个可读的 false，而不是静默成功（那会让用户以为取消生效了，回答还在继续跑）。
     * @param jobId - 要取消的轮次标识。
     */
    protected cancelAskJob(jobId?: string): boolean;
    /**
     * 取一批逐条分析的取消信号（W3-11.5）。语义与 {@link searchSignal} / {@link askSignal} 一致：
     * 槽位只认「自己这一枚控制器」，先取消再重跑的令牌不会互相删。
     *
     * 为什么单独一格而不复用 `_askJobs`：分析批与问答轮次会同时在跑，共用一个 Map 的话
     * 两个毫不相干的 jobId 会互相顶掉对方的令牌，取消会打到错误的批次上。
     * @param jobId - 渲染层生成的批次标识；缺省/空白时 undefined（不可取消）。
     */
    protected layaSignal(jobId?: string): {
        signal: AbortSignal;
        done: () => void;
    } | undefined;
    /**
     * 取消一批逐条分析。返回是否真的找到了在跑的那一批 —— 找不到（已算完 / jobId 不认识）
     * 时给调用方一个可读的 false，而不是静默成功。
     * @param jobId - 要取消的批次标识。
     */
    protected cancelLayaJob(jobId?: string): boolean;
    /**
     * 取一次搜索索引构建的取消信号（W3-11.5）。语义与前两个 `xxxSignal` 一致。
     *
     * 为什么单独一格：搜索与构建会同时在跑（搜索兜底扫描期间用户就能点「构建索引」），
     * 共用 `_searchJobs` 的话「停止构建」会打到在跑的搜索上、把搜索打断。
     * @param jobId - 渲染层生成的批次标识；缺省/空白时 undefined（不可取消）。
     */
    protected searchIndexSignal(jobId?: string): {
        signal: AbortSignal;
        done: () => void;
    } | undefined;
    /**
     * 取消一次搜索索引构建。返回是否真的找到了在跑的那一次。
     * @param jobId - 要取消的批次标识。
     */
    protected cancelSearchIndexJob(jobId?: string): boolean;
    /**
     * 取一次知识库向量构建的取消信号（W3-11.5）。语义同前三个 `xxxSignal`。
     *
     * 单独一格而不是复用 `_searchIndexJobs`：消息域索引与某个库的向量索引会同时在跑，
     * 共用一格的话，停掉一个会把另一个也打断。
     * @param jobId - 渲染层生成的批次标识；缺省/空白时 undefined（不可取消）。
     */
    protected kbIndexSignal(jobId?: string): {
        signal: AbortSignal;
        done: () => void;
    } | undefined;
    /**
     * 取消一次知识库向量构建。返回是否真的找到了在跑的那一次。
     * @param jobId - 要取消的批次标识。
     */
    protected cancelKbIndexJob(jobId?: string): boolean;
    /**
     * 取一次模型/引擎下载的取消信号（W3-5.5）。语义与前几个 `xxxSignal` 一致。
     *
     * 移植到 download 上的原因：模型 1.5–3.1 GB，一旦开下就是几分钟到十几分钟的等待，
     * 而用户常常是“点错了模型”或者窗口要关了”——— 那一刻他
     * 唯一能做的就是等。取消不删局部文件，下次续传仍然有效。
     * @param jobId - 渲染层生成的下载标识；缺省/空白时 undefined（不可取消）。
     */
    protected whisperDownloadSignal(jobId?: string): {
        signal: AbortSignal;
        done: () => void;
    } | undefined;
    /**
     * 取消一次下载。返回是否真的找到了在下的那一次。
     * @param jobId - 要取消的下载标识。
     */
    protected cancelWhisperDownloadJob(jobId?: string): boolean;
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
    protected makeReasoningEmitter(streamId?: string): ((text: string) => void) | undefined;
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
    protected makeStageEmitter(streamId?: string): ((stage: {
        key: string;
        label: string;
        status: 'running' | 'done' | 'skipped';
        detail?: string;
    }) => void) | undefined;
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
    /** Run any enabled daily-summary task whose schedule time matches the current minute. */
    protected maybeRunDueTasks(): Promise<void>;
}
