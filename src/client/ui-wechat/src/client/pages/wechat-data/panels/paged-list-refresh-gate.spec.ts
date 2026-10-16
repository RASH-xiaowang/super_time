/**
 * P2-8 / 第二批 #17：`usePagedList` 的后台刷新节流与上界（纯逻辑部分）。
 *
 * 现场：实时同步活跃期宿主约每 10 秒派发一次 `dsh-wechat-data-updated`，每个用本钩子的
 * 面板都会 `refresh()`，一轮是 `ceil(已加载条数 / pageSize)` 个请求（旧上界 16 页），
 * 而后端只有**一条**调用队列。窗口藏在后台时这些请求尤其没有意义。
 *
 * 三条判据各自守一个容易做错的点：
 *   · 「太密」要**合并**（排一次尾部刷新），不是丢弃 —— 丢了就等于面板永远停在旧数据；
 *   · 不可见 ⇒ 一个请求都不发（可见性恢复时由调用方补刷）；
 *   · 一轮装不下 ⇒ **整轮跳过**。发前 N 页会把列表截短，而 `refresh()` 存在的全部理由
 *     就是「非破坏性」（截短会塌高度、把用户弹回顶部）。
 */
import { describe, expect, it } from 'vitest'
import { REFRESH_MAX_PAGES, REFRESH_MIN_INTERVAL_MS, refreshGate, refreshPagesFor } from './paged-list.ts'

describe('refreshGate：合并而不是丢弃', () => {
  const T0 = 1_760_000_000_000

  it('从没刷过 ⇒ 立刻发', () => {
    expect(refreshGate({ now: T0, lastStartedAt: 0, hidden: false })).toEqual({ go: true, waitMs: 0 })
  })

  it('间隔未到 ⇒ 现在不发，但要等到点补一次（waitMs = 剩余）', () => {
    const g = refreshGate({ now: T0 + 10_000, lastStartedAt: T0, hidden: false })
    expect(g.go, '距上次才 10 秒，不该又发一轮').toBe(false)
    expect(g.waitMs, '只丢事件不排队 = 面板永远停在旧数据').toBe(REFRESH_MIN_INTERVAL_MS - 10_000)
  })

  it('刚好到最短间隔 ⇒ 发', () => {
    expect(refreshGate({ now: T0 + REFRESH_MIN_INTERVAL_MS, lastStartedAt: T0, hidden: false }).go).toBe(true)
  })

  it('页面不可见 ⇒ 不发也不排队（回前台时调用方补刷）', () => {
    expect(refreshGate({ now: T0 + 60_000, lastStartedAt: T0, hidden: true })).toEqual({ go: false, waitMs: 0 })
  })

  it('时钟回拨（lastStartedAt 在未来）不许把刷新永久锁死', () => {
    const g = refreshGate({ now: T0, lastStartedAt: T0 + 5_000, hidden: false })
    expect(g.go, 'elapsed 为负时 waitMs 会是负数 ⇒ 再也排不上队').toBe(true)
  })
})

describe('refreshPagesFor：装不下就整轮跳过，不许截断列表', () => {
  it('已加载条数换算成页数', () => {
    expect(refreshPagesFor(0, 200)).toEqual({ pages: 0, feasible: true })
    expect(refreshPagesFor(200, 200)).toEqual({ pages: 1, feasible: true })
    expect(refreshPagesFor(1001, 200, 8)).toEqual({ pages: 6, feasible: true })
  })

  it('超过上界 ⇒ feasible:false（而不是发前 N 页把列表缩掉）', () => {
    const r = refreshPagesFor(3200, 200, REFRESH_MAX_PAGES)
    expect(r.feasible, '16 页 > 8 页上界：这一轮必须整轮跳过').toBe(false)
    expect(r.pages, '不可行时页数只是上界值，调用方不得拿它去发请求').toBe(REFRESH_MAX_PAGES)
  })

  it('pageSize 非法（0 / NaN）⇒ 不排队发请求，但判可行（交给首屏那条路）', () => {
    expect(refreshPagesFor(1000, 0)).toEqual({ pages: 0, feasible: true })
    expect(refreshPagesFor(1000, Number.NaN)).toEqual({ pages: 0, feasible: true })
  })
})
