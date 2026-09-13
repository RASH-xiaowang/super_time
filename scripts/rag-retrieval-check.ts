/**
 * RAG 检索层离线校验（可运行，不依赖 vitest）。
 *
 * 用 node:assert 断言纯逻辑行为，覆盖：意图路由 / 时间解析 / RRF 融合 / 时间感知去重 /
 * 重排 / 评估指标 / 合成评测回归。与 tests/retrieval.spec.ts 内容对应 ——
 * 后者是项目正式的 vitest 用例，本脚本用于「没有装 vitest 也能立刻验证」。
 *
 * 由 scripts/rag-retrieval-check.js 负责 bundling 后执行。
 */
import assert from 'node:assert/strict'
import { classifyIntent } from '../src/backend/wechat-data/src/query/retrieval/intent.ts'
import { resolveRelativeDate, toHalfWidth, buildQueryPlan } from '../src/backend/wechat-data/src/query/retrieval/rewrite.ts'
import { fuseResults, dedupeFused } from '../src/backend/wechat-data/src/query/retrieval/fusion.ts'
import { rerankDocs } from '../src/backend/wechat-data/src/query/retrieval/rank.ts'
import { mrr, ndcgAtK, precisionAtK } from '../src/backend/wechat-data/src/query/retrieval/eval.ts'
import { runSyntheticEval, syntheticIntentAccuracy } from '../src/backend/wechat-data/src/query/retrieval/eval-dataset.ts'
import { __internals } from '../src/backend/wechat-data/src/query/retrieval/embedding.ts'
import type { ChannelResult, FusedDoc, RetrievedDoc } from '../src/backend/wechat-data/src/query/retrieval/types.ts'

let passed = 0
/** 跑一个断言块并计数。 */
function check(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`  ✅ ${name}`)
  } catch (e) {
    console.error(`  ❌ ${name}\n     ${(e as Error).message}`)
    process.exitCode = 1
  }
}

/** 构造文档。 */
function doc(username: string, localId: number, text: string, createTime = 0): RetrievedDoc {
  return { docKey: `${username}:${localId}`, username, name: username, local_id: localId, create_time: createTime, text, snippet: text }
}

console.log('意图路由')
check('recency_lookup', () => assert.equal(classifyIntent('最近一次转账给我的是谁', ['李四']).intent, 'recency_lookup'))
check('entity_lookup（属性词）', () => assert.equal(classifyIntent('李四的电话号码是多少', ['李四']).intent, 'entity_lookup'))
check('entity_lookup（是谁）', () => assert.equal(classifyIntent('合同差额2000的那个客户是谁', ['李四']).intent, 'entity_lookup'))
check('aggregation', () => assert.equal(classifyIntent('我一共转了多少笔账', ['李四']).intent, 'aggregation'))
check('open_qa 优先于实体短问法', () => assert.equal(classifyIntent('王五借钱的事怎么样了', ['王五']).intent, 'open_qa'))
check('time_range', () => assert.equal(classifyIntent('上周三我和李四聊了什么', ['李四']).intent, 'time_range'))

console.log('查询改写')
check('全角转半角', () => assert.equal(toHalfWidth('２０２４'), '2024'))
check('相对时间解析', () => {
  const now = new Date('2026-09-10T12:00:00')
  assert.deepEqual(resolveRelativeDate('上周三的事', now), { from: '2026-09-02', to: '2026-09-02' })
  assert.deepEqual(resolveRelativeDate('上个月工资', now), { from: '2026-08-01', to: '2026-08-31' })
})
check('recency 词不进检索', () => {
  const plan = buildQueryPlan({ question: '最近一次转账给我的是谁', subQueries: ['转账'], now: new Date('2026-09-10T12:00:00') })
  assert.equal(plan.recency, true)
  assert.ok(plan.terms.includes('转账'))
  assert.ok(!plan.terms.includes('最近'))
})

console.log('融合与去重')
const mk = (channel: ChannelResult['channel'], docs: RetrievedDoc[]): ChannelResult => ({
  channel, active: true, hits: docs.map((d, i) => ({ doc: d, score: docs.length - i, rank: i + 1 })),
})
check('RRF 对多通道一致命中加权', () => {
  const a = doc('s1', 1, '转账')
  const b = doc('s1', 2, '别的')
  const fused = fuseResults([mk('sparse', [b, a]), mk('dense', [a])], 60, 10)
  assert.equal(fused[0].doc.docKey, 's1:1')
})
check('去重叠加时间邻近（模板消息不算重复）', () => {
  const t1 = doc('s1', 1, '微信转账 收到转账3500.00元 请及时查收', 1000)
  const t2 = doc('s1', 2, '微信转账 收到转账3500.00元 请及时查收', 4600)
  const t3 = doc('s1', 3, '微信转账 收到转账3500.00元 请及时查收', 1010)
  const fused: FusedDoc[] = [t1, t2, t3].map((d, i) => ({ doc: d, ranks: { sparse: i + 1 }, scores: { sparse: 1 }, rrf: 1 - i * 0.01 }))
  assert.deepEqual(dedupeFused(fused, 0.85, 300).map(f => f.doc.docKey), ['s1:1', 's1:2'])
})

console.log('重排')
const weights = { sparse: 1, dense: 1, entity: 2, coverage: 1, timePref: 1, recency: 0, agreement: 0.5 }
check('实体命中压过通用内容分', () => {
  const fused: FusedDoc[] = [
    { doc: doc('s1', 1, '转账', 100), ranks: { sparse: 1 }, scores: { sparse: 1 }, rrf: 1 },
    { doc: doc('s2', 1, '转账 李四', 100), ranks: { sparse: 2 }, scores: { sparse: 0.2 }, rrf: 0.9 },
  ]
  const ranked = rerankDocs({ fused, terms: ['转账'], termWeights: new Map([['转账', 1]]), entity: '李四', softFromMs: NaN, softToMs: NaN, recency: false, recencyFirst: false, weights, now: 200 })
  assert.equal(ranked[0].doc.docKey, 's2:1')
})
check('recencyFirst 时间新→旧', () => {
  const fused: FusedDoc[] = [
    { doc: doc('s1', 1, '转账', 1000), ranks: { sparse: 1 }, scores: { sparse: 1 }, rrf: 1 },
    { doc: doc('s1', 2, '转账', 5000), ranks: { sparse: 2 }, scores: { sparse: 0.5 }, rrf: 0.9 },
  ]
  const ranked = rerankDocs({ fused, terms: ['转账'], termWeights: new Map([['转账', 1]]), entity: '', softFromMs: NaN, softToMs: NaN, recency: true, recencyFirst: true, weights, now: 6000 })
  assert.equal(ranked[0].doc.docKey, 's1:2')
})

console.log('评估指标')
check('Precision@k', () => assert.ok(Math.abs(precisionAtK(['a', 'b', 'c'], ['a', 'c'], 3) - 2 / 3) < 1e-9))
check('MRR', () => assert.ok(Math.abs(mrr(['x', 'a'], ['a']) - 0.5) < 1e-9))
check('NDCG 完美排序为 1', () => assert.ok(Math.abs(ndcgAtK(['a', 'b'], ['a', 'b'], 5) - 1) < 1e-9))

console.log('向量哈希')
check('SimHash 确定性且相似向量更近', () => {
  const planes = __internals.getPlanes(8)
  const a = __internals.l2normalize([1, 1, 1, 1, 0, 0, 0, 0])
  const b = __internals.l2normalize([1, 1, 1, 0.9, 0, 0, 0, 0])
  const c = __internals.l2normalize([0, 0, 0, 0, 1, 1, 1, 1])
  const ha = __internals.simhash(a, planes)
  const hb = __internals.simhash(b, planes)
  const hc = __internals.simhash(c, planes)
  assert.deepEqual(__internals.simhash(a, planes), ha)
  const d = (x: { lo: number; hi: number }, y: { lo: number; hi: number }): number =>
    __internals.popcount32((x.lo ^ y.lo) >>> 0) + __internals.popcount32((x.hi ^ y.hi) >>> 0)
  assert.ok(d(ha, hb) < d(ha, hc))
})

console.log('合成评测回归')
const hybrid = runSyntheticEval({ k: 10 })
const sparseOnly = runSyntheticEval({ k: 10, denseEnabled: false, structuredEnabled: false })
check('混合不劣于纯稀疏（MRR/NDCG/Recall）', () => {
  assert.ok(hybrid.mrr >= sparseOnly.mrr, `MRR ${hybrid.mrr} < ${sparseOnly.mrr}`)
  assert.ok(hybrid.ndcg >= sparseOnly.ndcg, `NDCG ${hybrid.ndcg} < ${sparseOnly.ndcg}`)
  assert.ok(hybrid.recall >= sparseOnly.recall, `Recall ${hybrid.recall} < ${sparseOnly.recall}`)
})
check('混合达到质量下限（Recall≥0.9, MRR≥0.9）', () => {
  assert.ok(hybrid.recall >= 0.9, `Recall ${hybrid.recall}`)
  assert.ok(hybrid.mrr >= 0.9, `MRR ${hybrid.mrr}`)
})
check('意图分类全对', () => assert.equal(syntheticIntentAccuracy().accuracy, 1))

const pct = (x: number): string => (x * 100).toFixed(1) + '%'
console.log(`\n混合   P@10=${pct(hybrid.precision)} R@10=${pct(hybrid.recall)} MRR=${hybrid.mrr.toFixed(3)} NDCG=${hybrid.ndcg.toFixed(3)}`)
console.log(`仅稀疏 P@10=${pct(sparseOnly.precision)} R@10=${pct(sparseOnly.recall)} MRR=${sparseOnly.mrr.toFixed(3)} NDCG=${sparseOnly.ndcg.toFixed(3)}`)
console.log(`\n${process.exitCode ? '❌' : '✅'} 断言通过 ${passed} 项`)
