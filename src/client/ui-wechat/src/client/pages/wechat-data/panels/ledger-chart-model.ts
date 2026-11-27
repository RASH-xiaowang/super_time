/**
 * 资金图表用的纯数据。只重排账本快照里已经算好的金额和笔数，不补造时间或地区。
 */
import type { LedgerContactRow, LedgerSnapshot } from '@deepseek-ai/dsh-wechat-data/types'

export interface MoneyPart {
  name: string
  value: number
  tone: 'in' | 'out'
}

export interface PivotedContact {
  name: string
  amountIn: number
  amountOut: number
  count: number
}

export interface FunnelStep {
  name: string
  value: number
}

export function yuan(n: number): string {
  return '¥' + n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function contactLabel(row: LedgerContactRow): string {
  const who = row.name || row.username || '未命名'
  const dir = row.direction === 'out' ? '发出' : row.direction === 'in' ? '收到' : '未知'
  return `${who} · ${dir}`
}

/** 四类已知金额。为 0 的类不进图，避免空扇区。 */
export function moneyParts(data: LedgerSnapshot): MoneyPart[] {
  const s = data.summary
  const parts: MoneyPart[] = [
    { name: '转账收入', value: s.transferAmountIn, tone: 'in' },
    { name: '红包收入', value: s.redpacketAmountReceived, tone: 'in' },
    { name: '转账支出', value: s.transferAmountOut, tone: 'out' },
    { name: '红包支出', value: s.redpacketAmountSent, tone: 'out' },
  ]
  return parts.filter((part) => part.value > 0)
}

export function topContacts(rows: readonly LedgerContactRow[], limit = 8): LedgerContactRow[] {
  return [...rows].sort((a, b) => b.amount - a.amount || b.count - a.count).slice(0, limit)
}

/** 同名联系人的收、支并到一行，供热力图和平行坐标使用。 */
export function pivotContacts(rows: readonly LedgerContactRow[], limit = 8): PivotedContact[] {
  const map = new Map<string, PivotedContact>()
  for (const row of rows) {
    const name = row.name || row.username || '未命名'
    const cur = map.get(name) ?? { name, amountIn: 0, amountOut: 0, count: 0 }
    cur.count += row.count
    if (row.direction === 'out') cur.amountOut += row.amount
    else cur.amountIn += row.amount
    map.set(name, cur)
  }
  return [...map.values()]
    .sort((a, b) => (b.amountIn + b.amountOut) - (a.amountIn + a.amountOut) || b.count - a.count)
    .slice(0, limit)
}

/**
 * 三层漏斗，保证逐层不增。
 * 最下层用「能分清收或支的笔数 − 金额未知笔数」，再夹到 0。
 * 第三方里没有金额的记录也会被减掉，所以这一层是下限，不是精确笔数。
 */
export function funnelSteps(data: LedgerSnapshot): FunnelStep[] {
  const s = data.summary
  const all = s.transfers + s.redpacketsSent + s.redpacketsReceived + (s.redpacketUnconfirmedCount ?? 0)
  const sided = s.transferIn + s.transferOut + s.redpacketsSent + s.redpacketsReceived
  const known = Math.max(0, sided - Math.min(sided, s.amountUnknownCount ?? 0))
  return [
    { name: '本地资金记录', value: all },
    { name: '能分清收或支', value: Math.min(all, sided) },
    { name: '金额已解析', value: Math.min(all, known) },
  ]
}

export interface ParetoPoint {
  name: string
  amount: number
  /** 0–100，按金额从高到低的累计占比。 */
  share: number
}

export function pareto(rows: readonly LedgerContactRow[], limit = 8): ParetoPoint[] {
  const top = topContacts(rows, limit).filter((row) => row.amount > 0)
  const total = top.reduce((sum, row) => sum + row.amount, 0)
  if (total <= 0) return []
  let acc = 0
  return top.map((row) => {
    acc += row.amount
    return { name: contactLabel(row), amount: row.amount, share: Math.round((acc / total) * 1000) / 10 }
  })
}

export interface SankeyLink {
  source: string
  target: string
  value: number
}

/** 收到的金额流向「我」，再流向发出的对象。同名的人在两侧用前缀分开。 */
export function sankeyLinks(data: LedgerSnapshot, limit = 6): SankeyLink[] {
  const incoming = topContacts(data.byContact.filter((row) => row.direction !== 'out' && row.amount > 0), limit)
  const outgoing = topContacts(data.byContact.filter((row) => row.direction === 'out' && row.amount > 0), limit)
  const links: SankeyLink[] = []
  let inSum = 0
  let outSum = 0
  for (const row of incoming) {
    inSum += row.amount
    links.push({ source: `收·${row.name || row.username || '未命名'}`, target: '我', value: roundMoney(row.amount) })
  }
  for (const row of outgoing) {
    outSum += row.amount
    links.push({ source: '我', target: `支·${row.name || row.username || '未命名'}`, value: roundMoney(row.amount) })
  }
  const otherIn = roundMoney(data.summary.totalAmountIn - inSum)
  const otherOut = roundMoney(data.summary.totalAmountOut - outSum)
  if (otherIn > 0) links.push({ source: '收·其他', target: '我', value: otherIn })
  if (otherOut > 0) links.push({ source: '我', target: '支·其他', value: otherOut })
  return links.filter((link) => link.value > 0)
}

function roundMoney(n: number): number {
  return Math.round(n * 100) / 100
}
