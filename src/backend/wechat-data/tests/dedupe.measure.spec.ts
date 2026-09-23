/**
 * M12 实测：两处去重的真实代价。**不是回归用例**，靠 `MEASURE_M12=1` 门控。
 *
 *   A. `dedupeFused`：对每个候选与已保留集合做 O(N²) 两两 Jaccard。N 的上界是
 *      `fusion.keep`（默认 120），所以这里量「最坏情况」——全部同会话、时间都在 maxGap 内
 *      （此时两个廉价过滤都不生效，真的逐对比较）。
 *      **这条改过又撤掉了**：按会话索引（只比同会话）在本机配置的 N 下**没有可测收益**
 *      （4 会话交替的现实形状 0.54ms → 0.70ms，在噪声内），最坏情形不变（14.28 → 14.06ms）
 *      —— 被跳过的那些比较本来只是「数组走一步 + 字符串不等即 continue」，而 Map 查找
 *      自己也有开销。按「不加没有证据的代码」撤掉，只留 compress 那处有 2× 实测的改动。
 *      这一段测量保留下来，作为「为什么没改 fusion」的证据。
 *   B. `compress` 路径的句子级去重：`seenLines.some(s => … || jaccard(s.text, body) >= t)`。
 *      量**原语**在真实长度下的单次代价，再按配置上界（`maxChunks 10` × `linesPerChunk 6`
 *      × 已见 ≤60）估出每次提问的量级，并与「3-gram 按行只算一次」对照：
 *      实测 1.77 → 0.92ms/窗口（≈2×，即 ≈17.7 → 9.2ms/次提问）。
 *
 * 运行：
 *   MEASURE_M12=1 node node_modules/vitest/vitest.mjs run src/backend/wechat-data/tests/dedupe.measure.spec.ts
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { dedupeFused } from '../src/query/retrieval/fusion.ts'
import { at } from '../../tests/helpers/strict-index.ts'
import type { FusedDoc, RetrievedDoc } from '../src/query/retrieval/types.ts'

function doc(username: string, localId: number, text: string, createTime: number): RetrievedDoc {
  return {
    docKey: username + ':' + localId, username, name: username, local_id: localId,
    create_time: createTime, text, snippet: text,
  }
}

function fused(username: string, localId: number, text: string, createTime: number): FusedDoc {
  return { doc: doc(username, localId, text, createTime), ranks: { sparse: localId }, scores: { sparse: 1 }, rrf: 1 }
}

/** 确定性伪随机文本（高熵、长度接近真实消息）。 */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s }
}

function makeTexts(n: number, seed: number, len: number): string[] {
  const r = rng(seed)
  const chars = '的一是了不在人有我他这上中来大和国地到以说时要就出会可也'
  const out: string[] = []
  for (let i = 0; i < n; i += 1) {
    let t = ''
    for (let k = 0; k < len; k += 1) t += chars[r() % chars.length]
    out.push(t)
  }
  return out
}

function ms(fn: () => unknown, runs: number): { median: number } {
  const all: number[] = []
  for (let i = 0; i < runs; i += 1) {
    const t0 = Number(process.hrtime.bigint()) / 1e6
    fn()
    all.push(Number(process.hrtime.bigint()) / 1e6 - t0)
  }
  all.sort((a, b) => a - b)
  return { median: at(all, Math.floor(all.length / 2), '样本') }
}

describe.skipIf(process.env.MEASURE_M12 !== '1')('M12 去重实测', () => {
  it('dedupeFused 的最坏情况（全部同会话、时间相近 ⇒ 两个廉价过滤都不生效）', () => {
    for (const n of [30, 60, 120]) {
      const texts = makeTexts(n, 42, 120)
      const docs = texts.map((t, i) => fused('wxid_a', i + 1, t, 1700000000 + i))
      const r = ms(() => dedupeFused(docs, 0.85, 99999), 5)
      console.log(`  N=${n}（全同会话、时间全在窗口内，逐对比较）：中位 ${r.median.toFixed(2)}ms`)
    }
    // 现实一点的形状：4 个会话交替、时间散布
    const texts = makeTexts(120, 7, 120)
    const docs = texts.map((t, i) => fused('wxid_' + String(i % 4), i + 1, t, 1700000000 + i * 600))
    console.log(`  N=120（4 会话交替 + 时间散布 600s）        ：中位 ${ms(() => dedupeFused(docs, 0.85, 300), 10).median.toFixed(2)}ms`)
  })

  it('compress 路径的句子级去重：原语代价 × 配置上界', () => {
    const bodies = makeTexts(80, 99, 100)
    // 模拟 `seenLines.some(...)`：每次都对「一个新 body」与 60 条已见句子各算一次 Jaccard
    const seen = bodies.slice(0, 60)
    const run = (): number => {
      let hits = 0
      const grams = (s: string): Set<string> => {
        const out = new Set<string>()
        for (let i = 0; i + 3 <= s.length; i += 1) out.add(s.slice(i, i + 3))
        if (out.size === 0) out.add(s)
        return out
      }
      for (let k = 0; k < 6; k += 1) {
        const b = at(bodies, 60 + k, 'bodies')
        const gb = grams(b)
        for (const s of seen) {
          const ga = grams(s)
          let inter = 0
          for (const t of ga) if (gb.has(t)) inter += 1
          if (inter / (ga.size + gb.size - inter) >= 0.85) { hits += 1; break }
        }
      }
      return hits
    }
    const perWindow = ms(run, 20).median
    console.log(`  一个窗口（6 行 × 60 条已见）的现状代价：中位 ${perWindow.toFixed(2)}ms`)
    console.log(`  ⇒ 按 compress 上界 ${10} 个窗口估算：≈ ${(perWindow * 10).toFixed(1)}ms/次提问（每次 Jaccard 都重建两侧 3-gram）`)

    // 若把每行的 3-gram 缓存起来（改动后的做法）：
    const runCached = (): number => {
      let hits = 0
      const grams = (s: string): Set<string> => {
        const out = new Set<string>()
        for (let i = 0; i + 3 <= s.length; i += 1) out.add(s.slice(i, i + 3))
        if (out.size === 0) out.add(s)
        return out
      }
      const seenG = seen.map(grams)
      for (let k = 0; k < 6; k += 1) {
        const gb = grams(at(bodies, 60 + k, 'bodies'))
        for (const ga of seenG) {
          let inter = 0
          for (const t of ga) if (gb.has(t)) inter += 1
          if (inter / (ga.size + gb.size - inter) >= 0.85) { hits += 1; break }
        }
      }
      return hits
    }
    const perWindowCached = ms(runCached, 20).median
    console.log(`  同一负载、3-gram 只在建时算一次：中位 ${perWindowCached.toFixed(2)}ms ⇒ ≈ ${(perWindowCached * 10).toFixed(1)}ms/次提问（加速 ${(perWindow / Math.max(perWindowCached, 0.001)).toFixed(1)}×）`)
    expect(perWindow).toBeGreaterThanOrEqual(0)
  })
})
