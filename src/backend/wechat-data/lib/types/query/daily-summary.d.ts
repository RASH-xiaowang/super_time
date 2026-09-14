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
