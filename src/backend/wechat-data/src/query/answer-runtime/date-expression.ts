/**
 * 工具参数里的中文日期表达式解析。
 *
 * 只处理本地日历日，返回 `YYYY-MM-DD`。不读数据库、不依赖模型，便于把
 * “上周”“二〇二六年十月三日”这类输入稳定地归一成工具 schema 接受的值。
 *
 * @module query/answer-runtime/date-expression
 */
import { fmtLocalDate } from '../../format.ts'

/** 解析后的日期表达式。`from`/`to` 都是本地日历日 `YYYY-MM-DD`。 */
export interface ParsedDateExpression {
  from: string
  to: string
  /** true = 相对日历表达（今天/本周/上个月…），单字段出现时可按整段范围展开。 */
  relative: boolean
  /** true = 表达只给出结束日，需要调用方补齐起始日（如「截至本周」）。 */
  endOnly?: boolean
  /** true = 表达只给出起始日，需要调用方补齐结束日（如「本周以来」）。 */
  startOnly?: boolean
  /** 原样输入，便于生成修复说明。 */
  label: string
}

const WEEKDAY: Readonly<Record<string, number>> = {
  '一': 1,
  '二': 2,
  '三': 3,
  '四': 4,
  '五': 5,
  '六': 6,
  '日': 0,
  '天': 0,
}

const CN_DIGIT: Readonly<Record<string, number>> = {
  '〇': 0,
  '零': 0,
  '○': 0,
  '一': 1,
  '二': 2,
  '三': 3,
  '四': 4,
  '五': 5,
  '六': 6,
  '七': 7,
  '八': 8,
  '九': 9,
}

/** 用当前时间兜底非法/缺失日期，避免参数归一化被时钟输入拖垮。 */
export function normalizeDateInput(value: Date | undefined): Date {
  if (value && Number.isFinite(value.getTime())) return value
  return new Date()
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

function makeLocalDate(year: number, month: number, day: number): Date {
  return new Date(year, month - 1, day, 12, 0, 0, 0)
}

function validYmd(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return false
  const d = makeLocalDate(year, month, day)
  return d.getFullYear() === year && d.getMonth() + 1 === month && d.getDate() === day
}

function isoOf(year: number, month: number, day: number): string | undefined {
  if (!validYmd(year, month, day)) return undefined
  return `${year}-${pad2(month)}-${pad2(day)}`
}

function addDays(iso: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return iso
  const d = makeLocalDate(Number(m[1]), Number(m[2]), Number(m[3]))
  d.setDate(d.getDate() + days)
  return fmtLocalDate(d)
}

function addMonths(year: number, month: number, delta: number): { year: number; month: number } {
  const zeroBased = year * 12 + (month - 1) + delta
  return { year: Math.floor(zeroBased / 12), month: (zeroBased % 12 + 12) % 12 + 1 }
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(year, month, 0, 12, 0, 0, 0).getDate()
}

function mondayOfWeek(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return iso
  const d = makeLocalDate(Number(m[1]), Number(m[2]), Number(m[3]))
  const offset = (d.getDay() + 6) % 7
  return addDays(iso, -offset)
}

function weekdayOfWeek(monday: string, weekday: number): string {
  const offset = weekday === 0 ? 6 : weekday - 1
  return addDays(monday, offset)
}

function chineseNumber(raw: string): number | undefined {
  if (raw === '') return undefined
  if (!raw.includes('十')) {
    const chars = [...raw]
    if (chars.length > 1) {
      const joined = chars.map(c => CN_DIGIT[c]).join('')
      const value = Number(joined)
      return Number.isInteger(value) ? value : undefined
    }
    return CN_DIGIT[raw]
  }
  const [head = '', tail = ''] = raw.split('十')
  const tens = head === '' ? 1 : CN_DIGIT[head]
  const ones = tail === '' ? 0 : CN_DIGIT[tail]
  if (tens === undefined || ones === undefined) return undefined
  return tens * 10 + ones
}

function chineseYear(raw: string): number | undefined {
  const chars = [...raw]
  if (chars.length !== 4) return undefined
  const digits = chars.map(c => CN_DIGIT[c])
  if (digits.some(d => d === undefined)) return undefined
  return Number(digits.join(''))
}

function dateForMonthDay(month: number, day: number, now: Date): string | undefined {
  const currentYear = now.getFullYear()
  const current = isoOf(currentYear, month, day)
  if (!current) return undefined
  // 问「9月5日」而当前是 1 月时，通常指去年；未来的 9 月 5 日还没有数据。
  if (current > fmtLocalDate(now)) {
    return isoOf(currentYear - 1, month, day)
  }
  return current
}

/**
 * 解析单个日期/日期段表达。
 *
 * 支持：今天、昨天、前天、本周、这周、上周、本月、这个月、上个月、
 * `YYYY-MM-DD`、`YYYY/M/D`、`YYYY年M月D日`、`M月D日`、中文数字日期，
 * 以及 `上周三` / `本周一` 这类带星期的表达。周以周一为第一天。
 *
 * @param value - 原始日期文本。
 * @param nowInput - 当前时刻（测试可注入）。
 * @returns 解析结果；无法识别或日期不存在时返回 undefined。
 */
export function parseDateExpression(
  value: string,
  nowInput: Date = new Date(),
): ParsedDateExpression | undefined {
  const label = String(value ?? '').trim()
  if (label === '') return undefined
  const now = normalizeDateInput(nowInput)
  const today = fmtLocalDate(now)
  const compact = label.replace(/\s+/g, '')

  const day = (iso: string, relative = true): ParsedDateExpression => ({
    from: iso,
    to: iso,
    relative,
    label,
  })
  const range = (from: string, to: string): ParsedDateExpression => ({
    from,
    to,
    relative: true,
    label,
  })

  if (/^(今天|今日|today)$/i.test(compact)) return day(today)
  if (/^(昨天|昨日|yesterday)$/i.test(compact)) return day(addDays(today, -1))
  if (/^(前天)$/.test(compact)) return day(addDays(today, -2))
  if (/^(今天|今日|昨天|昨日)(以来|开始|起)$/.test(compact)) {
    const begin = compact.startsWith('昨天') || compact.startsWith('昨日')
      ? addDays(today, -1)
      : today
    return { from: begin, to: today, relative: true, startOnly: true, label }
  }
  if (/^(截至|截止到?)(今天|今日|昨天|昨日)$/.test(compact)) {
    const end = /昨天|昨日/.test(compact) ? addDays(today, -1) : today
    return { from: '', to: end, relative: true, endOnly: true, label }
  }

  const lastWeekDay = /^上周([一二三四五六日天])$/.exec(compact)
  if (lastWeekDay) {
    const weekday = WEEKDAY[lastWeekDay[1] ?? '']
    if (weekday !== undefined) {
      const monday = addDays(mondayOfWeek(today), -7)
      return day(weekdayOfWeek(monday, weekday))
    }
  }
  const thisWeekDay = /^(?:本周|这周|周)([一二三四五六日天])$/.exec(compact)
  if (thisWeekDay) {
    const weekday = WEEKDAY[thisWeekDay[1] ?? '']
    if (weekday !== undefined) return day(weekdayOfWeek(mondayOfWeek(today), weekday))
  }

  if (/^(上周|lastweek)$/i.test(compact)) {
    const monday = addDays(mondayOfWeek(today), -7)
    return range(monday, addDays(monday, 6))
  }
  if (/^(本周|这周|thisweek)$/i.test(compact)) {
    return range(mondayOfWeek(today), today)
  }
  if (/^(上个月|lastmonth)$/i.test(compact)) {
    const prev = addMonths(now.getFullYear(), now.getMonth() + 1, -1)
    const from = isoOf(prev.year, prev.month, 1)
    const to = isoOf(prev.year, prev.month, lastDayOfMonth(prev.year, prev.month))
    if (from && to) return range(from, to)
  }
  if (/^(本月|这个月|thismonth)$/i.test(compact)) {
    const from = isoOf(now.getFullYear(), now.getMonth() + 1, 1)
    if (from) return range(from, today)
  }
  if (/^(去年|lastyear)$/i.test(compact)) {
    const year = now.getFullYear() - 1
    const from = isoOf(year, 1, 1)
    const to = isoOf(year, 12, 31)
    if (from && to) return range(from, to)
  }
  if (/^(今年|thisyear)$/i.test(compact)) {
    const from = isoOf(now.getFullYear(), 1, 1)
    if (from) return range(from, today)
  }

  const full = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:日|号)?$/.exec(compact)
  if (full) {
    const iso = isoOf(Number(full[1]), Number(full[2]), Number(full[3]))
    return iso ? day(iso, false) : undefined
  }

  const cnFull = /^([〇零○一二三四五六七八九]{4})年([一二三四五六七八九十]{1,3})月([一二三四五六七八九十]{1,3})(?:日|号)?$/.exec(compact)
  if (cnFull) {
    const year = chineseYear(cnFull[1] ?? '')
    const month = chineseNumber(cnFull[2] ?? '')
    const date = chineseNumber(cnFull[3] ?? '')
    if (year === undefined || month === undefined || date === undefined) return undefined
    const iso = isoOf(year, month, date)
    return iso ? day(iso, false) : undefined
  }

  const monthDay = /^(\d{1,2})月(\d{1,2})(?:日|号)?$/.exec(compact)
  if (monthDay) {
    const iso = dateForMonthDay(Number(monthDay[1]), Number(monthDay[2]), now)
    return iso ? day(iso, false) : undefined
  }

  const cnMonthDay = /^([一二三四五六七八九十]{1,3})月([一二三四五六七八九十]{1,3})(?:日|号)?$/.exec(compact)
  if (cnMonthDay) {
    const month = chineseNumber(cnMonthDay[1] ?? '')
    const date = chineseNumber(cnMonthDay[2] ?? '')
    if (month === undefined || date === undefined) return undefined
    const iso = dateForMonthDay(month, date, now)
    return iso ? day(iso, false) : undefined
  }

  return undefined
}
