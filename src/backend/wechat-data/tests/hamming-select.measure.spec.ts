/**
 * M9 的性能实测（**不是回归用例**，但文件名必须保留 *.spec.ts —— vitest 只收集这个后缀，
 * 改成别的名字根本执行不了）。所以靠 `describe.skipIf(MEASURE_HAMMING !== '1')` 默认跳过，
 * 不带参数跑 `npm test` 不会执行它。
 *
 * 为什么需要它：M9 的验收标准是「单次检索 CPU 时间显著下降并**记录实测对比**」，而
 * 计时受 worker 并行与机器负载影响，放进 CI 只会变成随机红灯。**确定性的那部分**
 * （新旧算法选出的序列逐项相同）由 `retrieval.spec.ts` 的差分测试在 CI 里守。
 *
 * 为什么用合成数据：本机真实向量库是**空的**（`wechat_rag_vectors.db` 里 vectors 表 0 行），
 * 而改造要解决的问题恰恰是「表很大时的全量排序」。所以这里合成 N 行 `{rowid, lo, hi, username}`
 * —— 这正是 `loadHashRows` 的产物形状，规模按本机实测（13.5 万）与另一处 20 万量级取默认值。
 *
 * 运行：
 *   MEASURE_HAMMING=1 node node_modules/vitest/vitest.mjs run src/backend/wechat-data/tests/hamming-select.measure.spec.ts
 *   MEASURE_HAMMING=1 MEASURE_HAMMING_ROWS=200000 ...（可改规模）
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { __internals } from '../src/query/retrieval/embedding.ts'
import { at } from '../../tests/helpers/strict-index.ts'

interface Row { rowid: number; lo: number; hi: number; username: string }

/** xorshift32：确定性数据，便于复现。 */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13; s >>>= 0
    s ^= s >>> 17
    s ^= s << 5; s >>>= 0
    return s
  }
}

function makeRows(n: number, seed: number): Row[] {
  const r = rng(seed)
  const out: Row[] = new Array(n)
  for (let i = 0; i < n; i += 1) out[i] = { rowid: i + 1, lo: r(), hi: r(), username: 'wxid_a' }
  return out
}

/** 改动前的算法（全量 map+sort+slice），作为对照。 */
function reference(rows: readonly Row[], qh: { lo: number; hi: number }, pool: number): Row[] {
  return rows
    .map((r) => ({ r, d: __internals.popcount32((r.lo ^ qh.lo) >>> 0) + __internals.popcount32((r.hi ^ qh.hi) >>> 0) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, pool)
    .map((x) => x.r)
}

function timeIt(fn: () => unknown, runs: number): { median: number; all: number[] } {
  const all: number[] = []
  for (let i = 0; i < runs; i += 1) {
    const t0 = Number(process.hrtime.bigint()) / 1e6
    fn()
    all.push(Number(process.hrtime.bigint()) / 1e6 - t0)
  }
  const sorted = [...all].sort((a, b) => a - b)
  return { median: at(sorted, Math.floor(sorted.length / 2), '样本'), all }
}

describe.skipIf(process.env.MEASURE_HAMMING !== '1')('M9 稠密粗筛实测', () => {
  it('计数选择 vs 全量排序：耗时与结果一致性', () => {
    const N = Number(process.env.MEASURE_HAMMING_ROWS ?? '135000')
    const POOL = Number(process.env.MEASURE_HAMMING_POOL ?? '200')
    const RUNS = Number(process.env.MEASURE_HAMMING_RUNS ?? '7')
    const rows = makeRows(N, 20260914)
    const qh = { lo: rng(7)(), hi: rng(8)() }

    // 先确认选出来的序列逐项相同（否则计时没有意义）
    const want = reference(rows, qh, POOL).map((r) => r.rowid)
    const got = __internals.selectByHamming(rows, qh, POOL).map((r) => r.rowid)
    expect(got).toEqual(want)

    const ref = timeIt(() => reference(rows, qh, POOL), RUNS)
    const sel = timeIt(() => __internals.selectByHamming(rows, qh, POOL), RUNS)

    const fmt = (x: { median: number; all: number[] }): string =>
      `中位 ${x.median.toFixed(1)}ms（${x.all.map((v) => v.toFixed(1)).join(' / ')}）`
    console.log(`\nM9 粗筛实测：N=${N} 行，pool=${POOL}，每档 ${RUNS} 次`)
    console.log('  旧：全量 map+sort+slice : ' + fmt(ref))
    console.log('  新：计数选择（O(N)）   : ' + fmt(sel))
    console.log(`  → 加速 ${(ref.median / Math.max(sel.median, 0.001)).toFixed(1)}×（省 ${(ref.median - sel.median).toFixed(1)}ms/次）`)
    console.log('  说明：这是**粗筛这一步**的 CPU 时间；真实检索还要等一次 embedding 网络往返（几百 ms 量级）。')
  }, 300_000)
})
