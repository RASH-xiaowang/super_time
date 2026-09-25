/**
 * 「消息决策分析」的上下文收集（**数据层 + 一次本地推理调用**）。
 *
 * 分工与 `query/reply-suggest.ts` 对称：
 *   · `query/reply-suggest.ts` 取上下文喂给 **LLM**（生成回复句子，走出网闸门）；
 *   · 这里取上下文喂给 **laya**（判断意图/情绪/紧张度，**纯本地、不出网**）。
 *
 * 两者互补：laya 最擅长的「现在该做什么」里就有「先搜索历史聊天记录」这一项——
 * 那正是本应用自带的 FTS 搜索能力。
 */
import { type LayaAnswer } from './runtime.ts';
import { type LayaQuestions } from './presets.ts';
/** 对话里的一轮。 */
export interface LayaTurn {
    /** 是否本人发送。 */
    self: boolean;
    text: string;
}
/** 一段可直接喂给模型的对话上下文。 */
export interface LayaDialogue {
    /** `我：…` / `对方：…` 逐行拼接（模型按这个格式读）。 */
    dialogue: string;
    /** 被分析的那句（最近一条**对方**消息）。 */
    latestPeer: string;
    /** 截断后保留的轮次。 */
    turns: LayaTurn[];
}
/**
 * 构造对话上下文。
 *
 * **关键：截断到「最近一条对方消息」为止**——命题里说的「最后一句话」必须指向对方，
 * 否则对方之后我发的消息会让模型去分析我自己说的话，语义整个跑偏。
 *
 * @returns 该会话没有对方文本消息时，`dialogue` 与 `latestPeer` 均为空串。
 */
export declare function buildDialogueState(decryptedDir: string, talker: string, selfUsername?: string, limit?: number): LayaDialogue;
/** 一次分析请求。 */
export interface LayaAnalysisInput {
    decryptedDir: string;
    /** 会话 username。 */
    talker: string;
    selfUsername?: string;
    /** 上下文条数（默认 20，上限 60）。 */
    contextLimit?: number;
    /** 显式模型目录（默认走 `DSH_WECHAT_LAYA_DIR` / 数据目录）。 */
    modelDir?: string;
    /** 自定义命题组（默认 `defaultChatQuestions()`）。 */
    questions?: LayaQuestions;
}
/** 一次分析结果。 */
export interface LayaAnalysisResult {
    ok: boolean;
    /** 失败原因（模型未就绪 / 会话无可分析内容 / 推理异常）。 */
    error?: string;
    /** 被分析的那句。 */
    latestPeer: string;
    /** 实际使用的上下文条数。 */
    contextLines: number;
    /** 交给模型的对话文本（便于对照与排查）。 */
    dialogue: string;
    /** 逐命题的答案（按命题组定义顺序）。 */
    answers: LayaAnswer[];
    /** 是否使用了模型（false 表示走了降级路径，答案由规则给出）。 */
    usedModel: boolean;
    /** 降级说明（`usedModel=false` 时非空，如实写明原因）。 */
    note: string;
    inferenceMs: number;
    tokens: number;
    model: {
        dir: string;
        bytes: number;
    };
}
/**
 * 分析一个会话：取上下文 → 本地推理 → 返回可展示的答案。
 *
 * **不抛异常**：模型缺失/加载失败/推理异常都折叠成 `{ ok:false }` 或降级结果，
 * 由调用方决定怎么呈现（这是本功能的正常路径，不是异常路径）。
 */
export declare function analyzeSession(input: LayaAnalysisInput): Promise<LayaAnalysisResult>;
/** 逐条分析的目标：一条消息的定位信息（前端从消息对象里直接拿得到）。 */
export interface LayaTargetRef {
    /** 会话内唯一 id（自增，会话范围作用域）。 */
    localId: number;
    /** 毫秒稳定序键 —— 也是消息分页的游标键。 */
    sortSeq: number;
}
/** 一条消息的分析结果。 */
export interface LayaMessageAnalysis {
    localId: number;
    ok: boolean;
    /** 单条失败原因（模型未就绪是**会话级**错误，不在这里）。 */
    error?: string;
    /** 被分析的文本（语音则是转写后的文本）。 */
    sourceText: string;
    /** 文本是否来自语音转写。 */
    fromVoice: boolean;
    answers: LayaAnswer[];
    /** 本次推理耗时（命中缓存时为 0）。 */
    inferenceMs: number;
    /** 是否命中缓存（未重新推理）。 */
    cached: boolean;
}
/**
 * 语音转写器 —— 由调用方注入。
 * 为什么注入而不是自己调：转写需要 whisper 的引擎路径/模型目录/模型 id，那些是配置层的知识
 * （`getConfig` + `resolveWhisperModelsDir` + `whisperEnginePath`），不该由 laya 层去读。
 */
export type LayaVoiceTranscriber = (localId: number, serverId: string) => {
    ok: boolean;
    text?: string;
    error?: string;
};
export interface LayaVisibleAnalysisInput {
    decryptedDir: string;
    /** 解码目录（读语音转写的磁盘缓存）。 */
    decodedDir: string;
    talker: string;
    selfUsername?: string;
    targets: readonly LayaTargetRef[];
    contextLimit?: number;
    modelDir?: string;
    /** 缺省时不转写语音：那条消息会以「语音未转写」失败，而不是静默跳过。 */
    transcribe?: LayaVoiceTranscriber;
    /** 关掉缓存（测试用）。 */
    useCache?: boolean;
}
export interface LayaVisibleAnalysisResult {
    ok: boolean;
    /** 会话级错误（模型未就绪 / 缺会话）——单条问题在 `items[].error`。 */
    error?: string;
    model: {
        dir: string;
        bytes: number;
    };
    modelKey: string;
    items: LayaMessageAnalysis[];
}
/** 单次最多分析多少条：一次请求里跑十几条 × 0.5 s 已经接近请求超时，前端据此分批。 */
export declare const MAX_ANALYZE_BATCH = 12;
/**
 * 逐条分析一批消息（消息流可见窗口驱动）。
 *
 * 每条独立：取「该消息及之前」的上下文 → （语音先转写）→ 本地推理 → 结果落缓存。
 * **单条失败不拖垮整批**（`items[].ok=false` 带原因），只有模型未就绪这类会话级问题才整体 `ok=false`。
 */
export declare function analyzeVisibleMessages(input: LayaVisibleAnalysisInput): Promise<LayaVisibleAnalysisResult>;
