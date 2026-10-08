/**
 * 年度载荷归一化——**黑屏事故的回归守卫**（2026-09-30）。
 *
 * 事故经过：给「更多」长页加了五个新字段（moments / assets / money / revoke / groups）后，
 * 面板首帧读的是 localStorage 里的**旧缓存**（没有这五个字段），卡片直接读 `r.money.count`，
 * `undefined.count` 在渲染期抛 TypeError；面板没有 error boundary ⇒ **整窗黑屏**（只剩标题栏）。
 *
 * 所以这里钉的不是"函数写得对"，而是三条事后看非常具体的规矩：
 *   ① 缺字段的旧载荷必须能被补齐（不抛错）；
 *   ② 补出来的 0 **不许**被当成"真的是 0"（要标 `extrasPending`，否则界面会说"今年没有转账"）；
 *   ③ 缓存键带版本，形状变了就换键，不靠归一化去救一份过期数据。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { annualReviewCacheKey, normalizeReview } from './annual-normalize.ts'

/** 一份"上一版"的年度载荷（有全部旧字段，**没有**那五个新字段）。 */
function legacyPayload(): Record<string, unknown> {
  return {
    year: 2025, sent: 5767, sentTo: 69, sentDailyAvg: 28.5, activeDaysMine: 208,
    calendar: [], activeDaysAll: 208, maxDayAll: 2218,
    busiest: null, buddy: null, monthlyStar: [], starName: '', starUsername: '', starMonths: 0,
    hottestMonth: 7, hottestMonthCount: 957,
    night: {}, rhythm: {}, words: {}, catchphrase: {}, reply: {}, opener: {},
    ranking: [], emoji: {}, highlights: [],
    firstAt: '2月17日 13:47', firstText: '在', lastAt: '9月11日 23:07', lastText: '晚安',
  }
}

/** 一份完整的新载荷（五个新字段齐全）。 */
function fullPayload(): Record<string, unknown> {
  return {
    ...legacyPayload(),
    moments: { count: 12, topPost: { at: '7月1日', likes: 30, comments: 4, excerpt: '你好' }, topMonth: { month: 7, count: 5 }, lateNight: 2, available: true },
    assets: { favorites: 88, files: 21, bytes: 4096, sentFiles: 9, available: true },
    money: { count: 3, total: 88.5, topAmount: 66, topPeerName: 'a憨', byPeer: [{ username: 'wxid_a', name: 'a憨', amount: 66, count: 1 }] },
    revoke: { count: 4, topPeerName: 'a憨', byHour: new Array<number>(24).fill(0) },
    groups: { messages: 900, share: 0.12, top: [{ username: 'x@chatroom', name: '群', count: 500 }] },
  }
}

describe('normalizeReview：缺字段的旧载荷不许把面板打黑', () => {
  it('五个新字段全缺 ⇒ 补齐空形状 + extrasPending=true（渲染期不会再抛 TypeError）', () => {
    const r = normalizeReview(legacyPayload() as never)
    expect(r.extrasPending).toBe(true)
    expect(r.moments.count).toBe(0)
    expect(r.money.byPeer).toEqual([])
    expect(r.groups.top).toEqual([])
    // byHour 必须是 24 个桶（卡片里有 `byHour[peak]` 取值，长度不对会读出 undefined）
    expect(r.revoke.byHour).toHaveLength(24)
    // 原有字段一律原样保留（归一化不该碰它们）
    expect(r.sent).toBe(5767)
    expect(r.lastText).toBe('晚安')
  })

  it('补出来的 0 是"还没算"，不是"真的是 0"：available 恒为 false', () => {
    const r = normalizeReview(legacyPayload() as never)
    expect(r.moments.available).toBe(false)
    expect(r.assets.available).toBe(false)
  })

  it('只缺一个字段也算 pending（后端只升级一半的情形）', () => {
    const partial = fullPayload()
    delete partial['money']
    const r = normalizeReview(partial as never)
    expect(r.extrasPending).toBe(true)
    expect(r.money.count).toBe(0)
    // 其它已到的字段不该被清空
    expect(r.moments.count).toBe(12)
  })

  it('五个字段齐全 ⇒ 原样透传，extrasPending=false', () => {
    const r = normalizeReview(fullPayload() as never)
    expect(r.extrasPending).toBe(false)
    expect(r.money.total).toBe(88.5)
    expect(r.moments.available).toBe(true)
    expect(r.groups.share).toBe(0.12)
  })

  it('缓存键带载荷版本（v2）：形状变了就换键，不读旧键', () => {
    expect(annualReviewCacheKey(2025)).toBe('annual-review:v2:2025')
    expect(annualReviewCacheKey(2025), '旧键（不带版本）不许再出现').not.toBe('annual-review:2025')
  })
})
