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
import { layaModelKey, readAnalysisCache, writeAnalysisCache, type CachedAnalysis } from './store.ts'
import { queryMessages } from '../query/messages.ts'
import { messageText } from '../query/reply-suggest.ts'
import { cachedTranscript } from '../query/voice-transcribe.ts'

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
      // 只给一句概括：明细（缺哪个文件、期望目录）由 UI 从 `status.missing` 渲染成清单，
      // 这里再拼一遍会在卡片上出现两段一模一样的缺失列表。
      error: '本地决策模型未就绪',
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

// ---------------------------------------------------------------------------
// 逐条分析：消息流里每条（对方）消息下方的分析
// ---------------------------------------------------------------------------

/** 逐条分析的目标：一条消息的定位信息（前端从消息对象里直接拿得到）。 */
export interface LayaTargetRef {
  /** 会话内唯一 id（自增，会话范围作用域）。 */
  localId: number
  /** 毫秒稳定序键 —— 也是消息分页的游标键。 */
  sortSeq: number
}

/** 一条消息的分析结果。 */
export interface LayaMessageAnalysis {
  localId: number
  ok: boolean
  /** 单条失败原因（模型未就绪是**会话级**错误，不在这里）。 */
  error?: string
  /** 被分析的文本（语音则是转写后的文本）。 */
  sourceText: string
  /** 文本是否来自语音转写。 */
  fromVoice: boolean
  answers: LayaAnswer[]
  /** 本次推理耗时（命中缓存时为 0）。 */
  inferenceMs: number
  /** 是否命中缓存（未重新推理）。 */
  cached: boolean
}

/**
 * 语音转写器 —— 由调用方注入。
 * 为什么注入而不是自己调：转写需要 whisper 的引擎路径/模型目录/模型 id，那些是配置层的知识
 * （`getConfig` + `resolveWhisperModelsDir` + `whisperEnginePath`），不该由 laya 层去读。
 */
export type LayaVoiceTranscriber = (
  localId: number,
  serverId: string,
) => { ok: boolean; text?: string; error?: string }

export interface LayaVisibleAnalysisInput {
  decryptedDir: string
  /** 解码目录（读语音转写的磁盘缓存）。 */
  decodedDir: string
  talker: string
  selfUsername?: string
  targets: readonly LayaTargetRef[]
  contextLimit?: number
  modelDir?: string
  /** 缺省时不转写语音：那条消息会以「语音未转写」失败，而不是静默跳过。 */
  transcribe?: LayaVoiceTranscriber
  /** 关掉缓存（测试用）。 */
  useCache?: boolean
}

export interface LayaVisibleAnalysisResult {
  ok: boolean
  /** 会话级错误（模型未就绪 / 缺会话）——单条问题在 `items[].error`。 */
  error?: string
  model: { dir: string; bytes: number }
  modelKey: string
  items: LayaMessageAnalysis[]
}

/** 单次最多分析多少条：一次请求里跑十几条 × 0.5 s 已经接近请求超时，前端据此分批。 */
export const MAX_ANALYZE_BATCH = 12

/**
 * 取「目标消息 + 它之前的 `limit - 1` 条」。
 *
 * 两个坑都在这里：
 *  1. 游标语义是 `sort_seq < cursor`（**不含等于**），所以传 `sortSeq + 1` 才能把目标自己圈进来；
 *  2. `sort_seq` 存在重复（本机实测 14 张 Msg_ 表有重复值），所以不能假设「一圈就是一条」——
 *     结果里可能有同一毫秒的其它消息，必须按 `localId` **定位目标并截断**，
 *     否则会把目标之后发出的消息当成上下文（那等于让模型看未来）。
 */
function collectUpToTarget(
  decryptedDir: string,
  talker: string,
  target: LayaTargetRef,
  limit: number,
  selfUsername?: string,
): { messages: readonly { localId: number; type?: number; isSender: number; displayText?: string; strContent?: string; msgContent?: string; renderType?: string; serverId?: string }[]; found: boolean } {
  // 多取 8 条：同行（同 sort_seq）的消息数量不可预知，截断后再收敛到 limit。
  const snap = queryMessages(decryptedDir, talker, limit + 8, target.sortSeq + 1, selfUsername)
  const idx = snap.messages.findIndex((m) => m.localId === target.localId)
  if (idx < 0) {
    // 目标不在这一页（极旧的会话 / 已被清理）：退回「最近 limit 条」，并在结果里标 found=false。
    return { messages: snap.messages.slice(-limit), found: false }
  }
  const start = Math.max(0, idx + 1 - limit)
  return { messages: snap.messages.slice(start, idx + 1), found: true }
}

/**
 * 逐条分析一批消息（消息流可见窗口驱动）。
 *
 * 每条独立：取「该消息及之前」的上下文 → （语音先转写）→ 本地推理 → 结果落缓存。
 * **单条失败不拖垮整批**（`items[].ok=false` 带原因），只有模型未就绪这类会话级问题才整体 `ok=false`。
 */
export async function analyzeVisibleMessages(
  input: LayaVisibleAnalysisInput,
): Promise<LayaVisibleAnalysisResult> {
  const talker = String(input.talker ?? '').trim()
  const empty: LayaVisibleAnalysisResult = {
    ok: false, model: { dir: '', bytes: 0 }, modelKey: '', items: [],
  }
  if (talker === '') return { ...empty, error: '缺少会话' }
  if (input.targets.length === 0) return { ...empty, error: '没有要分析的消息' }

  const status = layaModelStatus(input.modelDir, input.decryptedDir)
  if (!status.installed) {
    return {
      ...empty,
      error: '本地决策模型未就绪',
      model: { dir: status.dir, bytes: status.bytes },
    }
  }
  const modelKey = layaModelKey(status.path)
  const targets = input.targets.slice(0, MAX_ANALYZE_BATCH)
  const useCache = input.useCache !== false

  const cached = useCache
    ? readAnalysisCache(input.decryptedDir, talker, modelKey, targets.map((t) => t.localId))
    : new Map<number, CachedAnalysis>()

  const items: LayaMessageAnalysis[] = []
  const toWrite: Array<{ localId: number; sourceText: string; fromVoice: boolean; answers: LayaAnswer[] }> = []
  const limit = Math.max(2, Math.min(Math.trunc(input.contextLimit ?? DEFAULT_CONTEXT), MAX_CONTEXT))

  for (const target of targets) {
    const hit = cached.get(target.localId)
    if (hit) {
      items.push({
        localId: target.localId, ok: true, sourceText: hit.sourceText, fromVoice: hit.fromVoice,
        answers: hit.answers, inferenceMs: 0, cached: true,
      })
      continue
    }

    const picked = collectUpToTarget(input.decryptedDir, talker, target, limit, input.selfUsername)
    const msgs = picked.messages
    if (msgs.length === 0) {
      items.push({ localId: target.localId, ok: false, error: '取不到这条消息', sourceText: '', fromVoice: false, answers: [], inferenceMs: 0, cached: false })
      continue
    }

    const targetMsg = msgs[msgs.length - 1]
    if (targetMsg === undefined) {
      items.push({ localId: target.localId, ok: false, error: '取不到这条消息', sourceText: '', fromVoice: false, answers: [], inferenceMs: 0, cached: false })
      continue
    }
    if (targetMsg.isSender === 1) {
      items.push({ localId: target.localId, ok: false, error: '自己发的消息不做分析', sourceText: '', fromVoice: false, answers: [], inferenceMs: 0, cached: false })
      continue
    }

    // 语音：先转写再分析（转写有自己的磁盘缓存，不重算）
    let fromVoice = false
    let text = messageText(targetMsg)
    if (targetMsg.renderType === 'voice' || targetMsg.type === 34) {
      fromVoice = true
      const svrId = String(targetMsg.serverId ?? '')
      const cachedText = svrId === '' ? '' : cachedTranscript(input.decodedDir, svrId)
      if (cachedText !== '') {
        text = cachedText
      } else if (input.transcribe) {
        const r = input.transcribe(target.localId, svrId)
        text = r.ok ? String(r.text ?? '').trim() : ''
        if (text === '') {
          items.push({
            localId: target.localId, ok: false, fromVoice: true,
            error: r.ok ? '语音转写结果为空' : (r.error ?? '语音转写失败'),
            sourceText: '', answers: [], inferenceMs: 0, cached: false,
          })
          continue
        }
      } else {
        items.push({ localId: target.localId, ok: false, fromVoice: true, error: '未配置语音转写', sourceText: '', answers: [], inferenceMs: 0, cached: false })
        continue
      }
    }

    // 拼对话：双方消息都进（判断意图要看到「我」说了什么）；历史里的语音用**已有缓存**补文本，
    // 但不为它们触发转写（那会把一次请求变成 N 次 whisper 调用）。
    const lines: string[] = []
    for (let i = 0; i < msgs.length; i += 1) {
      const m = msgs[i]
      if (m === undefined) continue
      let t = i === msgs.length - 1 ? text : messageText(m)
      if (t === '' && (m.renderType === 'voice' || m.type === 34)) {
        const svr = String(m.serverId ?? '')
        t = svr === '' ? '' : cachedTranscript(input.decodedDir, svr)
      }
      if (t === '') continue
      lines.push(`${m.isSender === 1 ? '我' : '对方'}：${t}`)
    }
    const dialogue = lines.join('\n')
    if (dialogue === '') {
      items.push({ localId: target.localId, ok: false, fromVoice, error: '这条消息没有可分析的文本', sourceText: text, answers: [], inferenceMs: 0, cached: false })
      continue
    }

    const r = await layaAnalyze({ state: { dialogue }, modelDir: input.modelDir, decryptedDir: input.decryptedDir })
    if (!r.ok) {
      items.push({ localId: target.localId, ok: false, fromVoice, error: r.error ?? '推理失败', sourceText: text, answers: [], inferenceMs: 0, cached: false })
      continue
    }
    items.push({
      localId: target.localId, ok: true, sourceText: text, fromVoice,
      answers: r.answers, inferenceMs: r.inferenceMs, cached: false,
    })
    toWrite.push({ localId: target.localId, sourceText: text, fromVoice, answers: r.answers })
  }

  if (useCache && toWrite.length > 0) {
    writeAnalysisCache(input.decryptedDir, talker, modelKey, toWrite)
  }

  return {
    ok: true,
    model: { dir: status.dir, bytes: status.bytes },
    modelKey,
    items,
  }
}
