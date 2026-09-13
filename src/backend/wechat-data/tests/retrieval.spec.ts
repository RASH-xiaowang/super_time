/**
 * RAG 检索层单元测试：意图路由 / 查询改写 / 融合 / 重排 / 评估指标 /
 * 向量哈希 / 合成评测回归。
 *
 * 全部为**纯逻辑**，不碰数据库与网络，因此可以在任何环境稳定跑。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { classifyIntent, refineIntentWithLlm } from '../src/query/retrieval/intent.ts'
import { buildQueryPlan, normalizeQuestion, resolveRelativeDate, synonymExpand, toHalfWidth } from '../src/query/retrieval/rewrite.ts'
import { dedupeFused, fuseResults } from '../src/query/retrieval/fusion.ts'
import { rerankDocs } from '../src/query/retrieval/rank.ts'
import { averagePrecision, mrr, ndcgAtK, precisionAtK, recallAtK } from '../src/query/retrieval/eval.ts'
import { __internals } from '../src/query/retrieval/embedding.ts'
import { defaultPolicyFor, effectiveParams, defaultRetrievalConfig } from '../src/query/retrieval/config.ts'
import { SYNTHETIC_CASES, runSyntheticEval, syntheticIntentAccuracy } from '../src/query/retrieval/eval-dataset.ts'
import type { ChannelResult, FusedDoc, RetrievedDoc } from '../src/query/retrieval/types.ts'

/** 构造一条统一文档。 */
function doc(username: string, localId: number, text: string, createTime = 0): RetrievedDoc {
  return {
    docKey: username + ':' + localId, username, name: username, local_id: localId,
    create_time: createTime, text, snippet: text,
  }
}

describe('intent 分类路由', () => {
  const entities = ['李四', '王五', '项目组']

  it('「最近」类问法路由到 recency_lookup', () => {
    expect(classifyIntent('最近一次转账给我的是谁', entities).intent).toBe('recency_lookup')
  })

  it('实体 + 属性词路由到 entity_lookup', () => {
    expect(classifyIntent('李四的电话号码是多少', entities).intent).toBe('entity_lookup')
  })

  it('「是谁」类问法路由到 entity_lookup', () => {
    expect(classifyIntent('合同差额2000的那个客户是谁', entities).intent).toBe('entity_lookup')
  })

  it('聚合词路由到 aggregation（且优先于「最近」）', () => {
    expect(classifyIntent('我一共转了多少笔账', entities).intent).toBe('aggregation')
    expect(classifyIntent('最近一共转了多少', entities).intent).toBe('aggregation')
  })

  it('开放问法（怎么样）优先于实体短问法，避免窄化召回', () => {
    expect(classifyIntent('王五借钱的事怎么样了', entities).intent).toBe('open_qa')
  })

  it('显式时间表达路由到 time_range', () => {
    expect(classifyIntent('上周三我和李四聊了什么', entities).intent).toBe('time_range')
    expect(classifyIntent('上个月工资发了多少', entities).intent).toBe('time_range')
  })

  it('LLM 只在规则未定时才修正意图', () => {
    const base = classifyIntent('帮我看看这个', entities)
    expect(refineIntentWithLlm(base, 'aggregation').intent).toBe('aggregation')
    const decided = classifyIntent('最近一次转账给谁', entities)
    expect(refineIntentWithLlm(decided, 'aggregation').intent).toBe('recency_lookup')
  })
})

describe('rewrite 查询改写', () => {
  it('全角转半角 + 压空白', () => {
    expect(toHalfWidth('２０２４')).toBe('2024')
    expect(normalizeQuestion('  李四  的 电话 ')).toBe('李四 的 电话')
  })

  it('确定性相对时间解析', () => {
    const now = new Date('2026-09-10T12:00:00') // 周四
    expect(resolveRelativeDate('上周三的事', now)).toEqual({ from: '2026-09-02', to: '2026-09-02' })
    expect(resolveRelativeDate('昨天的事', now)).toEqual({ from: '2026-09-09', to: '2026-09-09' })
    expect(resolveRelativeDate('上个月工资', now)).toEqual({ from: '2026-08-01', to: '2026-08-31' })
    expect(resolveRelativeDate('9月3号', now)).toEqual({ from: '2026-09-03', to: '2026-09-03' })
    expect(resolveRelativeDate('随便聊聊', now)).toEqual({ from: '', to: '' })
  })

  it('同义扩展只在命中同义词组时触发', () => {
    expect(synonymExpand(['转账'])).toContain('汇款')
    expect(synonymExpand(['天气'])).toEqual([])
  })

  it('改写出多个查询变体，并把时间词从检索词里摘掉', () => {
    const plan = buildQueryPlan({
      question: '最近一次转账给我的是谁',
      subQueries: ['转账'],
      now: new Date('2026-09-10T12:00:00'),
    })
    expect(plan.recency).toBe(true)
    expect(plan.terms).toContain('转账')
    expect(plan.terms).not.toContain('最近')
    expect(plan.variants.length).toBeGreaterThan(1)
  })

  it('用户显式时间范围是硬过滤，规划器日期是软偏好', () => {
    const hard = buildQueryPlan({ question: '聊聊', scopeFrom: '2026-09-01', scopeTo: '2026-09-02' })
    expect(hard.timeHard).toBe(true)
    const soft = buildQueryPlan({ question: '昨天聊了什么' })
    expect(soft.timeHard).toBe(false)
  })
})

describe('fusion RRF 融合与去重', () => {
  const mk = (channel: ChannelResult['channel'], docs: RetrievedDoc[]): ChannelResult => ({
    channel, active: true, hits: docs.map((d, i) => ({ doc: d, score: docs.length - i, rank: i + 1 })),
  })

  it('被两个通道同时召回的文档 RRF 更高', () => {
    const a = doc('s1', 1, '转账')
    const b = doc('s1', 2, '别的')
    const fused = fuseResults([
      mk('sparse', [b, a]),       // a 在 sparse 排第 2
      mk('dense', [a]),           // a 在 dense 排第 1
    ], 60, 10)
    expect(fused[0].doc.docKey).toBe('s1:1')
    expect(Object.keys(fused[0].ranks).sort()).toEqual(['dense', 'sparse'])
  })

  it('去重必须叠加时间邻近：模板化的转账通知不能被当成重复', () => {
    const t1 = doc('s1', 1, '微信转账 收到转账3500.00元 请及时查收', 1000)
    const t2 = doc('s1', 2, '微信转账 收到转账3500.00元 请及时查收', 1000 + 3600) // 一小时后（不同事件）
    const t3 = doc('s1', 3, '微信转账 收到转账3500.00元 请及时查收', 1000 + 10)   // 十秒后（同一句重复）
    const fused: FusedDoc[] = [t1, t2, t3].map((d, i) => ({ doc: d, ranks: { sparse: i + 1 }, scores: { sparse: 1 }, rrf: 1 - i * 0.01 }))
    const out = dedupeFused(fused, 0.85, 300)
    // t1/t2 时间不相近 → 都保留；t3 与 t1 近似且在同期 → 被合并。
    expect(out.map(f => f.doc.docKey)).toEqual(['s1:1', 's1:2'])
  })
})

describe('rank 交叉特征重排', () => {
  const weights = { sparse: 1, dense: 1, entity: 2, coverage: 1, timePref: 1, recency: 0, agreement: 0.5 }

  it('实体命中权重压过通用内容分', () => {
    const generic = doc('s1', 1, '转账', 100)
    const withEntity = doc('s2', 1, '转账 李四', 100)
    const fused: FusedDoc[] = [
      { doc: generic, ranks: { sparse: 1 }, scores: { sparse: 1 }, rrf: 1 },
      { doc: withEntity, ranks: { sparse: 2 }, scores: { sparse: 0.2 }, rrf: 0.9 },
    ]
    const ranked = rerankDocs({
      fused, terms: ['转账'], termWeights: new Map([['转账', 1]]), entity: '李四',
      softFromMs: NaN, softToMs: NaN, recency: false, recencyFirst: false, weights, now: 200,
    })
    expect(ranked[0].doc.docKey).toBe('s2:1')
    expect(ranked[0].features.entity).toBe(1)
  })

  it('recencyFirst 把命中内容词的候选按时间新→旧排', () => {
    const older = doc('s1', 1, '转账', 1000)
    const newer = doc('s1', 2, '转账', 5000)
    const fused: FusedDoc[] = [
      { doc: older, ranks: { sparse: 1 }, scores: { sparse: 1 }, rrf: 1 },
      { doc: newer, ranks: { sparse: 2 }, scores: { sparse: 0.5 }, rrf: 0.9 },
    ]
    const ranked = rerankDocs({
      fused, terms: ['转账'], termWeights: new Map([['转账', 1]]), entity: '',
      softFromMs: NaN, softToMs: NaN, recency: true, recencyFirst: true, weights, now: 6000,
    })
    expect(ranked[0].doc.docKey).toBe('s1:2')
  })
})

describe('eval 指标', () => {
  it('Precision@k / Recall@k', () => {
    expect(precisionAtK(['a', 'b', 'c'], ['a', 'c'], 3)).toBeCloseTo(2 / 3)
    expect(recallAtK(['a', 'b', 'c'], ['a', 'c', 'd'], 2)).toBeCloseTo(1 / 3)
  })

  it('MRR 取第一个相关结果名次的倒数', () => {
    expect(mrr(['x', 'a'], ['a'])).toBeCloseTo(0.5)
    expect(mrr(['x', 'y'], ['a'])).toBe(0)
  })

  it('NDCG 完美排序为 1，且截断生效', () => {
    expect(ndcgAtK(['a', 'b'], ['a', 'b'], 5)).toBeCloseTo(1)
    const truncated = ndcgAtK(['x', 'a'], ['a'], 1)
    expect(truncated).toBe(0)
  })

  it('AP 对位置敏感', () => {
    expect(averagePrecision(['a'], ['a'])).toBeCloseTo(1)
    expect(averagePrecision(['a', 'b'], ['a', 'b'])).toBeCloseTo(1)
  })
})

describe('embedding SimHash 工具', () => {
  it('L2 归一化后模长为 1', () => {
    const v = __internals.l2normalize([3, 4])
    expect(Math.hypot(v[0], v[1])).toBeCloseTo(1)
  })

  it('popcount 正确', () => {
    expect(__internals.popcount32(0)).toBe(0)
    expect(__internals.popcount32(0b1011)).toBe(3)
  })

  it('同一向量 SimHash 稳定，相似向量汉明距离近', () => {
    const planes = __internals.getPlanes(8)
    const a = __internals.l2normalize([1, 1, 1, 1, 0, 0, 0, 0])
    const b = __internals.l2normalize([1, 1, 1, 0.9, 0, 0, 0, 0])
    const c = __internals.l2normalize([0, 0, 0, 0, 1, 1, 1, 1])
    const ha = __internals.simhash(a, planes)
    const hb = __internals.simhash(b, planes)
    const hc = __internals.simhash(c, planes)
    expect(__internals.simhash(a, planes)).toEqual(ha) // 确定性
    const d = (x: { lo: number; hi: number }, y: { lo: number; hi: number }): number =>
      __internals.popcount32((x.lo ^ y.lo) >>> 0) + __internals.popcount32((x.hi ^ y.hi) >>> 0)
    expect(d(ha, hb)).toBeLessThan(d(ha, hc))
  })
})

describe('config 意图策略', () => {
  it('聚合意图放大召回、recency 意图时间优先', () => {
    expect(defaultPolicyFor('aggregation').wideRecall).toBe(true)
    expect(defaultPolicyFor('recency_lookup').recencyFirst).toBe(true)
    expect(defaultPolicyFor('aggregation').channelTopK.sparse).toBeGreaterThan(defaultPolicyFor('open_qa').channelTopK.sparse)
  })

  it('意图策略权重覆盖配置默认权重', () => {
    const cfg = defaultRetrievalConfig()
    const p = effectiveParams(cfg, defaultPolicyFor('entity_lookup'))
    expect(p.weights.entity).toBeGreaterThan(cfg.rerank.weights.entity)
  })
})

describe('合成评测集（回归护栏）', () => {
  it('混合检索不劣于纯稀疏消融', () => {
    const hybrid = runSyntheticEval({ k: 10 })
    const sparse = runSyntheticEval({ k: 10, denseEnabled: false, structuredEnabled: false })
    expect(hybrid.mrr).toBeGreaterThanOrEqual(sparse.mrr)
    expect(hybrid.ndcg).toBeGreaterThanOrEqual(sparse.ndcg)
    expect(hybrid.recall).toBeGreaterThanOrEqual(sparse.recall)
  })

  it('混合检索达到质量下限', () => {
    const r = runSyntheticEval({ k: 10 })
    expect(r.cases).toBe(SYNTHETIC_CASES.length)
    expect(r.recall).toBeGreaterThanOrEqual(0.9)
    expect(r.mrr).toBeGreaterThanOrEqual(0.9)
  })

  it('意图分类在评测集上全对', () => {
    const acc = syntheticIntentAccuracy()
    expect(acc.accuracy).toBe(1)
  })
})
