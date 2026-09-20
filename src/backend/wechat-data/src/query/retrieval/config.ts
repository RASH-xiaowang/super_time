/**
 * 检索参数配置中心。
 *
 * 目标 6「支持可配置的阈值与参数调优」的落点：所有阈值/权重/容量都集中在这里，
 * 而不是像旧实现那样散落在 ask.ts 的 20 多个模块级常量里。配置读自
 * 「数据根/rag-config.json」（与 wechat_search.db 同级），缺失时用内置默认值。
 *
 * 三层优先级（后者覆盖前者）：
 *   内置默认 → rag-config.json → 运行时显式覆盖（意图策略 / 前端面板）
 * 这样既能「一次调好写进文件持久化」，也能「按意图在单次查询里临时覆盖」。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ChannelName, IntentKind, RerankWeights, RetrievalPolicy } from './types.ts'

/** 重排特征默认权重。数值含义：相对大小决定影响，绝对大小与归一化后的特征量级匹配。 */
export const DEFAULT_RERANK_WEIGHTS: RerankWeights = {
  sparse: 1.0,
  dense: 0.9,
  // 与 sparse 同量级：知识库通道的分同样是 BM25 取负后**归一化到 0~1**的（融合阶段
  // 按名次 min-max），两边的量纲一致，所以可以给同一个权重而不是另拍一个数。
  kb: 1.0,
  // 实体命中是强信号：问「李四」时答对「李四」比多命中一个通用词重要得多。
  entity: 1.2,
  coverage: 0.8,
  timePref: 0.6,
  recency: 0.5,
  agreement: 0.4,
}

/** 完整检索配置。 */
export interface RetrievalConfig {
  /** 总开关：关闭时 askWechat 退回旧的单通道检索（灰度/回滚用）。 */
  enabled: boolean
  embedding: {
    enabled: boolean
    /** 向量模型名；为空时回退到 chat model（部分厂商同名可用）。 */
    model: string
    /** 单次 embedding 请求最多多少条文本（厂商通常有 batch 上限）。 */
    batchSize: number
    /**
     * 同时在飞的 embedding 请求数上限（M10）。
     *
     * 原先是一批一批串行 await：`maxDocsPerBuild: 40000` / `batchSize: 16` ⇒ 单次建库 2500 次
     * 往返，全程被网络延迟支配。厂商普遍有速率限制，所以这个值**故意保守**，且运行时会被
     * 夹到 [1, 16]。调高只对「延迟高但允许更高并发」的自建服务有意义。
     */
    concurrency: number
    /** 一次索引构建最多处理多少条消息（防止首次提问卡太久）。 */
    maxDocsPerBuild: number
    /** 向量库命中缓存条数。 */
    cacheSize: number
    /** 文本截断长度（超过部分不参与向量，省 token）。 */
    maxCharsPerDoc: number
  }
  channels: {
    sparse: { enabled: boolean; topK: number }
    dense: { enabled: boolean; topK: number; minSimilarity: number; candidatePool: number }
    structured: { enabled: boolean; topK: number }
    /**
     * 知识库文件块通道。
     *
     * 与其余通道的差别：它是**条件通道** —— 只有调用方传了 `kbId`（当前知识库）时才真正
     * 参与召回，否则返回 `active:false` 并附 note。因此这里可以安全地默认开启：
     * 没有导入文件的用户不受任何影响，也不会多一次检索。
     */
    kb: { enabled: boolean; topK: number }
  }
  fusion: {
    /** RRF 平滑常数 k；k 越大越弱化头部名次差异（经验值 60）。 */
    k: number
    /** 融合后保留候选数（进入重排）。 */
    keep: number
  }
  rerank: {
    weights: RerankWeights
    /** 低于该分数直接丢弃（0 = 不设下限）。 */
    minScore: number
  }
  compress: {
    /** 送进 LLM 的上下文字符预算。 */
    maxChars: number
    /** 最多保留多少个对话窗口。 */
    maxChunks: number
    /** 每个窗口最多几行。 */
    linesPerChunk: number
    /** 近似重复文本的 Jaccard 阈值，超过则去重。 */
    dedupThreshold: number
  }
  intent: {
    /** 是否用 LLM 辅助意图分类（失败时始终回退到规则分类）。 */
    llmAssist: boolean
  }
  feedback: {
    enabled: boolean
    /** 权重微调步长。 */
    learningRate: number
    /** 反馈记录上限（超出淘汰最旧）。 */
    maxRecords: number
  }
}

/** 内置默认配置。 */
export function defaultRetrievalConfig(): RetrievalConfig {
  return {
    enabled: true,
    embedding: {
      enabled: true,
      model: '',
      batchSize: 16,
      concurrency: 4,
      maxDocsPerBuild: 40000,
      cacheSize: 2000,
      maxCharsPerDoc: 200,
    },
    channels: {
      sparse: { enabled: true, topK: 400 },
      // candidatePool：稠密通道先做 SimHash 粗筛，只对粗筛幸存者算精确余弦。
      dense: { enabled: true, topK: 200, minSimilarity: 0.2, candidatePool: 2000 },
      structured: { enabled: true, topK: 60 },
      // 60 而不是 400：知识库的单元是**文件块**（一块最长 500 字，命中就已是一段完整内容），
      // 60 块 ≈ 3 万字，远超压缩阶段的字符预算；再多召回只会被压缩阶段丢掉，
      // 却照样要为每一块算 bm25 与摘要。召回上限最终仍由意图策略的 channelTopK 收紧。
      kb: { enabled: true, topK: 60 },
    },
    fusion: { k: 60, keep: 120 },
    rerank: { weights: { ...DEFAULT_RERANK_WEIGHTS }, minScore: 0 },
    compress: { maxChars: 6000, maxChunks: 10, linesPerChunk: 6, dedupThreshold: 0.85 },
    intent: { llmAssist: false },
    feedback: { enabled: true, learningRate: 0.08, maxRecords: 500 },
  }
}

/** 数据根 = 解密目录的父目录（与 wechat_search.db 同址）。 */
export function retrievalRoot(decryptedDir: string): string {
  return dirname(decryptedDir)
}

/** 配置文件路径。 */
export function retrievalConfigPath(decryptedDir: string): string {
  return join(retrievalRoot(decryptedDir), 'rag-config.json')
}

/** 深合并：把 patch 递归写进 base 的副本（只覆盖 patch 明确给出的字段）。 */
function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return (patch === undefined ? base : (patch as T))
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const cur = out[k]
    if (cur !== null && typeof cur === 'object' && !Array.isArray(cur) && v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = deepMerge(cur, v)
    } else if (v !== undefined) {
      out[k] = v
    }
  }
  return out as T
}

/**
 * 读取检索配置（文件缺失/损坏时回退默认值）。
 * @param decryptedDir - 解密数据根。
 * @returns 完整配置。
 */
/**
 * `fusion.keep` 的硬上限（M12 复审建议）。
 *
 * 为什么需要：`dedupeFused` 是两两比较 O(N²)，而 `keep` 是**可手改**的配置项
 * （`rag-config.json`），`deepMerge` 不做数值校验 —— 实测最坏情形（候选全在同一会话、
 * 时间都在窗口内）N=120 是 14ms，N=960 就 0.9s，N=1920 达 3.8s（一次提问直接卡住）。
 * 夹到 400 ⇒ 最坏约 0.16s。想要更宽的召回请改 `channels.*.topK`，别靠放大这里。
 */
const FUSION_KEEP_MAX = 400

/** 把越界/非法的 `fusion.keep` 归一到 [1, FUSION_KEEP_MAX]。 */
function clampFusionKeep(cfg: RetrievalConfig): RetrievalConfig {
  const raw = Number(cfg.fusion?.keep)
  const keep = Math.min(Math.max(Number.isFinite(raw) ? Math.floor(raw) : 120, 1), FUSION_KEEP_MAX)
  if (keep === cfg.fusion.keep) return cfg
  return { ...cfg, fusion: { ...cfg.fusion, keep } }
}

export function loadRetrievalConfig(decryptedDir: string): RetrievalConfig {
  const base = defaultRetrievalConfig()
  const p = retrievalConfigPath(decryptedDir)
  if (!existsSync(p)) return base
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'))
    return clampFusionKeep(deepMerge(base, raw))
  } catch {
    return base
  }
}

/**
 * 写入检索配置（以**当前文件内容**为基准合并后落盘）。
 *
 * 基准必须是磁盘上的现值，而不是内置默认值：设置面板只暴露了一部分参数
 * （`embedding.maxDocsPerBuild` / `channels.sparse.topK` / `rerank.weights` /
 * `compress.*` 明细 / `feedback.maxRecords` 等都不在界面上）。以默认值为基准合并，
 * 等于用户每点一次「保存检索设置」就把这些没暴露的参数静默重置回默认 ——
 * 手工调过 `rag-config.json` 的人一保存就丢配置。
 * （UI 自动化验收实测：面板保存后 `embedding.maxDocsPerBuild` 从 400 变回 40000，
 *   单次建向量索引因此发出 2501 次 embedding 请求。）
 * @param decryptedDir - 解密数据根。
 * @param patch - 要更新的字段（可只给子集）。
 * @returns 落盘后的完整配置。
 */
export function saveRetrievalConfig(decryptedDir: string, patch: unknown): RetrievalConfig {
  const base = loadRetrievalConfig(decryptedDir)
  const merged = clampFusionKeep(deepMerge(base, patch))
  const p = retrievalConfigPath(decryptedDir)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(merged, null, 2) + '\n', 'utf8')
  return merged
}

/** 把配置与意图策略合成一次查询的有效参数。 */
export interface EffectiveParams {
  config: RetrievalConfig
  policy: RetrievalPolicy
  /** 权重 = 意图策略覆盖后的最终值。 */
  weights: RerankWeights
  channelTopK: Record<ChannelName, number>
}

/** 合成一次查询的有效参数（意图策略覆盖配置默认）。 */
export function effectiveParams(config: RetrievalConfig, policy: RetrievalPolicy): EffectiveParams {
  return {
    config,
    policy,
    weights: { ...config.rerank.weights, ...policy.weights },
    channelTopK: policy.channelTopK,
  }
}

/**
 * 意图 → 默认策略表。
 *
 * 「分类路由」的核心：每种意图给出不同的通道组合 / topK / 权重 / 排序方式。
 * 这张表本身也是可调参的对象（未来可由反馈闭环更新）。
 */
export function defaultPolicyFor(intent: IntentKind): RetrievalPolicy {
  // 'time' 与 'kb' 都是**条件通道**：'time' 只有当查询计划里带日期线索（plan.from / plan.to）
  // 时才真正参与召回，'kb' 只有当调用方传了当前库（kbId）时才参与（见 pipeline 的 gate），
  // 因此它们可以安全地列在所有意图的通道表里而不必逐意图开关。
  const all: ChannelName[] = ['sparse', 'dense', 'structured', 'time', 'kb']
  switch (intent) {
    case 'recency_lookup':
      // 「最近一次 X」：命中内容词后按时间取最新，稠密只做补充，且必须时间优先。
      // kb 给最小额度：文件没有「最近一次」这回事，且要避免挤占消息证据的上下文预算。
      return {
        intent, channels: all,
        channelTopK: { sparse: 300, dense: 120, structured: 40, time: 24, kb: 12 },
        weights: { recency: 1.4, timePref: 0.8, entity: 1.0, coverage: 0.9, dense: 0.5 },
        recencyFirst: true, wideRecall: false,
      }
    case 'entity_lookup':
      // 「某人的某信息」：实体命中压过内容得分；结构化通道（联系人/群）权重最高。
      // kb 给到 20：文件里常写着这类事实（合同里的人名、表格里的电话），值得多取。
      return {
        intent, channels: all,
        channelTopK: { sparse: 250, dense: 100, structured: 80, time: 24, kb: 20 },
        weights: { entity: 2.0, sparse: 0.9, dense: 0.9, coverage: 0.6 },
        recencyFirst: false, wideRecall: false,
      }
    case 'time_range':
      // 「上周三…」「9 月 3 号…」：时间软偏好显著，召回适度放宽。
      // kb 给最小额度：文件没有时间轴，按日期问的问题里它只能当旁证。
      return {
        intent, channels: all,
        // time: 60 —— 时间问法里「按时段直取」是主通道；60 条足够让压缩阶段把锚点
        // 摊开到一整天（compressContext 会对 ±15 分钟内的命中做去重叠）。
        channelTopK: { sparse: 400, dense: 160, structured: 40, time: 60, kb: 12 },
        weights: { timePref: 1.6, sparse: 1.0, dense: 0.8, coverage: 0.8 },
        recencyFirst: false, wideRecall: false,
      }
    case 'aggregation':
      // 「一共/总共/有多少」：要覆盖度，通道 topK 与融合保留都放大，压缩预算更宽。
      // kb 给到 30：合同/报表里的合计数往往就是答案本身（「一共转了多少」）。
      return {
        intent, channels: all,
        channelTopK: { sparse: 600, dense: 240, structured: 60, time: 60, kb: 30 },
        weights: { coverage: 1.2, agreement: 0.8, sparse: 1.0, dense: 0.7, recency: 0 },
        recencyFirst: false, wideRecall: true,
      }
    case 'comparison':
      // 对比题常要同时看聊天记录与文件（「合同里写的和实际聊的对得上吗」）。
      return {
        intent, channels: all,
        channelTopK: { sparse: 500, dense: 200, structured: 60, time: 30, kb: 24 },
        weights: { coverage: 1.0, dense: 1.0, sparse: 1.0, agreement: 0.8 },
        recencyFirst: false, wideRecall: true,
      }
    case 'open_qa':
    default:
      return {
        intent: 'open_qa', channels: all,
        channelTopK: { sparse: 400, dense: 200, structured: 40, time: 24, kb: 20 },
        weights: {},
        recencyFirst: false, wideRecall: false,
      }
  }
}
