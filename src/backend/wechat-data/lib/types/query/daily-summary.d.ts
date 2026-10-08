/** Collected message stats shared by day/period summaries. */
type CollectedSummary = {
    lines: string[];
    count: number;
    sessions: number;
    total: number;
    types: Record<string, number>;
    hourly: number[];
    topSessions: Array<{
        username: string;
        count: number;
    }>;
};
/** One picked message with its source (for task extraction provenance). */
export interface SourceLine {
    index: number;
    username: string;
    localId: number;
    time: number;
    text: string;
}
/** collectRange result: summary plus optional source lines. */
export type CollectedRangeResult = CollectedSummary & {
    sources: SourceLine[];
};
/**
 * 可让出的 range 收集：给网关 `@Remote` 路径用。
 *
 * 结果与 {@link collectRange} **逐字段相同**（同一个生成器），
 * 区别只在每 {@link COLLECT_YIELD_EVERY_SHARDS} 个分片让出一次事件循环。
 * @param decryptedDir - decrypted data root.
 * @param start - 起始秒（含）。
 * @param end - 结束秒（不含）。
 * @param cap - 每会话消息上限。
 * @param groupUsername - 可选的单会话过滤。
 * @param collectSources - 是否收集来源行。
 * @param onStep - 每个分片检查点调用一次（返回 Promise 就等它）。
 * @returns 汇总结果 + 可选来源行。
 */
export declare function collectRangeAsync(decryptedDir: string, start: number, end: number, cap: number, groupUsername: string | undefined, collectSources: boolean, onStep: () => Promise<void>): Promise<CollectedRangeResult>;
/**
 * Collect one day of messages across sessions (chronological, capped).
 * @param decryptedDir - decrypted data root.
 * @param date - YYYY-MM-DD local date.
 * @param maxPerSession - cap messages per session (default 30).
 * @param groupUsername - optional session filter (only this talker).
 * @returns per-session message lines.
 */
export declare function collectDayMessages(decryptedDir: string, date: string, maxPerSession?: number, groupUsername?: string): CollectedSummary;
/**
 * 可让出版的「一天」收集（给 `@Remote` 路径用）。
 *
 * 实测 `generateDailySummary` 冷跑 **230ms 且一次都不让出**（`working/probe-remote.txt`），
 * 成本全在这一步（下面才是模型调用）。结果与 {@link collectDayMessages} 逐字段相同。
 * @param decryptedDir - decrypted data root.
 * @param date - YYYY-MM-DD local date.
 * @param maxPerSession - cap messages per session (default 30).
 * @param onStep - 每个分片检查点调用一次（传 `yieldToLoop`）。
 * @returns 汇总结果。
 */
export declare function collectDayMessagesAsync(decryptedDir: string, date: string, maxPerSession: number | undefined, onStep: () => Promise<void>): Promise<CollectedSummary>;
/**
 * 可让出版的「区间」收集（给 `@Remote` 路径用）。
 *
 * 实测 `generatePeriodSummary` 冷跑 **448ms 且一次都不让出**（当时最长的一个独占项）。
 * 结果与 {@link collectPeriodMessages} 逐字段相同。
 * @param decryptedDir - decrypted data root.
 * @param from - first date (YYYY-MM-DD).
 * @param to - last date (YYYY-MM-DD, inclusive).
 * @param maxPerSession - cap messages per session (default 30).
 * @param onStep - 每个分片检查点调用一次（传 `yieldToLoop`）。
 * @returns 汇总结果 + 来源行。
 */
export declare function collectPeriodMessagesAsync(decryptedDir: string, from: string, to: string, maxPerSession: number | undefined, onStep: () => Promise<void>): Promise<CollectedRangeResult>;
/**
 * Collect messages across an inclusive local date range.
 * @param decryptedDir - decrypted data root.
 * @param from - first date (YYYY-MM-DD).
 * @param to - last date (YYYY-MM-DD, inclusive).
 * @param maxPerSession - cap messages per session (default 30).
 * @param groupUsername - optional session filter (only this talker).
 * @returns per-session message lines.
 */
export declare function collectPeriodMessages(decryptedDir: string, from: string, to: string, maxPerSession?: number, groupUsername?: string): CollectedSummary;
/**
 * Collect period messages with per-message source (username/localId/time).
 * @param decryptedDir - decrypted data root.
 * @param from - first date (YYYY-MM-DD).
 * @param to - last date (YYYY-MM-DD, inclusive).
 * @param maxPerSession - cap messages per session (default 30).
 * @param groupUsername - optional session filter (only this talker).
 * @returns source-indexed message lines.
 */
export declare function collectPeriodLinesWithSources(decryptedDir: string, from: string, to: string, maxPerSession?: number, groupUsername?: string): {
    lines: string[];
    sources: SourceLine[];
};
export {};
