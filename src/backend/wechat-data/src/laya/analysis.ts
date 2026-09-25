/**
 * 「消息决策分析」的上下文收集（**数据层 + 一次本地推理调用**）。
 *
 * 分工与 `query/reply-suggest.ts` 对称：
 *   · `query/reply-suggest.ts` 取上下文喂给 **LLM**（生成回复句子，走出网闸门）；
 *   · 这里取上下文喂给 **laya**（判断意图/情绪/紧张度，**纯本地、不出网**）。
 *
 * 两者互补：laya 最擅长的「现在该做什么」里就有「先搜索历史聊天记录」这一项——
 * 那正是本应用自带的 FTS 搜索能力。
 */
import { layaAnalyze, type LayaAnswer } from './runtime.ts'
import { layaModelStatus } from './model-file.ts'
import { defaultChatQuestions, type LayaQuestions } from './presets.ts'
import { queryMessages } from '../query/messages.ts'
import { messageText } from '../query/reply-suggest.ts'

/** 默认取多少条作为上下文（laya 的 max_len 是 1024 token，20 条中文对话通常在预算内）。 */
const DEFAULT_CONTEXT = 20
/** 上限：再多也不会更准，只会挤掉模型头的选项预算。 */
const MAX_CONTEXT = 60

/** 对话里的一轮。 */
export interface LayaTurn {
  /** 是否本人发送。 */
  self: boolean
  text: string
}

/** 一段可直接喂给模型的对话上下文。 */
export interface LayaDialogue {
  /** `我：…` / `对方：…` 逐行拼接（模型按这个格式读）。 */
  dialogue: string
  /** 被分析的那句（最近一条**对方**消息）。 */
  latestPeer: string
  /** 截断后保留的轮次。 */
  turns: LayaTurn[]
}

/**
 * 构造对话上下文。
 *
 * **关键：截断到「最近一条对方消息」为止**——命题里说的「最后一句话」必须指向对方，
 * 否则对方之后我发的消息会让模型去分析我自己说的话，语义整个跑偏。
 *
 * @returns 该会话没有对方文本消息时，`dialogue` 与 `latestPeer` 均为空串。
 */
export function buildDialogueState(
  decryptedDir: string,
  talker: string,
  selfUsername?: string,
  limit = DEFAULT_CONTEXT,
): LayaDialogue {
  const cap = Math.max(1, Math.min(Math.trunc(limit) || DEFAULT_CONTEXT, MAX_CONTEXT))
  // queryMessages 已按时间正序返回；第 5 参是 selfUsername（用于标注「我」）。
  const snapshot = queryMessages(decryptedDir, talker, cap, undefined, selfUsername)
  const turns: LayaTurn[] = []
  for (const m of snapshot.messages) {
    const text = messageText(m)
    if (text === '') continue
    turns.push({ self: m.isSender === 1, text })
  }
  let lastPeer = -1
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const t = turns[i]
    if (t !== undefined && !t.self) { lastPeer = i; break }
  }
  if (lastPeer < 0) return { dialogue: '', latestPeer: '', turns: [] }
  const kept = turns.slice(0, lastPeer + 1)
  return {
    dialogue: kept.map((t) => `${t.self ? '我' : '对方'}：${t.text}`).join('\n'),
    latestPeer: kept[kept.length - 1]?.text ?? '',
    turns: kept,
  }
}

/** 一次分析请求。 */
export interface LayaAnalysisInput {
  decryptedDir: string
  /** 会话 username。 */
  talker: string
  selfUsername?: string
  /** 上下文条数（默认 20，上限 60）。 */
  contextLimit?: number
  /** 显式模型目录（默认走 `DSH_WECHAT_LAYA_DIR` / 数据目录）。 */
  modelDir?: string
  /** 自定义命题组（默认 `defaultChatQuestions()`）。 */
  questions?: LayaQuestions
}

/** 一次分析结果。 */
export interface LayaAnalysisResult {
  ok: boolean
  /** 失败原因（模型未就绪 / 会话无可分析内容 / 推理异常）。 */
  error?: string
  /** 被分析的那句。 */
  latestPeer: string
  /** 实际使用的上下文条数。 */
  contextLines: number
  /** 交给模型的对话文本（便于对照与排查）。 */
  dialogue: string
  /** 逐命题的答案（按命题组定义顺序）。 */
  answers: LayaAnswer[]
  /** 是否使用了模型（false 表示走了降级路径，答案由规则给出）。 */
  usedModel: boolean
  /** 降级说明（`usedModel=false` 时非空，如实写明原因）。 */
  note: string
  inferenceMs: number
  tokens: number
  model: { dir: string; bytes: number }
}

/**
 * 分析一个会话：取上下文 → 本地推理 → 返回可展示的答案。
 *
 * **不抛异常**：模型缺失/加载失败/推理异常都折叠成 `{ ok:false }` 或降级结果，
 * 由调用方决定怎么呈现（这是本功能的正常路径，不是异常路径）。
 */
export async function analyzeSession(input: LayaAnalysisInput): Promise<LayaAnalysisResult> {
  const talker = String(input.talker ?? '').trim()
  const empty: LayaAnalysisResult = {
    ok: false, latestPeer: '', contextLines: 0, dialogue: '', answers: [],
    usedModel: false, note: '', inferenceMs: 0, tokens: 0, model: { dir: '', bytes: 0 },
  }
  if (talker === '') return { ...empty, error: '缺少会话' }

  const ctx = buildDialogueState(input.decryptedDir, talker, input.selfUsername, input.contextLimit)
  if (ctx.dialogue === '') {
    return { ...empty, error: '这个会话还没有可分析的对方消息' }
  }

  const status = layaModelStatus(input.modelDir, input.decryptedDir)
  const questions = input.questions ?? defaultChatQuestions()

  if (!status.installed) {
    // 降级：模型没就绪时**不编造判断**，如实说明并给出可执行的下一步。
    return {
      ok: false,
      error: `本地决策模型未就绪：${status.missing.join('；')}`,
      latestPeer: ctx.latestPeer,
      contextLines: ctx.turns.length,
      dialogue: ctx.dialogue,
      answers: [],
      usedModel: false,
      note: `模型目录：${status.dir}`,
      inferenceMs: 0,
      tokens: 0,
      model: { dir: status.dir, bytes: status.bytes },
    }
  }

  const r = await layaAnalyze({
    state: { dialogue: ctx.dialogue },
    questions,
    modelDir: input.modelDir,
    decryptedDir: input.decryptedDir,
  })

  return {
    ok: r.ok,
    error: r.error,
    latestPeer: ctx.latestPeer,
    contextLines: ctx.turns.length,
    dialogue: ctx.dialogue,
    answers: r.answers,
    usedModel: r.ok,
    note: r.ok ? '' : '推理失败，未产出判断',
    inferenceMs: r.inferenceMs,
    tokens: r.tokens,
    model: r.model,
  }
}
