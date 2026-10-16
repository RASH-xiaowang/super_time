/**
 * 消息日历（A8）的状态与派生（#19 第三刀，自 `Chats.tsx#ChatsPanel` 拆出）。
 *
 * 为什么这一族值得单独出来：它的六个派生值全是**会算错而看不出来**的算术 ——
 * 周一起的首行空格、当月天数（含闰年 2 月）、日均是**按活跃天数**取整（不是按整月）、
 * 最活跃那天并列时取先见到的那个。这些原先埋在面板里、一条用例都没有；
 * 而日历是用户点开才看的弹窗，画错一格（比如把 2 月画成 28 天）没有任何东西会报。
 *
 * 纯函数（`deriveCalendar` / `calHeatOf`）与钩子分开放：前者可以用表格式用例把所有分支钉死，
 * 后者只需要数 RPC。名字刻意不叫 `fmt*` / `format*` —— 那个前缀 + 单位换算会被
 * `format-single-source` 判成第二份时间格式化实现（本仓真有过一次）。
 */
import { useCallback, useMemo, useState } from 'react'
import { apiGetDailyCounts } from '../api.ts'
import type { WechatSession } from '@deepseek-ai/dsh-wechat-data/types'

/** 日计数表：键是「几号」的字符串（`'1'`…`'31'`），值是当天消息条数。 */
export type DailyCounts = Record<string, number>

export interface CalendarDerived {
  /** 活跃天数（只数 >0 的那天）—— 日均的分母，不是整月天数。 */
  activeDays: number
  /** 日均（四舍五入）；整月无消息时为 0。 */
  avg: number
  /** 当月天数（含闰年 2 月）。 */
  days: number
  /** 首行空格数：网格按**周一**起排，所以周日要挪到最后一格。 */
  firstDow: number
  /** 热力最高的一天；全月无消息时为 null。 */
  top: { day: number; count: number } | null
  /** 全月总条数。 */
  total: number
}

/** 热力色：0 条透明，之后线性加深并封顶在 0.85（超过 140 条/天不再变深）。 */
export const HEAT_BASE = 0.15
export const HEAT_STEP_MAX = 200
export const HEAT_CAP = 0.85

/**
 * 把日计数表算成日历要展示的六个值。
 * @param counts - 后端给的「几号 → 条数」。
 * @param year - 日历年。
 * @param month - 日历月（1–12）。
 * @returns 总量 / 活跃天数 / 日均 / 最活跃那天 / 首行空格 / 当月天数。
 */
export function deriveCalendar(counts: DailyCounts, year: number, month: number): CalendarDerived {
  const values = Object.values(counts)
  const total = values.reduce((a, b) => a + b, 0)
  const activeDays = values.filter((n) => n > 0).length
  const avg = activeDays > 0 ? Math.round(total / activeDays) : 0
  let best = 0
  let bestDay = 0
  for (const [k, v] of Object.entries(counts)) {
    const d = Number(k)
    if (Number.isFinite(d) && v > best) { best = v; bestDay = d }
  }
  const dow = new Date(year, month - 1, 1).getDay()
  return {
    total,
    activeDays,
    avg,
    top: best > 0 ? { day: bestDay, count: best } : null,
    firstDow: dow === 0 ? 6 : dow - 1,
    days: new Date(year, month, 0).getDate(),
  }
}

/**
 * 一格的热力背景色。
 * @param cnt - 当天条数。
 * @returns CSS 颜色串（0 条 ⇒ `transparent`）。
 */
export function calHeatOf(cnt: number): string {
  if (cnt <= 0) return 'transparent'
  const alpha = Math.min(HEAT_BASE + cnt / HEAT_STEP_MAX, HEAT_CAP)
  return 'rgba(34, 211, 238, ' + alpha.toFixed(3) + ')'
}

export interface ChatsCalendarInputs {
  curSession: WechatSession | null
  /** 深链到某天的开头（与「按消息定位」走同一条路，只是这里给的是日首秒）。 */
  openSessionAndLocate: (username: string, localId?: number, dayStart?: number) => Promise<void> | void
  setCalOpen: (open: boolean) => void
  setMsgError: (msg: string | null) => void
}

export interface ChatsCalendarState {
  calActiveDays: number
  calAvg: number
  calCounts: DailyCounts
  /** 当月天数（含闰年 2 月）。 */
  calDays: number
  /** 首行空格数（网格周一起排）。 */
  calFirstDow: number
  calHeat: (cnt: number) => string
  calLoading: boolean
  calMonth: number
  /** 热力最高的一天；全月无消息时为 null。 */
  calTop: { day: number; count: number } | null
  calTotal: number
  calYear: number
  jumpToDay: (day: number) => void
  openCalendar: () => Promise<void>
  /** WAL 推送后的静默重取：不清计数、不翻 loading（清空会让热力格闪空）。 */
  refreshCurrentMonth: () => Promise<void>
  switchCalMonth: (delta: number) => Promise<void>
}

/**
 * 日历弹窗那一块的状态：当前年月 + 日计数 + 取数与翻月。
 *
 * `calOpen` 故意**不在这里持有** —— 它住在 `useChatsMsgSearch`（那几个弹窗互相排他，
 * 开一个要收掉其余的），搬过来就会把「谁开着什么」拆成两处真相。
 * @param inputs - 会话、深链回调与两个 setter。
 * @returns 面板与日历组件要用的值与动作。
 */
export function useChatsCalendar(inputs: ChatsCalendarInputs): ChatsCalendarState {
  const { curSession, openSessionAndLocate, setCalOpen, setMsgError } = inputs
  const [calYear, setCalYear] = useState(new Date().getFullYear())
  const [calMonth, setCalMonth] = useState(new Date().getMonth() + 1)
  const [calCounts, setCalCounts] = useState<DailyCounts>({})
  const [calLoading, setCalLoading] = useState(false)
  const derived = useMemo(() => deriveCalendar(calCounts, calYear, calMonth), [calCounts, calYear, calMonth])

  /**
   * 取某年某月的日计数。
   *
   * 在飞之前先把网格清空：翻月时若留着上个月的计数，界面会**用旧月份的颜色画新月份**
   * —— 那比空着更坏（看着像数据，其实是隔壁月的）。
   * 失败写进消息流那一侧的错误位（改前就是这样，这里保持原样）。
   */
  const fetchCounts = useCallback(async (username: string, year: number, month: number): Promise<void> => {
    setCalLoading(true)
    setCalCounts({})
    try {
      const r = await apiGetDailyCounts({ username, year, month })
      setCalCounts(r.counts)
    } catch (e) {
      setMsgError((e as Error).message)
    } finally {
      setCalLoading(false)
    }
  }, [setMsgError])

  const openCalendar = useCallback(async (): Promise<void> => {
    if (!curSession) return
    setCalOpen(true)
    await fetchCounts(curSession.username, calYear, calMonth)
  }, [curSession, calYear, calMonth, fetchCounts, setCalOpen])

  const switchCalMonth = useCallback(async (delta: number): Promise<void> => {
    let m = calMonth + delta
    let y = calYear
    if (m < 1) { m = 12; y -= 1 }
    if (m > 12) { m = 1; y += 1 }
    setCalMonth(m)
    setCalYear(y)
    if (!curSession) return
    await fetchCounts(curSession.username, y, m)
  }, [curSession, calMonth, calYear, fetchCounts])

  const refreshCurrentMonth = useCallback(async (): Promise<void> => {
    if (!curSession) return
    try {
      const r = await apiGetDailyCounts({ username: curSession.username, year: calYear, month: calMonth })
      setCalCounts(r.counts)
    } catch { /* 静默：保留旧值，下一次事件再试 */ }
  }, [curSession, calYear, calMonth])

  const jumpToDay = useCallback((day: number): void => {
    const startTs = Math.floor(new Date(calYear, calMonth - 1, day, 0, 0, 0, 0).getTime() / 1000)
    setCalOpen(false)
    if (curSession) void openSessionAndLocate(curSession.username, undefined, startTs)
    // 依赖里原先还挂着 `calOpen`：函数体读的是 `setCalOpen`，那个依赖只会让回调每次开关都换身份。
  }, [calYear, calMonth, curSession, openSessionAndLocate, setCalOpen])

  return {
    calTotal: derived.total,
    calActiveDays: derived.activeDays,
    calAvg: derived.avg,
    calTop: derived.top,
    calFirstDow: derived.firstDow,
    calDays: derived.days,
    calCounts,
    calHeat: calHeatOf,
    calLoading,
    calMonth,
    calYear,
    jumpToDay,
    openCalendar,
    refreshCurrentMonth,
    switchCalMonth,
  }
}
