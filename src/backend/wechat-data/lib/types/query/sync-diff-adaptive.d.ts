export declare const DIFF_RETRY_AFTER_MS: number;
/** 该快照现在还要不要尝试 page-diff（抑制期内 false）。 */
export declare function pageDiffSuppressed(target: string): boolean;
/**
 * 记录一次 page-diff 被拒。
 * @returns 本次是否刚跨过阈值进入抑制期（true 时调用方补一条日志即可，避免刷屏）。
 */
export declare function notePageDiffRejected(target: string): boolean;
/** page-diff 成功（或已能稳定走通）：清空抑制状态，重新参与判定。 */
export declare function notePageDiffSuccess(target: string): void;
