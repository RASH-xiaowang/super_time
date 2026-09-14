/**
 * 多阶段检索流水线（目标 1 的编排层）。
 *
 * 顺序：意图路由 → 查询改写 → 三通道并行召回 → RRF 融合去重 → 交叉特征重排 → 上下文压缩。
 *
 * 为什么把编排单独成一层：这样每一阶段都能被单独替换/关闭（消融实验），
 * 也让「配置调参」只需改 config，而不是在检索代码里到处找魔法数字。
 */
import { searchIndexBatch, searchIndexPath } from '../search.ts'
import { existsSync } from 'node:fs'
import type { SearchHit } from '../../types.ts'
import type {
  ChannelHit, ChannelResult, IntentKind, QueryPlan, RetrievalPolicy, RetrievalStats, RetrievedDoc, RankedDoc,
} from './types.ts'
import { classifyIntent, refineIntentWithLlm } from './intent.ts'
import { buildQueryPlan } from './rewrite.ts'
import { fuseResults, dedupeFused, channelSummary } from './fusion.ts'
import { rerankDocs } from './rank.ts'
import { compressContext } from './compress.ts'
import { defaultPolicyFor, effectiveParams, type RetrievalConfig } from './config.ts'
import { searchDense, vectorIndexStatus, type EmbedFn } from './embedding.ts'

/** 流水线输入。 */
export interface PipelineInput {
  decryptedDir: string
  question: string
  /** 规划器关键词。 */
  subQueries?: string[]
  /** 规划器点名的人。 */
  entity?: string
  /** 规划器给出的绝对日期（软偏好）。 */
  from?: string
  to?: string
  /** 用户显式检索范围（硬过滤）。 */
  scope?: { username?: string; from?: string; to?: string }
  /** 最终保留的引用条数。 */
  limit?: number
  config: RetrievalConfig
  /** 稠密通道的 embedding 函数；未注入则稠密通道不可用（自动降级并记录）。 */
  embedFn?: EmbedFn
  /** 已知实体名（用于意图识别与实体召回）。 */
  knownEntities?: string[]
  /** 可选：LLM 意图判定回调（config.intent.llmAssist 时调用）。 */
  llmIntent?: () => Promise<string>
  /** 预置的打分权重（来自反馈调参）；缺省用 config 默认。 */
  weightsOverride?: RetrievalConfig['rerank']['weights']
  /** 现在时刻（可注入，便于测试）。 */
  now?: Date
}

/** 流水线输出。 */
export interface PipelineOutput {
  citations: Array<{ name: string; time: string; snippet: string; username: string; local_id: number; sender?: string }>
  chunks: ReturnType<typeof compressContext>['chunks']
  terms: string[]
  plan: QueryPlan
  policy: RetrievalPolicy
  /** 逐篇的特征向量（反馈归因用）。 */
  rankedFeatures: Array<{ docKey: string; features: RankedDoc['features'] }>
  stats: RetrievalStats
}

/** SearchHit → 统一文档。 */
function docFromHit(h: SearchHit): RetrievedDoc {
  return {
    docKey: h.username + ':' + h.local_id,
    username: h.username,
    name: h.name,
    local_id: h.local_id,
    create_time: h.create_time,
    text: h.text,
    snippet: h.snippet,
    ...(h.sender ? { sender: h.sender } : {}),
  }
}

/** 时间范围判定（毫秒）。 */
function inRange(tsSec: number, fromMs: number, toMs: number): boolean {
  if (!Number.isFinite(fromMs) && !Number.isFinite(toMs)) return true
  const ms = tsSec * 1000
  if (ms <= 0) return false
  if (Number.isFinite(fromMs) && ms < fromMs) return false
  if (Number.isFinite(toMs) && ms > toMs) return false
  return true
}

/** 稀疏通道：内容词 BM25（不带 person，保证与结构化通道互补）。 */
function sparseChannel(decryptedDir: string, terms: string[], topK: number, username?: string): ChannelResult {
  if (terms.length === 0) return { channel: 'sparse', hits: [], active: false, note: '无检索词' }
  const res = searchIndexBatch(decryptedDir, terms, topK, username ? { username } : undefined)
  if (!res.ranked) return { channel: 'sparse', hits: [], active: false, note: '稀疏索引未就绪' }
  const hits: ChannelHit[] = res.hits.map((h, i) => ({ doc: docFromHit(h), score: h.score ?? 0, rank: i + 1 }))
  return { channel: 'sparse', hits, active: true }
}

/** 结构化通道：实体（who 列）与时间范围的精确召回。 */
function structuredChannel(
  decryptedDir: string,
  plan: QueryPlan,
  topK: number,
  scopeFrom: string,
  scopeTo: string,
): ChannelResult {
  const hasEntity = Boolean(plan.entity)
  const hasTime = Boolean(plan.from || plan.to)
  if (!hasEntity && !hasTime) return { channel: 'structured', hits: [], active: false, note: '无实体/时间线索' }
  // 实体 → 命中「与某人的会话」；无实体但有时间 → 用少量内容词在该时间窗内召回。
  const terms = hasEntity ? [] : plan.terms.slice(0, 4)
  const res = searchIndexBatch(decryptedDir, terms, topK, hasEntity ? { person: plan.entity } : undefined)
  if (!res.ranked) return { channel: 'structured', hits: [], active: false, note: '稀疏索引未就绪' }
  // 时间过滤：硬范围（用户显式）严格过滤；否则用软范围。
  const hardFrom = scopeFrom ? new Date(scopeFrom + 'T00:00:00').getTime() : NaN
  const hardTo = scopeTo ? new Date(scopeTo + 'T23:59:59').getTime() : NaN
  const useHard = Number.isFinite(hardFrom) || Number.isFinite(hardTo)
  const softFrom = (!useHard && plan.from) ? new Date(plan.from + 'T00:00:00').getTime() : NaN
  const softTo = (!useHard && plan.to) ? new Date(plan.to + 'T23:59:59').getTime() : NaN
  const fromMs = useHard ? hardFrom : softFrom
  const toMs = useHard ? hardTo : softTo
  const filtered = (Number.isFinite(fromMs) || Number.isFinite(toMs))
    ? res.hits.filter(h => inRange(h.create_time, fromMs, toMs))
    : res.hits
  const hits: ChannelHit[] = filtered.slice(0, topK).map((h, i) => ({ doc: docFromHit(h), score: h.score ?? 1 / (i + 1), rank: i + 1 }))
  return {
    channel: 'structured', hits, active: hits.length > 0,
    ...(hits.length === 0 ? { note: '结构化过滤后无命中' } : {}),
  }
}

/** 稠密通道。 */
async function denseChannel(
  decryptedDir: string,
  plan: QueryPlan,
  config: RetrievalConfig,
  policy: RetrievalPolicy,
  embedFn?: EmbedFn,
  username?: string,
): Promise<ChannelResult> {
  if (!config.embedding.enabled) return { channel: 'dense', hits: [], active: false, note: '稠密通道已关闭' }
  if (!embedFn) return { channel: 'dense', hits: [], active: false, note: '未配置 embedding' }
  const st = vectorIndexStatus(decryptedDir)
  if (!st.ready) return { channel: 'dense', hits: [], active: false, note: '向量索引未就绪' }
  try {
    const res = await searchDense(decryptedDir, plan.normalized, embedFn, {
      topK: policy.channelTopK.dense,
      minSimilarity: config.channels.dense.minSimilarity,
      candidatePool: config.channels.dense.candidatePool,
      ...(username ? { username } : {}),
    })
    const hits: ChannelHit[] = res.docs.map((d, i) => ({ doc: d, score: res.scores[i] ?? 0, rank: i + 1 }))
    return {
      channel: 'dense', hits, active: hits.length > 0,
      ...(res.note ? { note: res.note } : {}),
    }
  } catch (e) {
    return { channel: 'dense', hits: [], active: false, note: '稠密召回失败: ' + (e as Error).message }
  }
}

/**
 * 跑完整检索流水线。
 * @param input - 见 PipelineInput。
 * @returns 引用 / 窗口 / 词项 / 计划 / 策略 / 特征 / 统计。
 */
export async function runRetrievalPipeline(input: PipelineInput): Promise<PipelineOutput> {
  const started = Date.now()
  const now = input.now ?? new Date()
  const config = input.config
  const limit = Math.min(Math.max(input.limit ?? 24, 1), 60)

  // ── 0. 意图路由 ──
  let decision = classifyIntent(input.question, input.knownEntities ?? [])
  if (config.intent.llmAssist && input.llmIntent) {
    try {
      const llmIntent = await input.llmIntent()
      decision = refineIntentWithLlm(decision, llmIntent)
    } catch { /* LLM 失败保持规则判定 */ }
  }
  const policy = defaultPolicyFor(decision.intent)
  const params = effectiveParams(config, policy)
  if (input.weightsOverride) params.weights = { ...params.weights, ...input.weightsOverride }

  // ── 1. 查询改写 ──
  const plan = buildQueryPlan({
    question: input.question,
    subQueries: input.subQueries,
    entity: input.entity,
    from: input.from,
    to: input.to,
    scopeFrom: input.scope?.from,
    scopeTo: input.scope?.to,
    knownEntities: input.knownEntities,
    now,
  })

  // ── 2. 三通道召回（互不抢名额；失败的通道降级不影响其余）──
  const scopeUsername = input.scope?.username
  const channels: ChannelResult[] = []
  if (config.channels.sparse.enabled && policy.channels.includes('sparse')) {
    channels.push(sparseChannel(input.decryptedDir, plan.terms.slice(0, 12), params.channelTopK.sparse, scopeUsername))
  }
  if (config.channels.dense.enabled && policy.channels.includes('dense')) {
    channels.push(await denseChannel(input.decryptedDir, plan, config, policy, input.embedFn, scopeUsername))
  }
  if (config.channels.structured.enabled && policy.channels.includes('structured')) {
    channels.push(structuredChannel(input.decryptedDir, plan, params.channelTopK.structured, input.scope?.from ?? '', input.scope?.to ?? ''))
  }

  // 词项权重（IDF 近似）：命中越少越稀有。用稀疏通道的样本估计。
  const termWeights = new Map<string, number>()
  const sparse = channels.find(c => c.channel === 'sparse')
  const allTexts = channels.flatMap(c => c.hits.map(h => h.doc.text))
  for (const t of plan.terms) {
    let n = 0
    for (const txt of allTexts) if (txt.includes(t)) n += 1
    if (n > 0) termWeights.set(t, 1 / (1 + Math.min(n, 200)))
  }
  if (termWeights.size === 0) for (const t of plan.terms) termWeights.set(t, 1)

  const recalled = channels.reduce((a, c) => a + c.hits.length, 0)
  void sparse

  // ── 3. 融合 + 去重 ──
  const fused = dedupeFused(fuseResults(channels, config.fusion.k, config.fusion.keep), config.compress.dedupThreshold)

  // ── 4. 重排 ──
  const softFromMs = plan.from ? new Date(plan.from + 'T00:00:00').getTime() : NaN
  const softToMs = plan.to ? new Date(plan.to + 'T23:59:59').getTime() : NaN
  const ranked = rerankDocs({
    fused,
    terms: plan.terms,
    termWeights,
    entity: plan.entity,
    softFromMs,
    softToMs,
    recency: plan.recency,
    recencyFirst: policy.recencyFirst,
    weights: params.weights,
    now: Math.floor(now.getTime() / 1000),
  })

  // ── 5. 上下文压缩 ──
  const compressOpts = policy.wideRecall
    ? { ...config.compress, maxChunks: config.compress.maxChunks + 4, maxChars: Math.round(config.compress.maxChars * 1.5) }
    : config.compress
  const { chunks, windowMessages } = compressContext(input.decryptedDir, ranked.slice(0, limit), compressOpts)

  const citations = chunks.map(c => c.anchor)
  const hintHits = (Number.isFinite(softFromMs) || Number.isFinite(softToMs))
    ? ranked.slice(0, limit).filter(r => r.timePref === 1).length
    : 0

  const stats: RetrievalStats = {
    intent: decision.intent,
    channels: channelSummary(channels),
    recalled,
    fused: fused.length,
    ranked: ranked.length,
    kept: citations.length,
    compressed: chunks.length,
    windowMessages,
    terms: plan.terms.length,
    entity: plan.entity,
    timeHint: (plan.from || plan.to) ? `${plan.from || '…'} ~ ${plan.to || '…'}` : '',
    hintHits,
    recency: plan.recency,
    denseActive: channels.some(c => c.channel === 'dense' && c.active),
    elapsedMs: Date.now() - started,
  }

  return {
    citations,
    chunks,
    terms: plan.terms,
    plan,
    policy,
    rankedFeatures: ranked.slice(0, limit).map(r => ({ docKey: r.doc.docKey, features: r.features })),
    stats,
  }
}

/** 稀疏索引是否已就绪（gateway 决定是否先建索引）。 */
export function sparseIndexExists(decryptedDir: string): boolean {
  return existsSync(searchIndexPath(decryptedDir))
}
