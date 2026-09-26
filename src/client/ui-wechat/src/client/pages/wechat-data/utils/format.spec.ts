/**
 * 前端唯一格式化出处的行为（P3-1 / P3-2，第一批 #8）。
 *
 * ## 这份用例存在的理由
 *
 * 审查报告数到 4 份 `fmtTime`（两份收秒、两份收毫秒）与 5 份字节格式化。
 * 名字里带单位（`...Sec` / `...Ms`）只是**让漂移看得见**，看得见这件事本身也得有断言撑着 ——
 * 否则下一次有人把 `fmtLocaleSec(x)` 改成 `fmtLocaleMs(x)`，编译照样通过，
 * 只是界面安静地全变成 1970 年。所以这里钉三件事：
 *   ① 同一个瞬间换单位喂两条路，渲染结果必须一致；
 *   ② 单位喂错**必须**渲染出别的东西（1970 / 荒谬年份），这样用例才会红，而不是继续显示；
 *   ③ `fmtBytes` 的口径与后端 `src/backend/wechat-data/src/format.ts` **逐字一致** ——
 *      那张表在下面和后端用例里各钉一遍（两份「唯一出处」之间再漂移就回到原点了）。
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fmtBytes, fmtDateTimeSec, fmtLocaleMs, fmtLocaleSec, fmtTodayOrLocaleMs,
} from './format.ts'

/** 本地 2026-09-26 18:00 —— 用「本地」构造，断言就不依赖运行时区。 */
const NOW_LOCAL = new Date(2026, 8, 26, 18, 0, 0)
/** 同一个「今天」里的时刻：15:30。 */
const TODAY_MS = new Date(2026, 8, 26, 15, 30, 0).getTime()

describe('fmtBytes（前端侧）', () => {
  it('统一口径：B 不省略、KB/MB 一位小数、GB/TB 两位（与后端那张表同源）', () => {
    expect(fmtBytes(0)).toBe('0 B')
    expect(fmtBytes(512)).toBe('512 B')
    expect(fmtBytes(1024)).toBe('1.0 KB')
    expect(fmtBytes(1536)).toBe('1.5 KB')
    expect(fmtBytes(1024 ** 2)).toBe('1.0 MB')
    expect(fmtBytes(1.5 * 1024 ** 2)).toBe('1.5 MB')
    // 统一前有实现封顶在 MB ⇒ 1.5 GB 显示成 1536.0 MB；另一份无 B 单位 ⇒ 512 显示成 0.5 KB
    expect(fmtBytes(1.5 * 1024 ** 3)).toBe('1.50 GB')
    expect(fmtBytes(2 * 1024 ** 4)).toBe('2.00 TB')
  })

  it('脏输入不炸也不显示负数；null 与 0 同口径', () => {
    for (const v of [null, undefined, Number.NaN, -5]) expect(fmtBytes(v as number)).toBe('0 B')
  })
})

describe('时间格式化：单位写在名字里，且写错一定看得见', () => {
  it('同一个瞬间换单位走两条路 ⇒ 渲染必须一致', () => {
    expect(fmtLocaleSec(Math.floor(TODAY_MS / 1000))).toBe(fmtLocaleMs(TODAY_MS))
    expect(fmtDateTimeSec(Math.floor(TODAY_MS / 1000))).toBe('2026-09-26 15:30')
  })

  it('把秒喂给收毫秒的函数 ⇒ 掉进 1970（用例因此会红，界面因此不会骗人）', () => {
    const sec = Math.floor(TODAY_MS / 1000)
    expect(fmtLocaleMs(sec).slice(0, 4), '错单位如果仍渲染成 2026，命名就失去意义了').toBe('1970')
    expect(fmtLocaleMs(sec)).not.toBe(fmtLocaleMs(TODAY_MS))
  })

  it('把毫秒喂给收秒的函数 ⇒ 跑到荒谬的未来年份，绝不会仍是一眼可信的 2026', () => {
    const out = fmtLocaleSec(TODAY_MS)
    const year = Number(/^(\d{4,})/.exec(out)?.[1] ?? NaN)
    expect(year, `渲染成了 ${out}`).toBeGreaterThan(3000)
    expect(out).not.toBe(fmtLocaleSec(Math.floor(TODAY_MS / 1000)))
  })

  it('空值/非法值返回占位符，而不是 1970-01-01', () => {
    for (const v of [0, null, undefined, Number.NaN]) {
      expect(fmtLocaleMs(v as number)).toBe('—')
      expect(fmtLocaleSec(v as number)).toBe('—')
      expect(fmtDateTimeSec(v as number)).toBe('—')
      expect(fmtTodayOrLocaleMs(v as number)).toBe('—')
    }
    // 调用点用空串占位时也要尊重（列表里靠 `&&` 跳过的场景）
    expect(fmtLocaleMs(0, '')).toBe('')
  })
})

describe('fmtTodayOrLocaleMs（历史对话列表：今天只看时钟，其余要完整）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW_LOCAL)
  })
  afterEach(() => { vi.useRealTimers() })

  it('当天只给「今天 HH:mm」', () => {
    expect(fmtTodayOrLocaleMs(TODAY_MS)).toBe('今天 15:30')
    expect(fmtTodayOrLocaleMs(new Date(2026, 8, 26, 0, 5).getTime())).toBe('今天 00:05')
  })

  it('非当天（哪怕是昨天）给完整本地时间，不带「今天」', () => {
    const yesterday = new Date(2026, 8, 25, 23, 59).getTime()
    const out = fmtTodayOrLocaleMs(yesterday)
    expect(out).not.toContain('今天')
    // 与实现同 locale 取串：这里要钉的是「跨了日历天就切换形状」，不是 ICU 的写法
    expect(out).toBe(new Date(yesterday).toLocaleString('zh-CN', { hour12: false }))
    expect(out).toContain('2026')
  })

  it('跨年也不许被当成「今天」', () => {
    const lastNYear = new Date(2025, 11, 31, 15, 30).getTime()
    expect(fmtTodayOrLocaleMs(lastNYear)).not.toContain('今天')
  })
})
