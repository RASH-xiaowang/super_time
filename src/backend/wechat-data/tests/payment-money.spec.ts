/**
 * Money parsing is the boundary between "unknown" and a displayed number.
 * These cases deliberately include malformed and foreign-currency values so a
 * failed parse can never be folded into a real zero-yuan transaction.
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { centsToYuan, parseCnyAmount } from '../src/query/payment-money.ts'

describe('parseCnyAmount', () => {
  it.each([
    ['￥0.00', 0],
    ['¥1,234.56', 123_456],
    ['520.00元', 52_000],
    ['  RMB 20.5  ', 2_050],
    ['100分', 100],
  ])('parses %s as integer cents', (raw, cents) => {
    const parsed = parseCnyAmount(raw)
    expect(parsed).toMatchObject({ cents, yuan: centsToYuan(cents) })
    expect(parsed.reason).toBeUndefined()
  })

  it.each([
    ['', 'missing'],
    ['HK$100', 'foreign-currency'],
    ['US$100', 'foreign-currency'],
    ['€100', 'foreign-currency'],
    ['1.2.3', 'malformed'],
    ['1,23.45', 'malformed'],
    ['-1.00', 'malformed'],
  ])('rejects %s without manufacturing zero', (raw, reason) => {
    const parsed = parseCnyAmount(raw)
    expect(parsed.cents).toBeNull()
    expect(parsed.yuan).toBeNull()
    expect(parsed.reason).toBe(reason)
  })

  it('keeps a true zero distinct from a missing amount', () => {
    const zero = parseCnyAmount('￥0.00')
    const missing = parseCnyAmount('')
    expect(zero.cents).toBe(0)
    expect(missing.cents).toBeNull()
  })
})

