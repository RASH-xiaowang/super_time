import type { ClawbotAutoReplyStage, ClawbotAutoReplyStats, ClawbotInstanceConfig, ClawbotSendResult, OperationCategory, OperationStatus } from '../../types.ts';
/**
 * 自动回复正文的**总长**上限（超出截断并注明）。
 *
 * 取 **300**（2026-10-17 用户要求「每次回复不能超过 30 字」）：单条上限 30 字，
 * 300 字 = 最多 10 条 —— 再多就不是「回一条消息」而是「刷屏」了。
 * 模型可以输出很长，微信会话不该被一条回复刷屏。
 */
export declare const MAX_REPLY_CHARS = 300;
/** 每实例的待回复上限（超出丢弃并记账）：一批几百条消息不该把模型调用打爆。 */
export declare const MAX_PENDING = 5;
/** 后台恢复默认周期；durable runner 用 unref timer 定期吸收分页上限之后的积压。 */
export declare const DEFAULT_RECOVERY_INTERVAL_MS = 60000;
/** 一轮恢复撞到安全预算后，短延迟续跑而不是干等下一个完整周期。 */
export declare const DEFAULT_RECOVERY_CONTINUATION_MS = 100;
export type AutoReplyRunnerStage = ClawbotAutoReplyStage;
/** runner 的稳定可观测快照；类型与 Remote 契约共用。 */
export type AutoReplyRunnerStats = ClawbotAutoReplyStats;
/**
 * 一条对话上下文消息（自动回复把最近几轮一起送进 ask 管道）。
 *
 * 为什么要带上下文（2026-10-18 用户报「不能关联上下文」）：只把最后一条文本当问题，
 * 模型会把「分析一下图中右边那辆车」当成一句孤立的话，于是回「我这边没看到图呀」。
 * 上下文里保留 `[图片]` / `[语音]` 占位，模型至少知道对方发过什么。
 */
export interface ClawbotHistoryMessage {
    role: 'user' | 'assistant';
    content: string;
}
/**
 * 一张随消息送进模型的图片（canonical base64 + MIME）。
 *
 * 图片由调用方从 ClawBot 媒体缓存读出；是否真的能送给模型由 ask 管道按模型能力决定，
 * 本模块不判断（也不联网）。
 */
export interface ClawbotImageInput {
    data: string;
    mediaType: string;
    name?: string;
}
/** 自动回复附带的上下文（最近对话 + 最近图片）。 */
export interface ClawbotAskContext {
    history?: ClawbotHistoryMessage[];
    images?: ClawbotImageInput[];
}
/**
 * 自动回复用的 ask 能力（由装配层注入）。
 *
 * 形状刻意保持很窄（一个问题 + 可选知识库 + 可选系统提示词 + 可选上下文 ⇒ 一段答案）：
 * 调用方不许知道模型是谁、也不许自己拼提示词 —— 那些都在 ask 管道里，
 * 与手动问答共用一份实现。
 * @param slot - 实例编号。
 * @param text - 入站消息正文（作为问题）。
 * @param kbId - 非 null 时把该知识库纳入检索（知识库增强回复）。
 * @param systemPrompt - 该实例的系统提示词（空串 = 用内置拟人化默认值）。
 * @param context - 最近对话与图片（2026-10-18 起；旧注入方可忽略）。
 */
export type ClawbotAskFn = (slot: number, text: string, kbId: number | null, systemPrompt: string, context?: ClawbotAskContext) => Promise<{
    ok: boolean;
    answer: string;
    error?: string;
}>;
/** 决策结果（`should` 为假时 `reason` 说明为什么，供审计与用例断言）。 */
export interface AutoReplyDecision {
    should: boolean;
    reason: string;
    /** 要带进 ask 的知识库；null = 不检索（**不是**「所有库」）。 */
    kbId: number | null;
}
/**
 * 该实例现在该不该自动回复。
 *
 * 只认开关，不看消息内容：**「开了就回」是用户的显式选择**，自动回复不该再自作主张
 * 判断「这句话值不值得回」（那类启发式一旦误判，用户看到的是「有时候回有时候不回」）。
 * @param cfg - 该实例的行为配置（每次现读，用户改完立即生效）。
 * @returns 决策（含实际要用的 kbId）。
 */
export declare function decideAutoReply(cfg: ClawbotInstanceConfig): AutoReplyDecision;
/** 一条候选消息里，本模块关心的那几列。 */
export interface ReplyableMessage {
    direction: 'in' | 'out';
    msgType: string | null;
    content: string;
    /** 落库行 id（用于从库里取「这条之前的对话」与媒体缓存；旧调用方可不带）。 */
    id?: number;
}
/**
 * 这条消息值不值得回。
 *
 * `direction === 'out'` 的是**本机发出去的**（含 bot 回显）——回它就成了自己跟自己说话；
 * 非文本（图片/语音/文件/视频）不做自动回复：媒体的语义要么靠转写（未接入）、
 * 要么本来就是「转存给人看」而不是「问问题」。
 * @param msg - 候选消息。
 * @returns 可回复为 true。
 */
export declare function isReplyable(msg: ReplyableMessage): boolean;
/**
 * 从一批候选里挑出**唯一**要回的那条：最后一条可回复的入站文本。
 *
 * 为什么一批只回一条（而不是逐条回）：服务端不下发消息时间，所以「刚绑定、首次长轮询
 * 拉回一堆历史」与「用户连发几条」在数据上长得一样。逐条回会在前者场景里刷屏，
 * 只回最后一条把上界压到 1 条，且对后者也是最自然的反应（人也不会逐条回）。
 * @param candidates - 本批新落库的消息。
 * @returns 目标（无则 null）与被跳过的条数（供审计说清「这一批跳了多少」）。
 */
export declare function pickReplyTarget(candidates: readonly ReplyableMessage[]): {
    target: ReplyableMessage | null;
    dropped: number;
};
/** 超长回复截断（带上「已截断」字样，不假装完整）。 */
export declare function truncateReply(text: string): string;
/** 自动回复发送时带出的持久化关联键（手动发送不传）。 */
export interface AutoReplySendContext {
    clientId: string;
    runId: number;
    partId: number;
    partIndex: number;
}
/**
 * 持久化编排依赖。
 *
 * 不传时执行器保持原来的纯内存队列行为（既有单测与旧注入方零改动）；
 * 生产装配传入后，每个目标消息先落 reply_run，再按 outbox 分段发送。
 */
export interface AutoReplyDurableDeps {
    /** 解密数据根（clawbot.db 在它的父目录）。 */
    dir: () => string;
    /** 同 slot 的入站合并窗口；缺省 1s。 */
    debounceMs?: number;
    /** 生成阶段最多尝试次数；缺省 3。 */
    maxGenerationAttempts?: number;
    /** 单段发送最多尝试次数；缺省 5。 */
    maxPartAttempts?: number;
    /** 指数退避基数；缺省 3s。 */
    retryBaseMs?: number;
    /** 生成租约；缺省 60s，长任务由 runner 心跳续租。 */
    generationLeaseMs?: number;
    /** 单段发送租约；缺省 30s，长任务由 runner 心跳续租。 */
    sendLeaseMs?: number;
    /** 单次生成截止时间；缺省 120s，<=0 表示不额外限时。 */
    askTimeoutMs?: number;
    /** 单段发送截止时间；缺省 60s，<=0 表示不额外限时。 */
    sendTimeoutMs?: number;
    /** 恢复分页大小；缺省 500，主要供压测和故障注入调小。 */
    recoveryPageSize?: number;
    /** 单轮恢复最多扫描多少行；缺省 10000。 */
    recoveryMaxScanPerRound?: number;
    /** 单轮恢复最多新增多少个调度；缺省 5000。 */
    recoveryMaxSchedulesPerRound?: number;
}
export interface AutoReplyRunnerDeps {
    /** 取该实例的配置（**每次现读**：用户关掉开关后，队列里的下一条就不再回）。 */
    readConfig: (slot: number) => ClawbotInstanceConfig;
    /**
     * 同一 slot 的候选合并窗口（毫秒）。默认 0 = 立即入队，保持旧行为。
     * > 0 时窗口内连续 consider 只保留最后一条可回复文本。
     */
    debounceMs?: number;
    /** 统一问答管道（缺省 = 未注入 ⇒ 自动回复不可用，只记账不发送）。 */
    ask?: ClawbotAskFn;
    /** 发送（生产 = `sendClawbotText`：**成功才落库**，失败不写假记录）。 */
    send: (slot: number, text: string, context?: AutoReplySendContext) => Promise<ClawbotSendResult>;
    /** 审计一行（`category='clawbot'`）。 */
    op: (category: OperationCategory, action: string, status: OperationStatus, target?: string, detail?: string) => void;
    /** 回复成功后通知外层（发 `clawbot/message` 事件，前端实时可见）。 */
    onReplied: (info: {
        slot: number;
        id: number;
    }) => void;
    /** 取目标消息之前的最近对话（缺省 = 不带上下文，退回旧行为）。 */
    history?: (slot: number, target: ReplyableMessage) => ClawbotHistoryMessage[];
    /** 取目标消息之前最近的入站图片（缺省 = 不送图；读取失败按空处理）。 */
    images?: (slot: number, target: ReplyableMessage) => Promise<ClawbotImageInput[]>;
    /** 持久化 run/outbox；缺省 = 纯内存队列（旧行为）。 */
    durable?: AutoReplyDurableDeps;
    /** durable 后台恢复周期；缺省 60s，非正数禁用。 */
    recoverIntervalMs?: number;
}
/**
 * 自动回复执行器：**全局单飞 + 每实例队列**。
 *
 * 单飞是全局的（同一时刻只有一轮 ask 在跑）：模型调用本来就慢，并发起来只会
 * 让几个号一起变慢，还不好排查；而会话内部的顺序本来就必须串行。
 *
 * 多个实例都有积压时按 slot ring 公平轮转，避免 Map 插入顺序让先到的实例一直饿死其他实例。
 * @param deps - 注入依赖（见 {@link AutoReplyRunnerDeps}）。
 * @returns `consider(slot, candidates)` 与测试用的 `pending()`。
 */
export declare function createAutoReplyRunner(deps: AutoReplyRunnerDeps): {
    consider: (slot: number, candidates: readonly ReplyableMessage[]) => void;
    pending: () => number;
    recover: () => void;
    discard: (slot: number) => void;
    stats: () => AutoReplyRunnerStats;
    dispose: () => void;
};
