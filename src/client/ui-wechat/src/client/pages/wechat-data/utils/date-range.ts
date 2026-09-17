/**
 * 日期区间纯逻辑：预设区间、本地日期格式化、区间归一化。
 *
 * 为什么抽出来：此前 8 个面板各写一套 `type="date"` 与各自的区间处理（周期总结里甚至
 * 同时存着 `localToday`/`addDays`/`fmt` 三个近重复的 helper），预设只在周期总结有。
 * 抽成一份纯函数后，预设语义与「起止颠倒就自动对调」这类规则只写一次，也才有办法单测。
 *
 * 全部走**本地时区**：`new Date().toISOString().slice(0, 10)` 取的是 UTC 日期，
 * 在 UTC+8 的夜里会算成昨天 —— 用户看到的「今天」必须是本机日历上的今天。
 */

/** ISO 日期字符串（`YYYY-MM-DD`）。 */
export type ISODate = string

/** 预设区间的键。 */
export type RangePresetKey =
  | 'today'
  | 'week'
  | 'month'
  | 'last-month'
  | 'last-7'
  | 'last-30'

/** 预设区间的展示信息。 */
export interface RangePreset {
  key: RangePresetKey
  label: string
  /** 生成该预设在 `now` 时刻的起止日期。 */
  resolve: (now: Date) => { from: ISODate; to: ISODate }
}

/** 本地日期 → `YYYY-MM-DD`。 */
export function formatLocalDate(d: Date): ISODate {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 本机日历上的今天。 */
export function todayISO(): ISODate {
  return formatLocalDate(new Date())
}

/** 在某个本地日期上偏移 n 天（`base` 为空时基于今天）。 */
export function addDaysISO(base: ISODate | '', n: number): ISODate {
  const d = base ? parseISODate(base) : new Date()
  d.setDate(d.getDate() + n)
  return formatLocalDate(d)
}

/**
 * 解析 `YYYY-MM-DD` 为**本地** Date。
 *
 * 不能用 `new Date('2026-09-16')`：那是 ES 规范里的 UTC 午夜，再 `getDate()` 会退回前一天
 * （本机 UTC+8）。按分量构造才保证是本地当天的零点。
 * @param iso - ISO 日期字符串。
 * @returns 本地 Date（无效输入返回 Invalid Date，调用方按需校验）。
 */
export function parseISODate(iso: ISODate): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return new Date(Number.NaN)
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

/** 是否是合法的 `YYYY-MM-DD`。 */
export function isValidISODate(iso: string): iso is ISODate {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false
  const d = parseISODate(iso)
  if (Number.isNaN(d.getTime())) return false
  return formatLocalDate(d) === iso
}

/** 全部预设（顺序即展示顺序：从最常用到最宽）。 */
export const RANGE_PRESETS: readonly RangePreset[] = [
  { key: 'today', label: '今天', resolve: (now) => ({ from: formatLocalDate(now), to: formatLocalDate(now) }) },
  // 周一起算：与「周期总结」改前的口径一致（`(getDay() + 6) % 7` 把周日算到上一周末尾）
  {
    key: 'week', label: '本周',
    resolve: (now) => {
      const monday = new Date(now)
      monday.setDate(now.getDate() - ((now.getDay() + 6) % 7))
      const sunday = new Date(monday)
      sunday.setDate(monday.getDate() + 6)
      return { from: formatLocalDate(monday), to: formatLocalDate(sunday) }
    },
  },
  {
    key: 'month', label: '本月',
    resolve: (now) => ({
      from: formatLocalDate(new Date(now.getFullYear(), now.getMonth(), 1)),
      to: formatLocalDate(new Date(now.getFullYear(), now.getMonth() + 1, 0)),
    }),
  },
  {
    key: 'last-month', label: '上月',
    resolve: (now) => ({
      from: formatLocalDate(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
      to: formatLocalDate(new Date(now.getFullYear(), now.getMonth(), 0)),
    }),
  },
  { key: 'last-7', label: '近7天', resolve: (now) => ({ from: addDaysISO(formatLocalDate(now), -6), to: formatLocalDate(now) }) },
  { key: 'last-30', label: '近30天', resolve: (now) => ({ from: addDaysISO(formatLocalDate(now), -29), to: formatLocalDate(now) }) },
]

/**
 * 取某个预设的起止日期。
 * @param key - 预设键。
 * @param now - 基准时刻（缺省为当前时间；测试里注入固定时刻）。
 * @returns 起止日期。
 */
export function resolveRangePreset(key: RangePresetKey, now: Date = new Date()): { from: ISODate; to: ISODate } {
  const found = RANGE_PRESETS.find(p => p.key === key)
  if (!found) return { from: formatLocalDate(now), to: formatLocalDate(now) }
  return found.resolve(now)
}

/**
 * 归一化区间：起止颠倒时对调，单边缺失时原样返回。
 *
 * 为什么要自动对调而不是报错：所有筛选区间的语义都是「这段时间之内」，用户先点了后面的
 * 日期再点前面的并不罕见 —— 静默对调比让筛选结果变空更符合预期（结果为空会被当成 bug）。
 * @param from - 起始日期（可为空）。
 * @param to - 结束日期（可为空）。
 * @returns 归一化后的起止。
 */
export function normalizeRange(from: ISODate | '', to: ISODate | ''): { from: ISODate | ''; to: ISODate | '' } {
  if (!from || !to) return { from, to }
  if (from > to) return { from: to, to: from }
  return { from, to }
}

/**
 * 区间的可读描述（详情区/统计条用）。
 * @param from - 起始日期。
 * @param to - 结束日期。
 * @param emptyText - 两边都为空时的文案。
 * @returns 人可读的区间文本。
 */
export function describeRange(from: ISODate | '', to: ISODate | '', emptyText = '全部时间'): string {
  if (!from && !to) return emptyText
  if (from && to) return from === to ? from : `${from} ~ ${to}`
  return from ? `自 ${from} 起` : `截至 ${to}`
}

/**
 * 区间天数（含两端）。任一侧缺失或非法时返回 `null`。
 * @param from - 起始日期。
 * @param to - 结束日期。
 * @returns 天数，或 `null`。
 */
export function rangeDays(from: ISODate | '', to: ISODate | ''): number | null {
  if (!from || !to) return null
  const a = parseISODate(from)
  const b = parseISODate(to)
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null
  return Math.round((b.getTime() - a.getTime()) / 86_400_000) + 1
}
