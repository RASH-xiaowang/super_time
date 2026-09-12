/**
 * Misc helpers migrated from st_control utils (clipboard/log/percent).
 */
/**
 * Copy text to the clipboard with a fallback.
 * @param text - Text to copy.
 * @returns true when the copy succeeded, false otherwise.
 */
export async function copyTextToClipboard(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    }
    catch { /* fall through to legacy path */ }
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        // Legacy fallback for browsers without the async Clipboard API.
        // execCommand('copy') is the only clipboard fallback where the async API is
        // missing; deprecated but deliberately retained.
        /* oxlint-disable-next-line typescript/no-deprecated */
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
    }
    catch {
        return false;
    }
}
/**
 * Debug log (dev only).
 * @param args - Values to log.
 */
export function logDebug(...args) {
    if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production')
        console.debug('[wechat-data]', ...args);
}
/**
 * Error log.
 * @param tag - Log tag/context label.
 * @param e - The error or value to log.
 */
export function logError(tag, e) {
    console.error('[wechat-data]' + tag, e);
}
/**
 * Format a fraction as a percentage with one decimal.
 * @param part - Numerator (the part).
 * @param total - Denominator (the total; 0 yields 0%).
 * @returns Percentage string, e.g. '12.5%'.
 */
export function checkupPct(part, total) {
    if (!total)
        return '0%';
    return ((part / total) * 100).toFixed(1) + '%';
}
/**
 * Format a rate percentage (x of total = pct).
 * @param x - Numerator.
 * @param total - Denominator.
 * @returns String like '3/10 (30.0%)'.
 */
export function checkupRatePct(x, total) {
    return `${x}/${total} (${checkupPct(x, total)})`;
}
//# sourceMappingURL=misc.js.map