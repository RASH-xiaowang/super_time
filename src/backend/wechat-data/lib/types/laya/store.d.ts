import type { LayaAnswer } from './runtime.ts';
/** 缓存库路径：`decrypted` 的兄弟文件（与 `message_edits.db` 同款）。 */
export declare function layaCachePath(decryptedDir: string): string;
/** 模型指纹：换模型自动失效（大小 + mtime 秒）。取不到文件时退化为固定串。 */
export declare function layaModelKey(modelPath: string): string;
export interface CachedAnalysis {
    sourceText: string;
    fromVoice: boolean;
    answers: LayaAnswer[];
    analyzedAt: number;
}
/** 批量读缓存（只取 `localIds` 里的）。读不到/解析失败一律跳过。 */
export declare function readAnalysisCache(decryptedDir: string, sessionId: string, modelKey: string, localIds: readonly number[]): Map<number, CachedAnalysis>;
/** 批量写缓存（UPSERT）。整批失败不抛。 */
export declare function writeAnalysisCache(decryptedDir: string, sessionId: string, modelKey: string, rows: ReadonlyArray<{
    localId: number;
    sourceText: string;
    fromVoice: boolean;
    answers: LayaAnswer[];
}>): void;
/** 清缓存（按会话或全清）。返回删除条件命中的行数（拿不到时返回 -1）。 */
export declare function clearAnalysisCache(decryptedDir: string, sessionId?: string): number;
