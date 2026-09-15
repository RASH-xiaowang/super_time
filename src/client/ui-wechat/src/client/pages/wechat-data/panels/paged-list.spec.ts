/**
 * L7：`usePagedList` 的 hasMore 判定（每个面板的「加载更多」都依赖它）。
 *
 * 验收来自 `docs/RELEASE-PLAN.md` L7 行：「total 不可信或整页末页时判错」。
 * 这里对每个被点名的情形都做**新旧判据对照**（`oldHasMore`）——否则用例可能在
 * 「退回旧实现」时依然全绿（M13/N19 反复栽过的空转守卫）。
 *
 * 另含一条**接线守卫**：纯逻辑用例测不到「`hooks.tsx` 有没有调用它」，
 * 把 `hooks.tsx` 的返回表达式退回旧写法时上面全部用例仍会通过，所以要读源码断言。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { computeHasMore } from './paged-list.ts'

/** 旧判据（改前 `hooks.tsx` 的写法），只用于对照：证明用例真的覆盖了缺陷。 */
function oldHasMore(p: { loaded: number; total: number; lastPageCount: number; pageSize: number }): boolean {
  return p.loaded < p.total && p.lastPageCount === p.pageSize
}

describe('L7 hasMore', () => {
  it('整页末页：末页刚好取满（loaded === total）时仍要继续，而不是静默截断', () => {
    const p = { loaded: 60, total: 60, lastPageCount: 30, pageSize: 30 }
    expect(oldHasMore(p)).toBe(false) // ← 旧判据在这里停住（缺陷）
    expect(computeHasMore(p)).toBe(true)
  })

  it('total 不可信（后端返回 0）时按「取满即可能还有」继续', () => {
    const p = { loaded: 30, total: 0, lastPageCount: 30, pageSize: 30 }
    expect(oldHasMore(p)).toBe(false) // ← 旧判据一次都加载不了（缺陷）
    expect(computeHasMore(p)).toBe(true)
  })

  it('total 被上限截断：已取满且 loaded >= total 时不停（与「真的到底」无法区分，宁多探一次）', () => {
    const p = { loaded: 200, total: 200, lastPageCount: 100, pageSize: 100 }
    expect(oldHasMore(p)).toBe(false)
    expect(computeHasMore(p)).toBe(true)
  })

  it('空页 ⇒ 到底（唯一确定的证据）', () => {
    expect(computeHasMore({ loaded: 30, total: 5000, lastPageCount: 0, pageSize: 30 })).toBe(false)
    // 旧判据在这里也收敛（`0 === pageSize` 为假），但它的收敛依赖页大小恰好相等 —— 见下一条
    expect(oldHasMore({ loaded: 30, total: 5000, lastPageCount: 0, pageSize: 30 })).toBe(false)
  })

  it('短页 + total 明确还有更多 ⇒ 继续（后端按 limit 截断 / 跳过无法解析的行）', () => {
    expect(computeHasMore({ loaded: 40, total: 500, lastPageCount: 10, pageSize: 30 })).toBe(true)
  })

  it('短页 + total 已到 ⇒ 停（正常收尾，不必再探）', () => {
    expect(computeHasMore({ loaded: 40, total: 40, lastPageCount: 10, pageSize: 30 })).toBe(false)
    expect(computeHasMore({ loaded: 40, total: 20, lastPageCount: 10, pageSize: 30 })).toBe(false)
  })

  it('第一页就取满且 total 更大 ⇒ 继续', () => {
    expect(computeHasMore({ loaded: 30, total: 2717, lastPageCount: 30, pageSize: 30 })).toBe(true)
  })

  it('NaN / 负数输入不会被当成「还有更多」，也不会恒真', () => {
    expect(computeHasMore({ loaded: 30, total: Number.NaN, lastPageCount: 30, pageSize: 30 })).toBe(true) // 取满 ⇒ 探一次
    expect(computeHasMore({ loaded: 30, total: Number.NaN, lastPageCount: 5, pageSize: 30 })).toBe(false)
    expect(computeHasMore({ loaded: 30, total: -1, lastPageCount: 5, pageSize: 30 })).toBe(false)
    expect(computeHasMore({ loaded: 30, total: 500, lastPageCount: -3, pageSize: 30 })).toBe(false)
  })

  it('页大小非法（0 / NaN）时退回 total 判据，不会恒真', () => {
    expect(computeHasMore({ loaded: 10, total: 100, lastPageCount: 10, pageSize: 0 })).toBe(true)
    // 页大小非法 + total 也说到底 ⇒ 停（否则哨兵会无限触发加载）
    expect(computeHasMore({ loaded: 100, total: 100, lastPageCount: 10, pageSize: 0 })).toBe(false)
    expect(computeHasMore({ loaded: 100, total: Number.NaN, lastPageCount: 10, pageSize: Number.NaN })).toBe(false)
  })

  it('正常分页全过程：短页收尾时不多发请求', () => {
    const pageSize = 30
    let loaded = 0
    const loader = { total: 75, next: 0 }
    const pages: number[] = []
    for (let guard = 0; guard < 10; guard += 1) {
      const take = Math.max(0, Math.min(pageSize, loader.total - loader.next))
      const lastPageCount = take
      loader.next += take
      loaded += take
      pages.push(lastPageCount)
      if (!computeHasMore({ loaded, total: loader.total, lastPageCount, pageSize })) break
    }
    // 30 / 30 / 15：末页不满 ⇒ 直接收敛，没有多余请求
    expect(pages).toEqual([30, 30, 15])
    expect(loaded).toBe(75)
  })

  it('总数刚好是页大小整数倍时多探一次空页（为「不再静默截断」付的代价，且立刻收敛）', () => {
    const pageSize = 30
    const loader = { total: 60, next: 0 }
    let loaded = 0
    const pages: number[] = []
    for (let guard = 0; guard < 10; guard += 1) {
      const lastPageCount = Math.max(0, Math.min(pageSize, loader.total - loader.next))
      loader.next += lastPageCount
      loaded += lastPageCount
      pages.push(lastPageCount)
      if (!computeHasMore({ loaded, total: loader.total, lastPageCount, pageSize })) break
    }
    expect(pages).toEqual([30, 30, 0])
    expect(loaded).toBe(60)
  })
})

const HERE = dirname(fileURLToPath(import.meta.url))
const hooksSrc = readFileSync(join(HERE, 'hooks.tsx'), 'utf8')
const hooksCode = hooksSrc.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).map(l => l.replace(/\/\/.*$/, '')).join('\n')

describe('L7 接线守卫：usePagedList 必须用 computeHasMore', () => {
  it('hasMore 由纯逻辑模块算出（面板的「加载更多」都依赖这一条）', () => {
    expect(hooksCode).toContain('computeHasMore({ loaded: items.length, total, lastPageCount: lastCount, pageSize })')
    expect(hooksCode).toContain("import { computeHasMore } from './paged-list.ts'")
  })

  it('旧判据（把 total 当必要条件）必须已经不在', () => {
    expect(hooksCode).not.toContain('hasMore: items.length < total && lastCount === pageSize')
    expect(hooksCode).not.toMatch(/hasMore: items\.length < total/)
  })
})
