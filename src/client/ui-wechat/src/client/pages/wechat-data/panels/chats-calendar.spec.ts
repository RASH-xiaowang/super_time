// @vitest-environment jsdom
/**
 * 消息日历的算术与取数守卫（#19 第三刀：`chats-calendar.ts`）。
 *
 * 这一族的每个数字都是**画错了也没人报**的那种：首行空格按周一起排（周日要挪到最后一格）、
 * 当月天数含闰年 2 月、日均的分母是**活跃天数**而不是整月天数、热力色到 140 条封顶。
 * 原先这些算法散在 `ChatsPanel` 里、一条用例没有，而日历是点开才看见的弹窗 ——
 * 把 2 月画成 28 天、或者翻月时把上个月的计数留在网格上，都不会让任何测试变红。
 *
 * 判据分两层：纯函数用表格钉死每种边界；钩子只数 RPC 与看 setter 收到什么
 * （翻月跨年、无会话不发请求、失败要把旧的网格清空）。
 */
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatsCalendarState } from './chats-calendar.ts'
import { calHeatOf, deriveCalendar } from './chats-calendar.ts'
import type { WechatSession } from '@deepseek-ai/dsh-wechat-data/types'

const mocks = vi.hoisted(() => ({ apiGetDailyCounts: vi.fn() }))
vi.mock('../api.ts', () => mocks)

const { useChatsCalendar } = await import('./chats-calendar.ts')

const CUR = { username: 'wxid_cal', displayName: '日历夹具', type: 'private' } as WechatSession

let state: ChatsCalendarState | null = null
let session: WechatSession | null = CUR
const setCalOpen = vi.fn()
const setMsgError = vi.fn()
const locate = vi.fn()
let host: HTMLDivElement
let root: Root

function Harness(): React.JSX.Element {
  state = useChatsCalendar({ curSession: session, openSessionAndLocate: locate, setCalOpen, setMsgError })
  return createElement('div')
}

/** 「现在」钉在 2026-09-15（本地时间）：钩子的初始年月取自 `new Date()`，不钉住断言就没法写。 */
const NOW = new Date(2026, 8, 15, 12, 0, 0)

function rerender(): void {
  act(() => { root.render(createElement(Harness)) })
}

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  mocks.apiGetDailyCounts.mockReset().mockResolvedValue({ counts: {} })
  setCalOpen.mockReset()
  setMsgError.mockReset()
  locate.mockReset()
  session = CUR
  state = null
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  rerender()
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  state = null
  vi.useRealTimers()
})

describe('deriveCalendar：日历上每个数字怎么来的', () => {
  it('空月份 ⇒ 全 0、无最活跃日，但天数照算', () => {
    const d = deriveCalendar({}, 2026, 9)
    expect(d).toMatchObject({ total: 0, activeDays: 0, avg: 0, top: null, days: 30 })
  })

  it('日均的分母是**活跃天数**，不是整月天数', () => {
    // 只有 1 号有 10 条：按 30 天算日均会是 0（"这个月平均一天不到一条"），
    // 而产品要的是"活跃起来一天多少条"。
    const d = deriveCalendar({ '1': 10 }, 2026, 9)
    expect(d.total).toBe(10)
    expect(d.activeDays).toBe(1)
    expect(d.avg, '日均算成了整月平均').toBe(10)
    expect(d.top).toEqual({ day: 1, count: 10 })
  })

  it('值为 0 的那天不算活跃，也不进总量', () => {
    const d = deriveCalendar({ '1': 5, '2': 0, '3': 7 }, 2026, 9)
    expect(d.total).toBe(12)
    expect(d.activeDays).toBe(2)
    expect(d.avg).toBe(6)
  })

  it('并列最活跃 ⇒ 取先见到的那天（不重复计数、也不给个 undefined）', () => {
    const d = deriveCalendar({ '1': 4, '2': 4, '3': 1 }, 2026, 9)
    expect(d.top).toEqual({ day: 1, count: 4 })
  })

  it('非数字键不进「最活跃」，但仍进总量（后端给了什么就照实加）', () => {
    const d = deriveCalendar({ x: 99 }, 2026, 9)
    expect(d.total).toBe(99)
    expect(d.top, '拿 Number("x")=NaN 当第几天 ⇒ 会画出一个 0 号/NaN 号').toBeNull()
  })

  it('首行空格：网格周一起排，1 号是周日时要挪满 6 格', () => {
    // 2026-09-01 是周二 ⇒ 1 格空格；2026-06-01 是周一 ⇒ 0；2026-02-01 是周日 ⇒ 6
    expect(deriveCalendar({}, 2026, 9).firstDow).toBe(1)
    expect(deriveCalendar({}, 2026, 6).firstDow).toBe(0)
    expect(deriveCalendar({}, 2026, 2).firstDow, '周日当成 0 会让整月错位一天').toBe(6)
  })

  it('当月天数含闰年 2 月', () => {
    expect(deriveCalendar({}, 2028, 2).days).toBe(29)
    expect(deriveCalendar({}, 2026, 2).days).toBe(28)
    expect(deriveCalendar({}, 2026, 12).days).toBe(31)
  })
})

describe('calHeatOf：色块深浅的那条标尺', () => {
  it('0 条与负数都是透明（不许画出一层"看起来有消息"的底色）', () => {
    expect(calHeatOf(0)).toBe('transparent')
    expect(calHeatOf(-3)).toBe('transparent')
  })

  it('随条数单调加深，到 140 条封顶在 0.85', () => {
    const alpha = (cnt: number): number => Number(/([\d.]+)\)$/.exec(calHeatOf(cnt))?.[1] ?? -1)
    expect(alpha(50), '越多反而越浅').toBeGreaterThan(alpha(10))
    expect(alpha(140)).toBeCloseTo(0.85, 3)
    expect(alpha(9999), '超过封顶值还在加深 ⇒ 深色格子会把日子数字吃掉').toBeCloseTo(0.85, 3)
  })

  it('输出是合法的 rgba 串（透明度固定三位小数）', () => {
    expect(calHeatOf(3)).toMatch(/^rgba\(34, 211, 238, 0\.\d{3}\)$/)
  })
})

describe('取数与翻月', () => {
  it('没有会话 ⇒ 不开弹窗也不发请求', async () => {
    session = null
    rerender()
    await act(async () => { await state?.openCalendar() })
    expect(setCalOpen).not.toHaveBeenCalled()
    expect(mocks.apiGetDailyCounts).not.toHaveBeenCalled()
  })

  it('打开当月 ⇒ 先开弹窗，再按当前年月去要计数，落地后关掉 loading', async () => {
    mocks.apiGetDailyCounts.mockResolvedValue({ counts: { '3': 8 } })
    await act(async () => { await state?.openCalendar() })
    expect(setCalOpen).toHaveBeenCalledWith(true)
    expect(mocks.apiGetDailyCounts).toHaveBeenCalledWith({ username: CUR.username, year: 2026, month: 9 })
    expect(state?.calCounts).toEqual({ '3': 8 })
    expect(state?.calTotal).toBe(8)
    expect(state?.calLoading, 'loading 没收尾 ⇒ 弹窗永远停在"加载中…"').toBe(false)
  })

  it('取数失败 ⇒ 错误写出去、loading 收尾、弹窗不卡住', async () => {
    mocks.apiGetDailyCounts.mockRejectedValue(new Error('库没解锁'))
    await act(async () => { await state?.openCalendar() })
    expect(setMsgError).toHaveBeenCalledWith('库没解锁')
    expect(state?.calLoading).toBe(false)
    expect(state?.calCounts).toEqual({})
  })

  it('翻月跨年：往前翻出 1 月要落到上一年的 12 月，且 RPC 用的是**新**年月', async () => {
    mocks.apiGetDailyCounts.mockResolvedValue({ counts: { '20': 3 } })
    await act(async () => { await state?.switchCalMonth(-8) })
    expect(state?.calYear, '2026-09 往前 8 个月该是 2026-01').toBe(2026)
    expect(state?.calMonth).toBe(1)
    expect(mocks.apiGetDailyCounts).toHaveBeenLastCalledWith({ username: CUR.username, year: 2026, month: 1 })
    await act(async () => { await state?.switchCalMonth(-1) })
    expect(state?.calYear).toBe(2025)
    expect(state?.calMonth).toBe(12)
    expect(mocks.apiGetDailyCounts).toHaveBeenLastCalledWith({ username: CUR.username, year: 2025, month: 12 })
  })

  it('翻月跨年（往后）：12 月的下一个月是次年 1 月', async () => {
    await act(async () => { await state?.switchCalMonth(3) })
    expect([state?.calYear, state?.calMonth]).toEqual([2026, 12])
    await act(async () => { await state?.switchCalMonth(1) })
    expect([state?.calYear, state?.calMonth]).toEqual([2027, 1])
  })

  it('没有会话时翻月只换月、不发请求（网格换月但空着）', async () => {
    session = null
    rerender()
    await act(async () => { await state?.switchCalMonth(1) })
    expect([state?.calYear, state?.calMonth]).toEqual([2026, 10])
    expect(mocks.apiGetDailyCounts).not.toHaveBeenCalled()
  })

  it('翻月的取数在飞时网格是空的（上个月的色块不许留在新月上）', async () => {
    mocks.apiGetDailyCounts.mockResolvedValue({ counts: { '5': 12 } })
    await act(async () => { await state?.openCalendar() })
    expect(state?.calTotal).toBe(12)

    let resolveLate: ((v: { counts: Record<string, number> }) => void) | null = null
    mocks.apiGetDailyCounts.mockImplementation(() => new Promise((r) => { resolveLate = r }))
    await act(async () => { void state?.switchCalMonth(1); await Promise.resolve() })
    expect(state?.calLoading, '翻月没进 loading').toBe(true)
    expect(state?.calTotal, '在飞期间还画着上个月的色块 ⇒ 用旧月的颜色冒充新月的数据').toBe(0)

    await act(async () => { resolveLate?.({ counts: { '5': 1 } }); await Promise.resolve() })
    expect(state?.calTotal).toBe(1)
    expect(state?.calLoading).toBe(false)
  })
})

describe('点某格跳到当天', () => {
  it('关掉弹窗并按「当天 00:00:00」的秒级时间戳去定位', async () => {
    await act(async () => { await state?.jumpToDay(9) })
    expect(setCalOpen).toHaveBeenCalledWith(false)
    const expect0 = Math.floor(new Date(2026, 8, 9, 0, 0, 0, 0).getTime() / 1000)
    expect(locate).toHaveBeenCalledWith(CUR.username, undefined, expect0)
    expect(Number.isInteger(locate.mock.calls[0]?.[2]), '时间戳必须是整数秒（后端按秒比对）').toBe(true)
  })

  it('没有会话 ⇒ 只关弹窗，不去定位', async () => {
    session = null
    rerender()
    await act(async () => { await state?.jumpToDay(9) })
    expect(setCalOpen).toHaveBeenCalledWith(false)
    expect(locate).not.toHaveBeenCalled()
  })
})
