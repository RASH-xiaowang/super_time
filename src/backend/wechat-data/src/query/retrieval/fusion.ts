/**
 * 多路召回结果融合与去重（目标 4）。
 *
 * 用 **RRF（Reciprocal Rank Fusion）** 而不是「分数加权求和」，原因：
 * 稀疏的 BM25 分与稠密的余弦分**量纲完全不同**（BM25 无上界、余弦在 [-1,1]），
 * 直接加权必须做归一化，而归一化对异常值极敏感（一条超长文档能把 BM25 归一化尺度带偏）。
 * RRF 只用**名次**，天然免标定，且被多个通道同时召回的文档会自动获得累加优势 ——
 * 这正是「一致性」信号，也是去重的天然入口（按 docKey 合并）。
 *
 * 融合后按压缩预算 keep 截断，再做去重兜底（docKey 相同 + 文本高度相似）。
 */
import type { ChannelName, ChannelResult, FusedDoc } from './types.ts'

/** 文档去重键。 */
function keyOf(username: string, localId: number): string {
  return username + ':' + localId
}

/** 把某通道原始分归一化到 0~1（min-max；全相等时给 1）。 */
function normalizeScores(scores: number[]): number[] {
  if (scores.length === 0) return []
  let min = Infinity
  let max = -Infinity
  for (const s of scores) { if (s < min) min = s; if (s > max) max = s }
  const span = max - min
  if (span <= 1e-12) return scores.map(() => 1)
  return scores.map(s => (s - min) / span)
}

/**
 * RRF 融合多路召回结果。
 * @param channels - 各通道结果（未启用的通道 active=false，被忽略）。
 * @param k - RRF 平滑常数（经验值 60；越小越强调头部名次）。
 * @param keep - 融合后保留候选数（进入重排）。
 * @returns 按 RRF 降序的融合候选。
 */
export function fuseResults(channels: ChannelResult[], k: number, keep: number): FusedDoc[] {
  const acc = new Map<string, FusedDoc>()
  for (const ch of channels) {
    if (!ch.active || ch.hits.length === 0) continue
    const norms = normalizeScores(ch.hits.map(h => h.score))
    ch.hits.forEach((hit, idx) => {
      const d = hit.doc
      const key = d.docKey || keyOf(d.username, d.local_id)
      let entry = acc.get(key)
      if (!entry) {
        entry = { doc: d, ranks: {}, scores: {}, rrf: 0 }
        acc.set(key, entry)
      }
      // 同一文档在同一通道出现多次时只取最好名次。
      const prevRank = entry.ranks[ch.channel]
      if (prevRank === undefined || hit.rank < prevRank) {
        entry.ranks[ch.channel] = hit.rank
        entry.scores[ch.channel] = norms[idx] ?? 0
      }
      entry.rrf += 1 / (k + hit.rank)
    })
  }
  const out = [...acc.values()].sort((a, b) => b.rrf - a.rrf)
  return out.slice(0, Math.max(keep, 1))
}

/**
 * 兜底去重：RRF 已按 docKey 合并，这里再合并**文本近似重复**的不同消息
 * （微信里同一句被转发/复述会产生多条不同 local_id 的近似文本）。
 *
 * **必须叠加时间邻近条件**：微信的系统通知是模板化的 —— 「微信转账 收到转账3500.00元」
 * 这类消息在同一会话里逐月出现，文本几乎完全一致却是**不同的事件**。旧实现只看文本相似度，
 * 会把「一共转了多少笔账」里的多笔转账合并成一条（实测把 9 月那笔吞掉）。
 * 因此只有「同会话 + 文本近似 + 时间相近（默认 5 分钟内）」才判定为重复。
 * @param docs - 融合后候选（已按 RRF 降序）。
 * @param threshold - 文本相似度阈值（≥阈值视为重复）。
 * @param maxGapSec - 判定为同一次发言的最大时间间隔（秒）。
 * @returns 去重后的候选。
 */
export function dedupeFused(docs: FusedDoc[], threshold: number, maxGapSec = 300): FusedDoc[] {
  if (docs.length <= 1) return docs
  const grams = (s: string): Set<string> => {
    const t = s.replace(/\s+/g, '')
    const out = new Set<string>()
    for (let i = 0; i + 3 <= t.length; i += 1) out.add(t.slice(i, i + 3))
    if (out.size === 0 && t) out.add(t)
    return out
  }
  const kept: FusedDoc[] = []
  const keptGrams: Array<Set<string>> = []
  for (const d of docs) {
    const g = grams(d.doc.text || d.doc.snippet)
    if (g.size === 0) { kept.push(d); keptGrams.push(g); continue }
    let dup = false
    for (let i = 0; i < keptGrams.length; i += 1) {
      // `kept` 与 `keptGrams` 只在同一处成对 push ⇒ 两表等长；读不到就当这一格不参与比较。
      const o = keptGrams[i]
      const k = kept[i]
      if (!o || !k) continue
      if (o.size === 0) continue
      // 只在同会话内判定重复：跨会话的同名句子往往是不同人在不同语境说的，不应合并。
      if (k.doc.username !== d.doc.username) continue
      // 时间不相近 → 视为不同事件（模板消息逐月重复的情形）。
      if (Math.abs(k.doc.create_time - d.doc.create_time) > maxGapSec) continue
      let inter = 0
      for (const t of g) if (o.has(t)) inter += 1
      const jac = inter / (g.size + o.size - inter)
      if (jac >= threshold) { dup = true; break }
    }
    if (!dup) { kept.push(d); keptGrams.push(g) }
  }
  return kept
}

/** 通道结果简表（写进统计）。 */
export function channelSummary(channels: ChannelResult[]): Array<{ channel: ChannelName; count: number; active: boolean; note?: string }> {
  return channels.map(c => ({
    channel: c.channel,
    count: c.hits.length,
    active: c.active,
    ...(c.note ? { note: c.note } : {}),
  }))
}
