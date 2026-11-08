/**
 * Shared CNY amount parsing for transfers and red packets.
 *
 * WeChat payment cards are not consistent across versions: some carry
 * `￥1,234.56`, some `520.00元`, and red-packet cards may omit the amount
 * entirely. A failed parse must remain distinguishable from a real zero
 * amount, so every caller receives cents or an explicit failure reason.
 */

export type CnyParseReason =
  | 'missing'
  | 'foreign-currency'
  | 'malformed'
  | 'negative'
  | 'out-of-range'

export interface ParsedCnyAmount {
  /** Integer cents. `null` means the source did not prove a CNY amount. */
  cents: number | null
  /** Convenience display value in yuan; never used for aggregation. */
  yuan: number | null
  reason?: CnyParseReason
  raw: string
}

const FOREIGN_CURRENCY = /(?:\bHKD\b|\bUSD\b|\bEUR\b|\bGBP\b|\bJPY\b|HK\$|US\$|[$€£₩₽₹])/i
const CNY_PREFIX = /^(?:CNY|RMB|人民币|¥|￥)\s*/i
const CNY_SUFFIX = /\s*(?:元|圆|人民币)$/i
const DECIMAL_CNY = /^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/

function result(raw: string, cents: number | null, reason?: CnyParseReason): ParsedCnyAmount {
  return {
    cents,
    yuan: cents === null ? null : cents / 100,
    ...(reason === undefined ? {} : { reason }),
    raw,
  }
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
export function parseCnyAmount(value: unknown): ParsedCnyAmount {
  const raw = typeof value === 'string'
    ? value
    : typeof value === 'number' && Number.isFinite(value)
      ? String(value)
      : ''
  const trimmed = raw.trim()
  if (trimmed === '') return result(raw, null, 'missing')
  if (FOREIGN_CURRENCY.test(trimmed)) return result(raw, null, 'foreign-currency')

  const withoutEntities = trimmed
    .replace(/&yen;|&#165;|&#xA5;/gi, '¥')
    .replace(/\u00a0/g, ' ')
  const fenMatch = /^(\d+)\s*分$/.exec(withoutEntities)
  if (fenMatch?.[1] !== undefined) {
    const centsBig = BigInt(fenMatch[1])
    if (centsBig > BigInt(Number.MAX_SAFE_INTEGER)) return result(raw, null, 'out-of-range')
    return result(raw, Number(centsBig))
  }

  const core = withoutEntities
    .replace(CNY_PREFIX, '')
    .replace(CNY_SUFFIX, '')
    .trim()
  const match = DECIMAL_CNY.exec(core)
  if (match === null) return result(raw, null, 'malformed')

  const unsigned = core.replace(/,/g, '')
  const [whole = '', fraction = ''] = unsigned.split('.')
  const centsBig = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0') || '0')
  if (centsBig > BigInt(Number.MAX_SAFE_INTEGER)) return result(raw, null, 'out-of-range')
  return result(raw, Number(centsBig))
}

/**
 * Convert integer cents to a two-decimal yuan number for API compatibility.
 * Aggregation must happen before this conversion, never afterwards.
 * @param cents - Integer cents.
 * @returns Yuan value.
 */
export function centsToYuan(cents: number): number {
  return cents / 100
}

