// @vitest-environment node
/**
 * 「停止分析」之后那一批消息的**归属**口径（W3-11.5 收尾）。
 *
 * 取消本身的行为在后端（`laya-analysis-cancel.spec.ts`），本文件钉的是它落地到
 * 「哪些消息会被重新算」这一层的两个口径。两者都不是显然的，而且**错了都不会让任何用例变红**：
 *
 * ① **被取消时没算到的那几条必须从结果表里删掉**。留着 `pending` 的话，
 *    收集那一步的 `map.has(localId)` 会永远跳过它们 ⇒ 用户停下来的那几条永远显示
 *    「本地分析中…」，而且再也补不上。
 * ② 但删掉之后**本轮必须豁免它们**。`map` 是收集 effect 的依赖，删条目会立刻触发重跑 ——
 *    于是「点停止 → 约半秒后自己又跑起来」，用户按了等于没按。
 *
 * 口径就落在纯函数 `collectAnalyzeTargets` 上（所以本文件不需要渲染组件）：
 *   · `skipOnce` 里的这一轮**不收**（豁免）；
 *   · 下一轮照收（一次性，不是永久拉黑）。
 */
import { describe, expect, it } from 'vitest'
import { collectAnalyzeTargets, findSortSeq } from './use-inline-analysis.ts'
import type { MessageRenderItem } from '../utils/message-items.ts'

/** 一条够格的可见消息。 */
const msg = (localId: number, sortSeq: number): { localId: number; sortSeq: number; eligible: boolean } =>
  ({ localId, sortSeq, eligible: true })

const never = (): boolean => false
const noSet: ReadonlySet<number> = new Set<number>()

describe('取消之后：哪些消息会被重新算', () => {
  it('本轮豁免的那几条不收（点停止不会让它们立刻自己复活）', () => {
    const visible = [msg(1, 1), msg(2, 2), msg(3, 3)]
    const skipOnce = new Set([2, 3])
    const got = collectAnalyzeTargets(visible, never, noSet, skipOnce, 4)
    expect(got.map((t) => t.localId), '被取消而没算到的那两条本轮不该再被收进目标').toEqual([1])
  })

  it('豁免是**一次性**的：下一轮照收（否则它们永远补不上）', () => {
    const visible = [msg(1, 1), msg(2, 2)]
    const skipOnce = new Set([2])
    // 第一轮：2 被豁免。
    expect(collectAnalyzeTargets(visible, never, noSet, skipOnce, 4).map((t) => t.localId)).toEqual([1])
    // hook 里豁免集合是「取走即弃」的，所以第二轮传空集合。
    expect(collectAnalyzeTargets(visible, never, noSet, new Set<number>(), 4).map((t) => t.localId))
      .toEqual([1, 2])
  })

  it('已在结果表 / 在飞的消息照旧不收（豁免不改变原有两条口径）', () => {
    const visible = [msg(1, 1), msg(2, 2), msg(3, 3)]
    const has = (id: number): boolean => id === 1
    const inflight: ReadonlySet<number> = new Set([2])
    expect(collectAnalyzeTargets(visible, has, inflight, noSet, 4).map((t) => t.localId)).toEqual([3])
  })

  it('不合格的消息（自己发的 / 非文本语音）不进目标，且不受豁免影响', () => {
    const visible = [
      { localId: 1, sortSeq: 1, eligible: false },
      msg(2, 2),
      { localId: 3, sortSeq: 3, eligible: false },
    ]
    // 把「不合格」的两条也放进豁免：结果不该变 —— 它们的出局理由与豁免无关。
    expect(collectAnalyzeTargets(visible, never, noSet, new Set([1, 3]), 4).map((t) => t.localId)).toEqual([2])
  })

  it('sortSeq 非法（0 / 负数 / NaN）的不收 —— 没有排序游标就取不对上下文', () => {
    const visible = [
      { localId: 1, sortSeq: 0, eligible: true },
      { localId: 2, sortSeq: -5, eligible: true },
      { localId: 3, sortSeq: Number.NaN, eligible: true },
      msg(4, 7),
    ]
    expect(collectAnalyzeTargets(visible, never, noSet, noSet, 4).map((t) => t.localId)).toEqual([4])
  })

  it('一次最多收 max 条（与 MAX_BATCH 对齐，批次越大占用 worker 越久）', () => {
    const visible = [msg(1, 1), msg(2, 2), msg(3, 3), msg(4, 4), msg(5, 5)]
    expect(collectAnalyzeTargets(visible, never, noSet, noSet, 4).length).toBe(4)
  })
})

describe('「重试这一条」的收集口径', () => {
  it('钉住的那条排最前，且不受「已在结果表里」限制', () => {
    const visible = [msg(1, 1), msg(2, 2), msg(3, 3)]
    // retry 把失败态翻成了 pending ⇒ `has(2)` 为真。不给钉住特权它会被滤掉。
    const has = (id: number): boolean => id === 2
    const pinned = new Map([[2, 22]])
    expect(collectAnalyzeTargets(visible, has, noSet, noSet, 4, pinned).map((t) => t.localId))
      .toEqual([2, 1, 3])
  })

  it('钉住的那条不必在可见窗口里（用户多半已经把它滚出视野）', () => {
    const visible = [msg(1, 1)]
    const pinned = new Map([[99, 42]])
    // 钉住的那条排在最前；可见窗口里那条仍然照收（名额还有余）。
    expect(collectAnalyzeTargets(visible, never, noSet, noSet, 4, pinned)).toEqual([
      { localId: 99, sortSeq: 42 },
      { localId: 1, sortSeq: 1 },
    ])
  })

  it('钉住的条目也占 max 名额（钉 3 条时可见窗口的目标只能补剩下的）', () => {
    const visible = [msg(1, 1), msg(2, 2), msg(3, 3), msg(4, 4)]
    const pinned = new Map([[90, 9], [91, 10], [92, 11]])
    const got = collectAnalyzeTargets(visible, never, noSet, noSet, 4, pinned)
    expect(got.map((t) => t.localId), '钉住的三条优先，剩下的名额只有一个').toEqual([90, 91, 92, 1])
  })

  it('在飞 / 本轮豁免的条目即便被钉住也不重发（避免同一条并发两批）', () => {
    const visible: Array<{ localId: number; sortSeq: number; eligible: boolean }> = []
    const inflight: ReadonlySet<number> = new Set([5])
    expect(collectAnalyzeTargets(visible, never, inflight, noSet, 4, new Map([[5, 1]]))).toEqual([])
    expect(collectAnalyzeTargets(visible, never, noSet, new Set([6]), 4, new Map([[6, 2]]))).toEqual([])
  })

  it('钉住的条目 sortSeq 非法时不发（否则后端取不对上下文）', () => {
    const visible: Array<{ localId: number; sortSeq: number; eligible: boolean }> = []
    expect(collectAnalyzeTargets(visible, never, noSet, noSet, 4, new Map([[7, 0]]))).toEqual([])
  })

  it('findSortSeq：找得到就回游标，找不到 / 游标非法就 undefined', () => {
    const row = (localId: number, sortSeq: number): MessageRenderItem =>
      ({ kind: 'msg', m: { localId, sortSeq } }) as unknown as MessageRenderItem
    const items = [row(1, 10), row(2, 20)] as const
    expect(findSortSeq([...items], 2)).toBe(20)
    // 消息已不在渲染行里（切了会话 / 列表清空）⇒ 无处可钉。
    expect(findSortSeq([...items], 3)).toBeUndefined()
    expect(findSortSeq([...items, row(4, 0)], 4)).toBeUndefined()
  })
})