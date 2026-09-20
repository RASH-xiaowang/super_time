/**
 * 笔记编辑器里的「模型建议的链接」—— 只**排序**，不写任何东西。
 *
 * ── 为什么这一层值得存在 ─────────────────────────────────────────────
 * `[[双向链接]]` 全靠用户手打，而人不会记得「另一篇笔记里有个标题正好是这件事」。
 * 于是图谱的边长期只反映「你想得起来的那些名字」。这一层做的是把本库已有的
 * 笔记标题与模型抽出的实体**按语义相近排个序**，摆在光标旁边让人点一下。
 *
 * ── 三条边界，都是产品契约（`docs/KB-MODEL-CONFIG.md` §2.3 / V6）────────
 *   ① **只出建议，不写正文**：本模块没有任何写路径，返回的是候选文本；
 *      插入动作发生在编辑器里、由用户点击触发。模型一次判断错，代价是「用户没点」，
 *      而不是「正文里多了一条他没写过的链接」—— 后者会污染图谱，且很难发现是哪来的。
 *   ② 出网的是**正文 + 候选标题**，功能名单独一个 `kb_link_suggest`（审计里要能与
 *      文件正文的 `kb_extract`、向量库的 `kb_embed` 分开）。
 *   ③ 排序用**嵌入**而不是再叫一次语言模型：候选是几十个短标题，余弦序已经够用，
 *      而多一轮 LLM 判定要多发一次正文、多一种失败模式（超时/429），换来的只是
 *      「把 0.42 分的说成值得连」—— 值不值得连由人点，不由模型说。
 *
 * 依赖方向与 `extract.ts` 同一条纪律：本模块只依赖向量数学，不 import 笔记库/文件库
 * 的任何查询模块（取候选是 gateway 的事），这样它可以脱离 sqlite 直接测。
 */
import { l2normalize } from '../vector-math.ts'

/** 一个候选：出现在本库里、还没被 `[[链接]]` 引用的名字。 */
export interface LinkCandidate {
  label: string
  /** note = 真实存在的笔记标题；entity = 模型从文件里抽出的实体。 */
  kind: 'note' | 'entity'
}

/** 一次建议的结果。 */
export interface SuggestResult {
  ranked: Array<LinkCandidate & { score: number }>
  /** 参与排序的候选数（截断到池上限之后）。 */
  pool: number
  /** 为什么只有这些 / 为什么一个都没有；界面原样显示，不做美化。 */
  note?: string
}

/** 候选池上限：再多就不是「补一个想不起来的链接」而是「把整个库 embedding 一遍」了。 */
export const SUGGEST_POOL_MAX = 80

/** 一次 embedding 请求里的标题条数（与宿主侧的批量上限同量级）。 */
const EMBED_BATCH = 40

/**
 * 相似度下限。低于这个值的候选在界面上只是噪音：短标题之间的余弦本来就不高，
 * 但 0.1 以下基本是「同库里的任意两句话」的基线水平。
 * 阈值给出来是为了**可解释**（芯片上显示分数），不是当成质量保证。
 */
export const SUGGEST_MIN_SCORE = 0.15

/** 归一化一个名字：与 `parseWikiLinks` 同一口径（去首尾空白 + 小写），否则比不中。 */
function normLabel(s: string): string {
  return s.trim().toLowerCase()
}

/**
 * 正文里已经写过 `[[目标]]` 的那些目标。
 *
 * 已经连上的名字不该再建议一次 —— 那不是「建议」，是「没看见用户已经做过的事」。
 * 别名写法 `[[目标|显示文本]]` 也要认：那是同一件事的另一种打字方式。
 * 判据与 `parseWikiLinks`、编辑器里的 `extractTargets` 同一口径（取 `|` 之前那段）。
 * @param text - 笔记正文（或标题+正文拼起来的串）。
 * @returns 归一化后的目标集合。
 */
export function alreadyLinked(text: string): Set<string> {
  const out = new Set<string>()
  if (typeof text !== 'string') return out
  for (const m of text.matchAll(/\[\[([^\][\n]{1,80})\]\]/g)) {
    const inner = m[1] ?? ''
    const bar = inner.indexOf('|')
    const t = normLabel(bar >= 0 ? inner.slice(0, bar) : inner)
    if (t !== '') out.add(t)
  }
  return out
}

/**
 * 把候选按与正文的语义距离排序。
 * @param queryText - 正在编辑的正文（会被截到 1200 字：建议要的是主题，不是全文）。
 * @param candidates - 候选（调用方负责去重与截断到 `SUGGEST_POOL_MAX`）。
 * @param embed - 已过隐私闸的 embedding 函数。
 * @param opts - `topK`（默认 8）。
 * @returns 排序结果（含池大小与说明；embedding 失败时 ranked 为空 + note 说明原因）。
 */
export async function rankLinkCandidates(
  queryText: string,
  candidates: readonly LinkCandidate[],
  embed: (texts: string[]) => Promise<number[][]>,
  opts: { topK?: number } = {},
): Promise<SuggestResult> {
  const q = String(queryText ?? '').trim().slice(0, 1200)
  const topK = Math.max(1, Math.min(Math.trunc(Number(opts.topK) || 8), 20))
  if (q === '') return { ranked: [], pool: 0, note: '正文还是空的，先写两句再要建议' }
  const linked = alreadyLinked(queryText ?? '')
  const seen = new Set<string>()
  const pool: LinkCandidate[] = []
  for (const c of candidates) {
    const key = normLabel(c.label)
    if (key === '' || linked.has(key) || seen.has(key)) continue
    seen.add(key)
    pool.push(c)
    if (pool.length >= SUGGEST_POOL_MAX) break
  }
  if (pool.length === 0) {
    return { ranked: [], pool: 0, note: candidates.length === 0 ? '本库还没有可建议的标题或实体' : '能连的都已经在正文里了' }
  }
  /** 归一化 label → 与正文的余弦。用 Map 而不是数组下标：分批 embed 时不必对齐全局序号。 */
  const scores = new Map<string, number>()
  let qv: Float32Array
  try {
    const qr = await embed([q])
    const raw = qr[0]
    if (!raw || raw.length === 0) return { ranked: [], pool: pool.length, note: 'embedding 返回空' }
    qv = l2normalize(raw)
    // 分批：一次 40 条短标题，80 条候选最多两次请求。批次之间不并发 —— 并发会让
    // 「一次建议」变成「同时打出去四个请求」，而这个动作是随打字触发的。
    for (let start = 0; start < pool.length; start += EMBED_BATCH) {
      const batch = pool.slice(start, start + EMBED_BATCH)
      const vecs = await embed(batch.map(c => c.label))
      for (let j = 0; j < batch.length; j += 1) {
        const item = batch[j]
        const raw2 = vecs[j]
        if (!item) continue
        scores.set(normLabel(item.label), raw2 && raw2.length > 0 ? dot(qv, l2normalize(raw2)) : 0)
      }
    }
  } catch (e) {
    const msg = (e as { message?: unknown } | null | undefined)?.message
    return { ranked: [], pool: pool.length, note: 'embedding 失败：' + (typeof msg === 'string' && msg !== '' ? msg : String(e)) }
  }
  const out = pool
    .map(c => ({ ...c, score: scores.get(normLabel(c.label)) ?? 0 }))
    .filter(c => c.score >= SUGGEST_MIN_SCORE)
    .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label))
    .slice(0, topK)
  return {
    ranked: out,
    pool: pool.length,
    ...(out.length === 0 ? { note: `试了 ${pool.length} 个候选，没有一个够近（阈值 ${SUGGEST_MIN_SCORE}）` } : {}),
  }
}

/** 点积（两侧都已 L2 归一 ⇒ 就是余弦）。维度不等时按短的算，与向量库的回读口径一致。 */
function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length)
  let s = 0
  for (let i = 0; i < n; i += 1) s += (a[i] ?? 0) * (b[i] ?? 0)
  return s
}
