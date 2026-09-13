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
      maxDocsPerBuild: 40000,
      cacheSize: 2000,
      maxCharsPerDoc: 200,
    },
    channels: {
      sparse: { enabled: true, topK: 400 },
      // candidatePool：稠密通道先做 SimHash 粗筛，只对粗筛幸存者算精确余弦。
      dense: { enabled: true, topK: 200, minSimilarity: 0.2, candidatePool: 2000 },
      structured: { enabled: true, topK: 60 },
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
export function loadRetrievalConfig(decryptedDir: string): RetrievalConfig {
  const base = defaultRetrievalConfig()
  const p = retrievalConfigPath(decryptedDir)
  if (!existsSync(p)) return base
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'))
    return deepMerge(base, raw)
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
  const merged = deepMerge(base, patch)
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
  const all: ChannelName[] = ['sparse', 'dense', 'structured']
  switch (intent) {
    case 'recency_lookup':
      // 「最近一次 X」：命中内容词后按时间取最新，稠密只做补充，且必须时间优先。
      return {
        intent, channels: all,
        channelTopK: { sparse: 300, dense: 120, structured: 40 },
        weights: { recency: 1.4, timePref: 0.8, entity: 1.0, coverage: 0.9, dense: 0.5 },
        recencyFirst: true, wideRecall: false,
      }
    case 'entity_lookup':
      // 「某人的某信息」：实体命中压过内容得分；结构化通道（联系人/群）权重最高。
      return {
        intent, channels: all,
        channelTopK: { sparse: 250, dense: 100, structured: 80 },
        weights: { entity: 2.0, sparse: 0.9, dense: 0.9, coverage: 0.6 },
        recencyFirst: false, wideRecall: false,
      }
    case 'time_range':
      // 「上周三…」「9 月 3 号…」：时间软偏好显著，召回适度放宽。
      return {
        intent, channels: all,
        channelTopK: { sparse: 400, dense: 160, structured: 40 },
        weights: { timePref: 1.6, sparse: 1.0, dense: 0.8, coverage: 0.8 },
        recencyFirst: false, wideRecall: false,
      }
    case 'aggregation':
      // 「一共/总共/有多少」：要覆盖度，通道 topK 与融合保留都放大，压缩预算更宽。
      return {
        intent, channels: all,
        channelTopK: { sparse: 600, dense: 240, structured: 60 },
        weights: { coverage: 1.2, agreement: 0.8, sparse: 1.0, dense: 0.7, recency: 0 },
        recencyFirst: false, wideRecall: true,
      }
    case 'comparison':
      return {
        intent, channels: all,
        channelTopK: { sparse: 500, dense: 200, structured: 60 },
        weights: { coverage: 1.0, dense: 1.0, sparse: 1.0, agreement: 0.8 },
        recencyFirst: false, wideRecall: true,
      }
    case 'open_qa':
    default:
      return {
        intent: 'open_qa', channels: all,
        channelTopK: { sparse: 400, dense: 200, structured: 40 },
        weights: {},
        recencyFirst: false, wideRecall: false,
      }
  }
}
