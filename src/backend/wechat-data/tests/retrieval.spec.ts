/**
 * RAG 检索层单元测试：意图路由 / 查询改写 / 融合 / 重排 / 评估指标 /
 * 向量哈希 / 合成评测回归。
 *
 * 全部为**纯逻辑**，不碰数据库与网络，因此可以在任何环境稳定跑。
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { classifyIntent, refineIntentWithLlm } from '../src/query/retrieval/intent.ts'
import { buildQueryPlan, normalizeQuestion, resolveRelativeDate, synonymExpand, toHalfWidth } from '../src/query/retrieval/rewrite.ts'
import { dedupeFused, fuseResults } from '../src/query/retrieval/fusion.ts'
import { rerankDocs } from '../src/query/retrieval/rank.ts'
import { averagePrecision, mrr, ndcgAtK, precisionAtK, recallAtK } from '../src/query/retrieval/eval.ts'
import { __internals, buildVectorIndex, searchDense } from '../src/query/retrieval/embedding.ts'
import { defaultPolicyFor, effectiveParams, defaultRetrievalConfig } from '../src/query/retrieval/config.ts'
import { SYNTHETIC_CASES, runSyntheticEval, syntheticIntentAccuracy } from '../src/query/retrieval/eval-dataset.ts'
import type { ChannelResult, FusedDoc, RetrievedDoc } from '../src/query/retrieval/types.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

const scratch: string[] = []
afterEach(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
  scratch.length = 0
})

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

describe('稠密粗筛：按汉明距离取前 pool（M9）', () => {
  interface Row { rowid: number; lo: number; hi: number; username: string }

  /** 确定性 PRNG（xorshift32）：同一 seed 每次跑出同一批数据，失败可复现。 */
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
    for (let i = 0; i < n; i += 1) out[i] = { rowid: i + 1, lo: r(), hi: r(), username: i % 3 === 0 ? 'wxid_a' : 'wxid_b' }
    return out
  }

  /**
   * **改动前**的算法，作为对照用的 oracle。
   *
   * 这里在测试里重写一遍「全量 map+sort+slice」不是为了复述实现，而是做**差分测试**：
   * 这个改动声称「选出的序列与原来逐项相同」，只有拿原算法当参照才能证明。
   */
  function reference(rows: readonly Row[], qh: { lo: number; hi: number }, pool: number): Row[] {
    return rows
      .map((r) => ({ r, d: __internals.popcount32((r.lo ^ qh.lo) >>> 0) + __internals.popcount32((r.hi ^ qh.hi) >>> 0) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, pool)
      .map((x) => x.r)
  }

  it('与「全量排序后取前 pool」逐项相同（多种规模 / pool / 分布）', () => {
    const cases: Array<{ n: number; pool: number; seed: number; note: string }> = [
      { n: 0, pool: 50, seed: 1, note: '空表' },
      { n: 1, pool: 50, seed: 2, note: 'pool 远大于 N' },
      { n: 200, pool: 50, seed: 3, note: '小表' },
      { n: 135_000, pool: 200, seed: 4, note: '真实规模（13.5 万）' },
      { n: 5000, pool: 5000, seed: 5, note: 'pool == N' },
      { n: 5000, pool: 9999, seed: 6, note: 'pool > N' },
      { n: 2000, pool: 1, seed: 7, note: '只取 1 个' },
      { n: 3000, pool: 120, seed: 8, note: '大量同距离（阈值处有并列）' },
      { n: 40, pool: 40, seed: 9, note: 'pool == N' },
      { n: 40, pool: 39, seed: 10, note: 'pool == N-1' },
      { n: 500, pool: 0, seed: 11, note: 'pool=0' },
      { n: 500, pool: 2000.7, seed: 12, note: '非整数 pool（配置可手改）' },
      { n: 500, pool: Number.NaN, seed: 13, note: 'NaN pool' },
      { n: 500, pool: Number.POSITIVE_INFINITY, seed: 14, note: 'Infinity pool' },
    ]
    for (const c of cases) {
      const rows = makeRows(c.n, c.seed)
      // 最后一条用例故意构造并列：把 hi 全设成 0，距离由 lo 决定，容易出现同距离
      if (c.note.includes('并列')) for (const r of rows) r.hi = 0
      const qh = { lo: rng(c.seed + 999)(), hi: c.note.includes('并列') ? 0 : rng(c.seed + 998)() }
      const got = __internals.selectByHamming(rows, qh, c.pool)
      // oracle 直接用旧实现的 `slice(0, pool)`：它对非整数会截断、对 NaN 得空数组 ——
      // 这两种容错正是新实现必须保持一致的地方（`new Array(非整数)` 会抛 RangeError）。
      const want = reference(rows, qh, c.pool)
      expect(got.map((r) => r.rowid), c.note).toEqual(want.map((r) => r.rowid))
    }
  })

  it('负数 pool 是有意与旧行为分叉（旧 slice(0,-k) 的语义显然是笔误）', () => {
    // 记在这里是为了防止「差分测试全绿」被误解成「行为逐位一致」：
    // 这是唯一已知的分叉点，且生产不可达（pool = Math.max(candidatePool, topK)，都非负）。
    const rows = makeRows(10, 15)
    const qh = { lo: rows[0].lo, hi: rows[0].hi }
    expect(reference(rows, qh, -3).length).toBe(7) // 旧行为：slice(0, -3) 去掉尾部 3 条
    expect(__internals.selectByHamming(rows, qh, -3)).toEqual([]) // 新行为：按 0 处理
  })

  it('距离全相同时按原表顺序取前 pool', () => {
    const rows = makeRows(64, 14)
    for (const r of rows) { r.lo = 0; r.hi = 0 }
    const qh = { lo: 0, hi: 0 } // 与每一行的距离都是 0
    const got = __internals.selectByHamming(rows, qh, 10)
    expect(got.map((r) => r.rowid)).toEqual(rows.slice(0, 10).map((r) => r.rowid))
  })

  it('恰好距离 64 的行不会被丢（直方图必须留 MAX_HAMMING 这一格）', () => {
    // 两段 32 位 popcount 之和**可以**正好等于 64（查询向量取反 ⇒ simhash 逐位取反）。
    // 直方图若只开 MAX_HAMMING 格，`hist[64]` 的写入会被静默丢弃 ⇒ 该组的条数记 0 ⇒
    // `limit` 落到更小的距离 ⇒ 这些行既不在 order 里、又让 out 出现空槽。
    const near: Row = { rowid: 1, lo: 0, hi: 0, username: 'wxid_a' }
    const far: Row = { rowid: 2, lo: 0xffffffff, hi: 0xffffffff, username: 'wxid_a' }
    const qh = { lo: 0, hi: 0 }
    expect(__internals.popcount32(0xffffffff)).toBe(32)
    const got = __internals.selectByHamming([far, near], qh, 2)
    expect(got.map((r) => r.rowid)).toEqual([1, 2]) // 近的在前，64 的仍然在
    expect(got.length).toBe(2)
  })

  it('popcount32 与朴素实现一致（差分测试的 oracle 依赖它）', () => {    // 差分测试两侧都用 popcount32，所以「popcount 本身对不对」是独立命题，必须单独验。
    const naive = (x: number): number => (x >>> 0).toString(2).split('').filter((c) => c === '1').length
    expect(__internals.popcount32(0)).toBe(0)
    expect(__internals.popcount32(0xffffffff)).toBe(32)
    for (let b = 0; b < 32; b += 1) expect(__internals.popcount32(1 << b)).toBe(1)
    const r = rng(4242)
    for (let i = 0; i < 10_000; i += 1) {
      const x = r()
      expect(__internals.popcount32(x)).toBe(naive(x))
    }
  })

  it('大量并列时结果稳定（两次调用完全一致，且顺序=距离升序）', () => {
    const rows = makeRows(5000, 11)
    for (const r of rows) r.hi = 0
    const qh = { lo: rows[0].lo ^ 0b111, hi: 0 }
    const a = __internals.selectByHamming(rows, qh, 300)
    const b = __internals.selectByHamming(rows, qh, 300)
    expect(a.map((r) => r.rowid)).toEqual(b.map((r) => r.rowid))
    const dist = (r: Row): number => __internals.popcount32((r.lo ^ qh.lo) >>> 0)
    for (let i = 1; i < a.length; i += 1) expect(dist(a[i])).toBeGreaterThanOrEqual(dist(a[i - 1]))
  })

  it('返回值就是原表里的对象（不复制、不改写）', () => {
    const rows = makeRows(500, 12)
    const got = __internals.selectByHamming(rows, { lo: rows[3].lo, hi: rows[3].hi }, 10)
    expect(got[0]).toBe(rows[3]) // 完全相同的查询哈希 → 距离 0 且在原表首位
    expect(rows[0]).toEqual({ rowid: 1, lo: expect.any(Number), hi: expect.any(Number), username: expect.any(String) })
  })

  it('dist 一律落在 [0, MAX_HAMMING]（Uint8Array 的容量前提）', () => {
    expect(__internals.MAX_HAMMING).toBe(64)
    const rows = makeRows(2000, 13)
    const qh = { lo: 0xffffffff, hi: 0 }
    const picked = __internals.selectByHamming(rows, qh, 100)
    expect(picked.length).toBe(100)
    const worst = __internals.popcount32(0xffffffff)
    expect(worst).toBe(32)
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

describe('接线：稠密粗筛必须走计数选择（M9）', () => {
  /**
   * 为什么需要源码级守卫：把调用点退回旧的 `map+sort+slice` **不会**让任何用例变红 ——
   * 那两种实现按定义行为等价（差分测试正是为了证明这一点）。于是「优化被静默回退」只能靠
   * 这条守卫兜住。仓库里 `tests/meta.spec.ts` / `tests/result-cache.spec.ts` 有同款做法。
   */
  const src = readFileSync(join(HERE, '..', 'src', 'query', 'retrieval', 'embedding.ts'), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n')

  it('粗筛那一段调用 selectByHamming，且没有退回全量排序', () => {
    const start = code.indexOf('const all = loadHashRows(')
    const end = code.indexOf('const filtered =', start)
    expect(start, '找不到 loadHashRows 调用点').toBeGreaterThan(-1)
    expect(end, '找不到 filtered 那行（粗筛段的结束标志）').toBeGreaterThan(start)
    const region = code.slice(start, end)
    expect(region).toContain('selectByHamming(all,')
    expect(region, '粗筛段里又出现了排序：优化被回退了').not.toContain('.sort(')
  })

  it('下游按余弦排序的 out.sort 仍在（守卫不要误伤它）', () => {
    expect(code).toContain('out.sort(')
  })
})

describe('真值级：稠密检索端到端（M9）', () => {
  /** 桩 embedding：文本 → 确定性向量（每维由文本的哈希位决定）。 */
  function vecOf(text: string): number[] {
    let h = 2166136261
    for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0 }
    const out: number[] = []
    for (let d = 0; d < 8; d += 1) out.push(((h >>> (d * 4)) & 0xf) - 7.5)
    return out.length > 0 && out.every((x) => x === 0) ? [1, 0, 0, 0, 0, 0, 0, 0] : out
  }
  const norm = (v: number[]): number[] => {
    const n = Math.hypot(...v) || 1
    return v.map((x) => x / n)
  }
  const dot = (a: number[], b: number[]): number => a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0)

  it('候选池 >= N 时，返回顺序与「纯余弦排序」一致（整条链路：建库→粗筛→余弦）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wx-m9-e2e-'))
    scratch.push(root)
    const dec = join(root, 'decrypted')
    mkdirSync(dec, { recursive: true })

    // 稀疏索引（buildVectorIndex 的输入）：message_meta
    const texts = Array.from({ length: 30 }, (_, i) => '文档' + String(i) + '：' + 'x'.repeat(i % 5))
    const sdb = new DatabaseSync(join(root, 'wechat_search.db'))
    sdb.exec('CREATE TABLE message_meta (rowid INTEGER PRIMARY KEY, text TEXT, username TEXT, local_id INTEGER, create_time INTEGER)')
    const ins = sdb.prepare('INSERT INTO message_meta VALUES (?,?,?,?,?)')
    texts.forEach((t, i) => ins.run(i + 1, t, 'wxid_a', i + 1, 1700000000 + i))
    sdb.close()

    const embed = async (ts: string[]): Promise<number[][]> => ts.map(vecOf)
    const built = await buildVectorIndex(dec, embed, { model: 'stub', batchSize: 8, maxCharsPerDoc: 200, maxDocsPerBuild: 1000 })
    expect(built.status).toBe('ok')
    expect(built.rows).toBe(texts.length)

    const qtext = '文档3：xxx'
    // candidatePool 大于表大小 ⇒ 粗筛退化为整表（选择器必须把 30 行一条不少地交出去；
    // 若它漏行/返回空槽，下面的顺序就会与真值不一致）
    const res = await searchDense(dec, qtext, embed, { topK: 5, minSimilarity: -1, candidatePool: 1000 })
    expect(res.docs.length).toBe(5)

    // 真值由**余弦的定义**独立算出（不是复述生产逻辑）
    const qv = norm(vecOf(qtext))
    const truth = texts
      .map((t, i) => ({ localId: i + 1, score: dot(norm(vecOf(t)), qv) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
    expect(res.docs.map((d) => d.local_id)).toEqual(truth.map((x) => x.localId))
    for (let i = 1; i < res.scores.length; i += 1) expect(res.scores[i]).toBeLessThanOrEqual(res.scores[i - 1])
  }, 60_000)

  it('候选池很小时也不越界、不返回空槽，且结果都来自真实文档', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wx-m9-e2e2-'))
    scratch.push(root)
    const dec = join(root, 'decrypted')
    mkdirSync(dec, { recursive: true })
    const texts = Array.from({ length: 20 }, (_, i) => 'note' + String(i))
    const sdb = new DatabaseSync(join(root, 'wechat_search.db'))
    sdb.exec('CREATE TABLE message_meta (rowid INTEGER PRIMARY KEY, text TEXT, username TEXT, local_id INTEGER, create_time INTEGER)')
    const ins = sdb.prepare('INSERT INTO message_meta VALUES (?,?,?,?,?)')
    texts.forEach((t, i) => ins.run(i + 1, t, 'wxid_a', i + 1, 1700000000 + i))
    sdb.close()

    const embed = async (ts: string[]): Promise<number[][]> => ts.map(vecOf)
    await buildVectorIndex(dec, embed, { model: 'stub', batchSize: 8, maxCharsPerDoc: 200, maxDocsPerBuild: 1000 })
    const res = await searchDense(dec, 'note7', embed, { topK: 3, minSimilarity: -1, candidatePool: 2 })
    expect(res.docs.length).toBeLessThanOrEqual(3)
    for (const d of res.docs) {
      expect(d).toBeTruthy() // 没有 undefined 空槽
      expect(texts).toContain(d.text)
    }
  }, 60_000)
})
