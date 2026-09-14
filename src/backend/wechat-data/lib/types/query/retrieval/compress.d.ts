import type { CompressedChunk, RetrievedDoc, RankedDoc } from './types.ts';
/** 压缩选项。 */
export interface CompressOptions {
    maxChars: number;
    maxChunks: number;
    linesPerChunk: number;
    dedupThreshold: number;
}
/**
 * 把重排后的候选压成受预算约束的对话窗口。
 * @param decryptedDir - 解密数据根。
 * @param ranked - 重排后的候选（顺序即优先级）。
 * @param opts - 预算 / 窗口数 / 行数 / 去重阈值。
 * @returns 压缩后的窗口 + 实际取回的消息条数。
 */
export declare function compressContext(decryptedDir: string, ranked: RankedDoc[], opts: CompressOptions): {
    chunks: CompressedChunk[];
    windowMessages: number;
    usedChars: number;
};
/** 便于测试：从统一文档构造一条「已排序」候选。 */
export declare function docToRanked(d: RetrievedDoc, score?: number): RankedDoc;
