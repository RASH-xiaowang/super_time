/**
 * 重排序（交叉特征重排）（目标 1 的 rerank 阶段）。
 *
 * 融合阶段只用「名次」，会丢掉各通道的相对相关度强弱；这里把通道分、词覆盖率、
 * 实体命中、时间偏好、时间新鲜度、多通道一致性 6 个特征**线性组合**成一个可解释的
 * 最终分。权重来自 config（意图策略可覆盖），因此「调参」就是改权重，不需要改代码。
 *
 * 保留了一条**硬优先级**路径：`recencyFirst`（问「最近一次 X」）时，先按时间取最新，
 * 再按分数 —— 这是旧实现踩坑最多的点（BM25 会把「讨论转账脚本」的群消息排到真正的
 * 转账通知前面），必须用时间硬压。
 */
import type { FusedDoc, RankedDoc, RerankWeights } from './types.ts'

/** 重排输入。 */
export interface RerankInput {
  fused: FusedDoc[]
  /** 检索词项（用于覆盖率特征）。 */
  terms: string[]
  /** 词 → 权重（稀有词更高）。 */
  termWeights: Map<string, number>
  /** 意图实体（人名/群名）。 */
  entity: string
  /** 软时间范围（毫秒；NaN 表示无）。 */
  softFromMs: number
  softToMs: number
  /** 是否「最近/最新」类问题。 */
  recency: boolean
  /** 是否强制时间优先排序。 */
  recencyFirst: boolean
  weights: RerankWeights
  /** 当前时间（秒），用于新鲜度衰减。 */
  now: number
}

/** 判定时间是否落在软范围内。 */
function inSoft(ts: number, fromMs: number, toMs: number): boolean {
  if (!Number.isFinite(fromMs) && !Number.isFinite(toMs)) return false
  const ms = ts * 1000
  if (ms <= 0) return false
  if (Number.isFinite(fromMs) && ms < fromMs) return false
  if (Number.isFinite(toMs) && ms > toMs) return false
  return true
}

/**
 * 交叉特征重排。
 * @param input - 见 RerankInput。
 * @returns 按最终分降序的候选（每项带完整特征，便于归因与反馈调参）。
 */
export function rerankDocs(input: RerankInput): RankedDoc[] {
  const { fused, terms, termWeights, entity, weights } = input
  const totalTermWeight = [...termWeights.values()].reduce((a, b) => a + b, 0) || 1
  const ranked: RankedDoc[] = fused.map((f) => {
    const d = f.doc
    const body = d.text || d.snippet || ''
    const matched = terms.filter(t => t && body.includes(t))

    const sparse = f.scores.sparse ?? 0
    const dense = f.scores.dense ?? 0
    const entityHit = entity && (d.name.includes(entity) || (d.sender ?? '').includes(entity) || body.includes(entity)) ? 1 : 0

    let cov = 0
    for (const t of matched) cov += termWeights.get(t) ?? 0
    const coverage = Math.min(1, cov / totalTermWeight)

    const timePref = inSoft(d.create_time, input.softFromMs, input.softToMs) ? 1 : 0

    // 新鲜度：以 30 天为半衰期做指数衰减；只有 recency 类问题才给权重。
    const ageDays = Math.max(0, (input.now - d.create_time) / 86400)
    const recency = input.recency ? Math.exp(-ageDays / 30) : 0

    const channelCount = Object.keys(f.ranks).length
    const agreement = Math.min(1, Math.max(0, (channelCount - 1) / 2))

    const features: Record<keyof RerankWeights, number> = {
      sparse, dense, entity: entityHit, coverage, timePref, recency, agreement,
    }
    let score = 0
    for (const k of Object.keys(weights) as Array<keyof RerankWeights>) {
      score += (weights[k] ?? 0) * features[k]
    }
    return { doc: d, score, matched, timePref, features, ranks: f.ranks }
  })

  ranked.sort((a, b) => (b.score - a.score) || (b.doc.create_time - a.doc.create_time))

  // recencyFirst：命中足够多内容词的候选按时间硬排序，其余按分数。
  // 阈值随词项数缩放：词项少（多为高质量规划器词）时命中 1 个即算强证据；
  // 词项多（含 bigram 切分与同义扩展的噪声）时要求命中 2 个，
  // 避免噪声词一命中就把时间序打乱。
  if (input.recencyFirst && ranked.length > 1) {
    const threshold = terms.length <= 4 ? 1 : 2
    const strong = ranked.filter(r => r.matched.length >= threshold)
    const weak = ranked.filter(r => r.matched.length < threshold)
    strong.sort((a, b) => (b.timePref - a.timePref) || (b.doc.create_time - a.doc.create_time))
    return [...strong, ...weak]
  }
  return ranked
}
