/**
 * 逐笔金额排序：未知金额不当成 0，两边都沉到底。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { sortRecordsByAmount } from '../src/query/records.ts'

function row(amount: string): { amount: string } {
  return { amount }
}

describe('逐笔金额排序', () => {
  it('高到低时大金额在前，没有金额的行在最后', () => {
    const items = [row(''), row('¥20.00'), row('¥1,500.00'), row('¥5.00')]
    sortRecordsByAmount(items, 'desc')
    expect(items.map((item) => item['amount'])).toEqual(['¥1,500.00', '¥20.00', '¥5.00', ''])
  })

  it('低到高时小金额在前，没有金额的行仍在最后', () => {
    const items = [row('¥20.00'), row(''), row('¥5.00')]
    sortRecordsByAmount(items, 'asc')
    expect(items.map((item) => item['amount'])).toEqual(['¥5.00', '¥20.00', ''])
  })
})
