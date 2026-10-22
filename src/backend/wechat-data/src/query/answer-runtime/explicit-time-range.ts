/**
 * 用户问题里的显式日期范围。
 *
 * 与 `date-expression.ts` 的分工：那一层解析工具参数里的单个日期表达式；
 * 这一层解析自然语言问题中的完整区间和「截至某日」锚点，并优先于单日期匹配。
 *
 * @module query/answer-runtime/explicit-time-range
 */
import type { AnswerTimeRange } from './intent.ts'

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** 严格组装 ISO 日期；非法年月日（如 2 月 30 日）返回 undefined。 */
export function strictIsoDay(year: number, month: number, day: number): string | undefined {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return undefined
  }
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) {
    return undefined
  }
  const value = `${String(year)}-${pad2(month)}-${pad2(day)}`
  const probe = new Date(year, month - 1, day)
  return probe.getFullYear() === year
    && probe.getMonth() === month - 1
    && probe.getDate() === day
    ? value
    : undefined
}

function parseIso(value: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return undefined
  const date = strictIsoDay(Number(match[1]), Number(match[2]), Number(match[3]))
  if (!date) return undefined
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
}

function formatDay(date: Date): string {
  return `${String(date.getFullYear())}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days)
}

/** 按月偏移并按月底截断，避免 1 月 31 日减一个月滚到 3 月。 */
export function addMonthsClamped(date: Date, months: number): Date {
  const index = date.getFullYear() * 12 + date.getMonth() + months
  const year = Math.floor(index / 12)
  const month = ((index % 12) + 12) % 12
  const lastDay = new Date(year, month + 1, 0).getDate()
  return new Date(year, month, Math.min(date.getDate(), lastDay))
}

function parseCount(value: string): number | undefined {
  const raw = value.trim()
  if (raw === '') return undefined
  if (/^\d{1,3}$/.test(raw)) {
    const count = Number(raw)
    return Number.isInteger(count) ? count : undefined
  }
  const digits: Record<string, number> = {
    一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
    六: 6, 七: 7, 八: 8, 九: 9,
  }
  if (!raw.includes('十')) return digits[raw]
  const [head = '', tail = ''] = raw.split('十')
  const tens = head === '' ? 1 : digits[head]
  const ones = tail === '' ? 0 : digits[tail]
  if (tens === undefined || ones === undefined) return undefined
  return tens * 10 + ones
}

function range(from: string, to: string, label: string): AnswerTimeRange | undefined {
  if (!parseIso(from) || !parseIso(to) || from > to) return undefined
  return {
    from,
    to,
    granularity: from === to ? 'day' : 'range',
    source: 'explicit',
    label,
  }
}

/**
 * 完整起止区间优先于单日期。
 *
 * 若先按单日期解析，`2026-09-16至2026-10-16` 会缩成 `2026-10-16`，
 * 随后模型按原文填入完整范围时反而被服务端判成越界。
 */
export function resolveExplicitDateRange(question: string): AnswerTimeRange | undefined {
  const q = question.replace(/\s+/g, '')
  const iso = /(\d{4})-(\d{1,2})-(\d{1,2})(?:日|号)?(?:至|到|~|～|—|–|－)(\d{4})-(\d{1,2})-(\d{1,2})(?:日|号)?/.exec(q)
  if (iso) {
    const from = strictIsoDay(Number(iso[1]), Number(iso[2]), Number(iso[3]))
    const to = strictIsoDay(Number(iso[4]), Number(iso[5]), Number(iso[6]))
    if (from && to) return range(from, to, from === to ? from : `${from} 至 ${to}`)
  }
  const cnd = /(\d{4})年(\d{1,2})月(\d{1,2})[日号]?(?:至|到|~|～|—|–|－)(\d{4})年(\d{1,2})月(\d{1,2})[日号]?/.exec(q)
  if (cnd) {
    const from = strictIsoDay(Number(cnd[1]), Number(cnd[2]), Number(cnd[3]))
    const to = strictIsoDay(Number(cnd[4]), Number(cnd[5]), Number(cnd[6]))
    if (from && to) return range(from, to, from === to ? from : `${from} 至 ${to}`)
  }
  return undefined
}

function resolveAnchor(question: string): Date | undefined {
  const iso = /(?:截至|截止到?)\s*(\d{4})-(\d{1,2})-(\d{1,2})/.exec(question)
  if (iso) return parseIso(strictIsoDay(Number(iso[1]), Number(iso[2]), Number(iso[3])) ?? '')
  const cnd = /(?:截至|截止到?)\s*(\d{4})年(\d{1,2})月(\d{1,2})[日号]?/.exec(question)
  if (cnd) return parseIso(strictIsoDay(Number(cnd[1]), Number(cnd[2]), Number(cnd[3])) ?? '')
  return undefined
}

/**
 * 「最近 N 天/周/月（截至某日）」以用户给出的截止日为锚点。
 *
 * 不能用当前时间重算：历史对话里的范围会漂移，模型照抄原文日期时还会冲突。
 */
export function resolveAnchoredRecentDateRange(question: string): AnswerTimeRange | undefined {
  const anchor = resolveAnchor(question)
  if (!anchor) return undefined
  const unit = /(?:最近|近|过去)\s*(\d{1,3}|[一二两三四五六七八九十]{1,3})\s*(天|日|周|星期|礼拜|个月|月)/.exec(question)
  if (!unit) return undefined
  const count = parseCount(unit[1] ?? '')
  if (count === undefined || count <= 0) return undefined
  const end = formatDay(anchor)
  const kind = unit[2] ?? ''
  if (kind === '天' || kind === '日') {
    const days = Math.min(count, 365)
    return range(
      formatDay(addDays(anchor, -(days - 1))),
      end,
      `最近 ${String(count)} 天（截至 ${end}）`,
    )
  }
  if (kind === '周' || kind === '星期' || kind === '礼拜') {
    const days = Math.min(count, 52) * 7
    return range(
      formatDay(addDays(anchor, -(days - 1))),
      end,
      `最近 ${String(count)} 周（截至 ${end}）`,
    )
  }
  return range(
    formatDay(addMonthsClamped(anchor, -Math.min(count, 24))),
    end,
    `最近 ${String(count)} 个月（截至 ${end}）`,
  )
}

/** 不带锚点的「最近 N 天/周/月」，以当前时刻为截止日。 */
export function resolveRecentDateRange(
  question: string,
  now: Date,
): AnswerTimeRange | undefined {
  const day = /(?:最近|近|过去)\s*(\d{1,3}|[一二两三四五六七八九十]{1,3})\s*(?:天|日)/.exec(question)
  if (day) {
    const parsed = parseCount(day[1] ?? '')
    if (parsed === undefined) return undefined
    const count = Math.max(1, Math.min(365, parsed))
    return range(
      formatDay(addDays(now, -(count - 1))),
      formatDay(now),
      `最近 ${String(count)} 天`,
    )
  }
  const week = /(?:最近|近|过去)\s*(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*(?:周|星期|礼拜)/.exec(question)
  if (week) {
    const parsed = parseCount(week[1] ?? '')
    if (parsed === undefined) return undefined
    const count = Math.max(1, Math.min(52, parsed))
    return range(
      formatDay(addDays(now, -(count * 7 - 1))),
      formatDay(now),
      `最近 ${String(count)} 周`,
    )
  }
  const month = /(?:最近|近|过去)\s*(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*个?月/.exec(question)
  if (month) {
    const parsed = parseCount(month[1] ?? '')
    if (parsed === undefined) return undefined
    const count = Math.max(1, Math.min(24, parsed))
    return range(
      formatDay(addMonthsClamped(now, -count)),
      formatDay(now),
      `最近 ${String(count)} 个月`,
    )
  }
  if (/前几天|这两天|这几天/.test(question)) {
    return range(formatDay(addDays(now, -6)), formatDay(now), '最近几天')
  }
  return undefined
}
