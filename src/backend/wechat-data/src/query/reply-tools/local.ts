/** Deterministic tools: no eval, shell, file, or network access. */
export function calculateReplyExpression(expression: string): number {
  if (expression.length > 160 || !/^[\d.eE+*/%()\s-]+$/.test(expression)) throw new Error('invalid_expression')
  const tokens = expression.match(/(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[()+*/%\-]/g) ?? []
  if (tokens.join('') !== expression.replace(/\s+/g, '')) throw new Error('invalid_expression')
  let at = 0; let depth = 0; let steps = 0
  const finite = (n: number): number => { if (!Number.isFinite(n) || Math.abs(n) > 1e15) throw new Error('numeric_range'); return n }
  const atom = (): number => {
    if (++steps > 100 || ++depth > 24) throw new Error('expression_limit')
    const t = tokens[at++]; let v: number
    if (t === '+' || t === '-') v = (t === '-' ? -1 : 1) * atom()
    else if (t === '(') { v = sum(); if (tokens[at++] !== ')') throw new Error('invalid_expression') }
    else if (t !== undefined && /^(?:\d|\.)/.test(t)) v = Number(t)
    else throw new Error('invalid_expression')
    while (tokens[at] === '%') { at++; v /= 100 }
    depth--; return finite(v)
  }
  const product = (): number => {
    let v = atom()
    while (tokens[at] === '*' || tokens[at] === '/') { const op = tokens[at++]; const r = atom(); if (op === '/' && r === 0) throw new Error('divide_by_zero'); v = finite(op === '*' ? v * r : v / r) }
    return v
  }
  const sum = (): number => {
    let v = product()
    while (tokens[at] === '+' || tokens[at] === '-') { const op = tokens[at++]; const r = product(); v = finite(op === '+' ? v + r : v - r) }
    return v
  }
  const value = sum()
  if (at !== tokens.length) throw new Error('invalid_expression')
  return finite(value)
}
const UNITS: Record<string, [string, number, number]> = {
  m: ['length', 1, 0], km: ['length', 1000, 0], cm: ['length', .01, 0], mm: ['length', .001, 0], mi: ['length', 1609.344, 0], ft: ['length', .3048, 0],
  kg: ['mass', 1, 0], g: ['mass', .001, 0], lb: ['mass', .45359237, 0],
  C: ['temperature', 1, 0], F: ['temperature', 5 / 9, -32 * 5 / 9], K: ['temperature', 1, -273.15],
  'm/s': ['speed', 1, 0], 'km/h': ['speed', 1 / 3.6, 0], mph: ['speed', .44704, 0],
  s: ['duration', 1, 0], min: ['duration', 60, 0], h: ['duration', 3600, 0], day: ['duration', 86400, 0],
}
export function convertReplyUnits(value: number, from: string, to: string): number {
  const a = UNITS[from]; const b = UNITS[to]
  if (!a || !b || a[0] !== b[0] || !Number.isFinite(value) || Math.abs(value) > 1e12) throw new Error('invalid_units')
  const base = value * a[1] + a[2]
  if (a[0] === 'temperature' && base < -273.15 - 1e-9) throw new Error('below_absolute_zero')
  return Number(((base - b[2]) / b[1]).toPrecision(12))
}
export function replyDate(now: Date, timezone: string, offsetDays = 0): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const get = (type: string): string => parts.find(p => p.type === type)?.value ?? ''
  const date = new Date(`${get('year')}-${get('month')}-${get('day')}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + offsetDays)
  return date.toISOString().slice(0, 10)
}

const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'] as const

/** 把目标消息里的相对日期换成具体日期。不联网，也不猜消息里没写的日子。 */
export function resolveReplyDate(expression: string, now: Date, timezone: string): { date: string; weekday: string; offsetDays: number; weekend: boolean } {
  const text = expression.trim()
  const today = replyDate(now, timezone, 0)
  const todayUtc = new Date(`${today}T12:00:00Z`)
  const todayWeek = todayUtc.getUTCDay()
  let offset = 0
  if (text === '今天') offset = 0
  else if (text === '明天') offset = 1
  else if (text === '后天') offset = 2
  else if (text === '大后天') offset = 3
  else if (text === '昨天') offset = -1
  else if (text === '前天') offset = -2
  else {
    const week = /^(上|下|本|这)(?:周|星期)([一二三四五六日天])$/.exec(text)
    if (week) {
      const which = week[1] ?? ''
      const dayChar = week[2] === '天' ? '日' : (week[2] ?? '')
      const target = WEEKDAY_LABELS.indexOf(dayChar as typeof WEEKDAY_LABELS[number])
      if (target < 0) throw new Error('invalid_date')
      const fromMonday = (day: number): number => (day + 6) % 7
      let delta = fromMonday(target) - fromMonday(todayWeek)
      if (which === '下') delta += 7
      if (which === '上') delta -= 7
      offset = delta
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      const target = new Date(`${text}T12:00:00Z`)
      if (Number.isNaN(target.getTime())) throw new Error('invalid_date')
      offset = Math.round((target.getTime() - todayUtc.getTime()) / 86400000)
    } else {
      throw new Error('invalid_date')
    }
  }
  if (!Number.isInteger(offset) || Math.abs(offset) > 366) throw new Error('invalid_date')
  const date = replyDate(now, timezone, offset)
  const weekdayIndex = new Date(`${date}T12:00:00Z`).getUTCDay()
  const label = WEEKDAY_LABELS[weekdayIndex] ?? '日'
  return { date, weekday: `星期${label}`, offsetDays: offset, weekend: weekdayIndex === 0 || weekdayIndex === 6 }
}

export const REPLY_UNIT_NAMES = Object.keys(UNITS)
