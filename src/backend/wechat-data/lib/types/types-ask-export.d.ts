/**
 * `types.ts` 的 ask-export 部分（M21 拆分；纯类型，无运行期值）。
 *
 * 从 `types.ts` 原样搬出，`types.ts` 继续以 `export *` 转发 ⇒ 所有
 * `from './types.ts'` / `from '../types.ts'` 的导入路径一行都不用改。
 *
 * @module types-ask-export
 */
import type { TokenUsage } from '@deepseek-ai/dsh-llm';
import type { AnswerStatus, EvidenceBundle } from './query/answer-runtime/evidence.ts';
import type { AnswerRuntimeResourceCitation, ToolCallTrace } from './query/answer-runtime/types.ts';
import type { ThreadState } from './query/answer-runtime/thread-state.ts';
import type { AskCitation } from './query/ask-citation-types.ts';
export type { ThreadState } from './query/answer-runtime/thread-state.ts';
export type { AskCitation } from './query/ask-citation-types.ts';
/** 语音消息的可播放音频（16kHz 单声道 wav 的 data URL）。 */
export interface VoiceDataUrlResult {
    url?: string;
    /** 由 wav 头算出的时长（秒），供界面显示与校验。 */
    durationSec?: number;
    error?: string;
}
/** Export result (written file path + count). */
export interface ExportResult {
    path: string;
    filename: string;
    count: number;
}
/**
 * 一次导出在**历史记录**里的形态。
 *
 * 与 `operation_log` 的区别：操作日志是「审计」口径（谁在何时做了什么，只留元数据），
 * 而这里是「可操作」口径 —— 用户要能据此**定位文件、重新导出、删除文件**，所以必须
 * 记住 `path`（绝对路径）、`params`（重跑导出所需的全部参数）与 `sizeBytes`。
 */
export interface ExportHistoryEntry {
    id: number;
    ts: number;
    /** 导出种类：contacts / favorites / records / moments / privacy / session / annual / all_sessions / backup。 */
    kind: string;
    /** 人类可读的说明（如「联系人 · 好友」「会话 · 某某」）。 */
    label: string;
    /** 落盘格式：csv / txt / html / xlsx / md / json / zip / wcb / dir。 */
    format: string;
    /** 绝对路径。 */
    path: string;
    /** 文件名（便于列表显示与搜索，避免每次都从 path 切）。 */
    filename: string;
    /** 文件字节数；目录型导出（备份目录）为 null。 */
    sizeBytes: number | null;
    /** 导出的行数/条数。 */
    rows: number;
    status: ExportStatus;
    /** 失败原因或补充说明。 */
    error: string;
    /** 重新导出所需的原始入参（JSON 文本；不存任何消息正文）。 */
    params: string;
    /**
     * 记录生成时的磁盘核对结果：文件是否仍存在。
     * 落库时是快照，展示前会由 `reconcileExportHistory` 刷新 —— 用户可能在资源管理器里
     * 把它移走或删掉，历史列表必须如实反映，而不是一直显示「存在」。
     */
    existsNow: boolean;
}
/** 导出结果状态。 */
export type ExportStatus = 'ok' | 'fail' | 'canceled';
/** 读取导出历史的筛选/排序/分页条件。 */
export interface ExportHistoryQuery {
    /** 文本搜索：匹配文件名、说明、路径与种类。 */
    q?: string;
    /** 只保留这些种类（空/缺省表示全部）。 */
    kinds?: string[];
    status?: ExportStatus;
    /** 起始时间（毫秒，含）。 */
    from?: number;
    /** 结束时间（毫秒，含）。 */
    to?: number;
    /** 排序字段。 */
    sort?: 'ts' | 'size' | 'rows' | 'name';
    /** 排序方向。 */
    order?: 'asc' | 'desc';
    limit?: number;
    offset?: number;
}
/** 导出历史一页：条目 + 命中总数 + 各聚合数（用于页签上的计数）。 */
export interface ExportHistorySnapshot {
    items: ExportHistoryEntry[];
    total: number;
    /** 各状态的条数（ok/fail/canceled），用于「仅看失败」这类筛选的计数。 */
    statusCounts: Record<string, number>;
    /** 各导出种类的条数，用于种类页签计数。 */
    kindCounts: Record<string, number>;
    /** 命中条目的文件总字节数（文件已被外部删除的不计）。 */
    totalBytes: number;
    /** 命中条目里文件已不在磁盘上的条数（供「清理失效记录」提示）。 */
    missingCount: number;
    /**
     * 非空 = 这一页**没读到**（隐私库打不开 / 被占用 / 表损坏），`items` 因此是空的。
     * P1-1/#9：没有这个字段时，界面画的是「还没有导出记录」，而真实原因是记录库读不动。
     */
    readError?: string;
}
/** 删除导出历史的结果。 */
export interface ExportHistoryDeleteResult {
    /** 实际删除的记录数。 */
    removed: number;
    /** 连带删除的文件数。 */
    filesDeleted: number;
    /** 删除文件失败的文件名（记录仍会被删除，这里如实回报）。 */
    fileErrors: string[];
}
/**
 * 清理导出历史的策略（两个条件都满足才删；都为 0/缺省则不删任何东西 ——
 * 避免「传空对象把历史清光」这种误调用）。
 */
export interface ExportHistoryPruneOptions {
    /** 只清理早于「现在 - olderThanDays 天」的记录。 */
    olderThanDays?: number;
    /** 只保留最近 keepLatest 条，其余作为清理候选。 */
    keepLatest?: number;
    /** 是否连带删除磁盘上的文件。 */
    deleteFiles?: boolean;
    /** 只清理文件已不存在的失效记录（忽略上面两个条件）。 */
    onlyMissing?: boolean;
}
/** Ask optimization result: rewritten question + improvement suggestions. */
export interface AskOptimizeResult {
    optimized: string;
    suggestions: string[];
}
/** Ask retrieval plan: intent + decomposed sub-queries + resolved scope hints. */
export interface AskPlan {
    intent: string;
    subQueries: string[];
    /** 规划器从问题里换算出的绝对日期范围（YYYY-MM-DD；未识别为空）。 */
    from?: string;
    to?: string;
    /** 问题里点名的人（用于命中加分）。 */
    person?: string;
    /** 实际参与检索的词项（去停用词后的 bigram/关键词）。 */
    terms?: string[];
}
/** Ask result: LLM answer + source citations (+ the retrieval plan used). */
/**
 * 「推荐回复」的结果：按当前会话上下文（+ 用户选中的知识库）生成的候选回复。
 */
export interface ReplySuggestResult {
    ok: boolean;
    /** 候选回复（最多 3 条，按建议顺序）。`ok=false` 时缺省 —— 客户端按空数组处理。 */
    replies?: string[];
    /** 失败原因（`ok=false` 时）—— 被隐私闸门拦下与「模型不可用」是两句不同的话。 */
    error?: string;
    /** 这次依据了多少条会话消息（供界面如实说明依据，而不是笼统说「已参考」）。 */
    messageCount?: number;
    /** 这次依据了多少段知识库片段。 */
    kbSnippetCount?: number;
    /** 降级说明：选了库但没命中时如实说明「这次只用了会话上下文」。 */
    degraded?: string;
}
export interface AskResult {
    answer: string;
    citations: AskCitation[];
    /** 本轮问答的执行状态（工具/证据/综合各阶段收敛后的结果）。 */
    status?: AnswerStatus;
    /** 空证据、澄清、阻断或降级的可读原因。 */
    reason?: string;
    /**
     * 状态原因的统一展示口径：优先综合失败原因，其次为空证据/阻断原因。
     * 保留 `reason` / `synthesisError` 两个原字段，避免诊断信息在映射时丢失。
     */
    statusReason?: string;
    /** 综合生成失败时的原始错误（证据仍会保留并降级返回）。 */
    synthesisError?: string;
    /** 本轮真实执行过的工具 trace（不含完整参数正文）。 */
    toolCalls?: ToolCallTrace[];
    /** 收敛、去重、预算截断后的证据包。 */
    evidence?: EvidenceBundle;
    /** 文件/收藏/朋友圈等独立资源的可点击引用。 */
    resources?: AnswerRuntimeResourceCitation[];
    /** 本轮结束后的多轮线程状态，可传给下一次问答继承指代与时间。 */
    threadState?: ThreadState;
    /** Retrieval plan used for this answer (multi-turn pipeline). */
    plan?: AskPlan;
    /**
     * 模型的**思考过程**（2026-10-16 新增）。
     *
     * 为什么单独一个字段而不是拼进 `answer`：思考与可见正文是两条独立的流
     * （模型可能先吐一大段 reasoning 再吐正文），界面上要能**分开折叠展示** ——
     * 拼在一起就没法只收起思考、也没法只复制正文。
     *
     * 只在模型真的产出 reasoning 时才有值（多数非推理模型没有）。
     */
    reasoning?: string;
    /** 回答正文里真正引用到的来源序号（1 基，对应 citations 的下标 +1）。 */
    citedIndexes?: number[];
    /**
     * 数据来源说明（条数/会话数/时间跨度 + 回答引用了哪几条），**由检索结果算出**，
     * 不是模型写的 —— 用户可据此逐条对照原文。
     */
    basis?: string;
    /** 本轮没有检索到任何原文：未调用模型，直接说明无法回答。 */
    insufficient?: boolean;
    /** 模型给出的内容无法对应到任何一条原文：已不予采用，改为明确告知无证据。 */
    withheld?: boolean;
    /** 回答是否实际使用了检索材料；`false` 时无人值守通道不得发送。 */
    evidenceUsed?: boolean;
    /**
     * 接地核对结果（生成之后用**回答自己引用的原文**做的确定性复核）：
     *   · checked —— 校验过的「必须逐字来自原文」的值个数（金额/日期/长数字串）；
     *   · unsupported —— 原文里找不到出处的值（界面据此提示「可能是编造或推算」）；
     *   · cited —— 回答真正引用到的来源条数；
     *   · repaired —— 是否因核对未通过而触发过一次重写。
     * 注意：金额不硬拦截（合计是模型可以算出来的），因此 unsupported 非空**不代表**
     * 回答被弃用 —— 只有「一条 [n] 都没有」才会走 withheld。
     */
    grounding?: {
        checked: number;
        unsupported: string[];
        cited: number;
        repaired: boolean;
    };
    /** 本轮检索的追踪 id：反馈时回传它，才能把「哪条引用有用」归因到检索特征。 */
    retrievalId?: string;
    /**
     * 本轮模型调用的 token 用量（2026-10-19）。
     *
     * 一次问答可能调用模型多次（检索规划 / 生成 / 接地回炉），这里是**累加值**；
     * 供应商不返回 usage（或全部没有）时缺省为 undefined —— 不伪造 0。
     * ClawBot 自动回复用它按实例记账（`clawbot_token_usage`）。
     */
    usage?: TokenUsage;
    /** 检索统计（命中候选数 / 保留数 / 范围），用于解释「为什么只有这些来源」。 */
    retrieval?: {
        candidates: number;
        kept: number;
        scope: string;
        recency: boolean;
        /** 规划器推断出的时间线索（软偏好，非硬过滤）。 */
        timeHint?: string;
        /** 保留的引用里落在时间线索范围内的条数。 */
        hintHits?: number;
        /** 命中消息聚类后的对话窗口数（chunk 级检索）。 */
        chunks?: number;
        /** 窗口展开实际取回的消息条数。 */
        windowMessages?: number;
        /** 多阶段流水线：分类出的查询意图。 */
        intent?: string;
        /** 多阶段流水线：稠密通道是否真正生效（false 说明已降级为纯稀疏）。 */
        denseActive?: boolean;
        /** 多阶段流水线：各召回通道命中数。 */
        channels?: Array<{
            channel: string;
            count: number;
            active: boolean;
            note?: string;
        }>;
        /** 多阶段流水线：端到端检索耗时（毫秒）。 */
        elapsedMs?: number;
        /** 多阶段流水线：召回 → 融合 → 重排 → 压缩 各阶段数量，用于解释「为什么只剩这些」。 */
        funnel?: {
            recalled: number;
            fused: number;
            ranked: number;
        };
        /**
         * W3-6.3：**精排（rerank）到底有没有用上**。
         *
         * 为什么必须独立成字段：之前它只被拼进 `basis` 的一句文本里，前端想显示
         * 「精排：本地线性加权」就得去 parse 那句话。而这句话对用户很重要 ——
         * 「为什么排第一的是它」在两种模型下答案完全不同（LLM 精排 vs 本地加权）。
         *
         * `used=false` 时 `note` 说明原因（没配模型 / 模型不可用 / 候选太少…）。
         */
        rerank?: {
            used: boolean;
            candidates: number;
            kept: number;
            model?: string;
            note?: string;
        };
        /**
         * W2-6.4：**检索索引正在后台更新**，这一轮用的是更新前的索引。
         *
         * 为什么单开一个字段而不是塞进 `channels[].note`：那一栏说的是「某个通道召回了几条」，
         * 而这一条说的是「**这次回答的检索空间本身**不是最新的」。混进去用户会以为某个通道坏了。
         * `undefined` = 索引是新的，不需要提示。
         */
        indexNote?: string;
    };
}
/**
 * 一次问答在**历史记录**里的结局。
 *
 * 与「操作日志」的区别：日志只记「发生了一次任务」，这里要区分「回答成不成立」——
 * 用户回看历史时最需要知道的是「这条当时是不是真的答上了」。
 *   · ok           —— 正常回答（至少引用了一条原文）；
 *   · insufficient —— 没有检索到任何原文，未调用模型；
 *   · withheld     —— 模型内容无法对应到任何原文，已不予采用；
 *   · fail         —— 调用过程出错（模型未配置 / 检索或生成失败等）。
 *
 * ⚠ 2026-09-30 起「出站拦截」已随应用内出网开关整体移除，失败原因里不再有它。
 */
export type AskHistoryStatus = 'ok' | 'insufficient' | 'withheld' | 'fail';
/**
 * 一次问答的完整记录（问题 + 回答 + 引用 + 检索元信息）。
 *
 * 这是应用里**唯一**存问答正文的表，因此比审计表敏感：只落本机、按数据根隔离、
 * 不参与任何导出，且用户可逐条删除或整体清空。
 */
export interface AskHistoryEntry {
    id: number;
    /** 问答发生时间（毫秒）。 */
    ts: number;
    question: string;
    answer: string;
    /** 入口来源：ask（微信问答页签）/ session（会话内问答）。 */
    source: string;
    /** 会话范围（空 = 全部会话）。 */
    username: string;
    /** 会话显示名（列表直接显示，不必再查会话表）。 */
    usernameName: string;
    /** 时间范围（YYYY-MM-DD，空 = 全部时间）。 */
    from: string;
    to: string;
    /** 回答模型（provider · model）。 */
    model: string;
    /** 检索规划器识别的意图。 */
    intent: string;
    /** 实际参与检索的词项。 */
    terms: string[];
    /** 引用来源（原样还原为对象，点击可跳转原文）。 */
    citations: AskCitation[];
    /** 回答正文里真正引用到的序号（1 基）。 */
    citedIndexes: number[];
    /** 数据来源说明（由检索结果算出，非模型生成）。 */
    basis: string;
    status: AskHistoryStatus;
    /** 失败原因（status='fail' 时有值）。 */
    error: string;
    /** 多阶段检索统计（结构化；老记录可能为 null）。 */
    retrieval: Record<string, unknown> | null;
    /** 端到端耗时（毫秒）；0 表示未记录。 */
    elapsedMs: number;
}
/** 读取问答历史的筛选/排序/分页条件。 */
export interface AskHistoryQuery {
    /** 文本搜索：匹配问题、回答、会话名、检索词与意图。 */
    q?: string;
    /** 只保留这些来源（空/缺省表示全部）。 */
    sources?: string[];
    status?: AskHistoryStatus;
    /** 起始时间（毫秒，含）。 */
    from?: number;
    /** 结束时间（毫秒，含）。 */
    to?: number;
    /** 排序字段。 */
    sort?: 'ts' | 'question';
    /** 排序方向（默认 desc = 最新优先）。 */
    order?: 'asc' | 'desc';
    limit?: number;
    offset?: number;
}
/** 问答历史一页：条目 + 命中总数 + 各聚合数（用于筛选页签上的计数）。 */
export interface AskHistorySnapshot {
    items: AskHistoryEntry[];
    total: number;
    /** 各状态的条数（ok/insufficient/withheld/fail）。 */
    statusCounts: Record<string, number>;
    /** 各来源的条数（ask/session）。 */
    sourceCounts: Record<string, number>;
}
/** 删除问答历史的结果。 */
export interface AskHistoryDeleteResult {
    /** 实际删除的记录数。 */
    removed: number;
}
/** 清空问答历史的结果。 */
export interface AskHistoryClearResult {
    /** 实际删除的记录数。 */
    removed: number;
}
