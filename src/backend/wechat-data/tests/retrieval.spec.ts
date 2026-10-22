/**
 * RAG 检索层单元测试：意图路由 / 查询改写 / 融合 / 重排 / 评估指标 /
 * 向量哈希 / 合成评测回归。
 *
 * 全部为**纯逻辑**，不碰数据库与网络，因此可以在任何环境稳定跑。
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
import { buildVectorIndex, searchDense } from '../src/query/retrieval/embedding.ts'
// P3-17：这几件纯数学的出处是 query/vector-math.ts（原先绕道 embedding 的 __internals 测试接缝，
// 接缝只该给"真实入口拿不到"的东西用，见 embedding.ts 里 __internals 的注释）。
import { getPlanes, l2normalize, MAX_HAMMING, popcount32, selectByHamming, simhash } from '../src/query/vector-math.ts'
import { defaultPolicyFor, effectiveParams, defaultRetrievalConfig, loadRetrievalConfig, retrievalConfigPath } from '../src/query/retrieval/config.ts'
import { SYNTHETIC_CASES, runSyntheticEval, syntheticIntentAccuracy } from '../src/query/retrieval/eval-dataset.ts'
import { at } from '../../tests/helpers/strict-index.ts'
import type { ChannelResult, FusedDoc, RetrievedDoc } from '../src/query/retrieval/types.ts'
import { pickDimension, resolveWindow, factsToDocs, runAggregate, directionTerms } from '../src/query/retrieval/aggregate.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

const scratch: string[] = []
afterEach(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
  scratch.length = 0
})

/** 造一个不存在的解密根；父目录唯一且登记清理，避免命中全局 %TEMP%/wechat_search.db。 */
function makeMissingDecryptedDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'wx-missing-'))
  scratch.push(root)
  return join(root, 'decrypted')
}

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

  /**
   * 排名问法也是聚合（2026-10-16 补）。
   *
   * 实测（真实数据）：「哪个群聊消息最多？」此前不含任何 AGG_RE 词 ⇒ 判成 `open_qa`
   * ⇒ 聚合通道不跑 ⇒ 模型只能从片段里数，答「判断不了」。而它的答案需要
   * `GROUP BY username ORDER BY COUNT(*) DESC`，与「一共多少」是同一类。
   */
  it('排名问法（哪个最多/最少、排行）也路由到 aggregation', () => {
    expect(classifyIntent('哪个群聊消息最多？', entities).intent).toBe('aggregation')
    expect(classifyIntent('谁跟我聊得最少', entities).intent).toBe('aggregation')
    expect(classifyIntent('消息量排行前十的群', entities).intent).toBe('aggregation')
    // 「最近 7 天哪个群最多」含「最近」但仍是聚合（AGG_RE 优先于 recency）
    expect(classifyIntent('最近7天哪个群聊消息最多？', entities).intent).toBe('aggregation')
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

  it('规划器短语原样进词表（供 FTS 连续短语匹配，而不是只剩 bigram）', () => {
    const plan = buildQueryPlan({
      question: '最近谁给我转账了',
      subQueries: ['收到转账', '转账'],
      now: new Date('2026-09-10T12:00:00'),
    })
    // 「收到转账」必须作为**整词**在表里（检索侧会编成 "收到 到转 转账" 连续短语）
    expect(plan.terms).toContain('收到转账')
    expect(plan.terms).toContain('转账')
    // 短语排在拆分出的 bigram 之前：预算有限时优先用精度更高的项
    expect(plan.terms.indexOf('收到转账')).toBeLessThan(plan.terms.indexOf('到转'))
  })

  it('过长的规划器短语不整词保留（避免整句变成一个短语，反而零命中）', () => {
    const long = '帮我看看上周三和李四聊的那个合同差额的事情'
    const plan = buildQueryPlan({ question: '合同差额', subQueries: [long] })
    expect(plan.terms).not.toContain(long)
    expect(plan.terms.length).toBeGreaterThan(0)
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
    expect(at(fused, 0, 'fused').doc.docKey).toBe('s1:1')
    expect(Object.keys(at(fused, 0, 'fused').ranks).sort()).toEqual(['dense', 'sparse'])
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
  // `kb` 这一项**必须有**：打分是 `for (const k of Object.keys(weights))` 遍历**夹具自己的键**，
  // 少写一个键就等于那条通道在这些用例里根本不参与打分 —— 与线上跑的不是同一件事。
  const weights = { sparse: 1, dense: 1, kb: 0, entity: 2, coverage: 1, timePref: 1, recency: 0, agreement: 0.5 }

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
    expect(at(ranked, 0, 'ranked').doc.docKey).toBe('s2:1')
    expect(at(ranked, 0, 'ranked').features.entity).toBe(1)
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
    expect(at(ranked, 0, 'ranked').doc.docKey).toBe('s1:2')
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
    const v = l2normalize([3, 4])
    // 这里是 typed array（Float32Array），不是普通数组 —— `at()` 的 `readonly T[]` 套不上，
    // 而下标对 typed array 恒在范围内，所以 `?? 0` 只是把类型收窄，不是掩盖问题。
    expect(Math.hypot(v[0] ?? 0, v[1] ?? 0)).toBeCloseTo(1)
  })

  it('popcount 正确', () => {
    expect(popcount32(0)).toBe(0)
    expect(popcount32(0b1011)).toBe(3)
  })

  it('同一向量 SimHash 稳定，相似向量汉明距离近', () => {
    const planes = getPlanes(8)
    const a = l2normalize([1, 1, 1, 1, 0, 0, 0, 0])
    const b = l2normalize([1, 1, 1, 0.9, 0, 0, 0, 0])
    const c = l2normalize([0, 0, 0, 0, 1, 1, 1, 1])
    const ha = simhash(a, planes)
    const hb = simhash(b, planes)
    const hc = simhash(c, planes)
    expect(simhash(a, planes)).toEqual(ha) // 确定性
    const d = (x: { lo: number; hi: number }, y: { lo: number; hi: number }): number =>
      popcount32((x.lo ^ y.lo) >>> 0) + popcount32((x.hi ^ y.hi) >>> 0)
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
      .map((r) => ({ r, d: popcount32((r.lo ^ qh.lo) >>> 0) + popcount32((r.hi ^ qh.hi) >>> 0) }))
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
      const got = selectByHamming(rows, qh, c.pool)
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
    const qh = { lo: at(rows, 0, 'rows').lo, hi: at(rows, 0, 'rows').hi }
    expect(reference(rows, qh, -3).length).toBe(7) // 旧行为：slice(0, -3) 去掉尾部 3 条
    expect(selectByHamming(rows, qh, -3)).toEqual([]) // 新行为：按 0 处理
  })

  it('距离全相同时按原表顺序取前 pool', () => {
    const rows = makeRows(64, 14)
    for (const r of rows) { r.lo = 0; r.hi = 0 }
    const qh = { lo: 0, hi: 0 } // 与每一行的距离都是 0
    const got = selectByHamming(rows, qh, 10)
    expect(got.map((r) => r.rowid)).toEqual(rows.slice(0, 10).map((r) => r.rowid))
  })

  it('恰好距离 64 的行不会被丢（直方图必须留 MAX_HAMMING 这一格）', () => {
    // 两段 32 位 popcount 之和**可以**正好等于 64（查询向量取反 ⇒ simhash 逐位取反）。
    // 直方图若只开 MAX_HAMMING 格，`hist[64]` 的写入会被静默丢弃 ⇒ 该组的条数记 0 ⇒
    // `limit` 落到更小的距离 ⇒ 这些行既不在 order 里、又让 out 出现空槽。
    const near: Row = { rowid: 1, lo: 0, hi: 0, username: 'wxid_a' }
    const far: Row = { rowid: 2, lo: 0xffffffff, hi: 0xffffffff, username: 'wxid_a' }
    const qh = { lo: 0, hi: 0 }
    expect(popcount32(0xffffffff)).toBe(32)
    const got = selectByHamming([far, near], qh, 2)
    expect(got.map((r) => r.rowid)).toEqual([1, 2]) // 近的在前，64 的仍然在
    expect(got.length).toBe(2)
  })

  it('popcount32 与朴素实现一致（差分测试的 oracle 依赖它）', () => {    // 差分测试两侧都用 popcount32，所以「popcount 本身对不对」是独立命题，必须单独验。
    const naive = (x: number): number => (x >>> 0).toString(2).split('').filter((c) => c === '1').length
    expect(popcount32(0)).toBe(0)
    expect(popcount32(0xffffffff)).toBe(32)
    for (let b = 0; b < 32; b += 1) expect(popcount32(1 << b)).toBe(1)
    const r = rng(4242)
    for (let i = 0; i < 10_000; i += 1) {
      const x = r()
      expect(popcount32(x)).toBe(naive(x))
    }
  })

  it('大量并列时结果稳定（两次调用完全一致，且顺序=距离升序）', () => {
    const rows = makeRows(5000, 11)
    for (const r of rows) r.hi = 0
    const qh = { lo: at(rows, 0, 'rows').lo ^ 0b111, hi: 0 }
    const a = selectByHamming(rows, qh, 300)
    const b = selectByHamming(rows, qh, 300)
    expect(a.map((r) => r.rowid)).toEqual(b.map((r) => r.rowid))
    const dist = (r: Row): number => popcount32((r.lo ^ qh.lo) >>> 0)
    for (let i = 1; i < a.length; i += 1) expect(dist(at(a, i, 'a'))).toBeGreaterThanOrEqual(dist(at(a, i - 1, 'a')))
  })

  it('返回值就是原表里的对象（不复制、不改写）', () => {
    const rows = makeRows(500, 12)
    const got = selectByHamming(rows, { lo: at(rows, 3, 'rows').lo, hi: at(rows, 3, 'rows').hi }, 10)
    expect(at(got, 0, 'got')).toBe(at(rows, 3, 'rows')) // 完全相同的查询哈希 → 距离 0 且在原表首位
    expect(rows[0]).toEqual({ rowid: 1, lo: expect.any(Number), hi: expect.any(Number), username: expect.any(String) })
  })

  it('dist 一律落在 [0, MAX_HAMMING]（Uint8Array 的容量前提）', () => {
    expect(MAX_HAMMING).toBe(64)
    const rows = makeRows(2000, 13)
    const qh = { lo: 0xffffffff, hi: 0 }
    const picked = selectByHamming(rows, qh, 100)
    expect(picked.length).toBe(100)
    const worst = popcount32(0xffffffff)
    expect(worst).toBe(32)
  })
})

describe('config 意图策略', () => {
  it('聚合意图放大召回、recency 意图时间优先', () => {
    expect(defaultPolicyFor('aggregation').wideRecall).toBe(true)
    expect(defaultPolicyFor('recency_lookup').recencyFirst).toBe(true)
    expect(defaultPolicyFor('aggregation').channelTopK.sparse ?? 0).toBeGreaterThan(defaultPolicyFor('open_qa').channelTopK.sparse ?? 0)
  })

  it('意图策略权重覆盖配置默认权重', () => {
    const cfg = defaultRetrievalConfig()
    const p = effectiveParams(cfg, defaultPolicyFor('entity_lookup'))
    expect(p.weights.entity).toBeGreaterThan(cfg.rerank.weights.entity)
  })
})

/**
 * 产品默认值契约（界面已不再暴露检索设置，这些值就是用户拿到手的全部行为）。
 *
 * 为什么需要一条「逐字钉住数值」的用例：检索设置面板已从界面上移除，
 * 用户不再有任何手动入口 —— 默认值一旦被静默改动，没有任何界面能让人察觉，
 * 只能靠这条用例在 CI 里拦。数值与  的参数表逐条对应，
 * 改任一数值都必须同步改那张表（表是给人看的，这条用例是给机器看的）。
 *
 * ⚠️ 历史坑（2026-09-18 实测）：`rag-config.json` 里曾长期留着 `fusion.k = 37`，
 * 那是 `scripts/ui-acceptance.mjs` 第 3 步 `fill('37')` 验证「保存落盘」时的**测试残留**
 * （脚本还原时该字段没被覆盖）。它一直静默覆盖着内置默认的 60，且因为面板上显示的
 * 就是 37，看起来像「有人特意调过」。**默认值契约能防止这类残留再次被误认为是有意配置。**
 */
describe('产品默认值契约（与检索层的内置默认一致）', () => {
  const cfg = defaultRetrievalConfig()

  it('流水线总开关与通道容量', () => {
    expect(cfg.enabled).toBe(true)
    expect(cfg.channels.sparse.topK).toBe(400)
    expect(cfg.channels.dense.topK).toBe(200)
    expect(cfg.channels.dense.minSimilarity).toBe(0.2)
    expect(cfg.channels.dense.candidatePool).toBe(2000)
  })

  it('RRF 融合常数 k = 60（不是测试残留的 37）', () => {
    // k 越大越弱化头部名次差异；60 是文档记载的经验值，也是 rag:check 基线所测的值。
    expect(cfg.fusion.k).toBe(60)
    expect(cfg.fusion.keep).toBe(120)
  })

  it('上下文预算与去重阈值', () => {
    // 2026-10-16 提速：6000 → 4500（首字延迟 9.9s，几乎全是模型处理 prompt 的时间）。
    // 减的是**相关度最低的那两段窗口**，对回答质量影响远小于对延迟的影响。
    expect(cfg.compress.maxChars).toBe(4500)
    expect(cfg.compress.maxChunks).toBe(8)
    expect(cfg.compress.dedupThreshold).toBe(0.85)
  })

  it('稠密与意图：默认按「零配置可用」取向', () => {
    // 稠密默认开：没配向量模型时 makeEmbedFn 返回 null，通道自动降级为纯稀疏（不影响可用性）；
    // 配了模型则在首次提问时惰性建索引（gateway 的 buildVectorIndex），无需手动按钮。
    expect(cfg.embedding.enabled).toBe(true)
    expect(cfg.embedding.batchSize).toBe(16)
    expect(cfg.embedding.maxDocsPerBuild).toBe(40000)
    // LLM 辅助意图分类默认关：规则分类已覆盖常见问法，开启会多一次模型往返。
    expect(cfg.intent.llmAssist).toBe(false)
  })

  it('反馈闭环默认开，步长 0.08', () => {
    expect(cfg.feedback.enabled).toBe(true)
    expect(cfg.feedback.learningRate).toBe(0.08)
  })
})

describe('M12 复审：fusion.keep 有硬上限', () => {
  /** 写一份手改的 rag-config.json 并读回。 */
  function loadWithKeep(keep: unknown): number {
    const root = mkdtempSync(join(tmpdir(), 'wx-keep-'))
    scratch.push(root)
    const dec = join(root, 'decrypted')
    mkdirSync(dec, { recursive: true })
    const cfgPath = retrievalConfigPath(dec)
    mkdirSync(dirname(cfgPath), { recursive: true })
    writeFileSync(cfgPath, JSON.stringify({ fusion: { keep } }), 'utf8')
    return loadRetrievalConfig(dec).fusion.keep
  }

  it('越界/非法值都被夹到 [1,400]（防 O(N²) 爆炸）', () => {
    // 实测最坏情形（候选全在同一会话、时间都在窗口内）：N=120 是 14ms、960 是 0.9s、1920 是 3.8s
    expect(loadWithKeep(9999)).toBe(400)
    expect(loadWithKeep(1920)).toBe(400)
    expect(loadWithKeep(0)).toBe(1)
    expect(loadWithKeep(-5)).toBe(1)
    expect(loadWithKeep('abc')).toBe(120) // 非数字 → 回落到默认
    expect(loadWithKeep(200.7)).toBe(200) // 合法值原样（截断成整数）
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

describe('接线：compress 的句子级去重必须用缓存的 3-gram（M12）', () => {
  /**
   * 为什么需要源码级守卫：全仓没有任何用例调用 `compressContext`（它只在 pipeline 里被调用），
   * 所以把它改回「每次重建两侧 3-gram」的旧写法**不会让任何用例变红**（复审实测：改回去全绿）。
   * 仓库对同类风险已有既定做法（本文件下半部分那条 selectByHamming 守卫、tests/meta.spec.ts、
   * tests/result-cache.spec.ts）。
   */
  const src = readFileSync(join(HERE, '..', 'src', 'query', 'retrieval', 'compress.ts'), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n')

  it('去重走 jaccardGrams(缓存的集合) 而不是每次 jaccard(a, b)', () => {
    // 断言的是**调用点**而不是「函数名在本文件里出现过」—— 后者连函数定义本身都能匹配，
    // 把调用点改回旧写法照样通过（复审那条变异我第一次就是这么放过它的）。
    expect(code).toContain('jaccardGrams(s.grams, bodyGrams)')
    expect(code).not.toContain('jaccard(s.text, body)')
  })

  it('每行的 3-gram 在写入 seen 的同时就被算好（与 text 同源）', () => {
    expect(code).toContain('bucket.push({ text: body, grams: bodyGrams })')
  })

  it('每行的 3-gram 只在建时算一次（gramsOf3 被调用）', () => {
    expect(code).toContain('gramsOf3(')
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
    for (let i = 1; i < res.scores.length; i += 1) expect(res.scores[i]).toBeLessThanOrEqual(at(res.scores, i - 1, 'scores'))
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

/**
 * 聚合通道（2026-10-16 新增）。
 *
 * ## 为什么必须有
 *
 * 用户报「搜索微信数据时根本不准确」。实测（真实数据 18.5 万条消息）：
 *   · 「我一共收到多少笔转账？」→ 答「14 条」（只召回了 14 条片段，真实 282 条）；
 *   · 「哪个群聊消息最多？」→ 答「判断不了」；
 *   · 「我总共跟多少人聊过天？」→ 答「没法数」。
 *
 * 根因：检索管线只做**片段召回**，`aggregation` 意图只是放大 topK，
 * **没有任何真正的聚合执行**。而这类问题的答案**不在任何一条消息里** ——
 * 它需要 `COUNT(*)` / `GROUP BY`。
 */
describe('聚合通道：维度判定与时间窗', () => {
  it('维度判定：去重计数 > 排名 > 按天 > 关键词', () => {
    // 「跟多少人」问的是**去重后的会话数**，不是「哪个会话最多」—— 必须先判 distinct
    expect(pickDimension('我总共跟多少人聊过天？')).toBe('distinct')
    expect(pickDimension('我一共有多少个会话')).toBe('distinct')
    expect(pickDimension('哪个群聊消息最多？')).toBe('session')
    expect(pickDimension('谁跟我聊得最少')).toBe('session')
    expect(pickDimension('哪天消息最多')).toBe('day')
    expect(pickDimension('我一共收到多少笔转账？')).toBe('keyword')
  })

  it('时间窗：显式范围 > 规划器日期 > 相对时间词 > 不限', () => {
    const now = new Date('2026-10-16T12:00:00')
    // 显式范围优先
    expect(resolveWindow({ decryptedDir: '', question: '最近7天哪个群最多', scope: { from: '2026-01-01', to: '2026-01-31' }, now }))
      .toEqual({ lo: Math.floor(new Date(2026, 0, 1).getTime() / 1000), hi: Math.floor(new Date(2026, 0, 31, 23, 59, 59).getTime() / 1000) })
    // 相对时间词「最近 N 天」必须换算 —— 否则「最近 7 天哪个群最多」会统计全库
    const w = resolveWindow({ decryptedDir: '', question: '最近7天哪个群聊消息最多？', now })
    expect(w.hi - w.lo).toBe(7 * 86400)
    // 不限
    expect(resolveWindow({ decryptedDir: '', question: '哪个群最多', now })).toEqual({ lo: 0, hi: 0 })
  })

  it('聚合事实转成文档时带 source=agg（压缩阶段靠它跳过窗口展开）', () => {
    const docs = factsToDocs([{ title: '按会话统计', body: '1. a：10 条', total: 10 }])
    expect(docs).toHaveLength(1)
    expect(docs[0]?.source).toBe('agg')
    // 没有会话、没有发生时间 —— 走窗口展开会得到空窗口
    expect(docs[0]?.username).toBe('')
    expect(docs[0]?.create_time).toBe(0)
  })

  it('库不存在时返回空数组（不抛错，问答照常可用）', () => {
    expect(runAggregate({ decryptedDir: makeMissingDecryptedDir(), question: '哪个群最多' })).toEqual([])
  })

  /**
   * 方向词组合（2026-10-16 实测踩到）。
   *
   * 用户问「我一共**收到**多少笔转账」，规划器把关键词拆成了「转账」——
   * 聚合通道于是统计出「含「转账」：282 条」，而**真实答案是 240 条**
   * （含「收到转账」）。282 里混着付出，模型看出这一点后只能说
   * 「没找到你收到转账的记录」—— 聚合跑了，但答的还是错的。
   */
  it('方向词组合：只认问题里字面出现的「方向+名词」（允许中间隔量词）', () => {
    expect(directionTerms('我一共收到多少笔转账？')).toEqual(['收到转账'])
    expect(directionTerms('我付出去了多少金额')).toEqual(['付出金额'])
    expect(directionTerms('收到转账和转出金额各多少')).toEqual(['收到转账', '转出金额'])
    // 没有方向词 ⇒ 空（不能凭空造组合）
    expect(directionTerms('我一共多少笔转账')).toEqual([])
    // 并列连词「和」不算间隔 ⇒ 只认出紧邻的「收到红包」，不造出「收到转账」
    expect(directionTerms('我收到红包和转账')).toEqual(['收到红包'])
    // 方向词与名词都在，但组合没出现 ⇒ 空
    expect(directionTerms('我收到过哪些金额')).toEqual([])
  })
})
