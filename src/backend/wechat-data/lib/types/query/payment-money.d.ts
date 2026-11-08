/**
 * Shared CNY amount parsing for transfers and red packets.
 *
 * WeChat payment cards are not consistent across versions: some carry
 * `￥1,234.56`, some `520.00元`, and red-packet cards may omit the amount
 * entirely. A failed parse must remain distinguishable from a real zero
 * amount, so every caller receives cents or an explicit failure reason.
 */
export type CnyParseReason = 'missing' | 'foreign-currency' | 'malformed' | 'negative' | 'out-of-range';
export interface ParsedCnyAmount {
    /** Integer cents. `null` means the source did not prove a CNY amount. */
    cents: number | null;
    /** Convenience display value in yuan; never used for aggregation. */
    yuan: number | null;
    reason?: CnyParseReason;
    raw: string;
}
/**
 * Parse a CNY amount from a payment-card field.
 *
 * Accepted examples: `￥0.00`, `¥1,234.56`, `520.00元`, `100分`.
 * Rejected examples: an empty field, `HK$100`, `US$100`, `1.2.3`,
 * `1,23.45`, and negative values.
 * @param value - Raw amount cell or parsed card field.
 * @returns Integer cents or an explicit parse failure.
 */
export declare function parseCnyAmount(value: unknown): ParsedCnyAmount;
/**
 * Convert integer cents to a two-decimal yuan number for API compatibility.
 * Aggregation must happen before this conversion, never afterwards.
 * @param cents - Integer cents.
 * @returns Yuan value.
 */
export declare function centsToYuan(cents: number): number;
