/**
 * Answer runtime v2 的统一意图识别。
 *
 * 这一层不替代 `query/retrieval/intent.ts`：旧分类器继续服务检索流水线，
 * 这里把它映射成更适合「工具调用 + 多轮上下文」的统一意图，并补上旧分类器
 * 没有表达的范围线索：会话、联系人、时间、消息序号、媒体类型、聚合维度。
 *
 * 设计约束：
 * 1. 规则分类是默认路径，零网络、可离线、可单测；
 * 2. LLM 只是注入式补充，未注入时不依赖模型；
 * 3. LLM 不得覆盖规则已经高置信识别的明确问法，只能补字段或修正低置信结果；
 * 4. 每个结论都带 reason / confidence / toolHints，可直接写入 AnswerTrace。
 *
 * @module query/answer-runtime/intent
 */
import type { IntentKind } from '../retrieval/types.ts';
/** 统一回答意图。 */
export type AnswerIntentKind = 'lookup' | 'aggregate' | 'relation' | 'timeline' | 'content_media' | 'open_qa' | 'clarify';
/** 兼容更短的领域命名。 */
export type AnswerIntent = AnswerIntentKind;
/** 所有统一意图，供 LLM 输出校验与外部枚举。 */
export declare const ANSWER_INTENT_KINDS: readonly AnswerIntentKind[];
/** 媒体类型。 */
export type AnswerMediaType = 'image' | 'video' | 'file' | 'voice' | 'link' | 'sticker' | 'other';
/** 聚合维度。 */
export type AnswerAggregationDimension = 'count' | 'sum' | 'average' | 'ranking' | 'distinct' | 'group_by_session' | 'group_by_contact' | 'group_by_time' | 'group_by_keyword' | 'compare';
/** 时间粒度。 */
export type AnswerTimeGranularity = 'day' | 'week' | 'month' | 'year' | 'range' | 'unknown';
/** 时间范围的来源。 */
export type AnswerTimeSource = 'explicit' | 'inherited' | 'progression' | 'llm';
/** 结构化时间范围。 */
export interface AnswerTimeRange {
    from: string;
    to: string;
    granularity: AnswerTimeGranularity;
    source: AnswerTimeSource;
    label: string;
}
/** 历史消息的最小形状（与 Ask / ClawBot 的 history 对齐）。 */
export interface AnswerHistoryMessage {
    role: 'user' | 'assistant';
    content: string;
}
/** 从上一轮 trace / thread state 继承的上下文。 */
export interface AnswerIntentContext {
    activeSession?: string;
    activeContact?: string;
    lastTimeRange?: AnswerTimeRange | {
        from: string;
        to: string;
    };
    lastEntity?: string;
    lastReferencedMessage?: string;
    lastIntent?: AnswerIntentKind;
}
/** 场景允许的扩展分类选项（精确入口所需字段仍可直接传）。 */
export interface ClassifyAnswerIntentOptions {
    knownEntities?: string[];
    now?: Date;
    history?: ReadonlyArray<AnswerHistoryMessage>;
    /** 当前会话 username；用于解析「这个群 / 当前会话」。 */
    currentSession?: string;
    /** 已知会话名或 username，用于显式会话点名。 */
    knownSessions?: string[];
    /** 已知联系人名。 */
    knownContacts?: string[];
    /** 上一轮结构化上下文。 */
    context?: AnswerIntentContext;
    /** 预置的 LLM 建议；运行时异步拿到后可用 `applyAnswerIntentSuggestion` 合并。 */
    llmSuggestion?: AnswerIntentLlmSuggestion;
    /** 规则置信度低于该值时才采纳 LLM 的意图覆盖；默认 0.72。 */
    llmOverrideThreshold?: number;
}
/** 兼容别名。 */
export type AnswerIntentOptions = ClassifyAnswerIntentOptions;
/** 消息引用提示。 */
export interface AnswerMessageReference {
    kind: 'ordinal' | 'latest' | 'previous' | 'contextual' | 'media';
    ordinal?: number;
    fromEnd?: boolean;
    mediaTypes?: AnswerMediaType[];
    session?: string;
    explicit: boolean;
    reason: string;
}
/** 主运行时可直接消费的范围提示。 */
export interface AnswerScopeHints {
    session?: string;
    contact?: string;
    from?: string;
    to?: string;
    media?: AnswerMediaType;
    ordinal?: number;
    /** `session` 未解析但用户明确指当前会话时使用。 */
    sessionRef?: 'current';
    mediaTypes?: AnswerMediaType[];
    messageRef?: AnswerMessageReference;
    timeRange?: AnswerTimeRange;
    aggregationDimensions?: AnswerAggregationDimension[];
    relationTargets?: string[];
    entities?: string[];
}
/** 用户显式重述的范围字段。 */
export type AnswerScopeField = 'session' | 'contact' | 'timeRange' | 'messageRef' | 'mediaTypes' | 'aggregation' | 'relationTargets';
/** 统一分类结果。 */
export interface AnswerIntentDecision {
    /** 统一意图。 */
    kind: AnswerIntentKind;
    /** 可直接传给旧检索流水线的意图。 */
    legacy: IntentKind;
    /** 0~1；越高越不应让 LLM 覆盖。 */
    confidence: number;
    /** 可解释依据。 */
    reason: string;
    /** 建议调用的工具名（按优先级排序）。 */
    toolHints: string[];
    /** 主运行时是否应先澄清再检索。 */
    needsClarification?: boolean;
    /** 主运行时可直接消费的范围字段。 */
    scopeHints?: AnswerScopeHints;
    /** 人类可读的线索（最多若干条）。 */
    signals?: string[];
    /** 用户本轮显式重述的字段；未列出的字段可继承线程状态。 */
    overrides?: AnswerScopeField[];
    /** 分类器来源。 */
    classifier?: 'rules' | 'llm' | 'hybrid';
    /** 若 kind=clarify，保留补全上下文后本来要走的意图。 */
    candidateKind?: AnswerIntentKind;
}
/** LLM 分类建议；所有字段都可选，非法值会被丢弃。 */
export interface AnswerIntentLlmSuggestion {
    kind?: AnswerIntentKind | string;
    confidence?: number;
    reason?: string;
    toolHints?: string[];
    needsClarification?: boolean;
    scopeHints?: {
        session?: string;
        contact?: string;
        from?: string;
        to?: string;
        media?: string;
        ordinal?: number;
    };
}
/** 注入式轻量 LLM 分类器（signal 用于独立 deadline）。 */
export type AnswerIntentLlmClassifier = (input: {
    question: string;
    rule: AnswerIntentDecision;
    now: Date;
    signal?: AbortSignal;
}) => Promise<AnswerIntentLlmSuggestion | null> | AnswerIntentLlmSuggestion | null;
/**
 * 旧意图 -> 统一意图。
 * @param kind - 旧检索意图。
 * @returns 统一意图。
 */
export declare function mapLegacyIntent(kind: IntentKind): AnswerIntentKind;
/**
 * 统一意图 -> 旧检索意图。
 * @param kind - 统一意图。
 * @param options - lookup 是否带「最近 / 最新」排序语义。
 * @returns 旧检索意图。
 */
export declare function toLegacyIntent(kind: AnswerIntentKind, options?: {
    recency?: boolean;
    comparison?: boolean;
}): IntentKind;
/** 判断一个值是否是统一意图。 */
export declare function isAnswerIntentKind(value: unknown): value is AnswerIntentKind;
/**
 * 把问题里的时间表达解析成绝对范围。
 *
 * 旧 `resolveRelativeDate` 继续负责日期 / 周几 / 月日，保证行为兼容；
 * 这里补充裸「上周 / 上个月 / 最近 N 天」窗口，以及相对上一轮时间窗的递进。
 * @param text - 用户问题。
 * @param options.now - 当前时刻（可注入）。
 * @param options.previous - 上一轮时间范围；仅用于递进问法。
 * @returns 结构化时间范围；没有时间线索时返回 undefined。
 */
export declare function resolveAnswerTimeRange(text: string, options?: {
    now?: Date;
    previous?: AnswerTimeRange;
}): AnswerTimeRange | undefined;
/**
 * 从文本推断媒体类型（也用于把历史 / trace 里的 `[图片]`、文件名归一化）。
 * @param text - 原始文本。
 * @returns 去重后的媒体类型。
 */
export declare function inferMediaTypesFromText(text: string): AnswerMediaType[];
/**
 * 规则分类（默认入口，同步、零依赖）。
 *
 * 规则覆盖：
 * - 「那上周呢 / 再往前」：有历史时间线索时相对上一窗递进，否则按绝对「上周」解析；
 * - 「这个群第二条」：识别当前会话引用 + 序号；
 * - 「他 / 对方」：有历史联系人则继承，否则要求澄清；
 * - 「刚才那个文件」：识别媒体类型与消息引用。
 *
 * @param question - 用户问题。
 * @param opts - 已知实体、历史、当前会话与上一轮上下文。
 * @returns 统一意图结果。
 */
export declare function classifyAnswerIntent(question: string, opts?: ClassifyAnswerIntentOptions): AnswerIntentDecision;
/**
 * 合并 LLM 建议。
 *
 * 保守策略：规则高置信时不允许模型改 kind，只允许补空字段；
 * 规则低置信或已判 clarify 时，才接受合法且自信的 kind 覆盖。
 * @param rule - 规则结果。
 * @param suggestion - 模型建议。
 * @param options.overrideThreshold - 允许覆盖的规则置信度上限，默认 0.72。
 * @returns 合并后的结果。
 */
export declare function applyAnswerIntentSuggestion(rule: AnswerIntentDecision, suggestion: AnswerIntentLlmSuggestion | null | undefined, options?: {
    overrideThreshold?: number;
}): AnswerIntentDecision;
/**
 * 规则 + 注入式 LLM 的异步入口。
 *
 * 没有传 `llm` 时与 `classifyAnswerIntent` 完全一致；模型失败也直接回退规则，
 * 不让分类器成为问答链路的单点故障。
 * @param question - 用户问题。
 * @param opts - 分类选项。
 * @param llm - 可选的轻量分类器。
 * @returns 合并后的分类结果。
 */
export declare function classifyAnswerIntentWithLlm(question: string, opts?: ClassifyAnswerIntentOptions, llm?: AnswerIntentLlmClassifier): Promise<AnswerIntentDecision>;
