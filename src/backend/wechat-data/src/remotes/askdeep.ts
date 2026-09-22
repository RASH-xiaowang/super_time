
/**
 * 问答主链路（提问检索生成、问题优化、向量索引重建） 的 @Remote 处理器（M21 自 `gateway.ts` 搬出）。
 *
 * 机制：类里保留 @Remote 装饰器与签名（协议层按名字枚举），方法体一行转发；
 * 处理器体在这里，依赖由 `rc` 显式给出。
 */
import { formatAskContext, parseAskOptimize, parseAskPlan, parseCitedIndexes, retrieveAskCitations } from '../query/ask.ts'
import { auditGrounding, groundingRepairHint } from '../query/grounding.ts'
import { buildKbVectorIndex, kbVectorIndexStatus } from '../query/kb-vectors.ts'
import { KbModelRole, ResolvedModel } from '../query/kb/model-config.ts'
import { loadRetrievalConfig } from '../query/retrieval/config.ts'
import { EmbedFn, buildVectorIndex, vectorIndexStatus } from '../query/retrieval/embedding.ts'
import { loadAdaptedWeights } from '../query/retrieval/feedback.ts'
import { citationDocKey } from '../query/retrieval/kb-channel.ts'
import { runRetrievalPipeline } from '../query/retrieval/pipeline.ts'
import { IntentKind, RerankWeights } from '../query/retrieval/types.ts'
import { ensureSearchIndex } from '../query/search.ts'
import { AskOptimizeResult, AskResult, OperationCategory, OperationStatus } from '../types.ts'
import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

/**
 * 回答的**数据来源说明**：条数 / 会话数 / 时间跨度。
 *
 * 由检索结果**算出来**，不是让模型写的 —— 模型写的「来源」可能被编造，
 * 而这行数字直接来自本次引用到的原文，用户可逐条对照。
 *
 * ⚠ 会话数**只数消息**：知识库引用的 `username` 是 `kb:<kbId>:<fileId>`（它按文件分组
 * 是为了同源去重，不是会话），把它算进「N 个会话」这行就开始说谎 ——
 * 用户会照着这行去数，然后发现自己只有 2 个会话却写着 3 个。
 * 文件另按**文件**去重单列（同一份文件命中三块是 1 个文件），与「条数」是两个口径。
 * @param citations - 本次检索到的原文（引用锚点）。
 * @returns 一行来源说明；没有原文时返回空串。
 */
function askBasisLine(citations: ReadonlyArray<{
  time?: string
  username?: string
  source?: 'msg' | 'kb'
  kb?: { fileId?: number; fileName?: string }
  snippet?: string
}>): string {
  if (citations.length === 0) return ''
  const msgs = citations.filter(c => c.source !== 'kb')
  const kbItems = citations.filter(c => c.source === 'kb')
  const sessions = new Set(msgs.map(c => c.username ?? '')).size
  const days = msgs.map(c => (c.time ?? '').slice(0, 10)).filter(Boolean).sort()
  const span = days.length > 0 ? ` · ${days[0]} ~ ${days[days.length - 1]}` : ''
  const parts = [`${citations.length} 条原文`]
  if (msgs.length > 0) parts.push(`${sessions} 个会话`)
  if (kbItems.length > 0) {
    const files = new Set(kbItems.map(c => (c.kb?.fileId !== undefined ? 'f' + c.kb.fileId : (c.kb?.fileName ?? c.snippet ?? ''))))
    parts.push(`${files.size} 个知识库文件`)
  }
  return `依据本机记录：${parts.join(' · ')}${span}`
}

export interface createAskDeepRemotesInputs {
  dirs: () => { decrypted: string; decoded: string }
  op: (category: OperationCategory, action: string, status: OperationStatus, target?: string, detail?: string) => void
  ctx: () => Context
  askTrace: Map<string, { features: Map<string, RerankWeights>; citations: string[]; question: string; answer: string; intent: IntentKind }>
  privacyBlocked: (feature: string, detail?: string) => string | null
  privacyGate: (feature: string, stats: { sessions: number; messages: number }, texts: string[]) => { ok: true; texts: string[] } | { ok: false; error: string }
  embedModelName: (override?: string) => string
  makeEmbedFn: (model: string, feature?: "ask_embed" | "kb_embed" | "kb_link_suggest") => EmbedFn | undefined
  makeRerankFn: (kbId: number) => ((query: string, documents: string[]) => Promise<number[]>) | undefined
  makeDeltaEmitter: (streamId?: string) => ((text: string) => void) | undefined
  kbModel: (kbId: number, role: KbModelRole) => ResolvedModel
  askKnownEntities: () => string[]
  saveAskHistory: (options: { question: string; username?: string; from?: string; to?: string; source?: string; usernameName?: string }, result: AskResult, elapsedMs: number, model: string) => void
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
      /**
       * 入口来源，写进问答历史：`ask` = 「微信问答」页签，`session` = 会话内问答。
       * 缺省按 `ask` 处理 —— 旧客户端不带这个字段时也能正常落库。
       */
      source?: string
      /** 会话显示名：历史列表直接显示，省掉面板再查一次会话表。 */
      usernameName?: string
      /**
       * 当前知识库 id：本次提问会把该库的文件块一并纳入检索。
       *
       * 缺省不检索知识库（而不是「搜所有库」）—— 与其余知识库接口同一纪律：
       * `kbId` 是作用域，没有「所有库」这种模式；漏传应当表现为「没检索到文件」，
       * 而不是把别的库的内容也端上来。
       */
      kbId?: number
    }): Promise<AskResult> {
      const ctx = rc.ctx()
      /** 端到端耗时基准（提问 → 回答生成结束），写进历史记录供用户回看时判断快慢。 */
      const askStartedAt = Date.now()
      // 先判「出站拦截」：它比「未配置模型」更该被用户看到（见 privacyBlocked 的注释）
      const blocked = rc.privacyBlocked('ask_wechat')
      if (blocked !== null) {
        rc.op('task', 'ask_wechat', 'skip', '', blocked)
        throw new Error(blocked)
      }
      const defaultModel = (ctx as unknown as {
        agentDefaultModel?: { currentSelection(): { provider: string; model: string; reasoningEffort?: string } }
      }).agentDefaultModel
      const sel = defaultModel?.currentSelection()
      if (!sel || !sel.provider || !sel.model) {
        rc.op('task', 'ask_wechat', 'fail', '', '未配置默认模型（agentDefaultModel）')
        throw new Error('未配置默认模型（agentDefaultModel），无法调用 AI 问答')
      }
      /** 写进历史的回答模型标签（与面板底部「片段会发给谁」同一口径）。 */
      const modelLabel = `${sel.provider} · ${sel.model}`
      // 检索范围：会话范围 / 时间范围必须真的参与检索。
      // 从前这里只传 question，用户选了「会话范围」也仍然全库检索（本次修复）。
      const scope: { username?: string; from?: string; to?: string } = {
        username: typeof options.username === 'string' && options.username ? options.username : undefined,
        from: typeof options.from === 'string' && options.from ? options.from : undefined,
        to: typeof options.to === 'string' && options.to ? options.to : undefined,
      }
      // 多轮：最多携带最近 16 条（8 轮），并按**总字数预算**截断 ——
      // 单条截断不够：8 轮长回答各 2000 字会把 prompt 撑到 1.6 万字，把检索结果挤到末尾。
      const history = (Array.isArray(options.history) ? options.history : [])
        .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim().length > 0)
        .slice(-16)
      const HISTORY_BUDGET = 4000
      let historyUsed = 0
      const trimmedHistory: Array<{ role: 'user' | 'assistant'; content: string }> = []
      for (const m of [...history].reverse()) {
        const room = HISTORY_BUDGET - historyUsed
        if (room <= 80) break
        const text = m.content.trim().slice(0, Math.min(m.role === 'assistant' ? 1200 : 400, room))
        trimmedHistory.unshift({ role: m.role, content: text })
        historyUsed += text.length
      }
      const llm = ctx.llm
      /**
       * 跑一次对话。`onDelta` 存在时，把**已生成的全文**在生成过程中回传 ——
       * 传全文而不是增量片段：渲染进程只需整体替换，丢一两个事件也不会串行错乱。
       */
      const runChat = async (system: string, userText: string, maxTokens: number, onDelta?: (text: string) => void): Promise<string> => {
        const assembler = new BlockAssembler()
        const opts: GenerateOptions = {
          provider: sel.provider,
          model: sel.model,
          messages: [createUserMessage({
            content: [{ type: 'text', text: userText }],
            source: { kind: 'plugin', plugin: 'dsh-wechat-data' },
          })],
          system,
          maxTokens,
        }
        let acc = ''
        let emitted = false
        for await (const chunk of llm.stream(opts)) {
          assembler.push(chunk)
          const c = chunk as { type?: string; text?: string }
          if (onDelta && c.type === 'text-delta' && typeof c.text === 'string') {
            acc += c.text
            emitted = true
            onDelta(acc)
          }
        }
        // 厂商不支持 SSE 时 stream() 只 yield 一次完整 text-delta，上面已覆盖；
        // 若一个 delta 都没拿到（极端情况），最后补发一次完整文本，保证界面不会空着。
        if (onDelta && !emitted) {
          const finalText = assembler.blocks().map(b => (b.type === 'text' ? b.text : '')).join('').trim()
          if (finalText) onDelta(finalText)
        }
        return assembler.blocks().map(b => (b.type === 'text' ? b.text : '')).join('').trim()
      }

      // ── 第 1 步：意图分析与拆解（LLM → JSON 规划） ──
      // 规划器同时负责**把相对时间换算成绝对日期**（「上周三」→ 2026-09-02）与
      // **点名的人**（「李四」）—— 旧实现只取 subQueries，这两个线索全丢，
      // 于是「上周三我和李四聊了什么」只能靠通用词在全库瞎撞。
      const today = new Date()
      const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
      const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][today.getDay()]
      const scopeDesc = `会话=${scope.username ?? '全部'}${scope.from ? `，起始=${scope.from}` : ''}${scope.to ? `，截止=${scope.to}` : ''}`
      const historyBrief = history.length > 0
        ? '\n对话历史（最近）：\n' + trimmedHistory.map(m => (m.role === 'user' ? '用户：' : '助手：') + m.content.slice(0, 300)).join('\n')
        : ''
      const planPrompt = `今天是 ${todayStr}（${weekday}）。\n用户问题：${options.question}\n当前筛选范围：${scopeDesc}${historyBrief}\n\n请输出 JSON（不要输出其他内容）。`
      const gatePlan = rc.privacyGate('ask_wechat', { sessions: 0, messages: 0 }, [planPrompt])
      if (!gatePlan.ok) {
        rc.op('task', 'ask_wechat', 'skip', '', gatePlan.error)
        throw new Error(gatePlan.error)
      }
      let plan: { intent: string; subQueries: string[]; from: string; to: string; person: string }
      try {
        const planText = await runChat(
          '你是微信本地聊天记录的检索规划器。任务：分析用户问题，输出**检索关键词**与**隐含条件**。'
          + '要求：① subQueries 给 1-4 个真正有区分度的中文关键词或短语（人名、事物、动作、专有名词），'
          + '不要输出「什么/怎么/我的/给我/最近/一次」这类疑问词、停用词或泛化时间词；'
          + '② 问题里出现相对时间（上周三/昨天/上个月）时，按给定的今天日期换算成绝对日期填 from/to（YYYY-MM-DD，单日则 from=to），'
          + '识别不出就留空字符串；③ 问题点名了某个人就填 person，否则留空字符串。'
          + '只输出一行 JSON：{"intent":"一句话意图","subQueries":["关键词1","关键词2"],"from":"YYYY-MM-DD","to":"YYYY-MM-DD","person":"人名"}',
          gatePlan.texts[0] ?? planPrompt,
          512,
        )
        plan = parseAskPlan(planText)
        if (plan.subQueries.length === 0 && options.question.trim()) plan.subQueries = [options.question.trim()]
      } catch (e) {
        // 规划失败不阻断：退化为直接用原问题做 bigram 检索，保证问答始终可用。
        plan = { intent: '（规划失败，直接检索原问题）', subQueries: options.question.trim() ? [options.question.trim()] : [], from: '', to: '', person: '' }
        rc.op('task', 'ask_wechat', 'fail', 'intent_plan', (e as Error).message)
      }

      // ── 第 2 步：多词召回 → 打分排序 → 展开成对话窗口（chunk 级 RAG 检索）──
      // 自建 BM25 索引是「相关度排序」的前提：没有它就得退回 LIKE 扫描，
      // 每个词只能看到按行号倒序的前 20 条（实测 `合同` 全库 4062 条 → 召回率 0.49%）。
      // 全量构建实测 5.4s / 13.5 万条，因此首次提问时自动建一次。
      //
      // **关键（本轮修）**：只有「首次构建」是不够的。「索引存在且版本对」跟「索引里有
      // 没有今天刚聊的消息」是两件事 —— 微信是持续写入的，而构建完就不再更新，于是索引
      // 会**永久**停在构建那一刻。实测生产索引 built_at=2026-09-13、库内最新消息 09-11，
      // 而消息分片里已经有 09-18 的对话（09-17 一天 139 条）：问「今天聊了啥」时当天数据
      // 根本不在检索空间里，BM25 只能召回正文恰好写着「今天」的旧消息（同年 2/3/7 月），
      // 这就是「回复内容不正确 + 消息列表冒出其他日期」的根源。
      // `ensureSearchIndex` 因此分两种情形：缺失/版本不符 → 全量构建；只是落后 →
      // 按分片水位线增量补录（代价与新增条数同阶，实测毫秒级）。
      try {
        const ensured = await ensureSearchIndex(rc.dirs().decrypted)
        if (ensured.action === 'build') {
          rc.op('task', 'ask_wechat', 'ok', 'build_index', `检索索引全量构建 · ${ensured.rows ?? 0} 条 · ${ensured.elapsed_ms}ms`)
        } else if (ensured.action === 'sync') {
          rc.op('task', 'ask_wechat', 'ok', 'build_index', `检索索引增量同步 · 新增 ${ensured.added ?? 0} 条 · ${ensured.elapsed_ms}ms`)
        } else if (ensured.message) {
          rc.op('task', 'ask_wechat', 'fail', 'build_index', ensured.message)
        }
      } catch (e) {
        // 索引不可用不阻断提问：退回 LIKE 召回（准确率低但可用）
        rc.op('task', 'ask_wechat', 'fail', 'build_index', (e as Error).message)
      }
      // ── 第 2 步：多阶段检索 ──
      // 顺序：意图路由 → 查询改写 → 混合召回（稀疏 BM25 + 稠密向量 + 结构化）→
      //       RRF 融合去重 → 交叉特征重排 → 上下文压缩。
      // config.enabled=false 时退回旧的单通道检索（灰度/回滚开关）。
      const retrConfig = loadRetrievalConfig(rc.dirs().decrypted)
      const scopeDescText = [
        scope.username ? '会话限定' : '',
        scope.from ? `起 ${scope.from}` : '',
        scope.to ? `止 ${scope.to}` : '',
      ].filter(Boolean).join(' ') || '全库'
      // 这五个都在这段下方的两条路径里被赋值（legacyRetrieve 闭包 / 流水线分支），
      // 而 TS 的确定性赋值分析看不穿闭包调用，会报 50 条 TS2454。这里给**真实默认值**
      // 而不是用 `!` 断言：万一哪条路径漏了赋值，宁可退化成「没有原文 → 不调模型」
      // （硬约束一），也不要带着未定义值继续往下跑。
      let citations: ReturnType<typeof retrieveAskCitations>['citations'] = []
      let chunks: ReturnType<typeof retrieveAskCitations>['chunks'] = []
      let terms: string[] = []
      let statsCompat: {
        candidates: number; kept: number; scope: string; recency: boolean
        timeHint: string; hintHits: number; chunks: number; windowMessages: number
        intent?: string; denseActive?: boolean; elapsedMs?: number
        channels?: Array<{ channel: string; count: number; active: boolean; note?: string }>
        funnel?: { recalled: number; fused: number; ranked: number }
      } = {
        candidates: 0, kept: 0, scope: scopeDescText, recency: false,
        timeHint: '', hintHits: 0, chunks: 0, windowMessages: 0,
      }
      let rankedFeatures: Array<{ docKey: string; features: RerankWeights }> = []
      let retrievalId = ''

      /** 旧单通道检索：灰度对照 / 回滚 / 流水线异常时的降级路径。 */
      const legacyRetrieve = (): void => {
        const legacy = retrieveAskCitations(
          rc.dirs().decrypted,
          options.question,
          { subQueries: plan.subQueries, from: plan.from, to: plan.to, person: plan.person },
          scope,
          24,
        )
        citations = legacy.citations
        chunks = legacy.chunks
        terms = legacy.terms
        statsCompat = { ...legacy.stats }
        rankedFeatures = []
        retrievalId = ''
      }

      // 依据行里那句「精排用了什么」：管道跑完才有值，而 `basisLine` 在 if 之外拼装，
      // 所以在外层占位。走不到管道（检索被关闭）时它保持空串，那句话也就不出现 ——
      // 比硬写一句「没精排」诚实：那次确实没有排序这回事，是**没检索**。
      let rerankLine = ''
      if (retrConfig.enabled) {
        try {
        // 稠密通道是**新增的出网点**：embedding 调用统一过隐私闸门（见 makeEmbedFn），
        // 未配置 / 被「出站拦截」时抛错，流水线自动降级为纯稀疏，不影响问答可用性。
        // 模型名只解析**一次**并复用：`makeEmbedFn` 发出去的是它，向量库记的也是它。
        // （此前两边各算一遍，这边算出 `'default'`、那边发的是 llm.json 的值 —— 见 §7 F1。）
        const embedModel = rc.embedModelName(retrConfig.embedding.model)
        const embedFn = rc.makeEmbedFn(embedModel)
        // 向量索引：首次（或增量）在提问时补齐；失败只记录，不阻断（退化为纯稀疏）。
        if (embedFn && retrConfig.embedding.enabled) {
          const vst = vectorIndexStatus(rc.dirs().decrypted)
          if (!vst.ready) {
            try {
              const built = await buildVectorIndex(rc.dirs().decrypted, embedFn, {
                model: embedModel,
                batchSize: retrConfig.embedding.batchSize,
                concurrency: retrConfig.embedding.concurrency,
                maxCharsPerDoc: retrConfig.embedding.maxCharsPerDoc,
                maxDocsPerBuild: retrConfig.embedding.maxDocsPerBuild,
              })
              rc.op('task', 'ask_wechat', 'ok', 'build_vectors', `向量索引 ${built.status} · ${built.rows} 条（本次 ${built.embedded}）· ${built.elapsed_ms}ms`)
            } catch (e) {
              rc.op('task', 'ask_wechat', 'fail', 'build_vectors', (e as Error).message)
            }
          }
        }
        const adapted = loadAdaptedWeights(rc.dirs().decrypted)
        // 已知实体名：让「点名识别」走本地确定性名单，而不是只靠规划器这一跳。
        const known = rc.askKnownEntities()
        // 知识库作用域：只有传了合法 id 才开 kb 通道。非法值（0 / 负数 / NaN）当「没传」
        // 处理并留一条操作日志 —— 静默变成「搜了整个库」才是危险的，变成「没搜文件」不是。
        const kbId = Number.isFinite(options.kbId) && (options.kbId ?? 0) > 0 ? Math.trunc(options.kbId as number) : undefined
        if (options.kbId !== undefined && kbId === undefined) {
          rc.op('task', 'ask_wechat', 'fail', 'kb_scope', `忽略非法的知识库标识：${String(options.kbId)}`)
        }
        // 知识库向量索引：与消息侧同款「提问时按需补齐」，但**按库**建。
        // 为什么要按库而不是一次建全库：出网范围必须与用户此刻的意图一致 —— 用户在这个库里
        // 提问，就只把这个库的正文送去 embedding；一次建全库会把**别的库**的正文也发出去，
        // 而「文件级 RAG 开关」只表达得了文件意愿、表达不了库意愿（见 kb-vectors.ts 头注）。
        // 失败只记录、不阻断：稠密不可用时通道如实降级为纯关键词，问答照常可用。
        // 库级覆盖**只作用于知识库这一路**：消息域的向量不属于任何库，跟着全局走。
        const kbEmbedModel = kbId === undefined ? embedModel : rc.kbModel(kbId, 'embed').model
        // 精排只构造一次：`makeRerankFn` 里含一次 SQLite 读（库级覆盖），调两遍就是白读一次，
        // 而且两次结果理论上可以不一致（中间正好有人改了设置）。
        const rerankModelName = rc.kbModel(kbId ?? 0, 'rerank').model
        const rerankFn = rc.makeRerankFn(kbId ?? 0)
        if (kbId !== undefined && retrConfig.embedding.enabled) {
          const kbSt = kbVectorIndexStatus(rc.dirs().decrypted, kbId, kbEmbedModel)
          if (!kbSt.ready) {
            try {
              const kbEmbed = rc.makeEmbedFn(kbEmbedModel, 'kb_embed')
              if (kbEmbed) {
                const built = await buildKbVectorIndex(rc.dirs().decrypted, kbId, kbEmbed, {
                  model: kbEmbedModel,
                  batchSize: retrConfig.embedding.batchSize,
                  concurrency: retrConfig.embedding.concurrency,
                  maxCharsPerDoc: retrConfig.embedding.maxCharsPerDoc,
                  maxDocsPerBuild: retrConfig.embedding.maxDocsPerBuild,
                })
                rc.op('task', 'ask_wechat', 'ok', 'build_kb_vectors',
                  `知识库向量 ${built.status} · ${built.rows} 条（本次 ${built.embedded}）· ${built.elapsed_ms}ms`)
              }
            } catch (e) {
              rc.op('task', 'ask_wechat', 'fail', 'build_kb_vectors', (e as Error).message)
            }
          }
        }
        const out = await runRetrievalPipeline({
          decryptedDir: rc.dirs().decrypted,
          question: options.question,
          subQueries: plan.subQueries,
          entity: plan.person,
          from: plan.from,
          to: plan.to,
          scope,
          limit: 24,
          config: retrConfig,
          ...(embedFn ? { embedFn } : {}),
          // 与 embedFn 同一个解析出来的模型名：稠密召回靠它判「库里那批向量是不是本次模型算的」。
          // 传 kbEmbedModel 而不是 embedModel —— 知识库这一路可能被库级覆盖改过名字。
          embedModel: kbEmbedModel,
          // 精排：没配 rerank 模型时这里就是 undefined，管道整段跳过并按本地加权排序。
          ...(rerankFn ? { rerank: rerankFn } : {}),
          rerankModel: rerankModelName,
          // 名单里已有的就不重复；规划器额外点出的名字也一并带上（可能不在通讯录里）。
          knownEntities: plan.person && !known.includes(plan.person) ? [...known, plan.person] : known,
          ...(adapted ? { weightsOverride: adapted } : {}),
          ...(kbId !== undefined ? { kbId } : {}),
        })
        rerankLine = out.rerankInfo.used
          ? ` · 精排：${out.rerankInfo.model || '未知模型'}（候选 ${out.rerankInfo.candidates} → 取 ${out.rerankInfo.kept}）`
          : ` · 精排：${out.rerankInfo.note}`
        citations = out.citations
        chunks = out.chunks
        terms = out.terms
        rankedFeatures = out.rankedFeatures
        retrievalId = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
        statsCompat = {
          candidates: out.stats.recalled,
          kept: out.stats.kept,
          scope: scopeDescText,
          recency: out.stats.recency,
          timeHint: out.stats.timeHint,
          hintHits: out.stats.hintHits,
          chunks: out.stats.compressed,
          windowMessages: out.stats.windowMessages,
          intent: out.stats.intent,
          denseActive: out.stats.denseActive,
          elapsedMs: out.stats.elapsedMs,
          channels: out.stats.channels.map(c => ({ channel: c.channel, count: c.count, active: c.active, ...(c.note ? { note: c.note } : {}) })),
          funnel: { recalled: out.stats.recalled, fused: out.stats.fused, ranked: out.stats.ranked },
        }
        rc.op('task', 'ask_wechat', 'ok', 'route',
          `意图 ${out.stats.intent} · 通道[${out.stats.channels.map(c => `${c.channel}:${c.count}${c.active ? '' : '(off)'}`).join(' ')}] · 召回 ${out.stats.recalled} → 融合 ${out.stats.fused} → 重排 ${out.stats.ranked} → 窗口 ${out.stats.compressed} · ${out.stats.elapsedMs}ms`)
        } catch (e) {
          // 流水线自身异常（非通道降级）→ 回退旧检索，绝不让问答整体不可用。
          rc.op('task', 'ask_wechat', 'fail', 'retrieval_pipeline', (e as Error).message)
          legacyRetrieve()
        }
      } else {
        legacyRetrieve()
      }

      // ── 硬约束一：没有任何原文就**不调模型** ──
      // 提示词里写「没找到就说明没找到」只是软约束；模型完全有可能凭常识编一段。
      // 这里直接短路：没有可引用的原文，就没有可核实的回答。
      // 精排这一句必须出现在依据行里：`used:true` 与 `used:false` 是两种不同的可信度 ——
      // 前者说明「有个模型读过这批候选并给了顺序」，后者说明「顺序是本地启发式给的」。
      // 不写出来，用户就会把「没配模型」读成「模型认为这些最相关」。
      const basisLine = askBasisLine(citations) + rerankLine
      if (citations.length === 0) {
        rc.op('task', 'ask_wechat', 'skip', '', '未检索到任何原文，未调用模型')
        // 「没检索到」也是一次问答（用户确实问了、也确实拿到了回答），必须进历史 ——
        // 否则回看历史时这一段是空的，用户会以为当时根本没问过。
        const emptyResult: AskResult = {
          answer: '本机记录里没有检索到与这个问题相关的原文，因此不作回答（不会基于常识推测）。可以试试：换关键词、收窄时间范围，或指定某个会话再问。',
          citations: [],
          plan: { intent: plan.intent, subQueries: plan.subQueries, from: plan.from, to: plan.to, person: plan.person, terms },
          citedIndexes: [],
          basis: '',
          insufficient: true,
          retrieval: {
            candidates: statsCompat.candidates, kept: statsCompat.kept, scope: statsCompat.scope,
            recency: statsCompat.recency, chunks: statsCompat.chunks, windowMessages: statsCompat.windowMessages,
          },
        }
        rc.saveAskHistory(options, emptyResult, Date.now() - askStartedAt, modelLabel)
        return emptyResult
      }

      const contextBlock = formatAskContext(citations, {
        intent: plan.intent,
        terms,
        scope: statsCompat.scope,
        recency: statsCompat.recency,
        timeHint: statsCompat.timeHint,
        hintHits: statsCompat.hintHits,
      }, chunks)

      // ── 第 3 步：综合对话历史与检索结果生成回答 ──
      const historyBlock = trimmedHistory.length > 0
        ? '此前的对话（保持多轮连贯，但答案必须以本次检索结果为准）：\n' + trimmedHistory.map(m => (m.role === 'user' ? '用户：' : '助手：') + m.content).join('\n') + '\n\n'
        : ''
      // 提示词的取舍：
      //  · 「只用材料里的事实 / 找不到就直说」是**内容**底线（配合后端的两道硬约束：无原文不调模型、
      //    无引用不予采用）；
      //  · 「像微信聊天那样自然说话」是**语气**要求 —— 早先写的是「简洁分点」，模型会写成报告腔
      //    （「综上所述」「根据数据分析」），而这是个聊天记录问答工具，用户想听的是「谁说了什么」。
      // 时间线索护栏（本轮修）：检索侧给出时间线索却 0 命中时，材料里剩下的**全是别的
      // 日期**的记录。旧实现只在上下文头写了一句「不要声称限定在该日期」，模型于是如实
      // 回答「今天没找到，放宽都是别的日子」—— 但这几条别日期的片段仍被当作「唯一事实
      // 依据」并列了出来，用户看到的就是「回复不正确 + 冒出其他日期的消息」。
      // 这里把它写成不可绕过的行为规则，并要求逐条标出真实日期。
      const timeGuardRule = statsCompat.timeHint
        ? (statsCompat.hintHits > 0
          ? `\n7. **时间范围**：材料都落在 ${statsCompat.timeHint} 内，可以按该范围陈述。`
          : `\n7. **时间范围（重要）**：检索在 ${statsCompat.timeHint} 内**一条都没找到**，下面列出的片段全部来自**其他日期**。必须先明确说一句「${statsCompat.timeHint} 这段时间没有找到相关聊天记录」，然后才可以说「另外在 X 月 X 日聊过……」并**逐条写出这些内容的真实日期**。绝对不要把其他日期的内容说成是该时间范围内发生的。`)
        : ''
      const synthPrompt = `${historyBlock}用户本次问题：${options.question}

  ${contextBlock}

  请按以下要求回答：
  1. **只用材料里的事实**：上面检索结果里没有的信息一律不要补充，尤其不要凭常识推测人名、金额、日期、时间。宁可少说，也不要编。金额、日期、电话/卡号这类值**只能原样照抄**材料里的写法 —— 要说合计就写明由哪几条相加（如「3500+3500=7000」），不要自行换算单位或推算日期。
  2. **像微信里跟人说话那样自然**：口语化中文，直接把事情讲清楚，不要写成报告或分析（不要「综上所述」「根据数据分析」「经梳理」这类腔调），也不要复述检索过程。要罗列多条时可以分点，但每条都要像在转述聊天内容。
  3. **每条事实后面标 [n]**：例如「小何说收到转账 13.00 元 [1]」，多个来源写 [1][3]。材料里形如「群名 · 某人」的，要说清是谁说的。
  4. **时间写绝对日期**（如 2026-09-05），不要写「上周」「前几天」这类相对表述。
  5. **找不到就直说**：材料不足以回答时，直接说明「聊天记录里没有找到……」，再给 1-2 条改问建议（换关键词、收窄时间或指定会话）。不要用推测填空。
  6. 只引用真正支持结论的那几条来源，不要罗列全部；也不用写「依据本机记录」这类来源说明，界面上已单独显示。${timeGuardRule}`
      const gateAnswer = rc.privacyGate(
        'ask_wechat',
        { sessions: new Set(citations.map(c => c.username)).size, messages: citations.length },
        [synthPrompt],
      )
      if (!gateAnswer.ok) {
        rc.op('task', 'ask_wechat', 'skip', '', gateAnswer.error)
        throw new Error(gateAnswer.error)
      }
      const answer = await runChat(
        '你是用户微信聊天记录里的问答助手。只用下面给出的检索结果回答，说话自然、口语化，像在微信里跟人转述聊天内容；每句事实后面用 [n] 标注来源；记录里没有的就说没找到，绝不推测或编造。',
        gateAnswer.texts[0] ?? synthPrompt,
        1600,
        // 必须走 this.：makeDeltaEmitter 是实例方法。裸调用会抛
        // 「ReferenceError: makeDeltaEmitter is not defined」—— 它出现在**综合生成那一刻**，
        // 于是每次提问都在出答案前崩掉（UI 自动化验收实测捕捉到）。
        rc.makeDeltaEmitter(options.streamId),
      )
      /** 回答「自己引用的」那些来源的正文：优先窗口全文，退化用引用卡片里的片段。
       *  接地审计必须拿**同一条证据**去核对 —— 用窗口全文而不是列表里的 120 字摘要，
       *  是为了避免「值明明在窗口里、只是没进摘要」被误判成编造。 */
      const evidenceFor = (cited: number[]): string[] => {
        const idx = cited.length > 0 ? cited : citations.map((_, i) => i + 1)
        return idx.map((n) => {
          const ch = chunks[n - 1]
          if (ch) {
            const head = `${ch.name} ${ch.anchor.sender ?? ''} ${ch.anchor.time}`
            return head + '\n' + ch.lines.map(l => `${l.day ?? ''} ${l.time} ${l.sender} ${l.text}`).join('\n')
          }
          const c = citations[n - 1]
          return c ? `${c.name} ${c.sender ?? ''} ${c.time} ${c.snippet}` : ''
        })
      }
      const groundingAuditFor = (text: string, cited: number[]): ReturnType<typeof auditGrounding> =>
        auditGrounding(text, evidenceFor(cited), citations.length)

      // ── 硬约束二：回答必须能对应到原文，否则不采用 ──
      // 三道检查，任一不通过都带着**具体问题**回炉重写一次：
      //   ① 一个 [n] 都没有 → 整段内容无法逐条核实（可能是模型凭常识补的）；
      //   ② 接地审计发现「引用原文里没有的金额/日期/长数字」→ 典型编造；
      //   ③ 带这些高风险值的句子没标 [n]（软问题，只触发重写）。
      // 重写后仍然没有任何引用才**不予采用**。金额类不做硬拦截 —— 合计是模型可以正当
      // 算出来的，拦住它会把「一共转了多少」直接变成无法回答（与前端
      // panels/utils/grounding.ts 的同一取舍：那里只提示、不拦截）。重写通过时用重写稿，
      // 没有变得更差才替换 —— 免得「越改越糟」把已经能核实的内容丢掉。
      let citedIndexes = parseCitedIndexes(answer, citations.length)
      let finalAnswer = answer
      let withheld = false
      let grounding = groundingAuditFor(answer, citedIndexes)
      let repaired = false
      if (citedIndexes.length === 0 || grounding.unsupported.length > 0 || grounding.uncited > 0) {
        const repairHint = groundingRepairHint(grounding)
        const strictPrompt = `${synthPrompt}

  【重要】请重写上一次的回答，逐条修掉下面的问题。
  ${citedIndexes.length === 0 ? ' · 上一次的回答**没有标注任何 [n] 来源**。\n' : ''}${repairHint ? repairHint + '\n' : ''} · 每一句事实性陈述后面都必须紧跟对应的 [n]，且只标真正支持这句话的那几条；
   · 语气保持自然口语化，像在微信里转述聊天内容；
   · 如果检索结果不足以回答，只输出一句话：「本机记录中没有找到可据以回答的证据」。`
        const second = await runChat(
          '你是用户微信聊天记录里的问答助手。只用给定检索结果回答，自然口语化，每句事实标注 [n]；记录里没有就直说没找到，不要推测或编造。',
          strictPrompt,
          1600,
        )
        const secondCited = parseCitedIndexes(second, citations.length)
        const secondAudit = groundingAuditFor(second, secondCited)
        const better = secondCited.length > 0 && (
          secondAudit.unsupported.length < grounding.unsupported.length
          || (secondAudit.unsupported.length === grounding.unsupported.length && secondCited.length > citedIndexes.length)
        )
        if (better) {
          finalAnswer = second
          citedIndexes = secondCited
          grounding = secondAudit
          repaired = true
        }
      }
      if (citedIndexes.length === 0) {
        withheld = true
        finalAnswer = '本机记录中没有找到可据以回答的证据（模型给出的内容无法对应到任何一条原文，已不予采用）。可以换关键词、收窄时间范围或指定会话后重试。'
      }
      const answer_basis = citedIndexes.length > 0
        ? `${basisLine}（回答引用了其中 ${citedIndexes.length} 条：[${citedIndexes.join('][')}]）`
        : basisLine
      // 记录本次检索的特征画像，供用户反馈时做「特征归因 → 权重微调」。
      if (retrievalId && rankedFeatures.length > 0) {
        rc.askTrace.set(retrievalId, {
          features: new Map(rankedFeatures.map(r => [r.docKey, r.features])),
          // 归因键**必须**与检索侧 docKey 逐字相同，否则「这条引用有用」对应不到任何
          // 特征向量 —— 而且不报错，只是调参永远不动。知识库引用的键是
          // `kb:<kbId>:<chunkId>`（由 citationDocKey 产出，是这条格式的唯一来源）；
          // 从前这里手写 `username + ':' + local_id`，KB 引用会塌成 `:`，
          // 同一轮里的多个文件引用还会**互相覆盖**，把反馈记到不存在的消息上。
          citations: citations.map(c => citationDocKey(c)),
          question: options.question,
          answer: finalAnswer,
          intent: (statsCompat.intent ?? 'open_qa') as IntentKind,
        })
        // 有界缓存：只保留最近 20 轮，避免长会话把内存撑大。
        while (rc.askTrace.size > 20) {
          const oldest = rc.askTrace.keys().next()
          if (oldest.done) break
          rc.askTrace.delete(oldest.value)
        }
      }
      rc.op(
        'task', 'ask_wechat', withheld ? 'fail' : 'ok', '',
        `意图「${statsCompat.intent ?? plan.intent}」· 关键词 ${terms.length} 个 · 召回 ${statsCompat.candidates} 条 → 窗口 ${statsCompat.chunks} 段（${statsCompat.windowMessages} 条消息）· 回答引用 ${citedIndexes.length} 段${withheld ? ' · 未引用任何来源，已不予采用' : ''}${grounding.checked > 0 ? ` · 接地核对 ${grounding.checked} 项（无出处的 ${grounding.unsupported.length} 项）` : ''}${repaired ? ' · 已按核对结果重写' : ''}${statsCompat.timeHint ? ` · 时间线索 ${statsCompat.timeHint}（命中 ${statsCompat.hintHits}）` : ''}`,
      )
      const result: AskResult = {
        answer: finalAnswer || '（模型未返回有效回答。可点「优化提问」改写问题，或收窄会话/时间范围后重试。）',
        citations,
        plan: { intent: plan.intent, subQueries: plan.subQueries, from: plan.from, to: plan.to, person: plan.person, terms },
        citedIndexes,
        basis: answer_basis,
        withheld: withheld || undefined,
        // 接地核对结果：界面上「回答里某某在原文里没有出现」的提示与操作日志共用它，
        // 也让「这轮到底核对了什么」可被追问。
        grounding: {
          checked: grounding.checked,
          unsupported: grounding.unsupported.map(v => v.value),
          cited: citedIndexes.length,
          repaired,
        },
        retrievalId: retrievalId || undefined,
        retrieval: {
          candidates: statsCompat.candidates, kept: statsCompat.kept, scope: statsCompat.scope,
          recency: statsCompat.recency, timeHint: statsCompat.timeHint, hintHits: statsCompat.hintHits,
          chunks: statsCompat.chunks, windowMessages: statsCompat.windowMessages,
          ...(statsCompat.intent ? { intent: statsCompat.intent } : {}),
          ...(statsCompat.denseActive !== undefined ? { denseActive: statsCompat.denseActive } : {}),
          ...(statsCompat.channels ? { channels: statsCompat.channels } : {}),
          ...(statsCompat.elapsedMs !== undefined ? { elapsedMs: statsCompat.elapsedMs } : {}),
          ...(statsCompat.funnel ? { funnel: statsCompat.funnel } : {}),
        },
      }
      // 自动落进「问答历史」。这是两个写入点里的第二个（另一个在上面「没检索到原文」
      // 的短路返回处）—— 只要走到 return，就有一次可回看的问答。
      // best-effort：存历史失败绝不能把已经生成好的回答变成一次报错。
      rc.saveAskHistory(options, result, Date.now() - askStartedAt, modelLabel)
      return result
    },

    async optimizeAskQuestion(options: {
      question: string
      username?: string
      from?: string
      to?: string
      history?: Array<{ role: 'user' | 'assistant'; content: string }>
    }): Promise<AskOptimizeResult> {
      const ctx = rc.ctx()
      const blocked = rc.privacyBlocked('ask_optimize')
      if (blocked !== null) {
        rc.op('task', 'ask_optimize', 'skip', '', blocked)
        throw new Error(blocked)
      }
      const question = String(options?.question || '').trim()
      if (!question) throw new Error('请先输入问题，再进行优化')
      const defaultModel = (ctx as unknown as {
        agentDefaultModel?: { currentSelection(): { provider: string; model: string; reasoningEffort?: string } }
      }).agentDefaultModel
      const sel = defaultModel?.currentSelection()
      if (!sel || !sel.provider || !sel.model) {
        rc.op('task', 'ask_optimize', 'fail', '', '未配置默认模型（agentDefaultModel）')
        throw new Error('未配置默认模型（agentDefaultModel），无法优化提问')
      }
      const scopeDesc = `会话=${options.username || '全部'}${options.from ? `，起始=${options.from}` : ''}${options.to ? `，截止=${options.to}` : ''}`
      const history = (Array.isArray(options.history) ? options.history : [])
        .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .slice(-6)
      const historyBrief = history.length > 0
        ? '\n最近对话背景：\n' + history.map(m => (m.role === 'user' ? '用户：' : '助手：') + m.content.slice(0, 200)).join('\n')
        : ''
      const prompt = `用户原始问题：${question}\n当前检索范围：${scopeDesc}${historyBrief}\n\n请输出 JSON（不要输出其他内容）。`
      const gate = rc.privacyGate('ask_optimize', { sessions: 0, messages: 0 }, [prompt])
      if (!gate.ok) {
        rc.op('task', 'ask_optimize', 'skip', '', gate.error)
        throw new Error(gate.error)
      }
      const assembler = new BlockAssembler()
      const opts: GenerateOptions = {
        provider: sel.provider,
        model: sel.model,
        messages: [createUserMessage({
          content: [{ type: 'text', text: gate.texts[0] ?? prompt }],
          source: { kind: 'plugin', plugin: 'dsh-wechat-data' },
        })],
        system: '你是微信聊天记录的提问优化器。把用户问题改写得更清晰、更利于全文检索（保留原意，补充隐含的时间/对象等限定，去掉口语口水词），并给出至多 3 条具体的改进建议。只输出一行 JSON：{"optimized":"优化后的问题","suggestions":["建议1","建议2"]}',
        maxTokens: 512,
      }
      for await (const chunk of ctx.llm.stream(opts)) assembler.push(chunk)
      const text = assembler.blocks().map(b => (b.type === 'text' ? b.text : '')).join('').trim()
      const parsed = parseAskOptimize(text)
      const optimized = parsed.optimized || text.slice(0, 300)
      rc.op('task', 'ask_optimize', 'ok', '', optimized.slice(0, 80))
      return { optimized, suggestions: parsed.suggestions }
    },

    async buildRagVectorIndex(options?: { force?: boolean }): Promise<{ ok: boolean; status: string; rows: number; embedded: number; elapsed_ms: number; message?: string }> {
      const cfg = loadRetrievalConfig(rc.dirs().decrypted)
      const embedModel = rc.embedModelName()
      const embedFn = rc.makeEmbedFn(embedModel)
      if (!embedFn) return { ok: false, status: 'no-embedder', rows: 0, embedded: 0, elapsed_ms: 0, message: '未配置 embedding（请在模型配置里填写向量模型或 API Key）' }
      // 向量库是按「搜索索引里的文档」建的，所以先保证索引最新（缺失→构建，落后→增量）。
      try { await ensureSearchIndex(rc.dirs().decrypted) } catch { /* 交给下面状态判定 */ }
      try {
        const r = await buildVectorIndex(rc.dirs().decrypted, embedFn, {
          model: embedModel,
          batchSize: cfg.embedding.batchSize,
          concurrency: cfg.embedding.concurrency,
          maxCharsPerDoc: cfg.embedding.maxCharsPerDoc,
          maxDocsPerBuild: cfg.embedding.maxDocsPerBuild,
          force: Boolean(options?.force),
        })
        rc.op('task', 'build_vectors', 'ok', '', `${r.status} rows=${r.rows} embedded=${r.embedded} ${r.elapsed_ms}ms`)
        return { ok: true, ...r }
      } catch (e) {
        rc.op('task', 'build_vectors', 'fail', '', (e as Error).message)
        return { ok: false, status: 'error', rows: 0, embedded: 0, elapsed_ms: 0, message: (e as Error).message }
      }
    },

  }
}
