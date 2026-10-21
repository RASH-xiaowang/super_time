/**
 * 问答的**检索阶段**（2026-10-16 从 `askdeep.ts#askWechat` 抽出）。
 *
 * ## 为什么抽出来
 *
 * `createAskDeepRemotes` 受 `function-size-ratchet.spec.ts` 的棘轮管着（登记 574 行，
 * 只许变小）。本轮为修「搜索不准确」加了聚合通道、阶段事件、思考过程之后涨到 671 行 ——
 * 直接顶穿棘轮。而检索这一段（向量索引补齐 → 知识库向量 → 跑流水线 → 降级回退）
 * 是**语义独立**的一块：它只回答「这次提问该拿哪些原文」，与后面的规划、生成、
 * 接地核对没有耦合。
 *
 * ## 为什么用「结果对象」而不是多个 out 参数
 *
 * 它要回传 7 个值（citations / chunks / terms / rankedFeatures / retrievalId /
 * statsCompat / timeBrowse）。用 out 参数会让调用点变成一串 `let`，而返回对象
 * 让「检索产出了什么」在签名里一眼看得全。
 *
 * @module remotes/ask-retrieval
 */
import { retrieveAskCitations, type AskCitation, type AskChunk } from '../query/ask.ts'
import { buildKbVectorIndex, kbVectorIndexStatus } from '../query/kb-vectors.ts'
import { loadRetrievalConfig } from '../query/retrieval/config.ts'
import { buildVectorIndex, vectorIndexStatus } from '../query/retrieval/embedding.ts'
import { loadAdaptedWeights } from '../query/retrieval/feedback.ts'
import { runRetrievalPipeline, type PipelineOutput } from '../query/retrieval/pipeline.ts'
import type { RerankWeights } from '../query/retrieval/types.ts'
import { buildTools } from '../query/tools/registry.ts'
import type { RetrievalTool, ToolContext } from '../query/tools/types.ts'

/**
 * 把流水线输出摊平成「与旧 `AskRetrievalStats` 同形」的统计对象。
 *
 * 两个口径写在这里而不是散在调用点：
 *  · `rerankInfo` 是**判别联合**：`used:false` 那一支没有 candidates/kept（根本没跑精排，
 *    没有「候选」可数）。读的时候给 0 —— 否则界面会显示成「候选 undefined → 取 undefined」，
 *    而 `model`/`note` 两个键也必须按分支取。
 *  · 通道名称直接向外（UI 按这个字段选标签），不在这里翻译。
 * @param out - 流水线输出。
 * @param scopeDescText - 范围的人话描述。
 * @param indexNote - 索引状态说明（后台构建中时非空）。
 * @returns 摊平后的统计。
 */
export function askRetrievalCompat(
  out: PipelineOutput,
  scopeDescText: string,
  indexNote = '',
): AskRetrievalOutput['stats'] {
  return {
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
    rerank: {
      used: out.rerankInfo.used,
      candidates: out.rerankInfo.used ? out.rerankInfo.candidates : 0,
      kept: out.rerankInfo.used ? out.rerankInfo.kept : 0,
      ...(out.rerankInfo.used && out.rerankInfo.model ? { model: out.rerankInfo.model } : {}),
      ...(!out.rerankInfo.used && out.rerankInfo.note ? { note: out.rerankInfo.note } : {}),
    },
    ...(indexNote === '' ? {} : { indexNote }),
  }
}

/** 检索阶段的输入。 */
export interface AskRetrievalInput {
  /** 解密数据根目录。 */
  decryptedDir: string
  /** 用户原始问题。 */
  question: string
  /** 规划器结果。 */
  plan: { subQueries: string[]; from: string; to: string; person: string }
  /** 用户显式范围（硬过滤）。 */
  scope: { username?: string; from?: string; to?: string }
  /** 当前知识库 id（不传 = 不检索知识库）。 */
  kbId?: number
  /**
   * 是否允许检索**本机微信数据**（消息 / 联系人 / 朋友圈 / 收藏 / 文件 / 账单）。
   *
   * 缺省 `true`（手动问答的既有行为，逐字节不变）。**自动回复传 `false`** ——
   * 那条链路是「无人值守出网」，用户明确要求它的数据面只限**知识库 + 对话上下文 + 模型**，
   * 不许碰本机微信数据（2026-10-17）。
   *
   * 关掉时：跳过微信侧的召回与工具，只保留知识库通道；`stats.scope` 会写明
   * 「仅知识库」而不是「全库」—— 依据行必须如实反映这次到底查了什么。
   */
  wechatDataEnabled?: boolean
  /** 索引状态说明（后台构建中时非空）。 */
  indexNote: string
  /** 范围的人话描述（写进 stats）。 */
  scopeDescText: string
  /** 操作日志。 */
  op: (category: 'task', action: string, status: 'ok' | 'fail' | 'skip', target: string, detail?: string) => void
  /** 取 embedding 函数（已含隐私闸门）。 */
  makeEmbedFn: (model: string, feature?: 'ask_embed' | 'kb_embed' | 'kb_link_suggest') => ((texts: string[]) => Promise<number[][]>) | undefined
  /** 解析向量模型名。 */
  embedModelName: (override?: string) => string
  /** 取精排函数。 */
  makeRerankFn: (kbId: number) => ((query: string, documents: string[]) => Promise<number[]>) | undefined
  /** 取库级模型名。 */
  kbModel: (kbId: number, role: 'embed' | 'rerank') => { model: string }
  /** 已知实体名。 */
  askKnownEntities: () => string[]
  /** 阶段事件发射器（可选）。 */
  emitStage?: ((stage: { key: string; label: string; status: 'running' | 'done' | 'skipped'; detail?: string }) => void) | undefined
}

/** 检索阶段的产出。 */
export interface AskRetrievalOutput {
  citations: AskCitation[]
  chunks: AskChunk[]
  terms: string[]
  rankedFeatures: Array<{ docKey: string; features: RerankWeights }>
  retrievalId: string
  /** 依据行里那句「精排用了什么」（管道跑完才有值）。 */
  rerankLine: string
  /** 检索统计（与旧 `AskRetrievalStats` 同形）。 */
  stats: {
    candidates: number; kept: number; scope: string; recency: boolean
    timeHint: string; hintHits: number; chunks: number; windowMessages: number
    intent?: string; denseActive?: boolean; elapsedMs?: number
    channels?: Array<{ channel: string; count: number; active: boolean; note?: string }>
    funnel?: { recalled: number; fused: number; ranked: number }
    rerank?: { used: boolean; candidates: number; kept: number; model?: string; note?: string }
    indexNote?: string
  }
  /** 是否「纯时间浏览」问法（用于「模型没标引用」时的兜底）。 */
  timeBrowse: boolean
}

/**
 * 跑检索阶段。
 *
 * 两条路径：流水线（`config.enabled`）与旧单通道（灰度/回滚/流水线异常时的降级）。
 * 两条都**不抛错** —— 检索失败绝不该让问答整体不可用。
 * @param input - 见 {@link AskRetrievalInput}。
 * @returns 见 {@link AskRetrievalOutput}。
 */
export async function runAskRetrieval(input: AskRetrievalInput): Promise<AskRetrievalOutput> {
  const { decryptedDir, question, plan, scope, indexNote, scopeDescText, op } = input
  const retrConfig = loadRetrievalConfig(decryptedDir)

  let citations: AskCitation[] = []
  let chunks: AskChunk[] = []
  let terms: string[] = []
  let rankedFeatures: Array<{ docKey: string; features: RerankWeights }> = []
  let retrievalId = ''
  let timeBrowse = false
  let rerankLine = ''
  let stats: AskRetrievalOutput['stats'] = {
    candidates: 0, kept: 0, scope: scopeDescText, recency: false,
    timeHint: '', hintHits: 0, chunks: 0, windowMessages: 0,
  }

  /** 旧单通道检索：灰度对照 / 回滚 / 流水线异常时的降级路径。 */
  const legacyRetrieve = (): void => {
    if (input.wechatDataEnabled === false) {
      op('task', 'ask_wechat', 'skip', 'retrieval_legacy', 'kb-only 已阻止回退到本机微信检索')
      return
    }
    const legacy = retrieveAskCitations(
      decryptedDir, question,
      { subQueries: plan.subQueries, from: plan.from, to: plan.to, person: plan.person },
      scope, 24,
    )
    citations = legacy.citations
    chunks = legacy.chunks
    terms = legacy.terms
    stats = { ...legacy.stats }
    rankedFeatures = []
    retrievalId = ''
  }

  if (!retrConfig.enabled) {
    legacyRetrieve()
    return { citations, chunks, terms, rankedFeatures, retrievalId, rerankLine, stats, timeBrowse }
  }

  try {
    // 稠密通道是**新增的出网点**：embedding 调用统一过隐私闸门（见 makeEmbedFn），
    // 未配置向量模型时抛错，流水线自动降级为纯稀疏，不影响问答可用性。
    // 模型名只解析**一次**并复用：`makeEmbedFn` 发出去的是它，向量库记的也是它。
    const embedModel = input.embedModelName(retrConfig.embedding.model)
    const embedFn = input.makeEmbedFn(embedModel)
    /*
     * ⚠️ 微信数据面关闭时**不建消息向量索引**（2026-10-17）：建索引会把本机消息正文
     * 送去 embedding（出网），而这条链路的数据面本就不该包含本机微信数据。
     * 知识库向量索引照常建（它读的是文件，与微信数据无关）。
     */
    const wechatOk = input.wechatDataEnabled !== false
    if (wechatOk && embedFn && retrConfig.embedding.enabled) {
      const vst = vectorIndexStatus(decryptedDir)
      if (!vst.ready) {
        try {
          const built = await buildVectorIndex(decryptedDir, embedFn, {
            model: embedModel,
            batchSize: retrConfig.embedding.batchSize,
            concurrency: retrConfig.embedding.concurrency,
            maxCharsPerDoc: retrConfig.embedding.maxCharsPerDoc,
            maxDocsPerBuild: retrConfig.embedding.maxDocsPerBuild,
          })
          op('task', 'ask_wechat', 'ok', 'build_vectors', `向量索引 ${built.status} · ${built.rows} 条（本次 ${built.embedded}）· ${built.elapsed_ms}ms`)
        } catch (e) {
          op('task', 'ask_wechat', 'fail', 'build_vectors', (e as Error).message)
        }
      }
    }
    const adapted = loadAdaptedWeights(decryptedDir)
    // 已知实体名：让「点名识别」走本地确定性名单，而不是只靠规划器这一跳。
    const known = input.askKnownEntities()
    const kbId = input.kbId
    // 知识库向量索引：与消息侧同款「提问时按需补齐」，但**按库**建。
    // 为什么要按库而不是一次建全库：出网范围必须与用户此刻的意图一致 —— 用户在这个库里
    // 提问，就只把这个库的正文送去 embedding；一次建全库会把**别的库**的正文也发出去。
    // 库级覆盖**只作用于知识库这一路**：消息域的向量不属于任何库，跟着全局走。
    const kbEmbedModel = kbId === undefined ? embedModel : input.kbModel(kbId, 'embed').model
    // 精排只构造一次：`makeRerankFn` 里含一次 SQLite 读（库级覆盖），调两遍就是白读一次，
    // 而且两次结果理论上可以不一致（中间正好有人改了设置）。
    const rerankModelName = input.kbModel(kbId ?? 0, 'rerank').model
    const rerankFn = input.makeRerankFn(kbId ?? 0)
    if (kbId !== undefined && retrConfig.embedding.enabled) {
      const kbSt = kbVectorIndexStatus(decryptedDir, kbId, kbEmbedModel)
      if (!kbSt.ready) {
        try {
          const kbEmbed = input.makeEmbedFn(kbEmbedModel, 'kb_embed')
          if (kbEmbed) {
            const built = await buildKbVectorIndex(decryptedDir, kbId, kbEmbed, {
              model: kbEmbedModel,
              batchSize: retrConfig.embedding.batchSize,
              concurrency: retrConfig.embedding.concurrency,
              maxCharsPerDoc: retrConfig.embedding.maxCharsPerDoc,
              maxDocsPerBuild: retrConfig.embedding.maxDocsPerBuild,
            })
            op('task', 'ask_wechat', 'ok', 'build_kb_vectors',
              `知识库向量 ${built.status} · ${built.rows} 条（本次 ${built.embedded}）· ${built.elapsed_ms}ms`)
          }
        } catch (e) {
          op('task', 'ask_wechat', 'fail', 'build_kb_vectors', (e as Error).message)
        }
      }
    }
    const out = await runRetrievalPipeline({
      decryptedDir,
      question,
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
      // 数据面：`false` 时只关微信侧通道，知识库通道照常（见 PipelineInput 的说明）。
      ...(input.wechatDataEnabled === false ? { wechatDataEnabled: false } : {}),
    })
    rerankLine = out.rerankInfo.used
      ? ` · 精排：${out.rerankInfo.model || '未知模型'}（候选 ${out.rerankInfo.candidates} → 取 ${out.rerankInfo.kept}）`
      : ` · 精排：${out.rerankInfo.note}`
    citations = out.citations
    chunks = out.chunks
    terms = out.terms
    rankedFeatures = out.rankedFeatures
    // 纯时间浏览问法（见 AskRetrievalOutput.timeBrowse 的说明）。
    timeBrowse = out.plan.timeBrowse === true
    retrievalId = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
    // W3-6.3：组装整块搪去模块级函数（工厂受函数体棘轮管，只许变小）。
    stats = askRetrievalCompat(out, scopeDescText, indexNote)
    // 阶段事件（2026-10-16）：检索与精排各推一条，界面据此显示过程行。
    input.emitStage?.({
      key: 'retrieve', label: '检索本机记录', status: 'done',
      detail: `召回 ${out.stats.recalled} → 融合 ${out.stats.fused} → 重排 ${out.stats.ranked} → 窗口 ${out.stats.compressed} · ${out.stats.elapsedMs}ms`,
    })
    input.emitStage?.({
      key: 'rerank', label: '精排候选', status: out.rerankInfo.used ? 'done' : 'skipped',
      detail: out.rerankInfo.used
        ? `${out.rerankInfo.model || '模型'} · 候选 ${out.rerankInfo.candidates} → 取 ${out.rerankInfo.kept}`
        : (out.rerankInfo.note ?? '未启用精排，按本机加权排序'),
    })
    op('task', 'ask_wechat', 'ok', 'route',
      `意图 ${out.stats.intent} · 通道[${out.stats.channels.map(c => `${c.channel}:${c.count}${c.active ? '' : '(off)'}`).join(' ')}] · 召回 ${out.stats.recalled} → 融合 ${out.stats.fused} → 重排 ${out.stats.ranked} → 窗口 ${out.stats.compressed} · ${out.stats.elapsedMs}ms`)
  } catch (e) {
    // 流水线自身异常（非通道降级）→ 回退旧检索，绝不让问答整体不可用。
    input.emitStage?.({ key: 'retrieve', label: '检索本机记录', status: 'skipped', detail: '检索流水线异常，已回退旧检索' })
    op('task', 'ask_wechat', 'fail', 'retrieval_pipeline', (e as Error).message)
    legacyRetrieve()
  }
  return { citations, chunks, terms, rankedFeatures, retrievalId, rerankLine, stats, timeBrowse }
}

/**
 * 组装本次问答可用的**检索工具集**（2026-10-16 新增）。
 *
 * ## 为什么放在这里而不是 `askdeep.ts`
 *
 * 工具集需要三样**装配层**的东西：`decryptedDir`（环境）、`embedFn`（含隐私闸门）、
 * `kbId`（本次范围）。这三样在 `askdeep.ts` 里是散着的局部变量，而这里
 * （`AskRetrievalInput`）已经是它们的**唯一汇聚点** —— 检索阶段本来就要用它们。
 * 放在这里，接线点只有一处，且与「检索怎么跑」在同一份文件里，改一处不会漏另一处。
 *
 * ## 与 `runAskRetrieval` 的关系
 *
 * 两者**并列**，不是替代：`runAskRetrieval` 是「一次问答该拿哪些原文」的**固定管线**
 * （稀疏+稠密+结构化+聚合+精排），工具集是「模型可以主动调哪几种检索」的**能力清单**。
 * 前者已经跑完并把结果给了模型；后者供模型在需要时**追加**检索（如「再查一下这个人的联系方式」）。
 *
 * ## 为什么 embedFn 要在这里解析
 *
 * `search_semantic` 需要它，而它含隐私闸门（出网范围必须与用户此刻的意图一致）。
 * 在装配层解析一次、注入工具集，工具内部就不再碰配置 —— 否则每个工具都要自己
 * 读一遍配置，出网范围会随「哪个工具先跑」而变。
 *
 * @param input - 与 {@link runAskRetrieval} 同一份输入（复用它的装配依赖）。
 * @returns 工具集（`search_semantic` 在未配向量模型时仍存在，执行时如实报「未配置」）。
 */
export function buildAskTools(input: AskRetrievalInput): RetrievalTool[] {
  const retrConfig = loadRetrievalConfig(input.decryptedDir)
  const embedModel = input.embedModelName(retrConfig.embedding.model)
  const embedFn = retrConfig.embedding.enabled ? input.makeEmbedFn(embedModel) : undefined
  return buildTools({ ...(embedFn ? { embedFn } : {}), embedModel })
}

/**
 * 本次问答的工具执行上下文（与 {@link buildAskTools} 配套）。
 *
 * 单独一个函数而不是内联在调用点：`knownEntities` 的取法（名单 + 规划器点出的名字）
 * 与 `runAskRetrieval` 里那一处**必须一致** —— 两处各写一遍，改一处就会让
 * 「工具看到的实体」与「管线看到的实体」不同，而症状是「同一个名字有时认得有时不认得」。
 * @param input - 与 {@link runAskRetrieval} 同一份输入。
 * @returns 工具上下文。
 */
export function askToolContext(input: AskRetrievalInput): ToolContext {
  const known = input.askKnownEntities()
  const person = input.plan.person
  return {
    decryptedDir: input.decryptedDir,
    ...(input.kbId !== undefined ? { kbId: input.kbId } : {}),
    ...(input.scope ? { scope: input.scope } : {}),
    knownEntities: person && !known.includes(person) ? [...known, person] : known,
  }
}
