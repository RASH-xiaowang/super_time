/**
 * laya 的**本地推理运行时**（onnxruntime-node + JS 分词 + 后处理）。
 *
 * 三件事都在这里：加载 → 推理 → 把原始 logits 解释成人类可读的答案。
 * 上层（`laya/analysis.ts`）只负责准备对话上下文，不碰张量。
 *
 * ## 为什么是 ONNX 而不是 Python
 * 打包版是纯 Node + Electron，没有 Python。实测把 `DecisionModel.forward` 导成 ONNX 后，
 * onnxruntime 与 torch 的 logits 偏差 3.1e-06、端到端答案零偏差（docs/LAYA-TRIAGE-FEASIBILITY.md §2.3）。
 *
 * ## 后处理的来源
 * temperature 缩放 / softmax / argmax **不在 ONNX 图里**（在 `laya/agent.py:325-362`），
 * 所以这里照搬那段纯 numpy 逻辑。本 checkpoint 的 `temperature` 实乃全 1.0，
 * 但保留缩放通道：换 checkpoint 时把 `rl_agent_config.json` 放到模型目录即可生效。
 *
 * ## 依赖是 external 的
 * `onnxruntime-node` / `@huggingface/transformers` 是原生/大体积包，**不进后端 bundle**
 * （`scripts/build-wechat-bundle.js` 的 `packages: 'external'`），运行时从 node_modules 解析
 * —— 与 koffi 的加载方式一致（`keys/win32-memory.ts` 是同一先例）。
 * 这里刻意用**变量说明符**做动态 import：让 tsc 不去静态解析这两个包的类型声明，
 * 避免把它们的类型面拖进后端编译。
 */
import { existsSync, readFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { join } from 'node:path'
import { collateItems, toInternal, buildSequence, QTYPES, type LayaItem, type LayaTokenizer } from './build-sequence.ts'
import { layaModelStatus, layaTokenizerDir, formatBytes } from './model-file.ts'
import { defaultChatQuestions, type LayaQuestions, type LayaQuestionKind } from './presets.ts'

/** onnxruntime-node 的最小类型面（只为让本文件可编译；实现细节交给运行时）。 */
interface OrtTensorCtor {
  new (type: 'int64', data: BigInt64Array, dims: readonly number[]): unknown
  new (type: 'bool', data: Uint8Array, dims: readonly number[]): unknown
}
interface OrtSession {
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: ArrayLike<number> }>>
}
interface OrtModule {
  Tensor: OrtTensorCtor
  InferenceSession: { create(path: string, options?: Record<string, unknown>): Promise<OrtSession> }
}
interface TransformersTokenizer {
  encode(text: string, options: { add_special_tokens: boolean }): number[]
}
interface TransformersModule {
  AutoTokenizer: { from_pretrained(path: string, options?: Record<string, unknown>): Promise<TransformersTokenizer> }
}

/** 命题在 UI 层的一种呈现（概率已排序、标签已本地化）。 */
export interface LayaAnswerOption {
  key: string
  label: string
  probability: number
}
export interface LayaAnswer {
  qid: string
  kind: LayaQuestionKind
  /** 问题文本（去掉给模型看的 `dialogue` 标记，直接可展示）。 */
  question: string
  options: LayaAnswerOption[]
  /** 概率最高项的关键字。 */
  top: string
  topProbability: number
  /** `noul` 专用：真那一端的概率。 */
  yes?: number
  /** `score` 专用：加权期望分。 */
  score?: number
  /** `score` 专用：分值上限（如 10）。 */
  scale?: number
  /** 归一化熵置信度（1 - H/log k），与 `laya` 的 confidence 同定义。 */
  confidence: number
}

export interface LayaAnalyzeInput {
  /** 模型输入 state（`{ dialogue }` 或纯字符串），键必须与命题里的引用一致。 */
  state: string | Record<string, unknown>
  questions?: LayaQuestions
  /** 显式模型目录（默认走 `DSH_WECHAT_LAYA_DIR` / 数据目录）。 */
  modelDir?: string
  decryptedDir?: string
}

export interface LayaAnalyzeResult {
  ok: boolean
  error?: string
  /** 模型目录与体积（供 UI 显示「正在用哪个模型」）。 */
  model: { dir: string; bytes: number }
  answers: LayaAnswer[]
  /** 推理耗时（不含模型加载）。 */
  inferenceMs: number
  /** 本次输入的 token 数（批内合计）。 */
  tokens: number
  /** 本次是否复用了已加载的会话。 */
  reused: boolean
}

/** 运行时的可观测状态（供 Remote 暴露给前端）。 */
export interface LayaRuntimeState {
  loaded: boolean
  dir: string
  /** 最近一次推理耗时（毫秒），未跑过为 0。 */
  lastInferenceMs: number
  /** 最近一次失败原因（成功一次即清空）。 */
  lastError: string
}

interface Loaded {
  dir: string
  ort: OrtModule
  session: OrtSession
  tokenizer: LayaTokenizer
  /** 词表体积，用于 UI 展示。 */
  tokenizerBytes: number
  optColsCap: number
}

let loaded: Loaded | null = null
let lastInferenceMs = 0
let lastError = ''
/** 同一时刻只允许一次加载（并发调用共享同一个 Promise）。 */
let loading: Promise<{ ok: boolean; error?: string; note?: string }> | null = null

/** 当前运行时状态。 */
export function layaRuntimeState(): LayaRuntimeState {
  return { loaded: loaded !== null, dir: loaded?.dir ?? '', lastInferenceMs, lastError }
}

/** 卸载模型（释放约 1.2 GB 常驻内存；下次调用会重新加载）。 */
export function layaUnload(): void {
  loaded = null
}

/**
 * 读取可选的温度配置：模型目录下的 `rl_agent_config.json`（laya 官方 checkpoint 里就有）。
 * 缺失时按 1.0 处理（本 checkpoint 的实际值），**不是**错误。
 */
function readTemperatures(dir: string): { base: number[]; byOptions: Record<string, number> } {
  const fallback = { base: [1, 1, 1], byOptions: {} as Record<string, number> }
  const p = join(dir, 'rl_agent_config.json')
  if (!existsSync(p)) return fallback
  try {
    const cfg = JSON.parse(readFileSync(p, 'utf8')) as { temperature?: number[]; temperature_by_options?: Record<string, number> }
    const clamp = (v: unknown): number => {
      const n = Number(v)
      if (!Number.isFinite(n) || n <= 0) return 1
      return Math.min(5, Math.max(0.5, n))
    }
    return {
      base: Array.isArray(cfg.temperature) ? cfg.temperature.map(clamp) : fallback.base,
      byOptions: cfg.temperature_by_options && typeof cfg.temperature_by_options === 'object'
        ? Object.fromEntries(Object.entries(cfg.temperature_by_options).map(([k, v]) => [k, clamp(v)]))
        : {},
    }
  } catch {
    return fallback
  }
}

/** 温度分桶名，对齐 `common.py:219-221 temp_bucket()`。 */
function tempBucket(qtype: number, k: number): string {
  const size = k <= 2 ? '2' : k <= 5 ? '3-5' : k <= 10 ? '6-10' : '11+'
  const kind = qtype === 0 ? 'choice' : qtype === 1 ? 'score' : 'noul'
  return `${kind}:${size}`
}

function softmax(z: number[]): number[] {
  const m = Math.max(...z)
  const e = z.map((v) => Math.exp(v - m))
  const s = e.reduce((a, b) => a + b, 0)
  return e.map((v) => v / s)
}

/** 归一化 Shannon 熵置信度，对齐 `common.py:210-216`。 */
function confidenceFromProbs(p: number[]): number {
  const k = p.length
  if (k < 2) return 1
  const ent = -p.reduce((a, v) => a + (v > 0 ? v * Math.log(v) : 0), 0)
  return Math.min(1, Math.max(0, 1 - ent / Math.log(k)))
}

/**
 * 加载模型与分词器（幂等；模型目录变化时自动重载）。
 * 失败**不缓存**（照 koffi 的先例：一次失败不该让整个功能永久瘫痪），下次调用可重试。
 */
export async function layaEnsureLoaded(
  modelDir?: string,
  decryptedDir?: string,
): Promise<{ ok: boolean; error?: string }> {
  const status = layaModelStatus(modelDir, decryptedDir)
  if (!status.installed) {
    return { ok: false, error: `模型未就绪：${status.missing.join('；')}` }
  }
  if (loaded !== null && loaded.dir === status.dir) return { ok: true }
  if (loading !== null) return loading

  loading = (async (): Promise<{ ok: boolean; error?: string }> => {
    try {
      // 变量说明符：让 tsc 不静态解析这两个外部包（见文件头注释）。
      const ortSpec = 'onnxruntime-node'
      const tokSpec = '@huggingface/transformers'
      const ort = (await import(ortSpec)) as unknown as OrtModule
      const { AutoTokenizer } = (await import(tokSpec)) as unknown as TransformersModule

      const tokDir = layaTokenizerDir(status.dir)
      const tok = await AutoTokenizer.from_pretrained(tokDir, { local_files_only: true })
      const one = (t: string): number => {
        const ids = tok.encode(t, { add_special_tokens: false })
        const first = Array.isArray(ids) ? ids[0] : undefined
        if (first === undefined || !Number.isFinite(first)) {
          throw new Error(`分词器无法解析特殊标记 ${t}（得到 ${JSON.stringify(ids)}）`)
        }
        return first
      }
      const tokenizer: LayaTokenizer = {
        clsId: one('<bos>'),
        sepId: one('<eos>'),
        maskId: one('<mask>'),
        padId: one('<pad>'),
        encode: (text: string) => tok.encode(text, { add_special_tokens: false }),
      }

      const session = await ort.InferenceSession.create(status.path, {
        intraOpNumThreads: Math.max(1, Math.min(8, cpus().length)),
        interOpNumThreads: 1,
      })

      let tokenizerBytes = 0
      try {
        tokenizerBytes = readFileSync(join(tokDir, 'tokenizer.json')).byteLength
      } catch { /* 体积只用于展示，取不到不算失败 */ }

      loaded = { dir: status.dir, ort, session, tokenizer, tokenizerBytes, optColsCap: 16 }
      lastError = ''
      return { ok: true }
    } catch (e) {
      lastError = (e as Error).message
      loaded = null
      return { ok: false, error: `laya 运行时加载失败：${lastError}` }
    } finally {
      loading = null
    }
  })()

  return loading
}

/**
 * 跑一次分析：把 state 对一组命题做一次并行 forward，返回可展示的答案。
 *
 * 失败返回 `{ ok: false, error }`——调用方据此降级（不要抛，降级是本功能的正常路径）。
 */
export async function layaAnalyze(input: LayaAnalyzeInput): Promise<LayaAnalyzeResult> {
  const questions = input.questions ?? defaultChatQuestions()
  const empty = { dir: input.modelDir ?? '', bytes: 0 }
  const ensure = await layaEnsureLoaded(input.modelDir, input.decryptedDir)
  if (!ensure.ok || loaded === null) {
    return { ok: false, error: ensure.error ?? 'laya 运行时未就绪', model: empty, answers: [], inferenceMs: 0, tokens: 0, reused: false }
  }
  const l = loaded

  const status = layaModelStatus(input.modelDir, input.decryptedDir)
  const model = { dir: l.dir, bytes: status.bytes }
  const temps = readTemperatures(l.dir)

  // 走 entries 而不是 keys + 索引：既能保证后面拿到的命题非空，也不给「键存在但值缺失」留缝。
  const entries = Object.entries(questions)
  if (entries.length === 0) {
    return { ok: false, error: '没有可用的命题', model, answers: [], inferenceMs: 0, tokens: 0, reused: true }
  }
  const ids = entries.map(([qid]) => qid)

  const items: LayaItem[] = []
  const internals = entries.map(([qid, q]) => {
    const internal = toInternal(q)
    const seq = buildSequence(l.tokenizer, input.state, internal)
    items.push({ qid, ids: seq.ids, markers: seq.markers, qtype: QTYPES[internal.t] })
    return internal
  })

  const batch = collateItems(items, l.tokenizer.padId)
  if (batch.optCols > l.optColsCap) {
    return {
      ok: false,
      error: `选项数超出模型头部上限（${batch.optCols} > ${l.optColsCap}）`,
      model, answers: [], inferenceMs: 0, tokens: 0, reused: true,
    }
  }

  let logits: ArrayLike<number>
  const t0 = Date.now()
  try {
    const out = await l.session.run({
      input_ids: new l.ort.Tensor('int64', BigInt64Array.from(batch.inputIds.flat().map(BigInt)), [batch.inputIds.length, batch.seqLen]),
      attention_mask: new l.ort.Tensor('int64', BigInt64Array.from(batch.attentionMask.flat().map(BigInt)), [batch.attentionMask.length, batch.seqLen]),
      marker_pos: new l.ort.Tensor('int64', BigInt64Array.from(batch.markerPos.flat().map(BigInt)), [batch.markerPos.length, batch.optCols]),
      marker_mask: new l.ort.Tensor('bool', Uint8Array.from(batch.markerMask.flat().map((v) => (v ? 1 : 0))), [batch.markerMask.length, batch.optCols]),
      qtype: new l.ort.Tensor('int64', BigInt64Array.from(batch.qtype.map(BigInt)), [batch.qtype.length]),
    })
    const firstKey = Object.keys(out)[0]
    const raw = out.logits ?? (firstKey === undefined ? undefined : out[firstKey])
    if (raw === undefined) throw new Error('模型没有返回 logits 输出')
    logits = raw.data
  } catch (e) {
    lastError = (e as Error).message
    return { ok: false, error: `laya 推理失败：${lastError}`, model, answers: [], inferenceMs: 0, tokens: 0, reused: true }
  }
  const inferenceMs = Date.now() - t0
  lastInferenceMs = inferenceMs
  lastError = ''

  const answers = postprocessAnswers({
    logits, items, questions, qids: ids, optCols: batch.optCols, temperatures: temps,
  })
  const tokens = items.reduce((a, it) => a + it.ids.length, 0)

  return { ok: true, model, answers, inferenceMs, tokens, reused: true }
}

/** 后处理入参（抽出来是为了能脱离 onnxruntime 单测）。 */
export interface LayaPostprocessInput {
  /** 模型原始输出，按 `[item][option]` 行主序展平（长度 = items.length × optCols）。 */
  logits: ArrayLike<number>
  items: LayaItem[]
  questions: LayaQuestions
  /** 与 `items` 同序的命题键。 */
  qids: string[]
  /** 每行的列数（= collate 后的 marker 列数）。 */
  optCols: number
  temperatures: { base: number[]; byOptions: Record<string, number> }
}

/**
 * 把原始 logits 解释成可展示的答案——**逐行照搬 `laya/agent.py:325-362`**：
 * 按题型的温度分桶取缩放值 → softmax → 按题型组装（choice 给分布 / score 给期望分 / noul 给真值概率）。
 *
 * 抽成纯函数是为了能直接用 fixture 里的 `logits` 做回归：CI 上没有 1.2 GB 模型，
 * 但「后处理是否与 Python 一致」必须有人守。
 */
export function postprocessAnswers(input: LayaPostprocessInput): LayaAnswer[] {
  const answers: LayaAnswer[] = []
  for (let r = 0; r < input.items.length; r += 1) {
    const qid = input.qids[r]
    const it = input.items[r]
    if (qid === undefined || it === undefined) continue
    const q = input.questions[qid]
    if (q === undefined) continue
    const k = it.markers.length
    if (k === 0) continue
    const scale = input.temperatures.byOptions[tempBucket(it.qtype, k)] ?? input.temperatures.base[it.qtype] ?? 1
    const z: number[] = []
    for (let i = 0; i < k; i += 1) z.push(Number(input.logits[r * input.optCols + i]) / scale)
    const p = softmax(z)
    const confidence = confidenceFromProbs(p)
    const question = String(q.instructions).replace(/`dialogue`/g, '对话').trim()

    if (q.type === 'choice') {
      const keys = Object.keys(q.criteria)
      const options: LayaAnswerOption[] = keys.map((key, i) => ({
        key,
        label: q.criteria[key] ?? key,
        probability: Math.round((p[i] ?? 0) * 1e4) / 1e4,
      })).sort((a, b) => b.probability - a.probability)
      answers.push({
        qid, kind: 'choice', question, options,
        top: options[0]?.key ?? '', topProbability: options[0]?.probability ?? 0, confidence,
      })
    } else if (q.type === 'score') {
      const options: LayaAnswerOption[] = q.criteria.map((label: string, i: number) => ({
        key: String(i),
        label,
        probability: Math.round((p[i] ?? 0) * 1e4) / 1e4,
      }))
      const score = Math.round(p.reduce((a, v, i) => a + i * v, 0) * 1e4) / 1e4
      const best = options.reduce((a, b) => (a.probability >= b.probability ? a : b))
      answers.push({
        qid, kind: 'score', question, options,
        top: best.key, topProbability: best.probability, score,
        scale: q.scale ?? q.criteria.length - 1, confidence,
      })
    } else {
      const yes = Math.round((p[1] ?? 0) * 1e4) / 1e4
      const labels = q.labels ?? { false: '不是', true: '是' }
      const options: LayaAnswerOption[] = [
        { key: 'false', label: labels.false, probability: Math.round((1 - yes) * 1e4) / 1e4 },
        { key: 'true', label: labels.true, probability: yes },
      ].sort((a, b) => b.probability - a.probability)
      answers.push({
        qid, kind: 'noul', question, options, yes,
        top: options[0]?.key ?? '', topProbability: options[0]?.probability ?? 0, confidence,
      })
    }
  }
  return answers
}

/** 供 UI 展示的模型体积文案。 */
export function layaModelSizeLabel(bytes: number): string {
  return formatBytes(bytes)
}
