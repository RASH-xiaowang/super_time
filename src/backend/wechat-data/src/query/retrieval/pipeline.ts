/**
 * 多阶段检索流水线（目标 1 的编排层）。
 *
 * 顺序：意图路由 → 查询改写 → 三通道并行召回 → RRF 融合去重 → 交叉特征重排 → 上下文压缩。
 *
 * 为什么把编排单独成一层：这样每一阶段都能被单独替换/关闭（消融实验），
 * 也让「配置调参」只需改 config，而不是在检索代码里到处找魔法数字。
 */
import { listMessagesInRange, searchIndexBatch, searchIndexPath } from '../search.ts'
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
import { kbChannel } from './kb-channel.ts'

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
  /**
   * 与 `embedFn` **同源**的模型名（由 gateway 的 `embedModelName()` 给出）。
   * 知识库稠密召回要用它判「库里那批向量是不是同一个模型算的」——
   * 维度相同、语义空间不同的两个模型是维度检查唯一抓不到的错配。
   */
  embedModel?: string
  /**
   * 模型精排函数（由 gateway 注入，已含隐私闸门）。
   *
   * 只给「查询 + 候选文本」，回「与输入同长的分数数组」。
   * 未注入 ⇒ 整段精排跳过，`rerankInfo.used` 为假并说明用的是本地加权。
   */
  rerank?: (query: string, documents: string[]) => Promise<number[]>
  /** 精排用的模型名（只用于回带给界面显示，不参与任何计算）。 */
  rerankModel?: string
  /** 已知实体名（用于意图识别与实体召回）。 */
  knownEntities?: string[]
  /** 可选：LLM 意图判定回调（config.intent.llmAssist 时调用）。 */
  llmIntent?: () => Promise<string>
  /** 预置的打分权重（来自反馈调参）；缺省用 config 默认。 */
  weightsOverride?: RetrievalConfig['rerank']['weights']
  /**
   * 当前知识库 id（知识库通道的作用域）。
   *
   * **必填语义在调用方**：不传 = 本次提问不检索知识库（通道 `active:false` + note），
   * 而不是「搜所有库」。与 `kbId` 在其余知识库接口上的纪律一致 —— 没有「所有库」这种模式。
   */
  kbId?: number
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
  /**
   * 这次到底有没有用模型精排。
   *
   * 必须回带给界面：`used:false` 与 `used:true` 是两种不同的可信度 ——
   * 前者说明「顺序是本地启发式给的」，后者说明「有一个模型读过这些候选」。
   * 不显示的话，用户会把「没配模型」读成「模型认为这些最相关」。
   */
  rerankInfo:
    | { used: true; model: string; candidates: number; kept: number }
    | { used: false; note: string }
}

/**
 * 一次精排最多带多少条候选。
 *
 * 不精排全量：出网量与延迟都线性于条数，而尾部那些本来也进不了上下文预算。
 * 60 是「融合后头部」的经验值 —— 它大致等于各通道 topK 的并集规模。
 */
const RERANK_CANDIDATE_LIMIT = 60

/** 错误对象 → 一句话（与仓库其它层同口径：拿不到 message 就 String(e)）。 */
function errorText(e: unknown): string {
  const msg = (e as { message?: unknown } | null | undefined)?.message
  return typeof msg === 'string' && msg !== '' ? msg : String(e)
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
  scopeUsername?: string,
): ChannelResult {
  const hasEntity = Boolean(plan.entity)
  const hasTime = Boolean(plan.from || plan.to)
  if (!hasEntity && !hasTime) return { channel: 'structured', hits: [], active: false, note: '无实体/时间线索' }
  // 实体 → 命中「与某人的会话」；无实体但有时间 → 用少量内容词在该时间窗内召回。
  const terms = hasEntity ? [] : plan.terms.slice(0, 4)
  // **会话范围必须一起下发**：`who:` 是跨会话的全库过滤，不带 username 时
  // 「在当前会话里问问某人」会把这个人在**别的会话**里的消息也召回进来 ——
  // 会话级问答（会话内 AI 面板 / 用户选定的会话筛选）看到的就是别的聊天记录，
  // 属于「证据不在问题范围内」的严重错答（本轮修）。
  const res = searchIndexBatch(decryptedDir, terms, topK, {
    ...(scopeUsername ? { username: scopeUsername } : {}),
    ...(hasEntity ? { person: plan.entity } : {}),
  })
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

/** 某天的本地零点（毫秒）；非法日期返回 NaN。 */
function dayStartMs(day: string): number {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? new Date(day + 'T00:00:00').getTime() : NaN
}

/** 某天的本地 23:59:59.999（毫秒）；非法日期返回 NaN。 */
function dayEndMs(day: string): number {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? new Date(day + 'T23:59:59').getTime() + 999 : NaN
}

/** 纯时间浏览的摊开粒度：30 分钟。刻意等于 compressContext 的窗口跨度（±15 分钟），
 * 这样相邻锚点恰好落在不同窗口里，不会被「同会话 + 时间相邻」的规则吞掉。 */
const TIME_BUCKET_MS = 30 * 60 * 1000

/**
 * 把「某日期段的消息」压成**跨时段摊开**的代表序列。
 *
 * 为什么需要：`listMessagesInRange` 返回的是时间新→旧的 LIMIT 截断。当天若有一波
 * 密集对话（实测 09-17 该会话 135 条里，最后 4 分钟就占了 60+ 条），只取最新若干条
 * 会整段落在同一时刻，「今天聊了啥」就退化成了「今天最后几分钟聊了啥」。
 *
 * 做法：先按 30 分钟分桶（每桶只留**最新一条**，因为输入是新→旧，首见即最新），
 * 再按「最远点」顺序遍历 —— 从最活跃的桶出发，每次挑距离已选集合最远的桶。
 * 于是任意前缀都能摊开到整个日期段（前 3 个 ≈ 起始/中段/末尾）。
 * @param hits - 时间新→旧的消息。
 * @returns 摊开后的代表消息（数量 = 非空桶数）。
 */
function spreadByBucket(hits: SearchHit[]): SearchHit[] {
  const buckets = new Map<number, { hit: SearchHit; count: number }>()
  for (const h of hits) {
    const slot = Math.floor((h.create_time * 1000) / TIME_BUCKET_MS)
    const b = buckets.get(slot)
    if (b) b.count += 1
    else buckets.set(slot, { hit: h, count: 1 })
  }
  const slots = [...buckets.keys()]
  if (slots.length <= 1) return [...buckets.values()].map(b => b.hit)
  // 种子：最活跃的桶（并列取时间最新的那个）—— 纯时间浏览的「重点」就是最热闹的时段。
  let seed = slots[0]
  for (const s of slots) {
    const c = buckets.get(s)!.count
    const cs = buckets.get(seed)!.count
    if (c > cs || (c === cs && s > seed)) seed = s
  }
  const picked: number[] = [seed]
  const rest = new Set(slots.filter(s => s !== seed))
  while (rest.size > 0) {
    let best = -1
    let bestDist = -1
    let bestCount = -1
    for (const s of rest) {
      let d = Infinity
      for (const p of picked) d = Math.min(d, Math.abs(s - p))
      const c = buckets.get(s)!.count
      if (d > bestDist || (d === bestDist && c > bestCount)) {
        best = s; bestDist = d; bestCount = c
      }
    }
    picked.push(best)
    rest.delete(best)
  }
  return picked.map(s => buckets.get(s)!.hit)
}

/**
 * 纯时间问法的候选排序：改用时间通道的「跨时段摊开序」。
 *
 * 为什么不能沿用 rerankDocs 的排序：纯时间问法没有内容词，交叉特征对所有在窗候选
 * 取值完全相同（timePref=1、其余为 0 → 分数同为 1.6），`rank.ts` 的次级排序
 * （create_time 降序）于是成了唯一判据，取到的永远只是当天**最后几分钟**。
 * 这里按时间通道给出的摊开序重排，让 limit 个锚点覆盖整个日期段。
 * @param ranked - 重排后的候选。
 * @param channels - 各通道结果（取其中的 time 通道）。
 * @returns 按摊开序重排的候选（无时间通道时原样返回）。
 */
function spreadOrderRanked(ranked: RankedDoc[], channels: ChannelResult[]): RankedDoc[] {
  const timeCh = channels.find(c => c.channel === 'time')
  if (!timeCh || timeCh.hits.length === 0) return ranked
  const order = new Map<string, number>()
  timeCh.hits.forEach((h, i) => order.set(h.doc.docKey, i))
  return [...ranked].sort((a, b) => {
    const ia = order.get(a.doc.docKey) ?? Number.MAX_SAFE_INTEGER
    const ib = order.get(b.doc.docKey) ?? Number.MAX_SAFE_INTEGER
    return (ia - ib) || (b.doc.create_time - a.doc.create_time)
  })
}

/**
 * 时间通道：**按日期段直取消息**，不做任何内容匹配。
 *
 * 为什么必须单独有这条通道（本轮修的核心）：
 *   · 纯时间问法（「今天聊了啥」）剥掉时间表达后**没有任何内容词**。BM25 只能拿
 *     「今天」这个字面去撞，于是召回的是「正文里恰好写着『今天』」的消息 ——
 *     实测「今天聊了啥」召回 4 条，全部来自同年 2/3/7 月；而当天真实的 139 条
 *     一条都进不来。结构化通道虽然带时间过滤，但它**仍要求内容词命中**，
 *     于也是 0 命中（实测 note「结构化过滤后无命中」）。
 *     最终 `hintHits=0`，回答只能用别日期的片段作答 —— 用户看到的就是
 *     「回复内容不正确 + 消息列表冒出其他日期的消息」。
 *   · 带内容词但带日期的问法（「上周三李四说了什么」）同样受益：该日期的会话内容
 *     会被**显式**纳入候选，而不是仅靠词法撞运气。
 *
 * 单边线索（只有 from 或只有 to）按有界窗口处理，避免「今年」这种把全库拉进候选。
 * @param decryptedDir - 已解密数据根。
 * @param plan - 查询计划（用其 from/to）。
 * @param topK - 最多取多少条。
 * @param scopeUsername - 会话范围（会话内问答必须下发，否则会召回别的会话）。
 * @param now - 现在时刻（单边线索的右端点）。
 * @param stratify - 纯时间浏览模式：按 30 分钟分桶摊开（见 `spreadByBucket`），
 *   而不是只取最新的 topK 条。
 * @returns 通道结果。
 */
function timeChannel(
  decryptedDir: string,
  plan: QueryPlan,
  topK: number,
  scopeUsername: string | undefined,
  now: Date,
  stratify: boolean,
): ChannelResult {
  let loMs = plan.from ? dayStartMs(plan.from) : NaN
  let hiMs = plan.to ? dayEndMs(plan.to) : NaN
  if (!Number.isFinite(loMs) && Number.isFinite(hiMs)) loMs = hiMs - 30 * 86400_000
  if (Number.isFinite(loMs) && !Number.isFinite(hiMs)) hiMs = Math.min(loMs + 7 * 86400_000, now.getTime())
  if (!Number.isFinite(loMs) || !Number.isFinite(hiMs)) {
    return { channel: 'time', hits: [], active: false, note: '无有效时间线索' }
  }
  // 摊开模式下要先把整段取回来才能分桶，故取数上限放宽到 600（listMessagesInRange 的硬上限）；
  // 非摊开模式仍按 topK 截断（它只承担「同日内容补充」，不需要铺满）。
  const fetchCap = stratify ? 600 : topK
  const res = listMessagesInRange(
    decryptedDir,
    Math.floor(Math.min(loMs, hiMs) / 1000),
    Math.ceil(Math.max(loMs, hiMs) / 1000),
    fetchCap,
    scopeUsername,
  )
  if (!res.ready) return { channel: 'time', hits: [], active: false, note: '稀疏索引未就绪' }
  const picked = stratify ? spreadByBucket(res.hits) : res.hits
  // 摊开模式下每个桶只出一条，桶数本身已是天然上界（跨天上限 240 兜底）。
  const capped = stratify ? picked.slice(0, 240) : picked.slice(0, topK)
  // 得分用名次倒数：时间通道内部没有「相关度」可言，唯一次序是摊开序（或时间新→旧）。
  const hits: ChannelHit[] = capped.map((h, i) => ({ doc: docFromHit(h), score: 1 / (i + 1), rank: i + 1 }))
  return {
    channel: 'time',
    hits,
    active: hits.length > 0,
    ...(hits.length === 0 ? { note: '该日期范围内没有消息' } : {}),
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

  // ── 2. 多通道召回（互不抢名额；失败的通道降级不影响其余）──
  const scopeUsername = input.scope?.username
  const channels: ChannelResult[] = []
  // 纯时间问法（「今天聊了啥」）没有任何可检索的内容词：内容通道在这里只会引入噪音
  // （正文里写着「今天」的别日期消息），并触发一次全表 LIKE 兜底扫描。
  // 见 rewrite.ts 的 contentResidue / QueryPlan.timeBrowse。
  const pureTime = plan.timeBrowse
  if (!pureTime && config.channels.sparse.enabled && policy.channels.includes('sparse')) {
    channels.push(sparseChannel(input.decryptedDir, plan.terms.slice(0, 12), params.channelTopK.sparse, scopeUsername))
  }
  if (!pureTime && config.channels.dense.enabled && policy.channels.includes('dense')) {
    channels.push(await denseChannel(input.decryptedDir, plan, config, policy, input.embedFn, scopeUsername))
  }
  if (config.channels.structured.enabled && policy.channels.includes('structured')) {
    channels.push(structuredChannel(input.decryptedDir, plan, params.channelTopK.structured, input.scope?.from ?? '', input.scope?.to ?? '', scopeUsername))
  }
  // 知识库通道：与 sparse 用**同一份词项**，且必须是 `plan.terms` 而不是原问题 ——
  // `kb-search` 用 `ftsPhrase` 把每个词编成「连续 bigram 短语」，把整句问题当一个词传进去
  // 就成了要求文件里逐字出现这一整句，正常提问必然 0 命中。`plan.terms` 正是为此产出的
  // （规划器关键词原样保留 + 问题 bigram 补齐，见 rewrite.ts）。
  // 纯时间问法跳过：那类问题问的是「这一天聊了啥」，文件没有时间轴，不存在正确答案。
  if (!pureTime && config.channels.kb.enabled && policy.channels.includes('kb')) {
    // 知识库的稠密子路径复用「稠密能力」的两道门：
    //   ① `config.embedding.enabled && config.channels.dense.enabled` —— 这套能力此刻**能不能用**；
    //   ② `policy.channels.includes('dense')` —— 这次提问**要不要**在向量空间里找。
    // 缺任何一道就退回纯关键词；降级说明由 kb 通道按「稠密没跑」如实给出。
    const kbDenseEnabled = config.embedding.enabled && config.channels.dense.enabled && policy.channels.includes('dense')
    channels.push(await kbChannel(
      input.decryptedDir,
      input.kbId,
      plan.terms.slice(0, 12).join(' '),
      params.channelTopK.kb,
      {
        ...(input.embedFn ? { embedFn: input.embedFn } : {}),
        embedModel: input.embedModel ?? '',
        denseEnabled: kbDenseEnabled,
        minSimilarity: config.channels.dense.minSimilarity,
        candidatePool: config.channels.dense.candidatePool,
        fusionK: config.fusion.k,
      },
    ))
  }
  // 时间通道：只要有日期线索就开（与意图无关）。纯时间问法给它满额（它此时是**唯一**
  // 召回来源，需要覆盖一整天；compressContext 会对 ±15 分钟内的命中去重叠，自动把锚点
  // 摊开到全天）；带内容词的问法只给它小额度，起「同日内容补充」的作用，不抢词法召回名额。
  if (policy.channels.includes('time') && (plan.from || plan.to)) {
    const timeTopK = pureTime ? params.channelTopK.time : Math.min(params.channelTopK.time, 24)
    channels.push(timeChannel(input.decryptedDir, plan, timeTopK, scopeUsername, now, pureTime))
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

  /**
   * ── 4.5 模型精排（可选）──────────────────────────────────────────────
   * 插在**本地打分之后**，不是在它之前 —— 这条位置是功能成立的前提：
   * `rerankDocs` 是按自己的 8 个特征**从头排序**的，把候选池喂成别的顺序给它看，
   * 它照样会排回原来的样子（第一版就错在这里，被「精排没改变任何顺序」那条用例抓到）。
   * 所以本地打分负责**选出该精排的头部**，模型负责**决定头部的先后**。
   *
   * 三条刻意的选择：
   *   · 只精排前 `RERANK_CANDIDATE_LIMIT` 条：出网量与延迟都线性于条数，
   *     而尾部本来也进不了上下文预算；
   *   · 没注入 rerank ⇒ 整段跳过，`rerankInfo` 如实写「本地加权」。**这不是降级路径，是默认路径**
   *     —— 本仓库原本就没有模型精排，不能让它出现时悄悄改变默认行为的语义；
   *   · 失败不阻断问答（catch 掉写进 `rerankInfo`）：一次 503 不该让用户拿不到答案，
   *     他至少该看到「这次没有精排」而不是一个错误页。
   * 纯时间问法（`recencyFirst` / `pureTime`）**不参与**：那种问法要的就是时间序，
   * 让模型按「相关性」重排会把最新一条挤掉 —— 那是答非所问。
   */
  let rerankInfo: PipelineOutput['rerankInfo'] = { used: false, note: '本地线性加权（未配置重排序模型）' }
  let poolRanked = ranked
  if (typeof input.rerank === 'function' && ranked.length > 1 && !policy.recencyFirst && !pureTime) {
    const take = Math.min(ranked.length, RERANK_CANDIDATE_LIMIT)
    const head = ranked.slice(0, take)
    const tail = ranked.slice(take)
    try {
      const scores = await input.rerank(plan.normalized, head.map(r => r.doc.text))
      const order = head.map((r, i) => ({ r, s: Number(scores[i] ?? 0), i }))
      order.sort((a, b) => (b.s - a.s) || (a.i - b.i))
      poolRanked = [...order.map(o => o.r), ...tail]
      rerankInfo = { used: true, candidates: take, kept: Math.min(limit, take), model: input.rerankModel ?? '' }
    } catch (e) {
      rerankInfo = { used: false, note: '精排这次没跑成：' + errorText(e) + '（已退回本地加权）' }
    }
  } else if (typeof input.rerank === 'function') {
    rerankInfo = { used: false, note: '本次未做模型精排（候选不足两条，或问法要的是时间序）' }
  }

  // 纯时间问法没有「相关度」可言（见 spreadOrderRanked 的说明）：改用时间通道的
  // 跨时段摊开序，否则 8 个锚点会挤在当天最后几分钟。
  const finalRanked = pureTime ? spreadOrderRanked(poolRanked, channels) : poolRanked

  // ── 5. 上下文压缩 ──
  const compressOpts = policy.wideRecall
    ? { ...config.compress, maxChunks: config.compress.maxChunks + 4, maxChars: Math.round(config.compress.maxChars * 1.5) }
    : config.compress
  const { chunks, windowMessages } = compressContext(input.decryptedDir, finalRanked.slice(0, limit), compressOpts)

  const citations = chunks.map(c => c.anchor)
  const hintHits = (Number.isFinite(softFromMs) || Number.isFinite(softToMs))
    ? finalRanked.slice(0, limit).filter(r => r.timePref === 1).length
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
    rankedFeatures: finalRanked.slice(0, limit).map(r => ({ docKey: r.doc.docKey, features: r.features })),
    stats,
    rerankInfo,
  }
}

/** 稀疏索引是否已就绪（gateway 决定是否先建索引）。 */
export function sparseIndexExists(decryptedDir: string): boolean {
  return existsSync(searchIndexPath(decryptedDir))
}
