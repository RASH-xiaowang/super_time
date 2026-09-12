/**
 * Misc helpers migrated from st_control utils (clipboard/log/percent).
 */
/**
 * Copy text to the clipboard with a fallback.
 * @param text - Text to copy.
 * @returns true when the copy succeeded, false otherwise.
 */
export declare function copyTextToClipboard(text: string): Promise<boolean>;
/**
 * Debug log (dev only).
 * @param args - Values to log.
 */
export declare function logDebug(...args: unknown[]): void;
/**
 * Error log.
 * @param tag - Log tag/context label.
 * @param e - The error or value to log.
 */
export declare function logError(tag: string, e: unknown): void;
/**
 * Format a fraction as a percentage with one decimal.
 * @param part - Numerator (the part).
 * @param total - Denominator (the total; 0 yields 0%).
 * @returns Percentage string, e.g. '12.5%'.
 */
export declare function checkupPct(part: number, total: number): string;
/**
 * Format a rate percentage (x of total = pct).
 * @param x - Numerator.
 * @param total - Denominator.
 * @returns String like '3/10 (30.0%)'.
 */
export declare function checkupRatePct(x: number, total: number): string;
//# sourceMappingURL=misc.d.ts.map