/**
 * 知识库分块器（**纯函数**：不 import fs / sqlite / 网络，不读时间，不读配置）。
 *
 * 分块决定了「检索命中的东西有多像一段人话」。一个块的正文会：
 *   ① 被 BM25 索引、② 被嵌入成向量、③ 被当作证据塞进模型的上下文。
 * 所以这一层的产物质量直接决定这个功能能不能用 —— 它值得被单测逐条钉住。
 *
 * 三个数字是**固化的产品默认**（不是可调参数，与检索参数同一条纪律：
 * 目标用户不熟这些参数，给旋钮只会让他们调坏）：
 *   · `CHUNK_MAX_CHARS = 500`    —— 中文技术文档约 250~350 字一个自然段，
 *     500 字能容下「一段 + 它的列表」；
 *   · `CHUNK_OVERLAP_CHARS = 80` —— 保证跨块边界的句子仍能被完整召回；
 *   · `TABLE_ROWS_PER_CHUNK = 40`—— 取「行宽 × 40 ≈ 500 字符」的量级。
 *
 * 用**字符**而不是 token 作口径：全项目的上下文预算都是字符
 * （`compress.maxChars`、`excerptOf(body, limit)`），引入 tokenizer 的收益只是
 * 「块长更精确」，代价却是一个新依赖 + 与远端分词器版本绑死。偏差由嵌入接口
 * 自身的截断行为兜住。
 *
 * ── 两处与设计稿刻意不同的实现选择（都写在这里，免得后人以为写错了）─────────
 *
 * 1) **「续 N」给了所有非首块**，而不是只给硬切产生的块。
 *    设计稿 §5.1 的原话是「硬切时 heading 追加『续 N』」。实现上放宽成
 *    「只要不是本段的第一块就带（续 N）」：对读的人（和模型）来说，
 *    「这是不是硬切出来的」没有意义，「这是第几块」才有意义 —— 一个靠句子边界
 *    切出来的第 3 块，同样需要知道自己不是开头。宁多勿少。
 *
 * 2) **表格块允许超过 `CHUNK_MAX_CHARS`**，因为超长来自单行。
 *    兜底的办法只有「把那一行劈开」，而那正是表格分块要避免的事
 *    （喂给模型的证据会变成残行）。两害相权：**宁可块大，也不切行**。
 *
 * ── 终止性 ──────────────────────────────────────────────────────────────
 *
 * 切点一律在窗口**后段**（`start + minChars` 之后）找，且 `next >= start + 1`
 * 兜底，故循环必然推进。这条不是「应该没问题」：`minChars` 与 `overlapChars`
 * 的关系是 `overlap < min`，而 `minChars` 被夹到 `maxChars` 之内，
 * 所以「切点在 start+min 之后」⇒ `cut - overlap > start` 恒成立。
 */

import type { ChunkDraft, ChunkResult, ParsedBlock } from './types.ts'

/** 目标块长（字符）。 */
export const CHUNK_MAX_CHARS = 500

/** 相邻块重叠（字符）。 */
export const CHUNK_OVERLAP_CHARS = 80

/**
 * 窗口内切点的最早位置（相对窗口起点的字符数）。
 *
 * 为什么要有下界：句号密度极高的文本（一行一句的日志）若允许在任意位置切，
 * 会切出一堆两三个字的碎块 —— 那种块的向量没有语义、BM25 也没有区分度。
 * 取 `max` 的 40%：默认 200 字，约等于中文 1~2 个自然段。
 */
export const CHUNK_MIN_CHARS = 200

/** 表格每块的数据行数（不含每块都要重复的表头行）。 */
export const TABLE_ROWS_PER_CHUNK = 40

/**
 * 单个文件的块数上限。
 *
 * 两个保护合一：不让一次上传把出网闸门变成**批量外泄**（一个 5000 页 PDF 能解出
 * 8 万块，全部要送去嵌入），也保护向量库体积。截断必须被写进
 * `kb_files.parse_error` 让用户看见，否则他会以为整份文件都进了检索。
 */
export const MAX_CHUNKS_PER_FILE = 20000

/** 分块参数（内部用；对外一律走上面那几个常量）。 */
export interface ChunkOptions {
  maxChars?: number
  overlapChars?: number
  minChars?: number
  tableRowsPerChunk?: number
  maxChunks?: number
}

/** 归一化后的参数。 */
interface Resolved {
  maxChars: number
  overlapChars: number
  minChars: number
  tableRowsPerChunk: number
  maxChunks: number
}

/**
 * 归一化参数，并强制维持两条不变量：`0 <= overlap < max`、`0 < min <= max`。
 *
 * 越界的输入**就地夹住**而不是抛错：这是一条数据加工路径，宁可给出保守的块，
 * 也不要让一个参数错误把整份文件变成 failed（用户看到的会是「解析失败」，而真因在参数里）。
 * @param opts - 调用方给的参数（缺省取常量）。
 * @returns 归一化后的参数。
 */
function resolveOptions(opts: ChunkOptions): Resolved {
  const maxChars = Math.max(1, opts.maxChars ?? CHUNK_MAX_CHARS)
  const overlapChars = Math.min(Math.max(0, opts.overlapChars ?? CHUNK_OVERLAP_CHARS), maxChars - 1)
  const minChars = Math.min(Math.max(1, opts.minChars ?? CHUNK_MIN_CHARS), maxChars)
  const tableRowsPerChunk = Math.max(1, opts.tableRowsPerChunk ?? TABLE_ROWS_PER_CHUNK)
  const maxChunks = Math.max(1, opts.maxChunks ?? MAX_CHUNKS_PER_FILE)
  return { maxChars, overlapChars, minChars, tableRowsPerChunk, maxChunks }
}

/** 句末字符。`\n` 也算 —— 换行在纯文本里就是一层天然的语义边界。 */
const SENTENCE_ENDERS = new Set(['。', '！', '？', '；', '!', '?', ';', '\n'])

/**
 * 在 `[from, to)` 区间里找**最后一个**段落断点（`\n\n`）。
 * @param s - 全文。
 * @param from - 搜索起点（含）。
 * @param to - 搜索终点（不含）。
 * @returns 切点（断点之后一位）；没有则 -1。
 */
function lastParagraphCut(s: string, from: number, to: number): number {
  for (let i = to - 2; i >= from; i -= 1) {
    if (s.charCodeAt(i) === 10 && s.charCodeAt(i + 1) === 10) return i + 2
  }
  return -1
}

/**
 * 在 `[from, to)` 区间里找**最后一个**句末字符。
 * @param s - 全文。
 * @param from - 搜索起点（含）。
 * @param to - 搜索终点（不含）。
 * @returns 切点（句末字符之后一位）；没有则 -1。
 */
function lastSentenceCut(s: string, from: number, to: number): number {
  for (let i = to - 1; i >= from; i -= 1) {
    const ch = s[i]
    if (ch !== undefined && SENTENCE_ENDERS.has(ch)) return i + 1
  }
  return -1
}

/**
 * 把一段连续文字切成若干块。
 *
 * 切点优先级：**段落断点 > 句末 > 硬切**；一律只在窗口后段找断点（见 `CHUNK_MIN_CHARS`）。
 * 返回值**不做 trim** —— 相邻块的重叠必须逐字符相等（后一块的前 N 字符 = 前一块的后 N 字符），
 * 一旦 trim，重叠量就随内容漂移、无法断言，也无法向使用者解释「到底带了多少上下文」。
 * 调用方保证输入已归一化且无首尾空白（见 `parse-plain.ts`）。
 * @param text - 段正文（非空）。
 * @param opts - 分块参数。
 * @returns 块正文数组；空输入返回 `[]`。
 */
export function splitProse(text: string, opts: ChunkOptions = {}): string[] {
  const o = resolveOptions(opts)
  if (text === '') return []
  if (text.length <= o.maxChars) return [text]

  const out: string[] = []
  let start = 0
  while (start < text.length) {
    const windowEnd = Math.min(text.length, start + o.maxChars)
    let cut: number
    if (windowEnd >= text.length) {
      // 尾巴：剩下的全要，不再找断点（否则最后一段会被无谓地再切一次）。
      cut = text.length
    } else {
      const from = Math.min(windowEnd - 1, start + o.minChars)
      const para = lastParagraphCut(text, from, windowEnd)
      const sent = para >= 0 ? para : lastSentenceCut(text, from, windowEnd)
      cut = sent >= 0 ? sent : windowEnd
    }
    const piece = text.slice(start, cut)
    // 只跳过「整块都是空白」的残段；不做 trim（见函数头）。
    if (piece.trim() !== '') out.push(piece)
    if (cut >= text.length) break
    // 单调推进兜底：即便参数被调成 overlap >= min，也绝不回退成死循环。
    start = Math.max(cut - o.overlapChars, start + 1)
  }
  return out
}

/**
 * 把一段表格正文切成若干块，**每块首行都是表头**。
 *
 * 为什么必须重复表头：检索命中的是一个块、送给模型的也是那个块。块里没有列名，
 * 「28000」这个数字对模型就没有含义 —— 它回答不了「谁的月薪是 28000」。
 * 多存一行表头的代价，与「证据可读」的收益相比可以忽略。
 * @param text - 表头 + 数据行，以 `\n` 连接。
 * @param opts - 分块参数。
 * @returns 块正文数组（每块 = 表头行 + `\n` + 至多 N 行数据）。
 */
export function splitTableRows(text: string, opts: ChunkOptions = {}): string[] {
  const o = resolveOptions(opts)
  const lines = text.split('\n').filter(l => l.trim() !== '')
  if (lines.length === 0) return []
  const header = lines[0] as string
  const rows = lines.slice(1)
  if (rows.length === 0) return [header]

  const out: string[] = []
  for (let i = 0; i < rows.length; i += o.tableRowsPerChunk) {
    out.push([header, ...rows.slice(i, i + o.tableRowsPerChunk)].join('\n'))
  }
  return out
}

/** 块正文 + 它该用的 heading（`chunkBlocks` 内部用）。 */
interface Piece {
  text: string
  heading: string
}

/**
 * heading 拼接规则：`父 › 本段`；父为空时只有本段。
 * @param parent - 段落面包屑。
 * @param own - 本段追加的说明（表格用「列名 …」）。
 * @returns 拼接结果。
 */
function joinHeading(parent: string, own: string): string {
  if (!parent) return own
  if (!own) return parent
  return `${parent} › ${own}`
}

/**
 * 「续 N」——标记本块不是该段的第一块。
 * @param heading - 原 heading（可为空）。
 * @param n - 块序号（1 基）。
 * @returns 追加后的 heading；`n === 1` 时原样返回。
 */
function withContinuation(heading: string, n: number): string {
  if (n <= 1) return heading
  return heading ? `${heading}（续 ${n}）` : `（续 ${n}）`
}

/** 列名摘要的长度上限（heading 是给人一眼看的，不承载完整表头）。 */
const TABLE_HEADING_MAX = 60

/**
 * 单段的切块：prose 走三级切点，table 走行组。
 * @param block - 解析出的段。
 * @param o - 归一化参数。
 * @returns 该段的块数组。
 */
function piecesOf(block: ParsedBlock, o: Resolved): Piece[] {
  if (block.kind === 'table') {
    const lines = block.text.split('\n')
    const header = lines[0] ?? ''
    const clipped = header.length > TABLE_HEADING_MAX ? header.slice(0, TABLE_HEADING_MAX) + '…' : header
    const heading = joinHeading(block.heading, `列名 ${clipped}`)
    return splitTableRows(block.text, o).map((text, i) => ({ text, heading: withContinuation(heading, i + 1) }))
  }
  return splitProse(block.text, o).map((text, i) => ({ text, heading: withContinuation(block.heading, i + 1) }))
}

/**
 * 把解析出的段流式地切成块（负责分配 ordinal、累计字符数、执行总量上限）。
 *
 * 段与段之间**不重叠**：重叠只发生在同一段被切开的两块之间。跨段的「重叠」没有意义
 * —— 段边界本身就是标题或表格边界，重复带过去只会让检索结果看起来像重复条目。
 * @param blocks - `parse-plain.ts` 等解析器产出的段。
 * @param opts - 分块参数。
 * @returns 块 + 是否被截断 + 两个汇总数。
 */
export function chunkBlocks(blocks: readonly ParsedBlock[], opts: ChunkOptions = {}): ChunkResult {
  const o = resolveOptions(opts)
  const chunks: ChunkDraft[] = []
  let charCount = 0
  let truncated = false

  for (const block of blocks) {
    if (block.text.trim() === '') continue
    const pieces = piecesOf(block, o)
    for (const p of pieces) {
      if (chunks.length >= o.maxChunks) { truncated = true; break }
      chunks.push({
        ordinal: chunks.length,
        text: p.text,
        charCount: p.text.length,
        page: block.page,
        heading: p.heading,
      })
      charCount += p.text.length
    }
    if (truncated) break
  }

  return { chunks, truncated, chunkCount: chunks.length, charCount }
}
