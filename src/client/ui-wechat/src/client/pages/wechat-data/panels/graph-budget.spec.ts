/**
 * 连线额度（`graph-budget.ts`）的锁定。
 *
 * 这个模块是**建模层与绘制层共用的单一口径**，所以它的每一处退化都会同时影响两件事：
 *   ① 画不出来（模型里有边、图上没有）；
 *   ② 画太多（真实关系被「分桶截断」挤掉，或小图上把一个群的真实连线切掉）。
 * 两条都不是崩溃型缺陷 —— 界面照样能用，只是悄悄少画/多画几条线，肉眼极难发现，
 * 所以在源码级把曲线钉住。
 *
 * 具体钉的是三类数字：
 *   - `edgeDensityCap` 的**曲线**（下限 300 / 密度 5·n / 绝对上限 24000 各自接管哪一段）；
 *   - `MIN_EDGE_BUDGET = 300` 的**推导区间** [190, 325) —— 两条真机约束夹出来的，
 *     改这个数必须先看这两个断言（这不是「拍脑袋的整数」，见常量文档）；
 *   - `edgeHeadroom` 是**增量**而不是总额度，且「用满即 0」。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  EDGES_PER_NODE,
  MAX_EDGE_BUDGET,
  MIN_EDGE_BUDGET,
  OBSERVED_EDGE_CAP,
  edgeBudget,
  edgeDensityCap,
  edgeHeadroom,
} from './graph-budget.ts'

describe('edgeDensityCap：下限 / 密度 / 绝对上限三段各自接管', () => {
  it('下限段：节点数不大时用 MIN_EDGE_BUDGET 兜住', () => {
    expect(edgeDensityCap(0)).toBe(MIN_EDGE_BUDGET)
    expect(edgeDensityCap(1)).toBe(MIN_EDGE_BUDGET)
    // 10 节点 × 5 = 50 < 300 ⇒ 用下限
    expect(edgeDensityCap(10)).toBe(300)
    // 60 节点 × 5 = 300 = 下限（交接点）
    expect(edgeDensityCap(60)).toBe(300)
  })

  it('密度段：越过交接点后由「节点数 × 5」接管（不是被下限顶住）', () => {
    expect(edgeDensityCap(61)).toBe(305)
    // 真机默认好友视图：251 节点 → 1255（实测 998 条边，够画全）
    expect(edgeDensityCap(251)).toBe(1255)
    // 真机群组网络：65 节点 → 325（实测 691 条边，按权重截断）
    expect(edgeDensityCap(65)).toBe(325)
  })

  it('绝对上限段：节点数很大时由 24000 兜住（比例额度会线性膨胀）', () => {
    expect(edgeDensityCap(10000)).toBe(MAX_EDGE_BUDGET)
    expect(edgeDensityCap(100000)).toBe(MAX_EDGE_BUDGET)
  })

  it('非法输入不产生负额度', () => {
    expect(edgeDensityCap(-5)).toBe(MIN_EDGE_BUDGET)
    expect(edgeDensityCap(Number.NaN)).toBe(MIN_EDGE_BUDGET)
  })
})

describe('MIN_EDGE_BUDGET = 300：被两条真机约束夹出来的区间', () => {
  it('下界 190：必须覆盖「19 人同处一个群」这一个完全图', () => {
    // 一个人数不多的群**本身就是完全图**，那些线是全部事实，截掉就是在画假图。
    const clique = (19 * 18) / 2
    const total = 19 + clique // 亲密度 19 条 + 同群 171 条
    expect(clique).toBe(171)
    expect(total).toBe(190)
    // 20 个节点（19 人 + 「我」）的额度必须 ≥ 190，否则「19 人同群」会被切成 161 对
    expect(edgeDensityCap(20)).toBeGreaterThanOrEqual(total)
    // 老值 180 正是差在这里
    expect(180).toBeLessThan(total)
  })

  it('上界 < 325：不许越过「群组网络按权重截断」那档的实测定档', () => {
    // 群组网络 691 条 / 65 节点 → 额度 325，是刻意保留的截断
    expect(MIN_EDGE_BUDGET).toBeLessThan(edgeDensityCap(65))
    // 下限一旦 ≥ 325 就会把 325 → 691 放开，等于推翻「大群网络要截断」这个决定
    expect(edgeBudget(65, 691, 64)).toBe(325)
  })
})

describe('edgeBudget：总额度，且不超过实际可用量', () => {
  it('与 edgeDensityCap 同源（backbone=0 且边够多时就是它）', () => {
    for (const n of [10, 20, 61, 251, 10000]) {
      expect(edgeBudget(n, 1e6, 0)).toBe(edgeDensityCap(n))
    }
  })

  it('不超过实际边数（预算不该大于可用量）', () => {
    expect(edgeBudget(10, 5)).toBe(5)
    expect(edgeBudget(251, 998, 250)).toBe(998)
  })

  it('backbone 是一条**下限**，不是额外额度（不能写成 cap + backbone）', () => {
    // 骨架 600 > 节点数×5=500 ⇒ 以骨架为准
    expect(edgeBudget(100, 100000, 600)).toBe(600)
    // 骨架小于额度时以额度为准
    expect(edgeBudget(100, 100000, 30)).toBe(500)
  })
})

describe('edgeHeadroom：是「增量」，不是总额度', () => {
  it('= 密度上限 − 已占用，且不小于 0', () => {
    expect(edgeHeadroom(251, 0)).toBe(1255)
    expect(edgeHeadroom(251, 1031)).toBe(224) // 真机默认视图：加首字层前的实测余量
    expect(edgeHeadroom(251, 1255)).toBe(0)
    expect(edgeHeadroom(251, 99999)).toBe(0)
  })

  it('用满即 0：额度全占了就不许再新增（推断层不能挤掉观测层）', () => {
    for (const n of [10, 20, 251, 2606, 10000]) {
      expect(edgeHeadroom(n, edgeDensityCap(n))).toBe(0)
    }
  })

  it('非法输入不产生负值或 NaN', () => {
    expect(edgeHeadroom(251, -10)).toBe(1255)
    expect(Number.isNaN(edgeHeadroom(251, Number.NaN))).toBe(false)
  })

  it('观测层上限与密度上限是两个不同的数（6000 < 2606×5=13030 是首字层能出现的前提）', () => {
    // 全量视图：观测层夹在 6000，密度上限 13030 ⇒ 有 7030 条额度留给推断层。
    // 两个数相等（或观测层直接吃掉密度上限）就等于把推断层饿死 —— 那正是改前的缺陷。
    expect(OBSERVED_EDGE_CAP).toBe(6000)
    expect(edgeDensityCap(2606)).toBe(13030)
    expect(edgeHeadroom(2606, OBSERVED_EDGE_CAP)).toBe(7030)
    expect(EDGES_PER_NODE).toBe(5)
  })
})
