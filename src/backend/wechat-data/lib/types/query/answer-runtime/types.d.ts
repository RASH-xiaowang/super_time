/**
 * Answer runtime v2 的稳定公共契约。
 *
 * 这一层只描述「运行时输入什么、产出什么」，不绑定具体 LLM 供应商，也不直接
 * 访问数据库。生产接线只需要提供 `runTurn` / `synthesize` 与工具集，其余
 * 参数修复、范围守卫、重试、证据收敛都在运行时内完成。
 *
 * @module query/answer-runtime/types
 */
import type { ContentBlock, FinishReason, Message, TokenUsage, ToolSchema } from '@deepseek-ai/dsh-llm';
import type { AnswerProfile, AnswerProfileId } from '../tools/profiles.ts';
import type { RetrievalTool, ToolContext, ToolResult } from '../tools/types.ts';
import type { AnswerIntentLlmClassifier, ClassifyAnswerIntentOptions, AnswerIntentDecision } from './intent.ts';
import type { ThreadState } from './thread-state.ts';
import type { AnswerStatus, BuildEvidenceOptions, EvidenceBundle, EvidenceItem, EvidenceLocator, EvidenceSource } from './evidence.ts';
import type { ToolErrorClass } from './errors.ts';
/** 会话目录项：真实 username 与可被用户输入的显示名/别名。 */
export interface AnswerSessionCatalogEntry {
    username: string;
    name?: string;
    aliases?: readonly string[];
}
/**
 * 一次「可带工具」的模型轮次输出。
 *
 * 定义放在运行时层而不是 remotes：工具循环是 query 层的能力，不能为了一个函数
 * 类型反向依赖宿主适配层。`remotes/ask-run-chat.ts` 的实现直接满足这个结构。
 */
export interface AnswerModelTurn {
    blocks: ContentBlock[];
    finish: FinishReason;
    text: string;
    reasoning: string;
    usage?: TokenUsage;
}
/** 运行时依赖的模型轮次调用接缝。 */
export type AnswerRunTurnFn = (input: {
    system: string;
    messages: Message[];
    maxTokens: number;
    tools?: ToolSchema[];
    /** 本轮的硬截止/取消信号；实现应把它透传给供应商请求。 */
    signal?: AbortSignal;
    onDelta?: (text: string) => void;
    onReasoning?: (text: string) => void;
}) => Promise<AnswerModelTurn>;
/** 工具阶段的细粒度状态；普通流水线阶段不填。 */
export type AnswerRuntimeToolPhase = 'called' | 'completed' | 'failed' | 'retry';
/**
 * 过程时间线事件（与 AskProcess 的 stage 形状兼容）。
 *
 * 旧字段 `key/label/status/detail` 是**稳定契约**，新增字段全部可选，旧消费者可
 * 继续只认旧字段。工具调用额外携带结构化字段，前端按 `callId` 合并成实时工具卡，
 * 避免在一轮结束后才靠 trace 平铺。
 */
export interface AnswerRuntimeStage {
    key: string;
    label: string;
    status: 'running' | 'done' | 'failed' | 'skipped';
    detail?: string;
    /** 工具调用的结构化阶段；普通流水线阶段为空。 */
    phase?: AnswerRuntimeToolPhase;
    /** provider 签发的调用 id；工具阶段必有，用于前端合并同一张卡。 */
    callId?: string;
    /** 工具名；普通阶段为空。 */
    toolName?: string;
    /** 脱敏、截断后的参数摘要。 */
    argumentsSummary?: string;
    /** 当前是第几次尝试（1 基）。 */
    attempt?: number;
    /** 最多允许的尝试次数。 */
    maxAttempts?: number;
    /** 从本次调用开始到当前事件的耗时。 */
    elapsedMs?: number;
    /** 受限的错误分类，不含原始错误正文。 */
    errorClass?: ToolErrorClass;
    /** 是否是单次工具 deadline 主动超时。 */
    deadlineExceeded?: boolean;
    /** 当前结果命中数。 */
    hits?: number;
    /** 当前结果的确定性事实数。 */
    facts?: number;
}
/** 阶段事件发射器；回调异常不会中断工具循环。 */
export type AnswerRuntimeEmitStage = (stage: AnswerRuntimeStage) => void;
/** 操作日志（与现有 remotes 的 `op` 形状兼容）。 */
export type AnswerRuntimeOp = (category: 'task', action: string, status: 'ok' | 'fail' | 'skip', target: string, detail?: string) => void;
/**
 * 可注入的 sleep（测试传同步替身即可，不会真的等待）。
 *
 * `signal` 是可选的取消信号：实现若监听它，应尽快唤醒并清理定时器。
 * 即使实现忽略该参数，工具循环也会用同一信号与 sleep 竞速，避免取消只能
 * 等完整退避结束。
 */
export type AnswerRuntimeSleep = (ms: number, signal?: AbortSignal) => Promise<void>;
/**
 * 一次工具调用的脱敏 trace。
 *
 * 不记录完整参数正文：模型可能把整段聊天/文件内容塞进 `query`，trace 会落盘
 * 与进界面，完整保存既浪费空间也可能泄漏。只保留参数摘要、耗时、重试与错误类别。
 */
export interface ToolCallTrace {
    /** 全局序号（0 基，按发生顺序）。 */
    index: number;
    /** 第几轮模型调用（1 基）。 */
    round: number;
    /** 供应商签发的 call id。 */
    callId: string;
    /** 工具名。 */
    name: string;
    /** 脱敏、截断后的参数摘要。 */
    argumentsSummary: string;
    ok: boolean;
    /** 是否命中「工具名 + 规范化参数」缓存。 */
    deduplicated: boolean;
    /** 实际尝试次数（缓存命中/跳过为 0）。 */
    attempts: number;
    /** 实际重试次数（attempts - 1，最小 0）。 */
    retries: number;
    elapsedMs: number;
    /** 错误类别；成功时不填。 */
    errorClass?: ToolErrorClass;
    /** 工具层的稳定错误码。 */
    errorCode?: string;
    /** 脱敏、截断后的工具失败正文；成功或未执行时为空。 */
    errorMessage?: string;
    /** 命中数（hits 条数）。 */
    hits: number;
    /** 确定性事实条数。 */
    facts: number;
    /** 是否是我们的单次执行 deadline 主动超时。 */
    deadlineExceeded?: boolean;
    /** 超出本轮调用上限而未执行。 */
    skipped?: boolean;
    /** 人话补充（复用缓存 / 跳过原因 / 工具 note）。 */
    note?: string;
}
/** 已执行工具结果的缓存条目。 */
export interface CachedToolResult {
    /** 工具名 + 规范化参数的稳定键。 */
    key: string;
    name: string;
    args: Record<string, unknown>;
    result: ToolResult;
}
/** 工具循环输入。 */
export interface ToolLoopInput {
    /** 系统提示（工具选择阶段只应包含规则与范围，不应放原始证据）。 */
    system: string;
    /** 初始对话消息；循环不会修改传入数组。 */
    messages: Message[];
    /** 用户问题（用于首轮空输出的混合检索兜底）。 */
    question: string;
    /** 发给模型的工具 schema；缺省时按 profileTools 生成。 */
    tools?: ToolSchema[];
    /** profile 或 id；工具循环会在执行前再次按白名单过滤。 */
    profile: AnswerProfile | AnswerProfileId;
    /** 完整工具集（通常是 buildTools 组装的那份）。 */
    profileTools: readonly RetrievalTool[];
    /** 工具执行上下文；session/clawbot 的边界由运行时预先归一。 */
    toolContext: ToolContext;
    /** 取消检查；工具执行前、退避等待前后调用，取消后不再启动重试。 */
    throwIfCanceled?: () => void;
    /** 取消信号；用于唤醒退避等待，避免只能等 sleep 自然结束。 */
    cancelSignal?: AbortSignal;
    /** 一轮「多消息 + 工具」模型调用（生产用 createAskRunChatTurn）。 */
    runTurn: AnswerRunTurnFn;
    maxRounds?: number;
    maxCallsPerRound?: number;
    maxTokens?: number;
    now?: Date;
    sleep?: AnswerRuntimeSleep;
    /** 单次工具执行 deadline，默认 20s。 */
    toolDeadlineMs?: number;
    /**
     * 单次模型轮次 deadline，默认 120s；0 表示关闭。
     *
     * 超时后会 abort 本轮请求并抛出 `model_timeout`，不会让旧请求继续占用
     * 模型额度或在晚到时污染新一轮消息。
     */
    modelDeadlineMs?: number;
    /** 首轮模型既无文本也无工具调用时的兜底查询；缺省用 question。 */
    fallbackQuery?: string;
    /**
     * 首轮没有工具调用时按顺序尝试的兜底工具。
     *
     * 由意图建议按 profile 白名单过滤后传入；运行时仍会在执行前做范围与必填校验。
     * 缺省保持旧行为：只回退 search_hybrid / search_kb。
     */
    fallbackTools?: readonly string[];
    /** 最多执行几个确定性兜底工具（默认 3，且不会超过每轮调用上限）。 */
    maxFallbackCalls?: number;
    /** 参数修复用的已知会话（显示名或 username）。 */
    knownSessions?: string[];
    /** 结构化会话目录；用于把显示名确定性解析成真实 username。 */
    knownSessionCatalog?: readonly AnswerSessionCatalogEntry[];
    /** 参数修复用的已知联系人；缺省回退 toolContext.knownEntities。 */
    knownContacts?: string[];
    /** assistant 消息的 provider/model 溯源（只用于回放消息）。 */
    assistantSource?: {
        provider: string;
        model: string;
    };
    emitStage?: AnswerRuntimeEmitStage;
    op?: AnswerRuntimeOp;
    onDelta?: (text: string) => void;
    onReasoning?: (text: string) => void;
}
/** 工具循环停止原因。 */
export type ToolLoopStopReason = 'stop' | 'max-rounds' | 'no-output' | 'no-tool-call';
/** 工具循环产出。 */
export interface ToolLoopResult {
    /** 最终对话（含 assistant tool-call 与 tool-result，可直接续跑）。 */
    messages: Message[];
    finalText: string;
    /** 已去除 reasoning 的最终 assistant blocks。 */
    finalBlocks: ContentBlock[];
    rounds: number;
    exhausted: boolean;
    fallbackUsed: boolean;
    stopReason: ToolLoopStopReason;
    /** 去重后的实际执行结果（缓存命中的重复调用不重复追加）。 */
    toolResults: ToolResult[];
    toolCalls: ToolCallTrace[];
    cachedResults: CachedToolResult[];
    /** 每次模型调用的 usage；生产侧按需累加，避免这里猜聚合口径。 */
    usages: TokenUsage[];
}
/**
 * 证据到引用形状的映射。
 *
 * 字段与现有 `AskCitation` 对齐（多出 `index/evidenceId/locator` 便于反馈归因），
 * 因此可以直接赋给 `AskResult.citations`。知识库缺 trace 时沿用证据层的
 * `0` / 空串约定，表示「该文件块没有可用的定位信息」。
 */
export interface AnswerRuntimeCitation {
    index: number;
    evidenceId: string;
    source: EvidenceSource;
    name: string;
    time: string;
    snippet: string;
    username: string;
    local_id: number;
    sender?: string;
    kb?: {
        kbId: number;
        chunkId: number;
        fileName: string;
        fileId: number;
        fileExt: string;
        ordinal: number;
        page: number;
        heading: string;
    };
    locator: EvidenceLocator;
}
/** 文件/收藏/朋友圈等资源的可点击定位（不伪装成消息引用）。 */
export interface AnswerRuntimeResourceCitation {
    evidenceId: string;
    tool: string;
    key: string;
    name: string;
    time: string;
    snippet: string;
    locator: EvidenceLocator;
}
/** 综合生成输入。 */
export interface AnswerSynthesisInput {
    question: string;
    system: string;
    profile: AnswerProfile;
    context: ToolContext;
    intent: AnswerIntentDecision;
    evidence: EvidenceBundle;
    toolResults: ToolResult[];
    /** 工具循环最后一轮的可见文本（可能为空）。 */
    finalText: string;
    messages: Message[];
    now: Date;
}
/** 综合生成输出；允许覆盖状态与引用。 */
export interface AnswerSynthesisOutput {
    answer: string;
    status?: AnswerStatus;
    citations?: readonly AnswerRuntimeCitation[];
    usage?: TokenUsage;
}
/** 生产侧注入的综合生成回调。 */
export type AnswerSynthesizeFn = (input: AnswerSynthesisInput) => Promise<string | AnswerSynthesisOutput> | string | AnswerSynthesisOutput;
/**
 * 高层运行时输入。
 *
 * `runTurn` 只负责工具选择/多轮工具调用；最终回答由 `synthesize` 在拿到
 * 收敛后的证据包后单独生成，这样模型在工具阶段看不到整段原文，降低泄漏面。
 */
export interface AnswerRuntimeInput {
    question: string;
    system: string;
    messages: Message[];
    profile: AnswerProfile | AnswerProfileId;
    profileTools: readonly RetrievalTool[];
    toolContext: ToolContext;
    /** 取消检查；工具执行前、退避等待前后调用，取消后不再启动重试。 */
    throwIfCanceled?: () => void;
    /** 取消信号；用于唤醒退避等待，避免只能等 sleep 自然结束。 */
    cancelSignal?: AbortSignal;
    tools?: ToolSchema[];
    runTurn: AnswerRunTurnFn;
    maxRounds?: number;
    maxCallsPerRound?: number;
    maxTokens?: number;
    now?: Date;
    sleep?: AnswerRuntimeSleep;
    toolDeadlineMs?: number;
    /** 单次模型轮次 deadline，默认 120s；0 表示关闭。 */
    modelDeadlineMs?: number;
    fallbackQuery?: string;
    /** 意图建议优先检查的工具；运行时按 profile 白名单过滤后使用。 */
    fallbackTools?: readonly string[];
    maxFallbackCalls?: number;
    knownSessions?: string[];
    /** 结构化会话目录；用于把「z_卖酒」这类显示名确定性解析成 username。 */
    knownSessionCatalog?: readonly AnswerSessionCatalogEntry[];
    knownContacts?: string[];
    assistantSource?: {
        provider: string;
        model: string;
    };
    emitStage?: AnswerRuntimeEmitStage;
    op?: AnswerRuntimeOp;
    onDelta?: (text: string) => void;
    onReasoning?: (text: string) => void;
    /** 意图识别选项；now 由运行时统一注入。 */
    intentOptions?: Omit<ClassifyAnswerIntentOptions, 'now'>;
    /** 低置信/需澄清时使用的轻量意图分类器；高置信规则不会调用它。 */
    intentClassifier?: AnswerIntentLlmClassifier;
    /** 分类器独立短 deadline（默认 4000ms；0 表示关闭）。 */
    intentClassifierDeadlineMs?: number;
    /** 可选的上一轮线程状态；只用于意图继承，不直接改工具参数。 */
    threadState?: ThreadState;
    /** 证据预算与状态覆盖。 */
    evidenceOptions?: BuildEvidenceOptions;
    /** 综合生成使用的系统提示；缺省沿用工具选择阶段的 system。 */
    synthesisSystem?: string;
    /**
     * 证据不足/失败时是否仍调用 synthesize。
     *
     * 缺省 false：直接返回工具循环的可见文本或证据摘要，并保留 insufficient/failed
     * 状态。ClawBot 的聊天兜底若依赖 synthesize，可显式打开。
     */
    synthesizeOnInsufficient?: boolean;
    /**
     * 意图判定为「需要澄清」时是否直接停止检索。
     *
     * 缺省 true（微信问答 / 会话内问答）：指代不明时先问清，避免拿错会话硬答。
     * kb-only 入口（ClawBot）缺省 false：它没有跨会话风险，仍应尝试知识库后再
     * 由回复文本追问。
     */
    clarifyBeforeSearch?: boolean;
    synthesize?: AnswerSynthesizeFn;
}
/** 高层运行时产出。 */
export interface AnswerRuntimeResult {
    status: AnswerStatus;
    answer: string;
    intent: AnswerIntentDecision;
    evidence: EvidenceBundle;
    profile: AnswerProfileId;
    /** 归一后的执行上下文（clawbot 会强制 wechatDataEnabled=false）。 */
    context: ToolContext;
    toolCalls: ToolCallTrace[];
    toolResults: ToolResult[];
    citations: AnswerRuntimeCitation[];
    resources: AnswerRuntimeResourceCitation[];
    rounds: number;
    exhausted: boolean;
    fallbackUsed: boolean;
    synthesized: boolean;
    messages: Message[];
    usages: TokenUsage[];
    durationMs: number;
    /** 阻断/空证据/综合失败的可解释原因。 */
    reason?: string;
    synthesisError?: string;
}
/** 便于调用方构造引用时复用证据项形状。 */
export type AnswerRuntimeEvidenceItem = EvidenceItem;
