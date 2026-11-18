import type { MessageAnalysis, MessageAnalysisScope, ReplyTrace } from '../../types-analysis.ts';
/**
 * 提示词版本：改提示词或输出结构时**必须**递增。
 * 否则旧缓存会把上一版字段喂给新界面，表现为「明明改了却看不到变化」。
 */
export declare const ANALYSIS_PROMPT_VERSION = 1;
/** 缓存库路径：`decrypted` 的兄弟文件（与 `message_edits.db` 同款）。 */
export declare function analysisCachePath(decryptedDir: string): string;
/**
 * 缓存键：模型 + 提示词版本 + 会话类型。
 * @param model - 实际使用的模型标识（`provider/model`）；空串表示未知。
 * @param scope - 单聊/群聊，两套提示词不能共用缓存。
 */
export declare function analysisPromptKey(model: string, scope: MessageAnalysisScope): string;
/** 缓存命中项。 */
export interface CachedMessageAnalysis {
    sourceText: string;
    fromVoice: boolean;
    analysis: MessageAnalysis;
    analyzedAt: number;
    /** 当初那次调用的过程留痕；老缓存的这一列为空，读出来就是 undefined。 */
    trace?: ReplyTrace;
}
/**
 * 读一条缓存。
 * @returns 未命中、库不存在或 JSON 坏掉时返回 undefined（当作未命中）。
 */
export declare function readMessageAnalysisCache(decryptedDir: string, sessionId: string, localId: number, promptKey: string): CachedMessageAnalysis | undefined;
/** 写一条缓存。失败不抛。 */
export declare function writeMessageAnalysisCache(decryptedDir: string, sessionId: string, localId: number, promptKey: string, row: {
    sourceText: string;
    fromVoice: boolean;
    analysis: MessageAnalysis;
    trace?: ReplyTrace;
}): void;
