/**
 * 合成评测集（目标 2 的数据来源）。
 *
 * 为什么自造语料：真实微信数据是隐私敏感的、且分布会漂移，不能作为可提交、可复现的
 * 回归基准。这里构造一份**确定性**的小语料 + 人工标注的「问题 → 相关消息」对，
 * 让召回指标可以随代码提交、在 CI 里每天跑，任何一次检索改动引起的退化都会立刻暴露。
 *
 * 语料刻意覆盖几类难例（都是真实场景里踩过的坑）：
 *   · 「最近一次转账给谁」—— 群里有讨论转账脚本的消息，真正的转账通知在房东会话里（时间占先）；
 *   · 「李四的电话」—— 号码以 138 开头，需要实体 + 属性双层匹配；
 *   · 「上周三和李四聊了什么」—— 需要把相对时间解析成绝对日期；
 *   · 「合同差额2000的客户是谁」—— 数字 + 实体的组合，考察分词与实体召回。
 *
 * 检索适配器在合成语料上复现真实流水线的**融合 + 重排**逻辑（fusion.ts / rank.ts），
 * 因此指标反映的是真实算法行为，而不是一个玩具实现。
 * 稠密通道用「字符 bigram 余弦」作为本地代理 —— 它不依赖任何网络，可离线跑 CI；
 * 真实运行时换成 provider 的 embedding（维度与语义更强，但接口形状一致）。
 */
import { extractAskTerms } from '../ask.ts'
import { bigramTokens } from '../search.ts'
import type { ChannelName, ChannelResult, IntentKind, RetrievedDoc } from './types.ts'
import { classifyIntent } from './intent.ts'
import { buildQueryPlan } from './rewrite.ts'
import { defaultPolicyFor, type RetrievalConfig } from './config.ts'
import { fuseResults, dedupeFused } from './fusion.ts'
import { rerankDocs } from './rank.ts'
import { evaluate, type EvalCase, type EvalReport } from './eval.ts'

/** 评估用的固定「现在」（2026-09-10 是周四，便于「上周三」解析成 2026-09-02）。 */
export const SYNTHETIC_NOW = new Date('2026-09-10T12:00:00')

/** 本地时区 epoch 秒。 */
function ts(y: number, mo: number, d: number, h = 10, mi = 0): number {
  return Math.floor(new Date(y, mo - 1, d, h, mi, 0).getTime() / 1000)
}

/** 构造一条语料文档。 */
function doc(
  username: string, name: string, localId: number, createTime: number, text: string, sender?: string,
): RetrievedDoc {
  return {
    docKey: username + ':' + localId,
    username, name, local_id: localId, create_time: createTime,
    text, snippet: text.slice(0, 120),
    ...(sender ? { sender } : {}),
  }
}

const CHEN = { u: 'wxid_chen', n: '房东老陈' }
const LISI = { u: 'wxid_lisi', n: '李四' }
const WANG = { u: 'wxid_wangwu', n: '王五' }
const GRP = { u: '12345678@chatroom', n: '项目组' }

/** 合成语料（28 条）。 */
export const SYNTHETIC_CORPUS: RetrievedDoc[] = [
  // —— 房东老陈：房租 + 一笔真正的转账通知（2026-09-05，最近一次转账的答案）——
  doc(CHEN.u, CHEN.n, 1, ts(2026, 8, 1, 9, 0), '这个月房租记得转我，还是老价钱'),
  doc(CHEN.u, CHEN.n, 2, ts(2026, 8, 5, 18, 30), '微信转账 收到转账3500.00元 请及时查收'),
  doc(CHEN.u, CHEN.n, 3, ts(2026, 9, 5, 20, 12), '微信转账 收到转账3500.00元 请及时查收'),
  doc(CHEN.u, CHEN.n, 4, ts(2026, 9, 6, 8, 0), '收到，谢谢'),

  // —— 李四：号码 + 上周三（2026-09-02）的对话 ——
  doc(LISI.u, LISI.n, 10, ts(2026, 7, 20, 11, 0), '我换号了，新号码是13812345678'),
  doc(LISI.u, LISI.n, 11, ts(2026, 9, 2, 14, 5), '上周三那个合同的事，你看下差额那部分'),
  doc(LISI.u, LISI.n, 12, ts(2026, 9, 2, 14, 7), '好的，差额是2000，我明天转给你'),
  doc(LISI.u, LISI.n, 13, ts(2026, 9, 2, 14, 8), '行，账号还是原来那个'),
  doc(LISI.u, LISI.n, 14, ts(2026, 9, 4, 9, 30), '收到转账2000.00元'),

  // —— 项目组：讨论转账脚本（会被「最近一次转账」问题的内容词误召回的干扰项。
  //    刻意排在 8 月 —— 早于房东那笔真正的转账通知，用于验证「按时间取最新」是否生效）——
  doc(GRP.u, GRP.n, 20, ts(2026, 8, 8, 10, 0), '那个自动转账的脚本我写好了，可以批量转账', '王五'),
  doc(GRP.u, GRP.n, 21, ts(2026, 8, 8, 10, 2), '转账接口要加个限流，不然会被风控', '李四'),
  doc(GRP.u, GRP.n, 22, ts(2026, 8, 8, 10, 5), '好，我下午发给你测试', '王五'),
  doc(GRP.u, GRP.n, 23, ts(2026, 9, 3, 15, 0), '周会纪要：本周重点是合同模板改版', '李四'),
  doc(GRP.u, GRP.n, 24, ts(2026, 9, 3, 15, 3), '合同模板我来改，差额字段要单独列出', '王五'),

  // —— 王五：工资 + 借钱 ——
  doc(WANG.u, WANG.n, 30, ts(2026, 8, 28, 17, 0), '这个月工资发了，一共12000'),
  doc(WANG.u, WANG.n, 31, ts(2026, 9, 1, 12, 0), '能不能先借我5000，下个月还你'),
  doc(WANG.u, WANG.n, 32, ts(2026, 9, 7, 13, 0), '微信转账 收到转账5000.00元 你查收一下'),

  // —— 更多噪声（用于稀释，让指标有区分度）——
  doc(CHEN.u, CHEN.n, 5, ts(2026, 7, 10, 8, 0), '水电费这个月有点高，一共380'),
  doc(CHEN.u, CHEN.n, 6, ts(2026, 7, 15, 19, 0), '门锁坏了我找师傅来修'),
  doc(LISI.u, LISI.n, 15, ts(2026, 6, 12, 10, 0), '周末一起去打球吗'),
  doc(LISI.u, LISI.n, 16, ts(2026, 6, 20, 10, 0), '好的，那就周六下午三点'),
  doc(GRP.u, GRP.n, 25, ts(2026, 8, 15, 11, 0), '需求文档我上传到共享盘了', '王五'),
  doc(GRP.u, GRP.n, 26, ts(2026, 8, 16, 11, 0), '收到，我今晚看', '李四'),
  doc(WANG.u, WANG.n, 33, ts(2026, 6, 1, 9, 0), '生日快乐！'),
  doc(WANG.u, WANG.n, 34, ts(2026, 6, 2, 9, 0), '谢谢'),

  // —— 「合同差额2000的客户是谁」的组合难例：数字与实体分散 ——
  doc(LISI.u, LISI.n, 17, ts(2026, 5, 10, 10, 0), '上次合作那个客户，合同差额算错了，差了2000'),
  doc(LISI.u, LISI.n, 18, ts(2026, 5, 10, 10, 2), '客户是杭州那家做物流的，姓周'),
]

/**
 * 人工标注的评测用例（相关 docKey 即 ground truth）。
 *
 * `subQueries` 模拟规划器（LLM）给出的关键词 —— 真实链路里这一步一定发生，
 * 若评测里省掉，就会把「bigram 切分把『一共转了多少笔账』切成 共转/笔账 而没有
 * 转账」这种分词缺陷误记成检索算法缺陷。给出 subQueries 才是在评测**检索阶段**。
 */
export const SYNTHETIC_CASES: EvalCase[] = [
  {
    id: 'recency-transfer',
    question: '最近一次转账给我的是谁',
    subQueries: ['转账', '收到转账'],
    // 语料里「收到转账」类消息的最新一条是 9/7 王五还的那笔 5000（其次 9/5 房东房租）；
    // 群里 8 月那几条「转账脚本」讨论是干扰项，用于验证「按时间取最新」不会被它们带偏。
    relevant: ['wxid_wangwu:32'],
    intent: 'recency_lookup',
  },
  {
    id: 'entity-phone',
    question: '李四的电话号码是多少',
    subQueries: ['李四', '电话号码'],
    relevant: ['wxid_lisi:10'],
    intent: 'entity_lookup',
  },
  {
    id: 'time-lastwed',
    question: '上周三我和李四聊了什么',
    subQueries: ['李四'],
    relevant: ['wxid_lisi:11', 'wxid_lisi:12', 'wxid_lisi:13'],
    intent: 'time_range',
  },
  {
    id: 'aggregate-transfer',
    question: '我一共转了多少笔账',
    subQueries: ['转账', '收到转账'],
    relevant: ['wxid_chen:2', 'wxid_chen:3', 'wxid_lisi:14', 'wxid_wangwu:32'],
    intent: 'aggregation',
  },
  {
    id: 'combo-contract',
    question: '合同差额2000的那个客户是谁',
    subQueries: ['合同', '差额', '客户'],
    relevant: ['wxid_lisi:17', 'wxid_lisi:18'],
    intent: 'entity_lookup',
  },
  {
    id: 'entity-loan',
    question: '王五借钱的事怎么样了',
    subQueries: ['借钱', '还钱', '王五'],
    relevant: ['wxid_wangwu:31', 'wxid_wangwu:32'],
    intent: 'open_qa',
  },
  {
    id: 'time-wages',
    question: '上个月工资发了多少',
    subQueries: ['工资'],
    relevant: ['wxid_wangwu:30'],
    intent: 'time_range',
  },
]

/** 字符 bigram 向量（稠密通道的本地代理）。 */
function ngramVec(text: string): Map<string, number> {
  const t = String(text || '').replace(/\s+/g, '')
  const v = new Map<string, number>()
  if (t.length <= 2) { if (t) v.set(t, 1); return v }
  for (let i = 0; i + 2 <= t.length; i += 1) {
    const g = t.slice(i, i + 2)
    v.set(g, (v.get(g) ?? 0) + 1)
  }
  return v
}

/** 余弦相似度（Map 稀疏向量）。 */
function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0
  const [small, big] = a.size <= b.size ? [a, b] : [b, a]
  for (const [k, x] of small) { const y = big.get(k); if (y) dot += x * y }
  let na = 0; for (const x of a.values()) na += x * x
  let nb = 0; for (const x of b.values()) nb += x * x
  if (na <= 0 || nb <= 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** 词项 → FTS5 侧的 bigram token 数（1 = 单词项；>1 = 连续短语）。与 `search.ts#ftsPhrase` 同源语义。 */
function phraseTokens(term: string): string[] {
  return bigramTokens(term).split(' ').filter(Boolean)
}

/**
 * 词项在文档里的词频 —— **必须与真实 FTS 的短语语义一致**。
 *
 * 真实检索里 `ftsPhrase` 把多字中文词编成「连续 bigram 短语」（`"收到 到转 转账"`），
 * 命中要求这些 bigram **连续**出现，等价于整词连续出现；单 token 词项才是普通匹配。
 * 合成评测若只按 bigram 逐个比对，就会把「短语项永远命中不了」误判成算法缺陷
 * （反之也会高估单词项的作用）。这里按整词出现次数计 tf。
 */
function termFreq(term: string, docText: string, toks: string[]): number {
  if (phraseTokens(term).length <= 1) {
    let n = 0
    for (const t of toks) if (t === term) n += 1
    return n
  }
  const body = docText.replace(/\s+/g, '')
  const needle = term.replace(/\s+/g, '')
  if (!needle) return 0
  let n = 0
  let at = 0
  for (;;) {
    const i = body.indexOf(needle, at)
    if (i < 0) break
    n += 1
    at = i + 1
  }
  return n
}

/** 稀疏通道：BM25（k1=1.2, b=0.75）。 */
function sparseChannel(terms: string[], corpus: RetrievedDoc[], topK: number): ChannelResult {
  const docs = corpus.map(d => ({ d, toks: extractAskTerms(d.text) }))
  const N = docs.length
  const avgdl = docs.reduce((a, x) => a + x.toks.length, 0) / Math.max(1, N)
  const k1 = 1.2
  const b = 0.75
  // 词项的 df：多字词项按「整词出现」判定，与真实 FTS 的短语匹配对齐。
  const tfCache = new Map<string, Map<string, number>>()
  for (const t of terms) {
    const m = new Map<string, number>()
    for (let i = 0; i < docs.length; i += 1) {
      const f = termFreq(t, docs[i].d.text, docs[i].toks)
      if (f > 0) m.set(docs[i].d.docKey, f)
    }
    tfCache.set(t, m)
  }
  const df = new Map<string, number>()
  for (const t of terms) df.set(t, tfCache.get(t)?.size ?? 0)
  const scored = docs.map(({ d, toks }) => {
    let s = 0
    for (const t of terms) {
      const f = tfCache.get(t)?.get(d.docKey) ?? 0
      if (f === 0) continue
      const n = df.get(t) ?? 0
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5))
      s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * (toks.length / Math.max(1, avgdl))))
    }
    return { d, s }
  }).filter(x => x.s > 0).sort((a, b2) => b2.s - a.s).slice(0, topK)
  return {
    channel: 'sparse', active: true,
    hits: scored.map((x, i) => ({ doc: x.d, score: x.s, rank: i + 1 })),
  }
}

/** 稠密通道（字符 bigram 余弦代理）。 */
function denseChannel(query: string, corpus: RetrievedDoc[], topK: number, minSim: number): ChannelResult {
  const qv = ngramVec(query)
  const scored = corpus.map(d => ({ d, s: cosine(qv, ngramVec(d.text)) }))
    .filter(x => x.s >= minSim)
    .sort((a, b) => b.s - a.s).slice(0, topK)
  return {
    channel: 'dense', active: true,
    hits: scored.map((x, i) => ({ doc: x.d, score: x.s, rank: i + 1 })),
  }
}

/** 结构化通道：实体/时间过滤（对合成语料按会话名与时间范围选）。 */
function structuredChannel(entity: string, from: string, to: string, corpus: RetrievedDoc[], topK: number): ChannelResult {
  const fromMs = from ? new Date(from + 'T00:00:00').getTime() : NaN
  const toMs = to ? new Date(to + 'T23:59:59').getTime() : NaN
  const hits = corpus.filter((d) => {
    const tsMs = d.create_time * 1000
    if (Number.isFinite(fromMs) && tsMs < fromMs) return false
    if (Number.isFinite(toMs) && tsMs > toMs) return false
    if (entity) return d.name.includes(entity) || (d.sender ?? '').includes(entity) || d.text.includes(entity)
    return Number.isFinite(fromMs) || Number.isFinite(toMs)
  }).slice(0, topK)
  return {
    channel: 'structured', active: hits.length > 0,
    hits: hits.map((d, i) => ({ doc: d, score: 1 / (i + 1), rank: i + 1 })),
    ...(hits.length === 0 ? { note: '无结构化命中' } : {}),
  }
}

/** 合成检索配置（默认全开；denseEnabled=false 用于消融对比）。 */
export interface SyntheticEvalOptions {
  denseEnabled?: boolean
  sparseEnabled?: boolean
  structuredEnabled?: boolean
  k?: number
  verbose?: boolean
}

/**
 * 在合成语料上跑一遍完整「路由 → 改写 → 三通道召回 → 融合 → 重排」，返回有序 docKey。
 * @param c - 评测用例。
 * @param opts - 通道开关与 k。
 * @returns 有序命中 docKey。
 */
export function syntheticRetrieve(c: EvalCase, opts: SyntheticEvalOptions = {}): string[] {
  const knownEntities = [CHEN.n, LISI.n, WANG.n, GRP.n]
  const decision = classifyIntent(c.question, knownEntities)
  const policy = defaultPolicyFor(decision.intent)
  const plan = buildQueryPlan({
    question: c.question,
    subQueries: c.subQueries,
    entity: c.subQueries?.find(s => knownEntities.includes(s)),
    scopeFrom: c.scope?.from,
    scopeTo: c.scope?.to,
    knownEntities,
    now: SYNTHETIC_NOW,
  })
  const channels: ChannelResult[] = []
  if (opts.sparseEnabled !== false) channels.push(sparseChannel(plan.terms, SYNTHETIC_CORPUS, policy.channelTopK.sparse))
  if (opts.denseEnabled !== false) channels.push(denseChannel(plan.normalized, SYNTHETIC_CORPUS, policy.channelTopK.dense, 0.15))
  if (opts.structuredEnabled !== false) channels.push(structuredChannel(plan.entity, plan.from, plan.to, SYNTHETIC_CORPUS, policy.channelTopK.structured))

  const fused = dedupeFused(fuseResults(channels, 60, 120), 0.85)
  const ranked = rerankDocs({
    fused,
    terms: plan.terms,
    termWeights: new Map(plan.terms.map(t => [t, 1])),
    entity: plan.entity,
    softFromMs: plan.from ? new Date(plan.from + 'T00:00:00').getTime() : NaN,
    softToMs: plan.to ? new Date(plan.to + 'T23:59:59').getTime() : NaN,
    recency: plan.recency,
    recencyFirst: policy.recencyFirst,
    weights: { ...defaultWeights(), ...policy.weights },
    now: Math.floor(SYNTHETIC_NOW.getTime() / 1000),
  })
  return ranked.map(r => r.doc.docKey)
}

/** 与 config 默认一致的权重（避免引入 config 全量依赖）。 */
function defaultWeights() {
  return { sparse: 1.0, dense: 0.9, kb: 1.0, entity: 1.2, coverage: 0.8, timePref: 0.6, recency: 0.5, agreement: 0.4 }
}

/** 跑合成评测，返回报告。 */
export function runSyntheticEval(opts: SyntheticEvalOptions = {}): EvalReport {
  return evaluate(SYNTHETIC_CASES, c => syntheticRetrieve(c, opts), { k: opts.k ?? 10 })
}

/** 意图分类准确率（对照用例里标注的 intent）。 */
export function syntheticIntentAccuracy(): { correct: number; total: number; accuracy: number } {
  const knownEntities = [CHEN.n, LISI.n, WANG.n, GRP.n]
  let correct = 0
  let total = 0
  for (const c of SYNTHETIC_CASES) {
    if (!c.intent) continue
    total += 1
    if (classifyIntent(c.question, knownEntities).intent === c.intent) correct += 1
  }
  return { correct, total, accuracy: total ? correct / total : 0 }
}

/** 供测试引用的语料实体。 */
export const __corpusMeta = { CHEN, LISI, WANG, GRP }
