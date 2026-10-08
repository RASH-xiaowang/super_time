// @vitest-environment jsdom
/**
 * 消息日历弹窗的行为守卫（#19 第七刀：`chats-calendar-dialog.tsx`）。
 *
 * 日历那族**只渲染才看得见**的四条规矩：
 * ① 点遮罩才关，点格子是跳转（少了 `e.target === e.currentTarget` 那一判，点哪天都会把弹窗弄没）；
 * ② 加载中不画格子（`useChatsCalendar` 在飞之前先清空网格，这里证明那次清空真的不可见）；
 * ③ 每格的 `title` 是"这天有没有消息"唯一的非视觉出口，两种文案都算判据；
 * ④ 星期表头「一→日」+ 前置空格数一起决定"1 号落在哪一列"，错一位整月的气泡就错位。
 * 算术本身在 `chats-calendar.spec.ts`，这里只管它长成什么样。
 */
import { act } from 'react-dom/test-utils'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatsCalendarDialogProps } from './chats-calendar-dialog.tsx'
import { ChatsCalendarDialog } from './chats-calendar-dialog.tsx'

const sink = {
  jumpToDay: vi.fn((_day: number): void => { void _day }),
  setCalOpen: vi.fn((_open: boolean): void => { void _open }),
  switchCalMonth: vi.fn((_delta: number): Promise<void> => Promise.resolve()),
}
/**
 * 热力函数交出去的是字符串，用**合法 CSS 颜色**（jsdom 会解析并规范化 style；
 * 写成 `rgb(12 0 0)` 这种空格分隔的写法会被丢掉，测出来是"颜色没接上"的假红）。
 */
const heat = vi.fn((cnt: number): string => `rgb(1, 2, ${String(cnt)})`)

function props(over: Partial<ChatsCalendarDialogProps> = {}): ChatsCalendarDialogProps {
  return {
    calActiveDays: 2,
    calAvg: 6,
    calCounts: { '5': 12 },
    calDays: 31,
    calFirstDow: 3,
    calHeat: heat,
    calLoading: false,
    calMonth: 3,
    calOpen: true,
    calTop: { day: 5, count: 12 },
    calTotal: 12,
    calYear: 2026,
    jumpToDay: sink.jumpToDay,
    setCalOpen: sink.setCalOpen,
    switchCalMonth: sink.switchCalMonth,
    ...over,
  }
}

let host: HTMLDivElement
let root: Root

function show(over: Partial<ChatsCalendarDialogProps> = {}): void {
  act(() => { root.render(createElement(ChatsCalendarDialog, props(over))) })
}

const q = (sel: string): Element | null => host.querySelector(sel)
const qa = (sel: string): Element[] => [...host.querySelectorAll(sel)]
const need = (el: Element | null | undefined, what: string): Element => {
  expect(el ?? null, `${what} 没找到`).not.toBeNull()
  return el as Element
}
const click = (el: Element | null | undefined): void => {
  need(el, '要点的元素')
  act(() => { el?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}
const textOf = (sel: string): string => q(sel)?.textContent ?? ''
/** 统计条里那几项（容器自己也叫 calStat*，得把它摘出去）。 */
const stats = (): Element[] => qa('[class*="calStat"]').filter((e) => !String(e.className).includes('calStats'))
/** 第 n 天那一格（1 起）。 */
const dayCell = (day: number): Element | undefined => qa('button[class*="calDay"]').find((b) => b.querySelector('[class*="calDayNum"]')?.textContent === String(day))
const overlay = (): Element => need(q('[data-st-dialog="chats-cal"]'), '遮罩')
/** 只在点到遮罩**本身**时才有 target === currentTarget ⇒ 直接把事件打在遮罩上。 */
const clickOverlay = (): void => {
  act(() => { overlay().dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  for (const k of Object.keys(sink)) (sink as unknown as Record<string, { mockReset: () => void }>)[k]?.mockReset()
  heat.mockClear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
})

describe('日历的开合与两种点击', () => {
  it('没打开 ⇒ 整块不渲染', () => {
    show({ calOpen: false })
    expect(q('[data-st-dialog="chats-cal"]')).toBeNull()
  })

  it('点到遮罩本身才关（点格子是跳转，不是关窗）', () => {
    show()
    clickOverlay()
    expect(sink.setCalOpen).toHaveBeenCalledTimes(1)
    expect(sink.setCalOpen).toHaveBeenLastCalledWith(false)
    sink.setCalOpen.mockClear()
    click(dayCell(5))
    expect(sink.jumpToDay).toHaveBeenCalledWith(5)
    expect(sink.setCalOpen, '点日期格把弹窗关掉了 ⇒ 用户跳转不成').not.toHaveBeenCalled()
  })

  it('标题与月份标题走的是当前年月', () => {
    show({ calYear: 2025, calMonth: 12 })
    expect(textOf('[class*="calTitle"]')).toBe('消息日历')
    expect(textOf('[class*="calMonthTitle"]')).toBe('2025 年 12 月')
  })

  it('翻月：‹ 是 -1、› 是 +1（aria-label 也要在，鼠标党之外还有读屏）', () => {
    show()
    click(q('button[aria-label="上一月"]'))
    expect(sink.switchCalMonth).toHaveBeenLastCalledWith(-1)
    click(q('button[aria-label="下一月"]'))
    expect(sink.switchCalMonth).toHaveBeenLastCalledWith(1)
    expect(sink.switchCalMonth).toHaveBeenCalledTimes(2)
  })

  it('头部关闭按钮走同一个 setter', () => {
    show()
    click(q('button[class*="calClose"]'))
    expect(sink.setCalOpen).toHaveBeenCalledTimes(1)
  })
})

describe('加载中不画旧格子', () => {
  it('calLoading ⇒ 只有文案，一个格子都没有', () => {
    show({ calLoading: true, calCounts: { '5': 12 }, calDays: 31 })
    // R4：加载态从 `.emptyInline` 改为 `<LoadingState variant="compact">`（带 data-st-loading）。
    expect(textOf('[data-st-loading="compact"]')).toBe('加载中…')
    expect(qa('button[class*="calDay"]').length, '加载中还在画格子 ⇒ 用上月的数画这月').toBe(0)
    expect(stats().length).toBe(0)
  })

  it('不加载 ⇒ 统计条四项齐（最活跃那条跟着 calTop 走）', () => {
    show()
    expect(stats().length).toBe(4)
    expect(textOf('[class*="calStats"]')).toContain('最活跃：3月5日（12 条）')
  })

  it('全月无消息 ⇒ 不给「最活跃」那一格（null 不能渲染成 0）', () => {
    show({ calTop: null, calCounts: {}, calTotal: 0, calActiveDays: 0, calAvg: 0 })
    expect(stats().length).toBe(3)
    expect(textOf('[class*="calStats"]')).not.toContain('最活跃')
  })
})

describe('网格的算术落在渲染上', () => {
  it('星期表头七个，从「一」排到「日」', () => {
    show()
    const heads = qa('[class*="calWd"]').map((e) => e.textContent)
    expect(heads).toEqual(['一', '二', '三', '四', '五', '六', '日'])
  })

  it('前置空格数 = calFirstDow，格子数 = calDays（1 号落错列整月都错位）', () => {
    show({ calFirstDow: 2, calDays: 28 })
    expect(qa('[class*="calEmpty"]').length).toBe(2)
    expect(qa('button[class*="calDay"]').length).toBe(28)
    expect(dayCell(1)?.textContent, '第一格不是 1 号').toBe('1')
    expect(dayCell(28)?.textContent).toBe('28')
  })

  it('计数徽标只在有消息的那天出现', () => {
    show({ calCounts: { '5': 12, '6': 0 } })
    expect(dayCell(5)?.querySelector('[class*="calDayCnt"]')?.textContent).toBe('12')
    expect(dayCell(6)?.querySelector('[class*="calDayCnt"]') ?? null, '0 天也画了徽标').toBeNull()
  })

  it('title 两种文案：有消息报条数、没消息明说无消息（这是唯一的非视觉出口）', () => {
    show({ calCounts: { '5': 12 } })
    expect(dayCell(5)?.getAttribute('title')).toBe('3月5日：12 条消息')
    expect(dayCell(6)?.getAttribute('title')).toBe('3月6日：无消息')
  })

  it('色块深浅来自 calHeat（换颜色口径只改那一处）', () => {
    show({ calCounts: { '5': 12 } })
    const bg = (day: number): string => {
      const el = dayCell(day)
      return el instanceof HTMLElement ? el.style.backgroundColor : ''
    }
    expect(bg(5), '颜色没接 calHeat ⇒ 整月一片白').toBe('rgb(1, 2, 12)')
    expect(bg(6)).toBe('rgb(1, 2, 0)')
    expect(heat).toHaveBeenCalledTimes(31)
  })

  it('底部提示语一直在（用户得知道点格子会发生什么）', () => {
    show()
    expect(textOf('[class*="calHint"]')).toContain('点击日期跳转到当天消息')
  })
})
