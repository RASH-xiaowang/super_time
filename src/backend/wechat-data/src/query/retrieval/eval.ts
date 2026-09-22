/**
 * 召回评估机制（目标 2）。
 *
 * 提供标准信息检索指标，把「检索效果好不好」从主观感受变成可回归的数字：
 *   · Precision@k —— top-k 里有多少是相关的（噪声控制）；
 *   · Recall@k    —— 相关文档里有多少被 top-k 召回（漏召控制）；
 *   · MRR         —— 第一个相关结果名次的倒数（「答案排多前」）；
 *   · NDCG@k      —— 带名次折扣的排序质量（越靠前越吃分，支持分级相关度）；
 *   · AP / MAP    —— 平均精度（对全部相关项的位置敏感，适合评估整体排序）。
 *
 * 指标是**纯函数**，与数据库无关：输入「有序的命中 docKey 列表 + 相关 docKey 集合」。
 * 因此既能在合成语料上跑（eval-dataset.ts），也能在真实数据 + 人工标注上跑。
 */
import type { IntentKind } from './types.ts'

/** 一个评测用例。 */
export interface EvalCase {
  id: string
  question: string
  scope?: { username?: string; from?: string; to?: string }
  /** 规划器给出的关键词（模拟 LLM 规划阶段；缺省则只看问题本身的 bigram 切分）。 */
  subQueries?: string[]
  /** 相关文档的 docKey（`username:local_id`）或可唯一命中的文本片段。 */
  relevant: string[]
  /** 可选：分级相关度（docKey → gain）。缺省时按二值（命中=1）。 */
  graded?: Record<string, number>
  /** 期望意图（用于评估意图分类准确率）。 */
  intent?: IntentKind
}

/** 单用例评估结果。 */
export interface CaseScore {
  id: string
  retrieved: string[]
  precision: number
  recall: number
  mrr: number
  ndcg: number
  ap: number
}

/** 聚合结果。 */
export interface EvalReport {
  cases: number
  hits: number
  precision: number
  recall: number
  mrr: number
  ndcg: number
  map: number
  perCase: CaseScore[]
}

/** 命中判定：docKey 精确相等，或候选文本包含相关片段。 */
function isRelevant(key: string, relevantSet: Set<string>, textIndex?: Map<string, string>): boolean {
  if (relevantSet.has(key)) return true
  if (!textIndex) return false
  const text = textIndex.get(key) ?? ''
  for (const r of relevantSet) if (r && text.includes(r)) return true
  return false
}

/** Precision@k = |相关 ∩ top-k| / k；空结果记 0。 */
export function precisionAtK(retrieved: string[], relevant: string[], k: number): number {
  if (k <= 0) return 0
  const rel = new Set(relevant)
  const top = retrieved.slice(0, k)
  if (top.length === 0) return 0
  let hit = 0
  for (const d of top) if (rel.has(d)) hit += 1
  return hit / k
}

/** Recall@k = |相关 ∩ top-k| / |相关|。 */
export function recallAtK(retrieved: string[], relevant: string[], k: number): number {
  const rel = new Set(relevant)
  if (rel.size === 0) return 0
  const top = retrieved.slice(0, k)
  let hit = 0
  for (const d of top) if (rel.has(d)) hit += 1
  return hit / rel.size
}

/** MRR = 1 / 第一个相关结果的名次（无相关结果记 0）。 */
export function mrr(retrieved: string[], relevant: string[]): number {
  const rel = new Set(relevant)
  for (let i = 0; i < retrieved.length; i += 1) {
    const id = retrieved[i]
    if (id !== undefined && rel.has(id)) return 1 / (i + 1)
  }
  return 0
}

/**
 * NDCG@k（支持分级相关度）。
 * DCG = Σ gain_i / log2(i+1)；IDCG 用理想排序归一化。
 * @param retrieved - 有序命中 docKey。
 * @param relevant - 相关 docKey 列表（二值场景）。
 * @param k - 截断位置。
 * @param graded - 可选分级增益（docKey → gain）；给了就用它，否则命中=1。
 */
export function ndcgAtK(retrieved: string[], relevant: string[], k: number, graded?: Record<string, number>): number {
  const gain = (key: string): number => {
    if (graded) return graded[key] ?? 0
    return relevant.includes(key) ? 1 : 0
  }
  const dcg = (list: string[]): number => {
    let s = 0
    for (let i = 0; i < list.length && i < k; i += 1) {
      const id = list[i]
      const g = id === undefined ? 0 : gain(id)
      if (g > 0) s += g / Math.log2(i + 2)
    }
    return s
  }
  const ideal = [...retrieved].sort((a, b) => gain(b) - gain(a))
  // 理想列表需覆盖所有相关项：把 relevant 补进候选再排序。
  const idealPool = Array.from(new Set([...retrieved, ...relevant, ...Object.keys(graded ?? {})]))
    .sort((a, b) => gain(b) - gain(a))
  const idcg = dcg(idealPool) || dcg(ideal)
  if (idcg <= 0) return 0
  return dcg(retrieved) / idcg
}

/** Average Precision（对全部相关项的位置敏感）。 */
export function averagePrecision(retrieved: string[], relevant: string[]): number {
  const rel = new Set(relevant)
  if (rel.size === 0) return 0
  let hit = 0
  let sum = 0
  for (let i = 0; i < retrieved.length; i += 1) {
    const id = retrieved[i]
    if (id !== undefined && rel.has(id)) {
      hit += 1
      sum += hit / (i + 1)
    }
  }
  return sum / rel.size
}

/** 评测主 k（Precision/Recall/NDCG 的截断位置）。 */
export interface EvaluateOptions {
  k?: number
  /** docKey → 文本，用于「按文本片段匹配相关」的用例。 */
  textIndex?: Map<string, string>
}

/**
 * 跑一遍评测集。
 * @param dataset - 评测用例。
 * @param retrieve - 检索函数：输入用例，返回**有序**的命中 docKey 列表。
 * @param opts - 截断 k 与文本索引。
 * @returns 聚合 + 逐用例报告。
 */
export function evaluate(
  dataset: EvalCase[],
  retrieve: (c: EvalCase) => string[],
  opts: EvaluateOptions = {},
): EvalReport {
  const k = opts.k ?? 10
  const perCase: CaseScore[] = []
  let sumP = 0
  let sumR = 0
  let sumMrr = 0
  let sumNdcg = 0
  let sumAp = 0
  let hits = 0
  for (const c of dataset) {
    const retrieved = retrieve(c)
    const relSet = new Set(c.relevant)
    // 文本片段相关的用例：先把命中的 docKey 补进相关集合。
    if (opts.textIndex) {
      for (const key of retrieved) {
        if (isRelevant(key, relSet, opts.textIndex)) relSet.add(key)
      }
    }
    const relList = [...relSet]
    const p = precisionAtK(retrieved, relList, k)
    const r = recallAtK(retrieved, relList, k)
    const m = mrr(retrieved, relList)
    const n = ndcgAtK(retrieved, relList, k, c.graded)
    const a = averagePrecision(retrieved, relList)
    if (m > 0) hits += 1
    sumP += p; sumR += r; sumMrr += m; sumNdcg += n; sumAp += a
    perCase.push({ id: c.id, retrieved, precision: p, recall: r, mrr: m, ndcg: n, ap: a })
  }
  const n = Math.max(1, dataset.length)
  return {
    cases: dataset.length,
    hits,
    precision: sumP / n,
    recall: sumR / n,
    mrr: sumMrr / n,
    ndcg: sumNdcg / n,
    map: sumAp / n,
    perCase,
  }
}

/** 把报告格式化成可读多行文本（写进操作日志 / 评测命令输出）。 */
export function formatEvalReport(name: string, report: EvalReport, k = 10): string {
  const pct = (x: number): string => (x * 100).toFixed(1) + '%'
  return [
    `评测集「${name}」· ${report.cases} 个用例 · 命中 ${report.hits}/${report.cases}`,
    `P@${k}=${pct(report.precision)}  R@${k}=${pct(report.recall)}  MRR=${report.mrr.toFixed(3)}  NDCG@${k}=${report.ndcg.toFixed(3)}  MAP=${report.map.toFixed(3)}`,
  ].join('\n')
}
