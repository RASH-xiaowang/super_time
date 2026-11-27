import type { ReplyTrace } from '../types-analysis.ts';
/**
 * 提示词版本：改了 `buildReplyPrompt` 的措辞或输出格式时**必须**递增，
 * 否则旧候选会以新界面呈现，表现为「明明改了却看不到差别」。
 */
export declare const REPLY_SUGGEST_PROMPT_VERSION = 3;
/** 缓存库路径：`decrypted` 的兄弟文件。 */
export declare function replySuggestCachePath(decryptedDir: string): string;
/**
 * 组装缓存键。
 * @param input - 会话、目标消息、知识库、模型与上下文行。
 * @returns 稳定键（长度可控，便于当主键）。
 */
export declare function replySuggestCacheKey(input: {
    /** `talker` 是 `WechatSession.username` 的别名。 */
    talker: string;
    targetLocalId: number | undefined;
    kbId: number;
    model: string;
    want: number;
    lines: readonly string[];
}): string;
/** 缓存命中项。 */
export interface CachedReplySuggest {
    replies: string[];
    trace?: ReplyTrace;
}
/**
 * 读缓存。
 * @returns 未命中或数据坏掉时 undefined。
 */
export declare function readReplySuggestCache(decryptedDir: string, cacheKey: string): CachedReplySuggest | undefined;
/** 写缓存；失败不抛。 */
export declare function writeReplySuggestCache(decryptedDir: string, cacheKey: string, row: CachedReplySuggest): void;
