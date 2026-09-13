/**
 * 上下文压缩（目标 1 的 context compression 阶段）。
 *
 * 检索阶段为了不漏召回会刻意多取（尤其聚合类问题），但送给 LLM 的上下文不能无限大：
 * 上下文越长，(a) 越贵，(b) 关键证据越容易被淹没（长上下文里的「中间遗忘」现象）。
 * 压缩阶段的三件事：
 *   ① **窗口化**：把命中的单条消息展开成所在对话窗口（与旧实现一致的 chunk 语义），
 *      因为微信里「我没答应」单独一条无法回答「谁答应过什么」。
 *   ② **去冗余**：同一句被转发/复述的消息在多个窗口重复出现时只保留一次；
 *      窗口重叠时后出现的窗口不再重复已给过的行。
 *   ③ **预算裁剪**：按字符预算贪心装填，超预算即止，保证 prompt 有上界。
 */
import { loadMessageWindow } from '../search.ts'
import type { CompressedChunk, RetrievedDoc, RankedDoc } from './types.ts'

/** 相邻消息归入同一窗口的最大间隔（秒）。 */
const CHUNK_GAP_S = 900
/** 窗口展开的前后跨度（毫秒）与窗口内最大条数。 */
const WINDOW_SPAN_MS = 15 * 60 * 1000
const WINDOW_MAX_MSGS = 14

/** 秒级时间戳 → HH:MM。 */
function formatClock(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 文本归一化（去空白，用于去冗余比较）。 */
function norm(s: string): string {
  return String(s || '').replace(/\s+/g, '')
}

/** 3-gram Jaccard。 */
function jaccard(a: string, b: string): number {
  if (!a || !b) return 0
  const grams = (s: string): Set<string> => {
    const out = new Set<string>()
    for (let i = 0; i + 3 <= s.length; i += 1) out.add(s.slice(i, i + 3))
    if (out.size === 0) out.add(s)
    return out
  }
  const ga = grams(a)
  const gb = grams(b)
  let inter = 0
  for (const t of ga) if (gb.has(t)) inter += 1
  return inter / (ga.size + gb.size - inter)
}

/** 压缩选项。 */
export interface CompressOptions {
  maxChars: number
  maxChunks: number
  linesPerChunk: number
  dedupThreshold: number
}

/**
 * 把重排后的候选压成受预算约束的对话窗口。
 * @param decryptedDir - 解密数据根。
 * @param ranked - 重排后的候选（顺序即优先级）。
 * @param opts - 预算 / 窗口数 / 行数 / 去重阈值。
 * @returns 压缩后的窗口 + 实际取回的消息条数。
 */
export function compressContext(
  decryptedDir: string,
  ranked: RankedDoc[],
  opts: CompressOptions,
): { chunks: CompressedChunk[]; windowMessages: number; usedChars: number } {
  const chunks: CompressedChunk[] = []
  let windowMessages = 0
  let usedChars = 0
  // 已选窗口区间：同会话 + 时间相邻的命中不再另开窗口（避免同一段对话反复出现）。
  const chosen: Array<{ username: string; start: number; end: number }> = []
  // 已在其他窗口出现过的行文本（全局去冗余）。
  const seenLines: Array<{ username: string; text: string }> = []

  for (const r of ranked) {
    if (chunks.length >= opts.maxChunks) break
    if (usedChars >= opts.maxChars) break
    const d = r.doc
    // 与已选窗口重叠 → 跳过（这段对话已经进上下文了）。
    if (chosen.some(c => c.username === d.username && d.create_time >= c.start && d.create_time <= c.end)) continue

    const centerMs = d.create_time * 1000
    const win = loadMessageWindow(decryptedDir, d.username, centerMs, WINDOW_SPAN_MS, WINDOW_MAX_MSGS)
    windowMessages += win.length

    const rawLines = win.length > 0
      ? win.map(w => ({ time: formatClock(w.create_time), sender: w.sender ? w.sender : '', text: w.text, ts: w.create_time, localId: w.local_id }))
      : [{ time: formatClock(d.create_time), sender: d.sender ?? '', text: d.snippet || d.text, ts: d.create_time, localId: d.local_id }]

    const lines: Array<{ time: string; sender: string; text: string }> = []
    let anchorPresent = false
    for (const l of rawLines) {
      if (lines.length >= opts.linesPerChunk) break
      const body = norm(l.text)
      if (!body) continue
      // 全局去冗余：同一句已在别的窗口给过 → 跳过（锚点除外，保证引用可定位）。
      const isAnchor = l.localId === d.local_id
      if (!isAnchor && seenLines.some(s => s.username === d.username && (s.text === body || jaccard(s.text, body) >= opts.dedupThreshold))) continue
      lines.push({ time: l.time, sender: l.sender, text: l.text })
      seenLines.push({ username: d.username, text: body })
      if (isAnchor) anchorPresent = true
    }
    // 锚点（真正命中的那条）必须在窗口里：否则模型看到的是一段不含命中消息的对话，
    // 窗口级语义失真（旧实现踩过：最近的转账被排到后面）。
    if (!anchorPresent) {
      const al = { time: formatClock(d.create_time), sender: d.sender ?? '', text: d.snippet || d.text }
      const at = lines.findIndex(l => l.time > al.time)
      if (at < 0) lines.push(al)
      else lines.splice(at, 0, al)
      while (lines.length > opts.linesPerChunk) lines.pop()
    }
    if (lines.length === 0) continue

    const cost = lines.reduce((a, l) => a + l.text.length + 8, 0)
    if (usedChars + cost > opts.maxChars && chunks.length > 0) break
    usedChars += cost

    chunks.push({
      username: d.username,
      name: d.name,
      anchor: {
        name: d.name,
        time: timeFull(d.create_time),
        snippet: d.snippet || d.text.slice(0, 90),
        username: d.username,
        local_id: d.local_id,
        ...(d.sender ? { sender: d.sender } : {}),
      },
      lines,
      score: r.score,
      pref: r.timePref,
      createTime: d.create_time,
    })
    chosen.push({ username: d.username, start: centerMs - WINDOW_SPAN_MS, end: centerMs + WINDOW_SPAN_MS })
  }
  return { chunks, windowMessages, usedChars }
}

/** YYYY-MM-DD HH:MM。 */
function timeFull(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 便于测试：从统一文档构造一条「已排序」候选。 */
export function docToRanked(d: RetrievedDoc, score = 0): RankedDoc {
  return {
    doc: d, score, matched: [], timePref: 0,
    features: { sparse: 0, dense: 0, entity: 0, coverage: 0, timePref: 0, recency: 0, agreement: 0 },
    ranks: {},
  }
}
