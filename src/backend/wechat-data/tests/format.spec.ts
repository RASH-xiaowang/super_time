/**
 * 后端唯一格式化出处的行为（P3-1 / P3-2）。
 *
 * 口径必须与前端 `utils/format.ts#fmtBytes` **逐字一致** —— 这两份实现的存在本身
 * 就是审查要消灭的东西，但两份「唯一出处」（渲染层一份、后端一份）之间再漂移一次
 * 就回到原点了。所以下面这张表前端用例里也有，两边钉同一个期望值。
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fmtBytes, fmtDateTimeSec, fmtRelativeDaySec } from '../src/format.ts'

describe('fmtBytes（后端侧）', () => {
  it('统一口径：B 不省略、KB/MB 一位小数、GB/TB 两位', () => {
    expect(fmtBytes(0)).toBe('0 B')
    expect(fmtBytes(512)).toBe('512 B')
    expect(fmtBytes(1024)).toBe('1.0 KB')
    expect(fmtBytes(1536)).toBe('1.5 KB')
    expect(fmtBytes(1024 ** 2)).toBe('1.0 MB')
    expect(fmtBytes(1.5 * 1024 ** 2)).toBe('1.5 MB')
    // 旧实现封顶在 MB ⇒ 1.5 GB 会显示成 1536.0 MB（kb-files-store 那一份就这样）
    expect(fmtBytes(1.5 * 1024 ** 3)).toBe('1.50 GB')
    expect(fmtBytes(2 * 1024 ** 4)).toBe('2.00 TB')
  })

  it('脏输入不炸也不显示负数', () => {
    for (const v of [null, undefined, Number.NaN, -5]) expect(fmtBytes(v as number)).toBe('0 B')
  })
})

describe('时间格式化：单位写进名字', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-26T12:00:00Z'))
  })
  afterEach(() => { vi.useRealTimers() })

  it('fmtDateTimeSec 收**秒**', () => {
    expect(fmtDateTimeSec(1_700_000_000)).toMatch(/^2023-11-1[45]/)
    expect(fmtDateTimeSec(0)).toBe('')
    expect(fmtDateTimeSec(0, '—')).toBe('—')
  })

  it('朋友圈标签：今天 / 昨天 / N 天前 / N 个月前', () => {
    const nowSec = Math.floor(Date.now() / 1000)
    expect(fmtRelativeDaySec(nowSec)).toMatch(/^今天 \d{2}:\d{2}$/)
    expect(fmtRelativeDaySec(nowSec - 86_400)).toMatch(/^昨天 \d{2}:\d{2}$/)
    expect(fmtRelativeDaySec(nowSec - 5 * 86_400)).toBe('5天前')
    expect(fmtRelativeDaySec(nowSec - 400 * 86_400)).toBe('13个月前')
    expect(fmtRelativeDaySec(0)).toBe('')
  })

  it('单位传错不会抛异常 —— 所以单位必须写在名字里（这就是旧写法无人发现的坑）', () => {
    const ms = Date.now()
    // 把毫秒喂给「收秒」的函数：得到的是四万多年后，而不是一个错误。
    const wrongYear = Number(fmtDateTimeSec(ms).slice(0, 4))
    expect(wrongYear, '错单位如果会抛错，就不需要靠命名来防了').toBeGreaterThan(3000)
    expect(fmtDateTimeSec(Math.floor(ms / 1000)).slice(0, 4)).toBe(String(new Date(ms).getFullYear()))
  })
})
