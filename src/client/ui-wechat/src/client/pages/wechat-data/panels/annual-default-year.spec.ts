/**
 * 年度报告的**默认年份选择**（2026-11-19 修的 bug）。
 *
 * ## 现场
 *
 * 用户打开年度报告，下拉里最新的是 2026 年，但面板显示的却是 **2020 年**。
 * 根因一行：`setYear(prev => prev ?? ys.at(-1) ?? …)` —— `at(-1)` 取数组**最后一项**，
 * 而后端返回的是**降序**（`annual.ts` 里 `sort((a, b) => b - a)`），
 * 于是"最后一项"恰好是**最旧**的一年。
 *
 * ## 为什么这类 bug 值得单独抽函数来测
 *
 * `at(-1)` 读起来像"最后一个/最新的"，代码看着毫无问题；它只错在**顺序假设**上。
 * 源码级断言（"不许出现 at(-1)"）能拦住同一写法，但拦不住"换个写法又错一次"。
 * 所以把选择逻辑抽成纯函数，用**三种顺序**的输入钉住"永远选最大年份"。
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { defaultAnnualYear, normalizeAnnualYears } from './annual-normalize.ts'

describe('默认打开最新一年', () => {
  it('降序输入（后端真实返回的形状）→ 取最大年份，不是最后一项', () => {
    // 后端 `Array.from(years).sort((a, b) => b - a)` 就是这个形状。
    expect(defaultAnnualYear([2026, 2024, 2023, 2022, 2021, 2020])).toBe(2026)
  })

  it('升序输入也取最大年份（不依赖顺序）', () => {
    expect(defaultAnnualYear([2020, 2021, 2022, 2023, 2024, 2026])).toBe(2026)
  })

  it('乱序输入仍取最大年份', () => {
    expect(defaultAnnualYear([2022, 2026, 2020, 2024])).toBe(2026)
  })

  it('只有一年时就是那一年', () => {
    expect(defaultAnnualYear([2026])).toBe(2026)
  })

  it('空数组 / 全是脏数据 → 退回当前年（不崩、不返回 undefined）', () => {
    const now = new Date().getFullYear()
    expect(defaultAnnualYear([])).toBe(now)
    expect(defaultAnnualYear([Number.NaN, Number.POSITIVE_INFINITY])).toBe(now)
  })
})

describe('年份列表归一化（下拉顺序）', () => {
  it('降序排列 + 去重', () => {
    expect(normalizeAnnualYears([2020, 2026, 2024, 2026, 2022])).toEqual([2026, 2024, 2022, 2020])
  })

  it('滤掉 2000 之前与非数字（与面板原有口径一致）', () => {
    expect(normalizeAnnualYears([2026, 1999, 2020, Number.NaN])).toEqual([2026, 2020])
  })

  it('归一化后的第一项就是默认年份（下拉首项 = 打开的那一年）', () => {
    const years = normalizeAnnualYears([2020, 2024, 2026, 2022])
    expect(years[0]).toBe(defaultAnnualYear(years))
  })
})
