/**
 * AI 年报叙述（W2-8.6）的 @Remote 处理器。
 *
 * ## 这条链路长什么样
 *
 * `collectAnnualSegments`（query 层，纯取材、有界）→ 每段一次 `llm.stream`
 * （**不把整年塞进一次调用**）→ 逐段拼成叙述。LLM 调用只能在这里做：
 * 它需要 `ctx.llm`，而 query 层拿不到 Context。
 *
 * ## 三条纪律
 *
 * ① **进度与取消沿用 M3/W2-8.2 那一套**（jobId → 本地 `onProgress` + `AbortController`），
 *    不引入新概念。扫描阶段总量未知（`total: 0`），段生成阶段才是定量的 `done/total`。
 * ② **取消 ⇒ 什么都不写**：本方法不落任何持久状态（不进 `cachedBySig`、
 *    不写 summary 记录）。半张年报进缓存 = 接下来 TTL 里每次都拿到残缺的。
 * ③ **某一段失败 ⇒ 已算完的段留着，失败如实说**：不抛错吞掉整份，
 *    也不假装成功。取消则是另一回事 —— 取消必须让整个调用以 `AbortError` 结束。
 *
 * @module remotes/annual-narr
 */
import { collectAnnualSegments } from '../query/annual-segments.ts'
import { StreamControl, throwIfCancelled } from '../query/zip.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { PrivacyGateFn } from '../gateway-privacy.ts'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { OperationCategory, OperationStatus } from '../types.ts'

/** LLM 单段输出上限（一段是 4000 字符输入，给它 600 token 足够写一小节）。 */
const SEGMENT_MAX_TOKENS = 600

export interface createAnnualNarrRemotesInputs {
  normalizeJobId: (jobId?: unknown) => string
  dirs: () => { decrypted: string; decoded: string }
  op: (category: OperationCategory, action: string, status: OperationStatus, target?: string, detail?: string) => void
  streamControl: (jobId?: string) => StreamControl
  finishStreamJob: (jobId: string, error?: string) => void
  ctx: () => Context
  privacyGate: PrivacyGateFn
}

/** 一段的结果。 */
export interface AnnualSegmentResult {
  label: string
  text: string
  /** 这一段有没有成功（失败时 text 是失败原因，如实说）。 */
  ok: boolean
}

/** AI 年报叙述结果。 */
export interface AnnualNarrativeResult {
  ok: boolean
  year: number
  segments: AnnualSegmentResult[]
  /** 拼接好的全文（段与段之间空行）。 */
  text: string
  /** 段数是否被 MAX_SEGMENTS 截断（界面要说，别让用户以为覆盖了整年）。 */
  truncated: boolean
  error?: string
}

export function createAnnualNarrRemotes(rc: createAnnualNarrRemotesInputs) {
  return {
    /**
     * 生成 AI 年报叙述：分段取材、逐段 LLM、逐段进度、可取消。
     * @param options - 年份 + 可选的进度任务标识。
     * @returns 各段结果 + 拼接全文。
     */
    async generateAnnualNarrative(options: { year: number; jobId?: string }): Promise<AnnualNarrativeResult> {
      const year = options.year
      const jobId = rc.normalizeJobId(options?.jobId)
      const ctrl = rc.streamControl(jobId)
      try {
        // ── 取材（纯 CPU，有让出与取消）──
        ctrl.onProgress?.({ phase: 'collect', done: 0, total: 0 })
        const collected = await collectAnnualSegments(rc.dirs().decrypted, year, {
          signal: ctrl.signal,
          onScanProgress: (rows) => { ctrl.onProgress?.({ phase: 'scan', done: rows, total: 0 }) },
        })
        throwIfCancelled(ctrl.signal)
        const total = collected.segments.length
        if (total === 0) {
          rc.op('task', 'annual_narrative', 'ok', String(year), '该年没有可总结的文本消息')
          return { ok: true, year, segments: [], text: '', truncated: false }
        }

        // ── 逐段 LLM ──
        const ctx = rc.ctx()
        const sel = (ctx as unknown as {
          agentDefaultModel?: { currentSelection(): { provider: string; model: string; reasoningEffort?: string } }
        }).agentDefaultModel?.currentSelection()
        const llm = ctx.llm
        const out: AnnualSegmentResult[] = []
        let cancelled = false
        for (let i = 0; i < collected.segments.length; i += 1) {
          // 每个段边界查取消：这是用户按下「停止」时**唯一**保证不会白烧一整段 LLM 的地方。
          if (ctrl.signal?.aborted === true) { cancelled = true; break }
          const seg = collected.segments[i]
          if (!seg) continue
          ctrl.onProgress?.({ phase: 'segment', done: i, total })
          const prompt = '下面是 ' + String(year) + ' 年' + seg.label + '的微信聊天片段，请用中文写一段简洁的月度小结（不超过 120 字）：\n\n' + seg.lines.join('\n')
          out.push(await runSegment(rc, ctrl, llm, sel, prompt, seg.lines.length, seg.label))
          ctrl.onProgress?.({ phase: 'segment', done: i + 1, total })
        }
        if (cancelled) {
          // 取消：一个字节都不写，直接以 AbortError 结束（界面据此不弹错误框）。
          throwIfCancelled(ctrl.signal)
        }
        const text = out.filter(s => s.ok).map(s => s.text).join('\n\n')
        const failed = out.filter(s => !s.ok).length
        rc.op('task', 'annual_narrative', 'ok', String(year),
          `${out.length} 段${failed > 0 ? '（' + String(failed) + ' 段失败）' : ''}${collected.truncated ? ' · 已截断' : ''}`)
        return { ok: failed === 0, year, segments: out, text, truncated: collected.truncated }
      } catch (e) {
        const canceled = ctrl.signal?.aborted === true
        // OperationStatus 只有 ok | fail | skip —— **没有 canceled**。
        // 「用户取消」不该被记成一次失败：操作日志是给人看「哪里坏了」的，
        // 把取消混进去会让真正的失败被噪音埋掉。（M3 那边把取消态放在
        // 导出历史的 status 字段里，这里是操作日志，两处口径不同。）
        rc.op('task', 'annual_narrative', canceled ? 'skip' : 'fail', String(year),
          canceled ? '用户取消' : (e as Error).message)
        if (canceled) throw e
        return { ok: false, year, segments: [], text: '', truncated: false, error: (e as Error).message }
      } finally {
        // 两种路径都要清在飞槽：取消也不例外（否则下一次同名 jobId 会撞上「上一个还在跑」）。
        rc.finishStreamJob(jobId)
      }
    },
  }
}

/**
 * 跑一段 LLM。**模块级**：它是纯编排，放进 `createAnnualNarrRemotes` 只会让那个
 * 函数体顶到记账棘轮上；而且它要被判据单独钉住（隐私闸门、首 token 超时、取消语义）。
 * @param rc - 处理器上下文。
 * @param ctrl - 进度 + 取消令牌。
 * @param llm - LLM 接口。
 * @param sel - 默认模型选择。
 * @param prompt - 本段提示词。
 * @param lineCount - 本段原文行数（隐私闸门的统计口径）。
 * @param label - 段名（失败原因里要带上它，否则用户不知道是哪个月坏了）。
 * @returns 本段结果。
 */
async function runSegment(
  rc: createAnnualNarrRemotesInputs,
  ctrl: StreamControl,
  llm: Context['llm'],
  sel: { provider: string; model: string; reasoningEffort?: string } | undefined,
  prompt: string,
  lineCount: number,
  label: string,
): Promise<AnnualSegmentResult> {
  if (!sel?.provider || !sel.model) {
    return { label, text: '（未配置默认模型，本段未生成）', ok: false }
  }
  const [gated] = rc.privacyGate('annual_narrative', { sessions: 0, messages: lineCount }, [prompt])
  const userMsg = createUserMessage({
    content: [{ type: 'text', text: gated ?? prompt }],
    source: { kind: 'plugin', plugin: 'dsh-wechat-data' },
  })
  const opts: GenerateOptions = {
    provider: sel.provider,
    model: sel.model,
    messages: [userMsg],
    system: '你是微信年度回顾写手，按给定的月度片段写中文小结。',
    maxTokens: SEGMENT_MAX_TOKENS,
  }
  const assembler = new BlockAssembler()
  try {
    for await (const chunk of llm.stream(opts)) {
      // 流里也要能停：一段 600 token 的生成有好几秒，用户在这期间点「停止」必须立刻生效。
      throwIfCancelled(ctrl.signal)
      assembler.push(chunk)
    }
    return { label, text: assembler.blocks().map(b => (b.type === 'text' ? b.text : '')).join('').trim(), ok: true }
  } catch (e) {
    if (ctrl.signal?.aborted === true) throw e
    return { label, text: '（' + label + ' 生成失败：' + (e as Error).message + '）', ok: false }
  }
}