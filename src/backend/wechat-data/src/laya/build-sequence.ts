/**
 * laya 输入构造的 JS 复刻（**逐字对齐 Python 侧 `laya/common.py`**）。
 *
 * 为什么要复刻而不是调 Python：打包版是纯 Node + Electron，没有 Python
 * （见 docs/LAYA-TRIAGE-FEASIBILITY.md §2.4）。Python 侧的
 * `render_options()` / `build_sequence()` / `collate_items()` 是一段**纯字符串与整数运算**，
 * 没有模型逻辑，所以可以精确搬过来。
 *
 * **对齐是硬要求**：token 序列差一个 token，模型给出的概率就完全不同。PoC 期间已经踩过一次
 * 「输入形态不同导致答案差 0.46」的假警报（state 传 str 与传 dict 的序列化不同）。
 * 因此这里的实现配套 `tests/laya-sequence.spec.ts`：拿 Python 侧 dump 的 fixture
 * **逐 token** 比对，不许只比"看起来对"。
 *
 * 上游对应关系：
 *   renderOptions      ← common.py:33-46 render_options
 *   buildSequence      ← common.py:49-86 build_sequence
 *   collateItems       ← common.py:247-280 collate_items
 *   serializeState     ← common.py:15-18 serialize_state（Python json.dumps 的空格形态）
 */
import type { LayaQuestion, LayaQuestionKind } from './presets.ts'

/** laya 的三种原语 → 整数类型码（common.py:11 `QTYPES`）。 */
export const QTYPES: Record<LayaQuestionKind, number> = { choice: 0, score: 1, noul: 2 }

/** laya 的 mask token 字面量（tokenizer_config.json 的 `mask_token`）。 */
export const MASK_TOKEN = '<mask>'

/** 模型输入要求的 tokenizer 能力（真实实现由 runtime 注入 `@huggingface/transformers`）。 */
export interface LayaTokenizer {
  readonly clsId: number
  readonly sepId: number
  readonly maskId: number
  readonly padId: number
  /** 等价于 Python `tok(text, add_special_tokens=False)["input_ids"]`。 */
  encode(text: string): number[]
}

/** 交给模型内部的命题形态（`t` / `ins` / `crit`，对齐 `Agent._to_internal`）。 */
export interface LayaInternalQuestion {
  t: LayaQuestionKind
  ins: string
  crit: Record<string, string> | string[] | null
}

/** 对齐 `Agent._to_internal()`（agent.py:254-263）。注意 `labels` 只是 UI 用的，不进模型输入。 */
export function toInternal(q: LayaQuestion): LayaInternalQuestion {
  if (q.type === 'choice') return { t: 'choice', ins: q.instructions, crit: q.criteria }
  if (q.type === 'score') return { t: 'score', ins: q.instructions, crit: q.criteria }
  return { t: 'noul', ins: q.instructions, crit: null }
}

/**
 * 对齐 Python `json.dumps(v, ensure_ascii=False)` 的**空格形态**（项间 `, `、键值间 `: `）。
 * `JSON.stringify` 不带空格，直接用它会让 state 的 token 序列与 Python 侧不同。
 */
export function pythonJsonDumps(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'number' || typeof v === 'boolean') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(pythonJsonDumps).join(', ')}]`
  if (typeof v === 'object') {
    const parts = Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => `${JSON.stringify(k)}: ${pythonJsonDumps(x)}`)
    return `{${parts.join(', ')}}`
  }
  return JSON.stringify(String(v))
}

/** 对齐 `serialize_state()`：字符串原样，其余走 json.dumps。 */
export function serializeState(state: string | Record<string, unknown>): string {
  return typeof state === 'string' ? state : pythonJsonDumps(state)
}

/** 对齐 `render_criterion()`：字符串原样，其余转 JSON。 */
function renderCriterion(value: unknown): string {
  if (typeof value === 'string') return value
  return pythonJsonDumps(value)
}

/**
 * 对齐 `render_options()`。`noul` 的选项文本由 laya 内置的英文默认值给出
 * （「no, the statement does not hold」/「yes, the statement holds」）——
 * 这里**刻意不动**：改掉它就等于改了 PoC 实测过的输入，概率不再可比。
 */
export function renderOptions(q: LayaInternalQuestion): string[] {
  if (q.t === 'choice') {
    const crit = (q.crit ?? {}) as Record<string, string>
    return Object.entries(crit).map(([k, v]) => (v === null || v === '' ? k : `${k}: ${renderCriterion(v)}`))
  }
  if (q.t === 'score') {
    const crit = (q.crit ?? []) as string[]
    return crit.map((c, i) => `level ${i}: ${renderCriterion(c)}`)
  }
  return [
    `false: ${renderCriterion('no, the statement does not hold')}`,
    `true: ${renderCriterion('yes, the statement holds')}`,
  ]
}

/** 单条样本构造后的产物。 */
export interface LayaSequence {
  ids: number[]
  markers: number[]
}

/**
 * 对齐 `build_sequence()`。格式：
 * `[CLS] <type> question: <instructions> [SEP] [MASK]opt0 [MASK]opt1 … [SEP] <state> [SEP]`
 *
 * @param truncateLeft 状态过长时是否保留尾部（默认 false = 保留头部，同 Python 默认值）
 */
export function buildSequence(
  tok: LayaTokenizer,
  state: string | Record<string, unknown>,
  q: LayaInternalQuestion,
  maxLen = 1024,
  headMaxLen = 256,
  truncateLeft = false,
): LayaSequence {
  const opts = renderOptions(q)
  const ins = String(q.ins).split(MASK_TOKEN).join(' ')
  let headIds = tok.encode(`${q.t} question: ${ins}`)
  let optIds = opts.map((o) => [tok.maskId, ...tok.encode(` ${o.split(MASK_TOKEN).join(' ')}`).slice(0, 48)])

  const sum = (rows: number[][]): number => rows.reduce((a, r) => a + r.length, 0)
  let optBudget = headMaxLen - sum(optIds)
  if (optBudget < 16) {
    const per = Math.max(4, Math.floor((headMaxLen - 16) / Math.max(1, optIds.length)))
    optIds = optIds.map((o) => o.slice(0, per))
    optBudget = headMaxLen - sum(optIds)
  }
  headIds = headIds.slice(0, Math.max(8, optBudget))

  let ids = [tok.clsId, ...headIds, tok.sepId]
  const markers: number[] = []
  for (const o of optIds) {
    markers.push(ids.length)
    ids = ids.concat(o)
  }
  ids = ids.concat([tok.sepId])

  const room = Math.max(0, maxLen - ids.length - 1)
  let st = tok.encode(serializeState(state).split(MASK_TOKEN).join(' '))
  st = truncateLeft ? st.slice(Math.max(0, st.length - room)) : st.slice(0, room)
  ids = ids.concat(st, [tok.sepId])

  return { ids: ids.slice(0, maxLen), markers: markers.filter((m) => m < maxLen) }
}

/** 一条已经构造好、等待 collate 的样本。 */
export interface LayaItem {
  qid: string
  ids: number[]
  markers: number[]
  qtype: number
}

/** collate 后的张量（用普通数组表示，调用方转成 onnxruntime 的 Tensor）。 */
export interface LayaBatch {
  inputIds: number[][]
  attentionMask: number[][]
  markerPos: number[][]
  markerMask: boolean[][]
  qtype: number[]
  /** 序列长度（输入张量第二维） */
  seqLen: number
  /** 选项列数（marker 张量第二维） */
  optCols: number
}

/** 对齐 `collate_items()`：右侧 pad、marker 右侧补 0、mask 右侧 false。 */
export function collateItems(items: LayaItem[], padId: number): LayaBatch {
  const seqLen = Math.max(...items.map((it) => it.ids.length))
  const optCols = Math.max(...items.map((it) => it.markers.length))
  const inputIds: number[][] = []
  const attentionMask: number[][] = []
  const markerPos: number[][] = []
  const markerMask: boolean[][] = []
  for (const it of items) {
    // `?? padId` 而不是三目：本项目开了 noUncheckedIndexedAccess，越界读是 `number | undefined`，
    // 两者语义相同（i < len 时值必然存在），但只有前者能通过类型检查。
    inputIds.push(Array.from({ length: seqLen }, (_, i) => it.ids[i] ?? padId))
    attentionMask.push(Array.from({ length: seqLen }, (_, i) => (i < it.ids.length ? 1 : 0)))
    markerPos.push(Array.from({ length: optCols }, (_, i) => it.markers[i] ?? 0))
    markerMask.push(Array.from({ length: optCols }, (_, i) => i < it.markers.length))
  }
  return { inputIds, attentionMask, markerPos, markerMask, qtype: items.map((it) => it.qtype), seqLen, optCols }
}
