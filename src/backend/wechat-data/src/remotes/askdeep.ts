/**
 * 问答主链路的 @Remote 处理器（M21 自 `gateway.ts` 搬出）。
 *
 * 2026-10-22 起，`askWechat` 不再自己维护「LLM 规划器 + 固定检索 + 综合生成」
 * 三段式实现，而是统一交给 `askWithRuntime()`：
 *   · `wechat-ask` / `session-ask` / `clawbot-auto` 共用同一套工具循环；
 *   · 工具选择、参数修复、范围守卫、重试与证据收敛都在运行时内完成；
 *   · 本文件只保留宿主接线：取消、流式事件、图片、索引新鲜度与历史落库。
 *
 * @module remotes/askdeep
 */
import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, TokenUsage } from '@deepseek-ai/dsh-llm'
import { parseAskOptimize } from '../query/ask.ts'
import type { KbModelRole, ResolvedModel } from '../query/kb/model-config.ts'
import { loadRetrievalConfig } from '../query/retrieval/config.ts'
import { buildVectorIndex } from '../query/retrieval/embedding.ts'
import type { EmbedFn } from '../query/retrieval/embedding.ts'
import { citationDocKey } from '../query/retrieval/kb-channel.ts'
import type { IntentKind, RerankWeights } from '../query/retrieval/types.ts'
import { ensureSearchIndex } from '../query/search.ts'
import type {
  AskCitation,
  AskOptimizeResult,
  AskResult,
  OperationCategory,
  OperationStatus,
} from '../types.ts'
import type { VectorBuildResult } from '../types-retrieval.ts'
import type { PrivacyGateFn } from '../gateway-privacy.ts'
import { beginAskCancel, cancelAskIn } from './ask-cancel.ts'
import { buildAskTools } from './ask-retrieval.ts'
import { askWithRuntime } from './ask-runtime.ts'
import type { AskRuntimeResult } from './ask-runtime.ts'
import { addTokenUsage, describeAskScope } from './ask-runtime-prompt.ts'
import type { ThreadState } from '../query/answer-runtime/thread-state.ts'
import type { AnswerRuntimeStage } from '../query/answer-runtime/types.ts'
import {
  createAskRunChat,
  createAskRunChatTurn,
} from './ask-run-chat.ts'

/** 自动回复送模型的一张图（canonical base64）；最多 2 张。 */
interface AskImageInput {
  data: string
  mediaType: string
  name?: string
}

export interface createAskDeepRemotesInputs {
  dirs: () => { decrypted: string; decoded: string }
  op: (category: OperationCategory, action: string, status: OperationStatus, target?: string, detail?: string) => void
  ctx: () => Context
  askTrace: Map<string, {
    features: Map<string, RerankWeights>
    citations: string[]
    question: string
    answer: string
    intent: IntentKind
  }>
  privacyGate: PrivacyGateFn
  embedModelName: (override?: string) => string
  makeEmbedFn: (model: string, feature?: 'ask_embed' | 'kb_embed' | 'kb_link_suggest') => EmbedFn | undefined
  makeRerankFn: (kbId: number) => ((query: string, documents: string[]) => Promise<number[]>) | undefined
  makeDeltaEmitter: (streamId?: string) => ((text: string) => void) | undefined
  /** 思考过程发射器：与可见正文分开推，界面单独折叠展示。 */
  makeReasoningEmitter: (streamId?: string) => ((text: string) => void) | undefined
  /** 阶段事件发射器：把意图 / 工具 / 综合生成的进度推给界面。 */
  makeStageEmitter: (streamId?: string) => ((stage: AnswerRuntimeStage) => void) | undefined
  kbModel: (kbId: number, role: KbModelRole) => ResolvedModel
  askKnownEntities: () => string[]
  askKnownSessions: () => Array<{ username: string; name: string }>
  saveAskHistory: (
    options: {
      question: string
      username?: string
      from?: string
      to?: string
      source?: string
      usernameName?: string
    },
    result: AskResult,
    elapsedMs: number,
    model: string,
  ) => void
  /** W3-6.1：取本轮问答的取消信号（gateway 持有槽位）。 */
  askSignal: (jobId?: string) => { signal: AbortSignal; done: () => void } | undefined
  /** W3-6.1：取消一轮问答；找不到在跑的那一轮时返回 false。 */
  cancelAskJob: (jobId?: string) => boolean
}

/**
 * 检索索引保鲜：后台全量、同步增量。
 *
 * 索引不可用不阻断问答（检索会退回旧索引 / LIKE），但必须把「本轮用的是旧索引」
 * 如实写进 `retrieval.indexNote`，否则用户会把漏召回误判成答错。
 */
async function prepareAskIndex(rc: createAskDeepRemotesInputs): Promise<string> {
  let indexNote = ''
  try {
    const ensured = await ensureSearchIndex(rc.dirs().decrypted, { background: true })
    if (ensured.action === 'deferred' && ensured.message !== undefined) {
      indexNote = ensured.message
      rc.op('task', 'ask_wechat', 'ok', 'build_index', '检索索引后台构建已开跑 · 本轮用旧索引')
    } else if (ensured.action === 'build') {
      rc.op('task', 'ask_wechat', 'ok', 'build_index', `检索索引全量构建 · ${ensured.rows ?? 0} 条 · ${ensured.elapsed_ms}ms`)
    } else if (ensured.action === 'sync') {
      rc.op('task', 'ask_wechat', 'ok', 'build_index', `检索索引增量同步 · 新增 ${ensured.added ?? 0} 条 · ${ensured.elapsed_ms}ms`)
    } else if (ensured.message) {
      rc.op('task', 'ask_wechat', 'fail', 'build_index', ensured.message)
    }
  } catch (e) {
    // 索引故障不阻断提问：检索侧有自己的降级路径。
    rc.op('task', 'ask_wechat', 'fail', 'build_index', (e as Error).message)
  }
  return indexNote
}

/**
 * 把工具链路产生的检索画像写入反馈归因表。
 *
 * `search_hybrid` 会在装配层回调 `runAskRetrieval` 的完整输出；这里只取
 * retrievalId + 特征向量 + 引用键，模型回放与 AskResult 均不携带这些内部权重。
 */
function rememberAskTrace(input: {
  rc: createAskDeepRemotesInputs
  retrievalId: string
  rankedFeatures: Array<{ docKey: string; features: RerankWeights }>
  citations: ReadonlyArray<AskCitation>
  resources?: ReadonlyArray<{ evidenceId: string; tool: string }>
  toolCalls?: ReadonlyArray<{ name: string }>
  question: string
  answer: string
  intent: IntentKind
}): void {
  if (input.retrievalId === '') return
  if (
    input.rankedFeatures.length === 0
    && input.citations.length === 0
    && (input.resources?.length ?? 0) === 0
    && (input.toolCalls?.length ?? 0) === 0
  ) return
  input.rc.askTrace.set(input.retrievalId, {
    features: featureMap(input.rankedFeatures, input.citations, input.resources),
    citations: [
      ...input.citations.map(citation => citationDocKey(citation)),
      ...(input.resources ?? []).map(resource => resource.evidenceId),
    ],
    question: input.question,
    answer: input.answer,
    intent: input.intent,
  })
  while (input.rc.askTrace.size > 20) {
    const oldest = input.rc.askTrace.keys().next()
    if (oldest.done) break
    input.rc.askTrace.delete(oldest.value)
  }
}

const EMPTY_FEATURES: RerankWeights = {
  sparse: 0,
  dense: 0,
  kb: 0,
  entity: 0,
  coverage: 0,
  timePref: 0,
  recency: 0,
  agreement: 0,
}

/**
 * 把 rerank 特征与「没有 rerank 的工具证据」合成可归因的特征表。
 *
 * 非 hybrid 工具（search_kb / search_messages / search_files …）没有 rerank
 * 向量，但反馈仍应能区分「知识库命中」「词法命中」「多工具共同命中」。这里给
 * 每条引用一个确定性的基础特征，hybrid 已有特征时以真实值为准。
 */
function featureMap(
  ranked: Array<{ docKey: string; features: RerankWeights }>,
  citations: ReadonlyArray<AskCitation>,
  resources: ReadonlyArray<{ evidenceId: string; tool: string }> = [],
): Map<string, RerankWeights> {
  const map = new Map<string, RerankWeights>()
  for (const item of ranked) {
    map.set(item.docKey, { ...EMPTY_FEATURES, ...item.features })
  }
  const docs = citations.map(citation => citationDocKey(citation)).filter(key => key !== '')
  for (const key of docs) {
    const existing = map.get(key)
    if (existing) continue
    map.set(key, {
      ...EMPTY_FEATURES,
      ...(key.startsWith('kb:') ? { kb: 1 } : { sparse: 1 }),
    })
  }
  const counts = new Map<string, number>()
  for (const key of docs) counts.set(key, (counts.get(key) ?? 0) + 1)
  for (const [key, count] of counts) {
    const features = map.get(key)
    if (!features || count < 2) continue
    map.set(key, { ...features, agreement: 1 })
  }
  for (const resource of resources) {
    const key = resource.evidenceId
    if (map.has(key)) continue
    map.set(key, {
      ...EMPTY_FEATURES,
      ...(resource.tool === 'search_kb' ? { kb: 1 } : { sparse: 1 }),
    })
  }
  return map
}

/** 运行时状态 → 旧问答历史可识别的操作日志文案。 */
function askOpDetail(result: AskRuntimeResult): string {
  const stats = result.evidence?.stats
  const calls = result.toolCalls?.length ?? 0
  const citations = result.citations.length
  const failed = stats?.failedTools.length ?? 0
  return [
    `状态 ${result.status}`,
    `工具 ${calls} 次${failed > 0 ? `（失败 ${failed}）` : ''}`,
    `证据 ${stats?.count ?? 0} 条`,
    `引用 ${citations} 条`,
    ...(result.statusReason ? [`原因 ${result.statusReason}`] : []),
  ].join(' · ')
}

export function createAskDeepRemotes(rc: createAskDeepRemotesInputs) {
  return {
    async askWechat(options: {
      question: string
      username?: string
      from?: string
      to?: string
      history?: Array<{ role: 'user' | 'assistant'; content: string }>
      /** 客户端生成的流式标识：带上它才会推送 wechat-ask/delta 增量事件。 */
      streamId?: string
      /** 入口来源：`ask` = 微信问答页签，`session` = 会话内问答，`auto` = ClawBot。 */
      source?: string
      /** 会话显示名：历史列表直接显示。 */
      usernameName?: string
      /** 当前知识库 id；缺省不检索知识库。 */
      kbId?: number
      jobId?: string
      /** 数据面：`wechat`（缺省）或 `kb-only`（ClawBot 自动回复）。 */
      dataScope?: 'wechat' | 'kb-only'
      /** 随问题一起送模型的图片（canonical base64，最多 2 张）。 */
      images?: AskImageInput[]
      /** 系统提示词覆盖；检索材料与「不编造」规则仍由运行时追加。 */
      systemPromptOverride?: string
      /** 上一轮问答返回的结构化线程状态；跨请求继承会话/联系人与时间窗。 */
      threadState?: ThreadState
    }): Promise<AskResult> {
      const askCtl = beginAskCancel(rc, options.jobId)
      let usageAcc: TokenUsage | undefined
      let trace: { retrievalId: string; rankedFeatures: Array<{ docKey: string; features: RerankWeights }> } | undefined
      const result = await askCtl.run(async (): Promise<AskRuntimeResult> => {
        const startedAt = Date.now()
        const ctx = rc.ctx()
        const defaultModel = (ctx as unknown as {
          agentDefaultModel?: {
            currentSelection(): { provider: string; model: string; reasoningEffort?: string }
          }
        }).agentDefaultModel
        const selected = defaultModel?.currentSelection()
        if (!selected || !selected.provider || !selected.model) {
          rc.op('task', 'ask_wechat', 'fail', '', '未配置默认模型（agentDefaultModel）')
          throw new Error('未配置默认模型（agentDefaultModel），无法调用 AI 问答')
        }
        const modelLabel = `${selected.provider} · ${selected.model}`
        const indexNote = options.dataScope === 'kb-only' ? '' : await prepareAskIndex(rc)
        askCtl.throwIfCanceled()

        const runtime = await askWithRuntime({
          decryptedDir: rc.dirs().decrypted,
          provider: selected.provider,
          model: selected.model,
          privacyGate: (feature, stats, texts) => rc.privacyGate(feature, stats, texts),
          ctx,
          llm: ctx.llm,
          knownEntities: () => rc.askKnownEntities(),
          knownSessionCatalog: () => rc.askKnownSessions(),
          tools: input => buildAskTools({
            decryptedDir: rc.dirs().decrypted,
            question: options.question,
            plan: {
              subQueries: input.plan.subQueries,
              from: input.plan.from ?? '',
              to: input.plan.to ?? '',
              person: input.plan.person ?? '',
            },
            scope: input.scope,
            ...(input.kbId !== undefined ? { kbId: input.kbId } : {}),
            ...(input.wechatDataEnabled === false ? { wechatDataEnabled: false } : {}),
            indexNote,
            scopeDescText: describeAskScope(input.scope, input.profile),
            op: (category, action, status, target, detail) => rc.op(category, action, status, target, detail),
            makeEmbedFn: (model, feature) => rc.makeEmbedFn(model, feature),
            embedModelName: (override) => rc.embedModelName(override),
            makeRerankFn: (id) => rc.makeRerankFn(id),
            kbModel: (id, role) => rc.kbModel(id, role),
            askKnownEntities: () => rc.askKnownEntities(),
            onHybridExecution: (output) => {
              trace = { retrievalId: output.retrievalId, rankedFeatures: output.rankedFeatures }
            },
          }),
          runTurn: createAskRunChatTurn({
            llm: ctx.llm,
            provider: selected.provider,
            model: selected.model,
            throwIfCanceled: askCtl.throwIfCanceled,
            onUsage: (usage) => { usageAcc = addTokenUsage(usageAcc, usage) },
          }),
          runChat: createAskRunChat({
            llm: ctx.llm,
            provider: selected.provider,
            model: selected.model,
            throwIfCanceled: askCtl.throwIfCanceled,
            onUsage: (usage) => { usageAcc = addTokenUsage(usageAcc, usage) },
          }),
          throwIfCanceled: askCtl.throwIfCanceled,
          ...(askCtl.signal ? { cancelSignal: askCtl.signal } : {}),
          modelDeadlineMs: 120_000,
          emitDelta: rc.makeDeltaEmitter(options.streamId),
          emitReasoning: rc.makeReasoningEmitter(options.streamId),
          emitStage: rc.makeStageEmitter(options.streamId),
          op: (category, action, status, target, detail) => rc.op(category, action, status, target, detail),
        }, {
          question: options.question,
          ...(options.username !== undefined ? { username: options.username } : {}),
          ...(options.from !== undefined ? { from: options.from } : {}),
          ...(options.to !== undefined ? { to: options.to } : {}),
          ...(options.history ? { history: options.history } : {}),
          ...(options.source !== undefined ? { source: options.source } : {}),
          ...(options.usernameName !== undefined ? { usernameName: options.usernameName } : {}),
          ...(options.kbId !== undefined ? { kbId: options.kbId } : {}),
          ...(options.dataScope !== undefined ? { dataScope: options.dataScope } : {}),
          ...(options.images ? { images: options.images } : {}),
          ...(options.systemPromptOverride !== undefined
            ? { systemPromptOverride: options.systemPromptOverride }
            : {}),
          ...(options.streamId !== undefined ? { streamId: options.streamId } : {}),
          ...(options.threadState !== undefined ? { threadState: options.threadState } : {}),
        })

        const retrievalId = trace?.retrievalId
          || `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
        runtime.retrievalId = retrievalId
        if (indexNote !== '') runtime.retrieval = { ...(runtime.retrieval ?? {
          candidates: 0,
          kept: 0,
          scope: '本机记录',
          recency: false,
        }), indexNote }
        rc.saveAskHistory(options, runtime, Date.now() - startedAt, modelLabel)
        rc.op('task', 'ask_wechat', runtime.status === 'failed' ? 'fail' : 'ok', '', askOpDetail(runtime))
        rememberAskTrace({
          rc,
          retrievalId,
          rankedFeatures: trace?.rankedFeatures ?? [],
          citations: runtime.citations,
          resources: runtime.resources,
          toolCalls: runtime.toolCalls,
          question: options.question,
          answer: runtime.answer,
          intent: (runtime.plan?.intent as IntentKind | undefined) ?? 'open_qa',
        })
        return runtime
      })
      return usageAcc === undefined ? result : { ...result, usage: usageAcc }
    },

    cancelAsk: (options: { jobId: string }): { ok: boolean; message?: string } => cancelAskIn(rc, options),

    async optimizeAskQuestion(options: {
      question: string
      username?: string
      from?: string
      to?: string
      history?: Array<{ role: 'user' | 'assistant'; content: string }>
    }): Promise<AskOptimizeResult> {
      return optimizeAskQuestionIn(rc, options)
    },

    async buildRagVectorIndex(options?: { force?: boolean }): Promise<VectorBuildResult> {
      const cfg = loadRetrievalConfig(rc.dirs().decrypted)
      const embedModel = rc.embedModelName()
      const embedFn = rc.makeEmbedFn(embedModel)
      if (!embedFn) {
        return {
          ok: false,
          status: 'no-embedder',
          rows: 0,
          embedded: 0,
          elapsed_ms: 0,
          message: '未配置 embedding（请在模型配置里填写向量模型或 API Key）',
        }
      }
      try {
        await ensureSearchIndex(rc.dirs().decrypted)
      } catch {
        // 交给下面的向量构建如实报错。
      }
      try {
        const built = await buildVectorIndex(rc.dirs().decrypted, embedFn, {
          model: embedModel,
          batchSize: cfg.embedding.batchSize,
          concurrency: cfg.embedding.concurrency,
          maxCharsPerDoc: cfg.embedding.maxCharsPerDoc,
          maxDocsPerBuild: cfg.embedding.maxDocsPerBuild,
          force: Boolean(options?.force),
        })
        rc.op('task', 'build_vectors', 'ok', '', `${built.status} rows=${built.rows} embedded=${built.embedded} ${built.elapsed_ms}ms`)
        return { ok: true, ...built }
      } catch (e) {
        rc.op('task', 'build_vectors', 'fail', '', (e as Error).message)
        return { ok: false, status: 'error', rows: 0, embedded: 0, elapsed_ms: 0, message: (e as Error).message }
      }
    },
  }
}

/** 提问优化：改写问题并给出至多 3 条建议。 */
async function optimizeAskQuestionIn(
  rc: createAskDeepRemotesInputs,
  options: {
    question: string
    username?: string
    from?: string
    to?: string
    history?: Array<{ role: 'user' | 'assistant'; content: string }>
  },
): Promise<AskOptimizeResult> {
  const ctx = rc.ctx()
  const question = String(options?.question || '').trim()
  if (!question) throw new Error('请先输入问题，再进行优化')
  const defaultModel = (ctx as unknown as {
    agentDefaultModel?: {
      currentSelection(): { provider: string; model: string; reasoningEffort?: string }
    }
  }).agentDefaultModel
  const selected = defaultModel?.currentSelection()
  if (!selected || !selected.provider || !selected.model) {
    rc.op('task', 'ask_optimize', 'fail', '', '未配置默认模型（agentDefaultModel）')
    throw new Error('未配置默认模型（agentDefaultModel），无法优化提问')
  }
  const scopeDesc = `会话=${options.username || '全部'}${options.from ? `，起始=${options.from}` : ''}${options.to ? `，截止=${options.to}` : ''}`
  const history = (Array.isArray(options.history) ? options.history : [])
    .filter(message => message
      && (message.role === 'user' || message.role === 'assistant')
      && typeof message.content === 'string')
    .slice(-6)
  const historyBrief = history.length > 0
    ? '\n最近对话背景：\n' + history
      .map(message => (message.role === 'user' ? '用户：' : '助手：') + message.content.slice(0, 200))
      .join('\n')
    : ''
  const prompt = `用户原始问题：${question}\n当前检索范围：${scopeDesc}${historyBrief}\n\n请输出 JSON（不要输出其他内容）。`
  const [gated] = rc.privacyGate('ask_optimize', { sessions: 0, messages: 0 }, [prompt])
  const assembler = new BlockAssembler()
  const generate: GenerateOptions = {
    provider: selected.provider,
    model: selected.model,
    messages: [createUserMessage({
      content: [{ type: 'text', text: gated ?? prompt }],
      source: { kind: 'plugin', plugin: 'dsh-wechat-data' },
    })],
    system: '你是微信聊天记录的提问优化器。把用户问题改写得更清晰、更利于全文检索（保留原意，补充隐含的时间/对象等限定，去掉口语口水词），并给出至多 3 条具体的改进建议。只输出一行 JSON：{"optimized":"优化后的问题","suggestions":["建议1","建议2"]}',
    maxTokens: 512,
  }
  for await (const chunk of ctx.llm.stream(generate)) assembler.push(chunk)
  const text = assembler.blocks().map(block => (block.type === 'text' ? block.text : '')).join('').trim()
  const parsed = parseAskOptimize(text)
  const optimized = parsed.optimized || text.slice(0, 300)
  rc.op('task', 'ask_optimize', 'ok', '', optimized.slice(0, 80))
  return { optimized, suggestions: parsed.suggestions }
}
