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
  fmtBytes, fmtCommentTimeSec, fmtDateMs, fmtDateSec, fmtDateTimeSec, fmtDividerSec, fmtHourMinuteMs,
  fmtLocaleMs, fmtLocaleSec, fmtLocalDate, fmtMonthDaySec, fmtTodayOrLocaleMs,
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

/**
 * 这四份形状原先各有一个本地副本（审查 P3-1 剩下的那六条里的五条：单聊资料页的 `fmtDate`、
 * 知识库的 `formatDate`、朋友圈评论角的 `fmtCommentTime`、同步状态行的 `fmtSyncTime`、
 * 区间层的 `formatLocalDate`）。搬进来时**输出逐个对齐**，所以这里钉的是「形状没变」，
 * 不是「形状对」—— 唯一有意改变的是空值那一档，见下面第二条用例。
 */
describe('日期与时钟形状（P3-1 收尾：四份本地副本的落点）', () => {
  const LOCAL_DATE = new Date(2026, 8, 7, 12, 0, 0)
  const LOCAL_MS = LOCAL_DATE.getTime()
  const LOCAL_SEC = Math.floor(LOCAL_MS / 1000)

  it('fmtLocalDate 用本地分量补零，月末与跨年都不借 UTC', () => {
    expect(fmtLocalDate(LOCAL_DATE)).toBe('2026-09-07')
    expect(fmtLocalDate(new Date(2026, 11, 31))).toBe('2026-12-31')
    expect(fmtLocalDate(new Date(2027, 0, 1))).toBe('2027-01-01')
    // 区间层（todayISO / addDaysISO / isValidISODate 的回填校验）依赖这一点：
    // 拿 new Date('2026-09-16') 再 toISOString 会是另一种形状。
    expect(fmtLocalDate(new Date(2026, 8, 16, 0, 0, 0))).toBe('2026-09-16')
  })

  it('同一瞬间走 Sec/Ms 两条路必须一致；喂错单位必然画成别的日子', () => {
    expect(fmtDateSec(LOCAL_SEC)).toBe(fmtDateMs(LOCAL_MS))
    expect(fmtDateSec(LOCAL_SEC)).toBe('2026-09-07')
    expect(fmtDateMs(LOCAL_SEC)).toContain('1970')
    expect(fmtDateSec(LOCAL_MS)).not.toBe('2026-09-07')
  })

  it('空值/非法回占位 —— 这是搬动唯一改变的一处显示：0 不再画成 1970-01-01', () => {
    // 知识库的 `formatDate` 与资料页的 `fmtDate` 原先都没有空值闸：`createdAt` 为 0 的笔记
    // 显示「创建于 1970-01-01」。这正是审查 P3-1 点名的病（单位/空值错了不报错，只安静画错）。
    for (const v of [0, null, undefined, Number.NaN]) {
      expect(fmtDateSec(v as number)).toBe('—')
      expect(fmtDateMs(v as number)).toBe('—')
    }
    expect(fmtDateSec(0, '')).toBe('')
  })

  it('fmtHourMinuteMs：状态行那种「最近同步 09:05」，只要钟点', () => {
    expect(fmtHourMinuteMs(new Date(2026, 8, 26, 9, 5).getTime())).toBe('09:05')
    expect(fmtHourMinuteMs(0)).toBe('')
    expect(fmtHourMinuteMs(Number.NaN)).toBe('')
    expect(fmtHourMinuteMs(new Date(2026, 8, 26, 9, 5).getTime() / 1000)).not.toBe('09:05')
  })

  it('fmtCommentTimeSec 的档位边界（now 注入，不依赖跑测试的时刻）', () => {
    const at = (secAgo: number): string => fmtCommentTimeSec(LOCAL_SEC - secAgo, LOCAL_MS)
    expect(at(0)).toBe('刚刚')
    expect(at(59)).toBe('刚刚')
    expect(at(60)).toBe('1分钟前')
    expect(at(3599)).toBe('59分钟前')
    expect(at(3600)).toBe('1小时前')
    expect(at(86399)).toBe('23小时前')
    expect(at(86400)).toBe('昨天')
    expect(at(172799)).toBe('昨天')
    // 48 小时之外退回 `M-D`，与文件列表那把尺子同源
    expect(at(172800)).toBe(fmtMonthDaySec(LOCAL_SEC - 172800))
    expect(at(4_000_000)).toBe(fmtMonthDaySec(LOCAL_SEC - 4_000_000))
    expect(at(-3600), '时钟回拨（未来时间）不许显示成负数').toBe('刚刚')
    expect(fmtCommentTimeSec(0, LOCAL_MS)).toBe('')
  })

  it('评论角与日期分隔标签不是一把尺子（防有人顺手合并成一份）', () => {
    const ts = Math.floor(new Date(2026, 8, 25, 15, 30).getTime() / 1000)
    expect(fmtCommentTimeSec(ts, NOW_LOCAL.getTime())).toBe('昨天')
    expect(fmtDividerSec(ts, NOW_LOCAL)).toBe('昨天 15:30')
  })
})
