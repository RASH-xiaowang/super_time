/**
 * 资金图表的数据整形：漏斗必须逐层不增，桑基只保留正金额。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import type { LedgerSnapshot } from '@deepseek-ai/dsh-wechat-data/types'
import { funnelSteps, moneyParts, pareto, sankeyLinks } from './ledger-chart-model.ts'

function snapshot(patch: Partial<LedgerSnapshot['summary']> = {}): LedgerSnapshot {
  return {
    month: null,
    summary: {
      transfers: 10,
      transferIn: 4,
      transferOut: 5,
      transferAmountIn: 100,
      transferAmountOut: 40,
      redpacketsSent: 2,
      redpacketsReceived: 1,
      redpacketAmountSent: 10,
      redpacketAmountReceived: 20,
      totalAmountIn: 120,
      totalAmountOut: 50,
      amountUnknownCount: 3,
      redpacketUnconfirmedCount: 1,
      transferThirdPartyCount: 1,
      ...patch,
    },
    byContact: [
      { username: 'a', name: '甲', count: 2, amount: 80, direction: 'in' },
      { username: 'b', name: '乙', count: 1, amount: 30, direction: 'out' },
    ],
    redpacket: {
      sentCount: 2, receivedCount: 1, sentAmount: 10, receivedAmount: 20,
      bestAmount: 20, avgAmount: 20,
    },
    warnings: [],
    updatedAt: 0,
  }
}

describe('资金图表数据', () => {
  it('漏斗逐层不增，金额未知不会把最下层减成负数', () => {
    const steps = funnelSteps(snapshot({ amountUnknownCount: 99 }))
    expect(steps.map((step) => step.value)).toEqual([14, 12, 0])
    const ordered = funnelSteps(snapshot())
    expect(ordered[0]!.value).toBeGreaterThanOrEqual(ordered[1]!.value)
    expect(ordered[1]!.value).toBeGreaterThanOrEqual(ordered[2]!.value)
  })

  it('零金额的类别不进饼图', () => {
    const names = moneyParts(snapshot({ redpacketAmountSent: 0 })).map((part) => part.name)
    expect(names).not.toContain('红包支出')
  })

  it('累计占比最后一点是 100，桑基丢掉 0 金额', () => {
    const line = pareto(snapshot().byContact)
    expect(line[line.length - 1]?.share).toBe(100)
    const links = sankeyLinks(snapshot({ totalAmountIn: 80, totalAmountOut: 30 }))
    expect(links.every((link) => link.value > 0)).toBe(true)
    expect(links.some((link) => link.target === '我')).toBe(true)
  })
})
