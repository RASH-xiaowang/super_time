/**
 * 「消息分析」的协议类型（Remote 进出参）。
 *
 * 设计要点：单聊与群聊**不是同一套问题**。
 *  · 单聊：对方这段话到底想要什么、情绪如何、我该怎么回；
 *  · 群聊：这条消息是否针对我、他在群里是什么动作、我该不该接话、公开回还是私聊。
 *
 * 因此结果类型分成「两套共享外壳 + 各自专属字段」，而不是把群聊硬套进「对方意图」。
 * 所有文本字段都由模型一次生成（严格 JSON），前端只做排版，不再做概率归纳。
 *
 * 与已移除的本地 ONNX 方案（laya）的区别：这里走用户配置的对话模型，
 * 经 `analyze_message` 隐私闸，出网内容与「推荐回复」同级；换来的是 1–3 秒出结果、
 * 不需要下载 1.26 GB 模型。
 */
/** 分析对象的会话类型。 */
export type MessageAnalysisScope = 'private' | 'group';
/** 置信度自评；界面据此决定语气强度与是否提示「信息有限」。 */
export type MessageAnalysisConfidence = 'high' | 'medium' | 'low';
/** 建议动作的语气取向。 */
export interface MessageAnalysisAction {
    /** 是否应该回应这条消息（群聊里常见「不必接」）。 */
    shouldReply: boolean;
    /**
     * 群聊专属：回应渠道。
     * `public` = 直接在群里接；`private` = 建议私聊；`either` = 都行。
     * 单聊恒为 `private`（就是当前会话）。
     */
    channel: 'public' | 'private' | 'either';
    /** 一句话动作标题，例如「直接回答具体内容」。 */
    title: string;
    /** 具体怎么说/怎么做。 */
    guidance: string;
    /** 明确要避免的做法。 */
    avoid: string;
}
/** 群聊专属：这条消息是否在找我。 */
export interface MessageAnalysisAddressed {
    /** 是否针对我（@我、引用我、接着我的话、点名我的名字）。 */
    targeted: boolean;
    /** 判断依据，一句话，引用上下文里的事实。 */
    reason: string;
}
/** 一次消息分析的结果（已可序列化、可直接排版）。 */
export interface MessageAnalysis {
    /** 会话类型，决定前端展示哪个版本。 */
    scope: MessageAnalysisScope;
    /** 结论一句话（最重要的判断）。 */
    headline: string;
    confidence: MessageAnalysisConfidence;
    /**
     * 单聊：对方的真实意图；群聊：这条消息在群里的性质
     * （提问 / 表态 / 回应某人 / 寒暄 / 转述）。
     */
    intent: {
        label: string;
        detail: string;
    };
    /** 情绪或氛围。 */
    mood: {
        label: string;
        detail: string;
    };
    action: MessageAnalysisAction;
    /** 群聊专属；单聊不返回。 */
    addressed?: MessageAnalysisAddressed;
    /** 关键信号（最多 3 条），每条一句话。 */
    signals: string[];
    /** 判断依据：引用上下文里的原话片段（最多 3 条）。 */
    evidence: string[];
}
/** 单条消息的分析外壳（含缓存与耗时元信息）。 */
export interface MessageAnalysisResult {
    ok: boolean;
    error?: string;
    /** 实际使用的模型（`provider/model`），仅本机展示。 */
    model: string;
    /** 被分析的文本（语音则是转写文本）。 */
    sourceText: string;
    fromVoice: boolean;
    /** 本次是否命中缓存。 */
    cached: boolean;
    /** 真实调用模型的耗时；命中缓存时为 0。 */
    elapsedMs: number;
    /** 源文本过短 ⇒ 判断主要来自上下文，界面提示「信息有限」。 */
    lowConfidence: boolean;
    analysis?: MessageAnalysis;
    /**
     * 本次调用的过程留痕：实际发出的提示词、上下文、模型原始输出。
     *
     * 命中缓存时返回当初那次调用的留痕（与 `analysis` 同源），所以详情视图
     * 永远能解释「这个结论是怎么来的」，不必再花一次模型调用。
     */
    trace?: ReplyTrace;
}
/** 一次模型调用的过程留痕（详情视图用）。 */
export interface ReplyTrace {
    /** Public sources and stage-only metadata; never raw tool arguments. */
    toolCalls?: import('./query/reply-tools/types.ts').ReplyToolObservation[];
    toolSources?: import('./query/reply-tools/types.ts').ReplyToolSource[];
    toolDegraded?: string;
    /** True when returned candidates use a safe evidence fallback rather than model text. */
    toolEvidenceGuarded?: boolean;
    /** 实际发给模型的 system 提示词（已过隐私闸）。 */
    systemPrompt: string;
    /** 实际发给模型的 user 提示词（已过隐私闸）。 */
    userPrompt: string;
    /** 送进提示词的上下文行（时间正序，已带时间与发言人）。 */
    contextLines: string[];
    /** 命中的知识库片段（分析恒为空；推荐回复勾选知识库时才有）。 */
    kbSnippets: string[];
    /** 模型原始输出（解析前）。这是「思考过程」最直接的证据。 */
    rawOutput: string;
    /** 实际使用的模型（`provider/model`）。 */
    model: string;
    /** 真实调用耗时（毫秒）。 */
    elapsedMs: number;
    /** 隐私闸是否改写过提示词；改过时上面的 prompt 就是实际发出的那一版。 */
    redacted: boolean;
}
/** 分析请求：一条消息 + 它之前的上下文。 */
export interface MessageAnalysisInput {
    /** 会话 `WechatSession.username`。 */
    talker: string;
    localId: number;
    /** 该消息的 `sort_seq`；<=0 时退回「最新一页」。 */
    sortSeq?: number;
    /** 忽略缓存重算。 */
    force?: boolean;
}
