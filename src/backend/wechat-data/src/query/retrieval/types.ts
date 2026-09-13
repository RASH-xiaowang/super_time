/**
 * RAG 检索层共享类型。
 *
 * 这一层把「召回 → 融合 → 重排 → 压缩」拆成互相独立的阶段，每个阶段只通过
 * 这里的结构化类型通信。这样评估（eval.ts）可以在不改动流水线的前提下，
 * 单独替换某一阶段做消融实验（例如只开稀疏通道、或关掉重排）。
 */

/**
 * 查询意图。不同意图对召回通道、时间权重、证据粒度的偏好完全不同：
 *   · recency_lookup（「最近一次转账给谁」）—— 命中内容词后必须按时间取最新，
 *     而不是按 BM25 取最"相关"（实测 BM25 会把讨论转账脚本的群消息排前面）。
 *   · aggregation（「一共转了多少」）—— 需要尽可能多的证据 покрытие，
 *     宁可多召回、由压缩阶段截断，也不能因为 topK 小而漏掉关键几条。
 *   · entity_lookup（「李四的电话」）—— 人物命中应压过一切内容得分。
 */
export type IntentKind =
  | 'recency_lookup'
  | 'entity_lookup'
  | 'time_range'
  | 'aggregation'
  | 'comparison'
  | 'open_qa'

/** 召回通道名。sparse=BM25 词法；dense=向量语义；structured=结构化过滤/实体。 */
export type ChannelName = 'sparse' | 'dense' | 'structured'

/**
 * 意图对应的检索策略（由 intent.ts 产出，pipeline 消费）。
 *
 * 这是「分类路由」的载体：同一个问题被判定为不同意图时，走完全不同的通道组合、
 * 权重与阈值，而不是所有问题共用一套参数。
 */
export interface RetrievalPolicy {
  intent: IntentKind
  /** 启用的召回通道。 */
  channels: ChannelName[]
  /** 每通道召回条数上限。 */
  channelTopK: Record<ChannelName, number>
  /** 重排特征权重（覆盖 config 的默认权重）。 */
  weights: Partial<RerankWeights>
  /** 是否强制结果按时间新→旧（recency 类问题）。 */
  recencyFirst: boolean
  /** 是否为「要覆盖度」的问题（聚合/对比）放宽 topK 与压缩预算。 */
  wideRecall: boolean
}

/** 重排特征权重（线性组合；全部可配置，便于按场景调参）。 */
export interface RerankWeights {
  /** 稀疏 BM25 归一化分。 */
  sparse: number
  /** 稠密余弦归一化分。 */
  dense: number
  /** 命中意图实体（人名/群名）的加成。 */
  entity: number
  /** 命中查询词项的覆盖率（稀有词权重更高）。 */
  coverage: number
  /** 落在推断时间范围内的加成（软偏好，非硬过滤）。 */
  timePref: number
  /** 时间新鲜度（仅 recency 类问题显著）。 */
  recency: number
  /** 多通道一致性（同一文档被更多通道召回 → 更可信）。 */
  agreement: number
}

/** 改写后的查询计划。 */
export interface QueryPlan {
  /** 原始问题。 */
  original: string
  /** 归一化后的问题（全角转半角、压空白）。 */
  normalized: string
  /** 用于检索的词项（已去停用词/功能词）。 */
  terms: string[]
  /** 多路改写后的查询变体（原句 + 规划器关键词 + 同义扩展）。 */
  variants: string[]
  /** 规划器点名的实体（人名/群名）。 */
  entity: string
  /** 识别出的时间范围（YYYY-MM-DD）。 */
  from: string
  to: string
  /** 该范围是硬过滤（用户显式选择）还是软偏好（从问题推断）。 */
  timeHard: boolean
  /** 是否含「最近/最新/最后一次」这类排序意图。 */
  recency: boolean
}

/**
 * 统一文档：无论来自哪个通道，都归一化成这个形状后再融合。
 *
 * docKey 是全局去重键（`username:local_id`）——融合阶段按它把同一消息
 * 在不同通道里的命中合并成一条，避免重复计入与重复送进上下文。
 */
export interface RetrievedDoc {
  docKey: string
  username: string
  name: string
  local_id: number
  create_time: number
  text: string
  snippet: string
  sender?: string
}

/** 单通道召回结果：文档 + 该通道内的原始得分与名次。 */
export interface ChannelHit {
  doc: RetrievedDoc
  /** 通道内得分（量纲各通道不同，融合时只用名次，不用原始分）。 */
  score: number
  /** 通道内名次（1 基，越小越靠前）。 */
  rank: number
}

/** 一路召回结果。 */
export interface ChannelResult {
  channel: ChannelName
  hits: ChannelHit[]
  /** 通道是否真正参与（false = 未启用/不可用，如未建向量库）。 */
  active: boolean
  /** 不可用原因（写进操作日志，便于解释「为什么没走稠密」）。 */
  note?: string
}

/** 融合后的候选：保留各通道名次与归一化分，供重排阶段做一致性/相关度特征。 */
export interface FusedDoc {
  doc: RetrievedDoc
  /** 各通道名次（1 基；未命中该通道则缺省）。 */
  ranks: Partial<Record<ChannelName, number>>
  /** 各通道归一化到 0~1 的分数（未命中缺省）。 */
  scores: Partial<Record<ChannelName, number>>
  /** RRF 融合分。 */
  rrf: number
}

/** 重排后的一条候选：带特征向量与最终分。 */
export interface RankedDoc {
  doc: RetrievedDoc
  score: number
  /** 命中的查询词项。 */
  matched: string[]
  /** 是否落在推断时间范围内（1/0）。 */
  timePref: number
  /** 各特征取值（调试 + 反馈调参用）。 */
  features: Record<keyof RerankWeights, number>
  ranks: Partial<Record<ChannelName, number>>
}

/** 压缩后的上下文单元（与既有 AskChunk 对齐，供 formatAskContext 复用）。 */
export interface CompressedChunk {
  username: string
  name: string
  anchor: {
    name: string
    time: string
    snippet: string
    username: string
    local_id: number
    sender?: string
  }
  lines: Array<{ time: string; sender: string; text: string }>
  score: number
  pref: number
  createTime: number
}

/** 检索统计（写进操作日志 + 返回给前端）。 */
export interface RetrievalStats {
  intent: IntentKind
  channels: Array<{ channel: ChannelName; count: number; active: boolean; note?: string }>
  recalled: number
  fused: number
  ranked: number
  kept: number
  compressed: number
  windowMessages: number
  terms: number
  entity: string
  timeHint: string
  hintHits: number
  recency: boolean
  /** 稠密通道是否启用（用于解释降级）。 */
  denseActive: boolean
  /** 端到端检索耗时（毫秒）。 */
  elapsedMs: number
}

/** 一条用户反馈。 */
export interface FeedbackRecord {
  /** 反馈唯一 id（时间戳 + 摘要）。 */
  id: string
  question: string
  answer: string
  /** 'up' | 'down'。 */
  rating: 'up' | 'down'
  /** 用户标注为「没用/有用」的引用序号（对应 citations 下标 +1）。 */
  citedUseful: number[]
  citedUseless: number[]
  /** 被评分时实际用的意图与检索参数快照（便于归因）。 */
  intent: IntentKind
  createdAt: number
  /** 反馈涉及的实参（会话名/词项），用于把权重调整落到具体特征。 */
  features: Array<keyof RerankWeights>
}
