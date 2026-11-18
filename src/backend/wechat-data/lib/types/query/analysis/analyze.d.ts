import type { MessageAnalysisInput, MessageAnalysisResult } from '../../types-analysis.ts';
/** 上下文条数：与推荐回复对齐，20 条足够判断一轮对话。 */
export declare const ANALYSIS_CONTEXT_LIMIT = 20;
/** 上限：再多只是把无关历史塞进提示词。 */
export declare const ANALYSIS_CONTEXT_MAX = 60;
/** 源文本短于这个长度时，判断主要来自上下文，界面提示「信息有限」。 */
export declare const ANALYSIS_LOW_CONFIDENCE_CHARS = 6;
/** 生成器签名：与 AI 回复的生成器同形，便于共用网关实现。 */
export type AnalysisGenerateFn = (input: {
    system: string;
    prompt: string;
    accountKey: string;
    chatUsername: string;
}) => Promise<{
    ok: boolean;
    text: string;
    error?: string;
    model?: string;
}>;
/** 执行分析所需的外部能力（全部由网关注入，便于单测）。 */
export interface AnalysisDeps {
    decryptedDir: () => string;
    selfUsername: () => string;
    /** 当前对话模型的标识（`provider/model`）；缓存键要用它。 */
    modelLabel: () => string;
    generate: AnalysisGenerateFn;
    gate: (feature: string, stats: {
        sessions: number;
        messages: number;
    }, texts: string[]) => string[];
    /** 语音消息先转写；缺省时语音按占位文本分析。 */
    transcribeVoice?: (input: {
        decryptedDir: string;
        /** `talker` 是 `WechatSession.username` 的别名。 */
        talker: string;
        localId: number;
    }) => Promise<string>;
    op: (action: string, ok: boolean, detail: string) => void;
}
/**
 * 分析一条消息。
 * @param deps - 注入的能力（模型、隐私闸、语音转写、日志）。
 * @param input - 会话、消息定位键与是否强制重算。
 * @returns 结构化分析；会话级问题（会话不存在、目标是你自己发的）返回 `ok:false` + 原因。
 */
export declare function analyzeMessage(deps: AnalysisDeps, input: MessageAnalysisInput): Promise<MessageAnalysisResult>;
