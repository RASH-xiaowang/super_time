
/**
 * 总结记录（每日/周期总结生成、记录删除、推荐回复） 的 @Remote 处理器（M21 自 `gateway.ts` 搬出）。
 *
 * 机制：类里保留 @Remote 装饰器与签名（协议层按名字枚举），方法体一行转发；
 * 处理器体在这里，依赖由 `rc` 显式给出。
 */
import { collectDayMessagesAsync, collectPeriodMessages, collectPeriodMessagesAsync } from '../query/daily-summary.ts'
import { buildSummaryPrompt, type SummaryFormat } from '../query/summary-prompt.ts'
import { yieldToLoop } from '../query/search-build.ts'
import {
  buildReplyPrompt,
  collectReplyContext,
  parseReplyCandidates,
  REPLY_SUGGEST_CONTEXT_LIMIT,
} from '../query/reply-suggest.ts'
import { collectReplyKbSnippetsHybrid } from '../query/reply-kb.ts'
import type { EmbedFn } from '../query/vector-math.ts'
import { deleteSummaryRecord as delRec, saveSummaryRecord as saveRec } from '../query/summary-tasks.ts'
import { DailySummaryResult, OperationCategory, OperationStatus, PeriodSummaryResult, ReplySuggestResult, SummaryTaskMutationResult, SummaryTaskRunResult } from '../types.ts'
import type { ReplyTrace } from '../types-analysis.ts'
import {
  readReplySuggestCache,
  replySuggestCacheKey,
  writeReplySuggestCache,
} from '../query/reply-suggest-cache.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { PrivacyGateFn } from '../gateway-privacy.ts'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

/**
 * 首 token 超时（D1，2026-09-28 性能修复）。
 *
 * 现场日志 `suggestReplies` 69 次 / 均 8.2s / **p99 89s**：均值的量级合理（远端 LLM 就该这个数），
 * 但 p99 到 89 秒说明**有请求整个卡死**——`llm.stream` 只受仓库默认的 120s 总超时约束，
 * 若 provider 连第一个 token 都没吐，用户就要瞪着「思考中」等到两分钟。15 秒足够覆盖
 * 正常 provider 的排队+首 token（远小于总生成耗时），又能在真卡住时快速失败。
 */
const FIRST_TOKEN_TIMEOUT_MS = 15_000

/** 推荐回复的输出上限（3 条候选约 150 token，320 留了两倍余量）。 */
const REPLY_SUGGEST_MAX_TOKENS = 320

/**
 * 知识库检索的超时上限。
 *
 * 稠密通道要先调一次向量模型，大库的索引扫描也不是常数时间；这两件事都可能
 * 比模型生成更慢。超过就把片段当作空、按纯对话推荐继续 —— 用户要的是候选，
 * 不是「等一个可能失败的知识库」。
 */
const KB_RETRIEVE_TIMEOUT_MS = 4_000

/**
 * 给 promise 套一个超时；超时后返回兜底值而不是抛错。
 * @param task - 待等待的 promise。
 * @param ms - 超时毫秒数。
 * @param fallback - 超时时采用的结果。
 * @returns 任务结果，或超时兜底值。
 */
async function withTimeout<T>(task: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      task,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => { resolve(fallback) }, ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * 给异步迭代器套一个「首块到期」看门狗（D1）。
 *
 * 语义刻意是**首 token** 而非整体：远端 LLM 正常生成 8~20 秒是家常便饭，
 * 按总时长设限会把正常请求误杀。只有当**第一个 chunk 都没来**时才判为卡死并中止。
 * 拿到首块后撤掉定时器，之后的迭代完全交还给原迭代器（`finally` 里也会清）。
 * @param src - 上游流（`llm.stream(...)`）。
 * @param firstChunkMs - 首块到期毫秒数。
 * @returns 与 `src` 等价的异步可迭代对象（超时则抛错）。
 */
async function* streamWithDeadline<T>(src: AsyncIterable<T>, firstChunkMs: number): AsyncGenerator<T> {
  const it = src[Symbol.asyncIterator]()
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  try {
    // 「还没出首块」时只有定时器在跑；一旦拿到第一块就 clearTimeout，后续不受它影响。
    const first = await Promise.race([
      it.next(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true
          reject(new Error(`模型 ${Math.round(firstChunkMs / 1000)} 秒内没有响应，请稍后重试`))
        }, firstChunkMs)
      }),
    ])
    if (timer !== undefined) clearTimeout(timer)
    if (first.done === true) return
    yield first.value
    // 首块之后：正常把控制权交回上游（不再受看门狗约束）
    while (true) {
      const n = await it.next()
      if (n.done === true) return
      yield n.value
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    // 超时后主动关掉上游，免得 provider 那边还挂着一条流。
    if (timedOut && typeof it.return === 'function') { try { await it.return() } catch { /* 忽略 */ } }
  }
}

/** Compact, readable daily digest for the no-LLM fallback (short per-message previews). */
function compactDailyDigest(lines: string[]): string {
  const parts: string[] = []
  let lastSession = ''
  let shown = 0
  for (const line of lines) {
    const m = line.match(/^【(.+?)】/)
    if (m && m[1]) { lastSession = m[1]; parts.push('\n【' + lastSession + '】'); continue }
    if (shown >= 6) { parts.push('……'); break }
    const s = line.replace(/\s+/g, ' ').slice(0, 48)
    parts.push('- ' + s + (line.length > 48 ? '…' : ''))
    shown += 1
  }
  return parts.join('\n')
}

export interface createSummaryRecordRemotesInputs {
  dirs: () => { decrypted: string; decoded: string }
  op: (category: OperationCategory, action: string, status: OperationStatus, target?: string, detail?: string) => void
  ctx: () => Context
  privacyGate: PrivacyGateFn
  runSummaryTask: (options: { id: number }) => Promise<SummaryTaskRunResult>
  selfUsername: () => string
  getSchedBusy: () => boolean
  setSchedBusy: (v: boolean) => void
  makeEmbedFn: (model: string, feature?: 'ask_embed' | 'kb_embed' | 'kb_link_suggest') => EmbedFn | undefined
  kbModel: (kbId: number, role: 'embed') => { model: string }
}

/**
 * 「推荐回复」的实现体。
 *
 * 从 remotes 工厂里抽出来（单函数行数闸门）：它要取上下文、检索知识库、调模型、
 * 解析候选，还要组装过程留痕 —— 留在工厂里会把那个函数顶过 250 行。
 * @param rc - 网关注入的依赖。
 * @param options - 会话、知识库、候选条数与可选的分析目标消息。
 * @returns 候选回复 + 本次调用的过程留痕。
 */
async function suggestRepliesOf(
  rc: createSummaryRecordRemotesInputs,
  options: {
    username?: string
    kbId?: number
    count?: number
    /** 分析面板当前选中的消息；缺省时仍按会话最新上下文推荐。 */
    targetLocalId?: number
    /** 忽略缓存、重新生成（界面的「换一批」用它）。 */
    force?: boolean
  },
): Promise<ReplySuggestResult> {
  /** `talker` 是 `WechatSession.username` 的别名。 */
  const talker = String(options.username ?? '').trim()
  if (talker === '') return { ok: false, error: '缺少会话' }
  const want = Math.max(1, Math.min(Math.trunc(options.count ?? 3), 5))
  const rawTarget = options.targetLocalId
  if (rawTarget !== undefined && (!Number.isFinite(Number(rawTarget)) || Number(rawTarget) <= 0)) {
    return { ok: false, error: '分析对象无效，请重新选择消息' }
  }
  const targetLocalId = rawTarget === undefined ? undefined : Math.trunc(Number(rawTarget))
  const { lines, latestPeer, count, targetFound, targetLine } = collectReplyContext(
    rc.dirs().decrypted,
    talker,
    rc.selfUsername(),
    REPLY_SUGGEST_CONTEXT_LIMIT,
    targetLocalId,
  )
  if (targetFound === false) return { ok: false, error: '这条消息已不在当前会话中，请重新选择' }
  if (count === 0) return { ok: false, error: '这个会话还没有可用的对话内容' }
  const kbId = Math.trunc(Number(options.kbId ?? 0))
  /**
   * 命中缓存就直接返回。
   *
   * 键里带着上下文指纹 —— 会话里出现了新消息时指纹会变、缓存自然失效；
   * 没变化的会话（关掉面板再打开、切走再切回）则秒开，不再等一次模型。
   * `force` 来自界面的「换一批」，明确要求换结果时跳过缓存。
   */
  const llm = rc.ctx().llm
  const defaultModel = (rc.ctx() as unknown as {
    agentDefaultModel?: { currentSelection(): { provider: string; model: string } }
  }).agentDefaultModel
  const sel = defaultModel?.currentSelection()
  if (!sel || !sel.provider || !sel.model) return { ok: false, error: 'LLM/模型不可用' }
  const modelLabel = sel.provider + '/' + sel.model
  const cacheKey = replySuggestCacheKey({
    talker,
    targetLocalId,
    kbId,
    model: modelLabel,
    want,
    lines,
  })
  if (options.force !== true) {
    const cached = readReplySuggestCache(rc.dirs().decrypted, cacheKey)
    if (cached !== undefined) {
      rc.op('task', 'suggest_replies', 'ok', talker, `命中缓存 · ${cached.replies.length} 条`)
      return {
        ok: true,
        replies: cached.replies,
        messageCount: count,
        kbSnippetCount: 0,
        cached: true,
        ...(cached.trace === undefined ? {} : { trace: cached.trace }),
      }
    }
  }
  /**
   * 知识库检索**必须有上限**。
   *
   * 它是整条链路里唯一可能卡住的地方：库很大时检索要扫索引，稠密通道还要先调一次
   * 向量模型（一次额外网络往返）。此前这里是裸 `await` —— 检索慢就等于候选慢，
   * 而且模型还没开始调。超时后按「没有片段」降级继续：推荐回复本身就是可降级功能，
   * 让它因为知识库而整个失败（或等到十几秒）是最差的选择。
   */
  const kb = kbId > 0
    ? await withTimeout(
        collectReplyKbSnippetsHybrid({
          decryptedDir: rc.dirs().decrypted,
          kbId,
          lines,
          latestPeer,
          topK: 3,
          makeEmbedFn: (model, feature) => rc.makeEmbedFn(model, feature),
          kbModel: (id, role) => rc.kbModel(id, role),
        }),
        KB_RETRIEVE_TIMEOUT_MS,
        { snippets: [], note: '知识库检索超时，这次只用了会话上下文' },
      )
    : { snippets: [], note: '' }
  const snippets = kb.snippets
  const prompt = buildReplyPrompt(lines, snippets, want, targetLine)
  const [gated] = rc.privacyGate('suggest_reply', { sessions: 1, messages: count }, [prompt])
  const sentPrompt = gated ?? prompt
  const systemPrompt = '你是微信聊天助手。只输出候选回复本身，不要解释、不要客套，也不要复述上下文。'
  const userMsg = createUserMessage({
    content: [{ type: 'text', text: sentPrompt }],
    source: { kind: 'plugin', plugin: 'dsh-wechat-data' },
  })
  const assembler = new BlockAssembler()
  const opts: GenerateOptions = {
    provider: sel.provider, model: sel.model, messages: [userMsg],
    system: systemPrompt,
    /**
     * 输出上限：3 条候选、每条 30 字上下，约 150 token。
     *
     * 此前**没有设上限** —— 模型会一直写到它自己认为够了为止，而推荐回复的
     * 输出体量本该是最小的一类（AI 回复 600 / 分析 1200 都设了，唯独这里漏了）。
     * 上限 320 给了两倍余量，同时把「模型开始啰嗦」这条尾部延迟掐掉。
     */
    maxTokens: REPLY_SUGGEST_MAX_TOKENS,
  }
  const startedAt = Date.now()
  try {
    for await (const chunk of streamWithDeadline<StreamChunk>(
      llm.stream(opts),
      FIRST_TOKEN_TIMEOUT_MS,
    )) assembler.push(chunk)
  } catch (e) {
    rc.op('task', 'suggest_replies', 'fail', talker, (e as Error).message)
    return { ok: false, error: (e as Error).message }
  }
  const elapsedMs = Date.now() - startedAt
  const raw = assembler.blocks().map(b => (b.type === 'text' ? b.text : '')).join('').trim()
  const replies = parseReplyCandidates(raw, want)
  // 留痕在**解析之后**组装：即使候选为空，详情里也要能看到模型的原始输出，
  // 否则「模型没给出可用的候选」这句话无法自证。
  const trace: ReplyTrace = {
    systemPrompt,
    userPrompt: sentPrompt,
    contextLines: lines,
    kbSnippets: snippets,
    rawOutput: raw,
    model: sel.provider + '/' + sel.model,
    elapsedMs,
    redacted: sentPrompt !== prompt,
  }
  if (replies.length === 0) {
    rc.op('task', 'suggest_replies', 'fail', talker, '模型没给出可用的候选')
    return { ok: false, error: '模型没给出可用的候选回复', trace }
  }
  rc.op(
    'task',
    'suggest_replies',
    'ok',
    targetLocalId === undefined ? talker : `${talker}#${String(targetLocalId)}`,
    `${replies.length} 条 · 上下文 ${count} 条 · 知识库 ${snippets.length} 段`,
  )
      const base: ReplySuggestResult = {
        ok: true,
        replies,
        messageCount: count,
        kbSnippetCount: snippets.length,
        trace,
        cached: false,
      }
      // 写缓存放在返回路径上：命中它的是「同一段没变化的对话」。
      writeReplySuggestCache(rc.dirs().decrypted, cacheKey, { replies, trace })
  const kbDetail = kb.note !== '' && kb.note !== '知识库没有匹配的内容' ? `（${kb.note}）` : ''
  return snippets.length === 0 && kbId > 0
    ? {
        ...base,
        degraded: `知识库里没有相关内容，这次只用了会话上下文${kbDetail}`,
      }
    : base
}

export function createSummaryRecordRemotes(rc: createSummaryRecordRemotesInputs) {
  return {
    async generateDailySummary(options: { date: string; provider?: string; model?: string; format?: string }): Promise<DailySummaryResult> {
      // 2026-09-28：改用可让出版收集 —— 真实 @Remote 探针实测本方法冷跑 **230ms 且一次
      // 都不让出**（`working/probe-remote.txt`），成本全在这一步（模型调用在下面）。
      const { lines, count, sessions, total, types, hourly, topSessions } = await collectDayMessagesAsync(rc.dirs().decrypted, options.date, undefined, yieldToLoop)
      const ctx = rc.ctx()
      const defaultModel = (ctx as unknown as {
        agentDefaultModel?: { currentSelection(): { provider: string; model: string; reasoningEffort?: string } }
      }).agentDefaultModel
      const sel = defaultModel?.currentSelection()
      const useProvider = (options.provider && options.provider.trim()) ? options.provider.trim() : (sel?.provider ?? '')
      let useModel = (options.model && options.model.trim()) ? options.model.trim() : (sel?.model ?? '')
      const llm = ctx.llm
      // Plain-text summarization: avoid a default vision/experimental model that returns empty text. Respect an explicit selection.
      if (!options.model && useModel && /vision|-exp/i.test(useModel)) {
        try {
          const ms = await llm.listModels(useProvider)
          const chatModelRe = /chat|flash|pro|v4/i
          const pick = ms.find(m => chatModelRe.test(m.id) && !/vision|image|exp/i.test(m.id))
            ?? ms.find(m => !/vision|image|exp/i.test(m.id))
            ?? ms[0]
          if (pick && pick.id) useModel = pick.id
        } catch { /* keep */ }
      }
      if (!useProvider || !useModel) {
        const fallback = 'AI 不可用（未配置默认模型或 LLM 服务）。\n\n当日统计：共 ' + String(total) + ' 条消息 / ' + String(sessions) + ' 个活跃会话。' + (compactDailyDigest(lines) || '\n（当天无文本消息）')
        rc.op('task', 'generate_daily_summary', 'fail', options.date, '未配置默认模型或 LLM 服务')
        return { summary: fallback, date: options.date, sessions, messages: count, total, types, hourly, topSessions }
      }
      const prompt = buildSummaryPrompt({
        from: options.date,
        to: options.date,
        lines,
        stats: { total, sessions, messages: count },
        format: (options.format as SummaryFormat | undefined) ?? 'brief',
      })
      const [gated] = rc.privacyGate('daily_summary', { sessions, messages: count }, [prompt])
      const userMsg = createUserMessage({
        content: [{ type: 'text', text: gated ?? prompt }],
        source: { kind: 'plugin', plugin: 'dsh-wechat-data' },
      })
      const assembler = new BlockAssembler()
      const opts: GenerateOptions = {
        provider: useProvider,
        model: useModel,
        messages: [userMsg],
        system: '你是微信聊天总结助手。严格按用户给出的篇幅与结构要求输出中文总结，只依据素材内容，不推测不编造。',
        maxTokens: 2048,
      }
      let summary = ''
      try {
        for await (const chunk of llm.stream(opts)) assembler.push(chunk)
        summary = assembler.blocks().map(b => (b.type === 'text' ? b.text : '')).join('').trim()
      } catch (e) {
        summary = 'LLM 调用失败: ' + (e as Error).message
      }
      const finalSummary = summary ||
        (lines.length > 0
          ? '模型未返回内容（请为默认模型配置 DEEPSEEK_API_KEY 或其它 LLM 密钥）。\n\n当日统计：共 ' + String(total) + ' 条消息 / ' + String(sessions) + ' 个活跃会话。' + (compactDailyDigest(lines) || '\n（当天无文本消息）')
          : '（当天没有可用的文本消息）')
      const ok = !finalSummary.startsWith('LLM 调用失败')
      rc.op('task', 'generate_daily_summary', ok ? 'ok' : 'fail', options.date, ok ? `共 ${count} 条消息` : finalSummary.slice(0, 120))
      // 2026-10-17：手动生成的每日总结**也落库**（改前只有定时任务落库，手动生成的
      // 刷新就没了 —— 用户实测"生成完切个页签回来就空了"）。
      // `taskId` 用 0 表示「手动生成」；`summaryDate` 存单个日期，与周期总结（存 `from~to`）区分。
      // 落库失败不影响本次结果返回 —— 用户已经拿到总结了，不该因为存不下就报错。
      saveRec(rc.dirs().decrypted, {
        taskId: 0,
        groupUsername: '',
        groupName: '',
        summaryDate: options.date,
        summary: finalSummary,
        messageCount: count,
        status: ok ? 'done' : 'error',
        error: ok ? '' : finalSummary.slice(0, 200),
      })
      return { summary: finalSummary, date: options.date, sessions, messages: count, total, types, hourly, topSessions }
    },

    deleteSummaryRecord(options: { id: number }): SummaryTaskMutationResult {
      const r = delRec(rc.dirs().decrypted, options.id)
      rc.op('delete', 'delete_summary_record', r.ok ? 'ok' : 'fail', `id=${options.id}`, r.error ?? '')
      return r
    },

    async generatePeriodSummary(options: { from: string; to: string; provider?: string; model?: string; format?: string }): Promise<PeriodSummaryResult> {
      // 2026-09-28：改用可让出版收集 —— 实测本方法冷跑 **448ms 且一次都不让出**
      // （`working/probe-remote.txt`，当时最长的一个独占项）。
      const collected = await collectPeriodMessagesAsync(rc.dirs().decrypted, options.from, options.to, undefined, yieldToLoop)
      const { lines, count, sessions, total, types, hourly, topSessions } = collected
      const ctx = rc.ctx()
      const defaultModel = (ctx as unknown as {
        agentDefaultModel?: { currentSelection(): { provider: string; model: string; reasoningEffort?: string } }
      }).agentDefaultModel
      const sel = defaultModel?.currentSelection()
      const useProvider = (options.provider && options.provider.trim()) ? options.provider.trim() : (sel?.provider ?? '')
      let useModel = (options.model && options.model.trim()) ? options.model.trim() : (sel?.model ?? '')
      const llm = ctx.llm
      if (!options.model && useModel && /vision|-exp/i.test(useModel)) {
        try {
          const ms = await llm.listModels(useProvider)
          const chatModelRe = /chat|flash|pro|v4/i
          const pick = ms.find(m => chatModelRe.test(m.id) && !/vision|image|exp/i.test(m.id))
            ?? ms.find(m => !/vision|image|exp/i.test(m.id))
            ?? ms[0]
          if (pick && pick.id) useModel = pick.id
        } catch { /* keep */ }
      }
      if (!useProvider || !useModel) {
        const fallback = 'AI 不可用（未配置默认模型或 LLM 服务）。\n\n周期统计：共 ' + String(total) + ' 条消息 / ' + String(sessions) + ' 个活跃会话。' + (compactDailyDigest(lines) || '')
        rc.op('task', 'generate_period_summary', 'fail', `${options.from}~${options.to}`, '未配置默认模型或 LLM 服务')
        return { summary: fallback, from: options.from, to: options.to, sessions, messages: count, total, types, hourly, topSessions }
      }
      const prompt = buildSummaryPrompt({
        from: options.from,
        to: options.to,
        lines,
        stats: { total, sessions, messages: count },
        format: (options.format as SummaryFormat | undefined) ?? 'brief',
      })
      const [gated] = rc.privacyGate('period_summary', { sessions, messages: count }, [prompt])
      const userMsg = createUserMessage({ content: [{ type: 'text', text: gated ?? prompt }], source: { kind: 'plugin', plugin: 'dsh-wechat-data' } })
      const assembler = new BlockAssembler()
      const opts: GenerateOptions = { provider: useProvider, model: useModel, messages: [userMsg], system: '你是微信聊天总结助手。严格按用户给出的篇幅与结构要求输出中文总结，只依据素材内容，不推测不编造。', maxTokens: 2048 }
      let summary = ''
      try { for await (const chunk of llm.stream(opts)) assembler.push(chunk); summary = assembler.blocks().map(b => (b.type === 'text' ? b.text : '')).join('').trim() } catch (e) { summary = 'LLM 调用失败: ' + (e as Error).message }
      const finalSummary = summary || (lines.length > 0 ? '模型未返回内容。\n\n周期统计：共 ' + String(total) + ' 条消息 / ' + String(sessions) + ' 个活跃会话。' + (compactDailyDigest(lines) || '') : '（该周期没有可用的文本消息）')
      const ok = !finalSummary.startsWith('LLM 调用失败')
      rc.op('task', 'generate_period_summary', ok ? 'ok' : 'fail', `${options.from}~${options.to}`, ok ? `共 ${count} 条消息` : finalSummary.slice(0, 120))
      // 2026-10-17：周期总结**落库**（改前只在内存里，刷新就没了 —— 用户实测"生成完切个页签回来就空了"）。
      // `taskId` 用 0 表示「手动生成」（不是定时任务产出）；`summaryDate` 存区间 `from~to`，
      // 这样「总结阅览」里能一眼看出这是哪一段，也能和每日总结（存单个日期）区分开。
      // 落库失败不影响本次结果返回 —— 用户已经拿到总结了，不该因为存不下就报错。
      saveRec(rc.dirs().decrypted, {
        taskId: 0,
        groupUsername: '',
        groupName: '',
        summaryDate: `${options.from}~${options.to}`,
        summary: finalSummary,
        messageCount: count,
        status: ok ? 'done' : 'error',
        error: ok ? '' : finalSummary.slice(0, 200),
      })
      return { summary: finalSummary, from: options.from, to: options.to, sessions, messages: count, total, types, hourly, topSessions }
    },

    async suggestReplies(options: {
      username?: string
      kbId?: number
      count?: number
      /** 分析面板当前选中的消息；缺省时仍按会话最新上下文推荐。 */
      targetLocalId?: number
      /** 跳过缓存重新生成（界面的「换一批」用它）。 */
      force?: boolean
    }): Promise<ReplySuggestResult> {
    return suggestRepliesOf(rc, options)
    },

  }
}
