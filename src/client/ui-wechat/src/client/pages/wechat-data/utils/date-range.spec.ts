/**
 * 日期区间纯逻辑的行为锁定（`utils/date-range.ts`）。
 *
 * 这些规则此前散落在周期总结面板里、且各筛选面板各写一套：预设只在周期总结有、
 * 「起止颠倒」没有任何一处处理（筛选结果会静默变空，看起来像没数据）。
 * 抽出来之后必须锁住的正是这两条语义，外加「本地时区」这个最容易写错的点。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  RANGE_PRESETS,
  addDaysISO,
  describeRange,
  formatLocalDate,
  isValidISODate,
  normalizeRange,
  parseISODate,
  rangeDays,
  resolveRangePreset,
  todayISO,
} from './date-range.ts'

/** 固定基准：2026-09-16（周三）本地零点。 */
const WED = new Date(2026, 8, 16)

describe('本地时区（不是 UTC）', () => {
  it('formatLocalDate 输出 YYYY-MM-DD，分量与本机日历一致', () => {
    expect(formatLocalDate(WED)).toBe('2026-09-16')
    // 月末/跨年边界：用真实 Date 构造而不是字符串截断
    expect(formatLocalDate(new Date(2026, 11, 31))).toBe('2026-12-31')
    expect(formatLocalDate(new Date(2027, 0, 1))).toBe('2027-01-01')
  })

  it('parseISODate 得到的是本地零点 —— 不能用 new Date(string)（那是 UTC 午夜，会退回前一天）', () => {
    const d = parseISODate('2026-09-16')
    expect(d.getFullYear()).toBe(2026)
    expect(d.getMonth()).toBe(8)
    expect(d.getDate()).toBe(16)
    expect(d.getHours()).toBe(0)
    // 关键回归：UTC 午夜在 UTC+8 会变成 09-15 08:00，getDate()=15
    expect(formatLocalDate(d)).toBe('2026-09-16')
  })

  it('todayISO 与本机今天一致（不是 UTC 今天）', () => {
    const now = new Date()
    expect(todayISO()).toBe(formatLocalDate(now))
  })

  it('isValidISODate 只认合法的本地日历日期', () => {
    expect(isValidISODate('2026-09-16')).toBe(true)
    expect(isValidISODate('2026-02-29')).toBe(false) // 2026 不是闰年
    expect(isValidISODate('2024-02-29')).toBe(true) // 2024 是闰年
    expect(isValidISODate('2026-13-01')).toBe(false)
    expect(isValidISODate('2026-9-16')).toBe(false) // 必须补零
    expect(isValidISODate('')).toBe(false)
    expect(isValidISODate('abc')).toBe(false)
  })
})

describe('addDaysISO', () => {
  it('在给定日期上偏移，跨月/跨年都正确', () => {
    expect(addDaysISO('2026-09-16', 0)).toBe('2026-09-16')
    expect(addDaysISO('2026-09-16', 15)).toBe('2026-10-01')
    expect(addDaysISO('2026-09-16', -16)).toBe('2026-08-31')
    expect(addDaysISO('2026-12-31', 1)).toBe('2027-01-01')
  })

  it('base 为空时基于今天', () => {
    expect(addDaysISO('', 0)).toBe(todayISO())
  })
})

describe('预设区间', () => {
  it('今天 = 同一天', () => {
    expect(resolveRangePreset('today', WED)).toEqual({ from: '2026-09-16', to: '2026-09-16' })
  })

  it('本周从周一起算（2026-09-16 是周三，本周 = 09-14 ~ 09-20）', () => {
    expect(resolveRangePreset('week', WED)).toEqual({ from: '2026-09-14', to: '2026-09-20' })
  })

  it('本周对周日也归到本周（周日是一周的最后一天，不是下一周的开始）', () => {
    const SUN = new Date(2026, 8, 20)
    expect(resolveRangePreset('week', SUN)).toEqual({ from: '2026-09-14', to: '2026-09-20' })
  })

  it('本月 / 上月 走真实月末（含 2 月与闰年）', () => {
    expect(resolveRangePreset('month', WED)).toEqual({ from: '2026-09-01', to: '2026-09-30' })
    expect(resolveRangePreset('last-month', WED)).toEqual({ from: '2026-08-01', to: '2026-08-31' })
    // 2 月：2024 闰年 29 天、2026 平年 28 天
    const FEB = new Date(2024, 1, 10)
    expect(resolveRangePreset('month', FEB)).toEqual({ from: '2024-02-01', to: '2024-02-29' })
    const FEB26 = new Date(2026, 1, 10)
    expect(resolveRangePreset('month', FEB26)).toEqual({ from: '2026-02-01', to: '2026-02-28' })
    // 跨年：1 月的上月是去年 12 月
    const JAN = new Date(2026, 0, 5)
    expect(resolveRangePreset('last-month', JAN)).toEqual({ from: '2025-12-01', to: '2025-12-31' })
  })

  it('近7天 / 近30天 含今天在内共 7 / 30 天', () => {
    const r7 = resolveRangePreset('last-7', WED)
    expect(r7).toEqual({ from: '2026-09-10', to: '2026-09-16' })
    expect(rangeDays(r7.from, r7.to)).toBe(7)
    const r30 = resolveRangePreset('last-30', WED)
    expect(rangeDays(r30.from, r30.to)).toBe(30)
    expect(r30.to).toBe('2026-09-16')
  })

  it('每个预设的 from 不晚于 to，且键唯一、标签唯一', () => {
    const keys = new Set<string>()
    const labels = new Set<string>()
    for (const p of RANGE_PRESETS) {
      const { from, to } = p.resolve(WED)
      expect(from <= to, `${p.key} 的起止颠倒`).toBe(true)
      expect(isValidISODate(from)).toBe(true)
      expect(isValidISODate(to)).toBe(true)
      expect(keys.has(p.key), `重复的预设键 ${p.key}`).toBe(false)
      expect(labels.has(p.label), `重复的预设标签 ${p.label}`).toBe(false)
      keys.add(p.key)
      labels.add(p.label)
    }
    expect(keys.size).toBe(RANGE_PRESETS.length)
  })

  it('确定性：同一时刻多次解析结果一致', () => {
    for (const p of RANGE_PRESETS) {
      expect(p.resolve(WED)).toEqual(p.resolve(new Date(2026, 8, 16)))
    }
  })
})

describe('normalizeRange', () => {
  it('起止颠倒时自动对调（用户先点后面日期不罕见，报错/留空都会让筛选看起来坏了）', () => {
    expect(normalizeRange('2026-09-20', '2026-09-10')).toEqual({ from: '2026-09-10', to: '2026-09-20' })
  })

  it('本来正确时原样返回', () => {
    expect(normalizeRange('2026-09-10', '2026-09-20')).toEqual({ from: '2026-09-10', to: '2026-09-20' })
    expect(normalizeRange('2026-09-16', '2026-09-16')).toEqual({ from: '2026-09-16', to: '2026-09-16' })
  })

  it('单边缺失时原样返回（「自某日起」是合法语义，不要替用户填今天）', () => {
    expect(normalizeRange('2026-09-10', '')).toEqual({ from: '2026-09-10', to: '' })
    expect(normalizeRange('', '2026-09-20')).toEqual({ from: '', to: '2026-09-20' })
    expect(normalizeRange('', '')).toEqual({ from: '', to: '' })
  })
})

describe('describeRange / rangeDays', () => {
  it('双端为空时说「全部时间」，单边有值说清楚是「自…起」还是「截至…」', () => {
    expect(describeRange('', '')).toBe('全部时间')
    expect(describeRange('', '', '未选择日期')).toBe('未选择日期')
    expect(describeRange('2026-09-10', '')).toBe('自 2026-09-10 起')
    expect(describeRange('', '2026-09-20')).toBe('截至 2026-09-20')
  })

  it('同一天不写成区间，跨天才写 `from ~ to`', () => {
    expect(describeRange('2026-09-16', '2026-09-16')).toBe('2026-09-16')
    expect(describeRange('2026-09-10', '2026-09-20')).toBe('2026-09-10 ~ 2026-09-20')
  })

  it('rangeDays 含两端；任一侧缺失或非法时返回 null', () => {
    expect(rangeDays('2026-09-16', '2026-09-16')).toBe(1)
    expect(rangeDays('2026-09-10', '2026-09-16')).toBe(7)
    expect(rangeDays('2026-09-16', '2026-09-10')).toBe(-5) // 颠倒也算差值，调用方自己决定要不要 normalize
    expect(rangeDays('2026-09-10', '')).toBeNull()
    expect(rangeDays('', '2026-09-16')).toBeNull()
    expect(rangeDays('abc', '2026-09-16')).toBeNull()
  })
})
