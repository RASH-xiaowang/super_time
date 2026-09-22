
/**
 * 问答反馈与检索配置（画像表 / 反馈表 / 配置） 的 @Remote 处理器（M21 自 `gateway.ts` 搬出）。
 *
 * 机制：类里保留 @Remote 装饰器与签名（协议层按名字枚举），方法体一行转发；
 * 处理器体在这里，依赖由 `rc` 显式给出。
 */
import { listAskHistory } from '../query/ask-history.ts'
import { boundedSet } from '../query/meta.ts'
import { loadRetrievalConfig, saveRetrievalConfig as saveRetrievalConfigFile } from '../query/retrieval/config.ts'
import { vectorIndexSummary } from '../query/retrieval/embedding.ts'
import { syntheticIntentAccuracy } from '../query/retrieval/eval-dataset.ts'
import { adaptWeights, attributeFeatures, feedbackStats, listFeedback, loadAdaptedWeights, recordFeedback, saveAdaptedWeights } from '../query/retrieval/feedback.ts'
import { FeedbackRecord, IntentKind, RerankWeights } from '../query/retrieval/types.ts'
import { AskHistoryQuery, AskHistorySnapshot, OperationCategory, OperationStatus } from '../types.ts'

export interface createAskRemotesInputs {
  dirs: () => { decrypted: string; decoded: string }
  op: (category: OperationCategory, action: string, status: OperationStatus, target?: string, detail?: string) => void
  askFeedbackSeen: Map<string, number>
  askTrace: Map<string, { features: Map<string, RerankWeights>; citations: string[];
    question: string; answer: string; intent: IntentKind }>
}

/**
 * N27：同一轮问答反馈的重复提交窗口。
 *
 * 10 秒的依据：真正的重复来自「同一轮被提交两次」——两个面板同时提交、旧版客户端重试、
 * 直接 RPC 调用，间隔都在一次点击的量级；而用户**改变主意重新评分**（up→down、或改了
 * 标注集合）会落到另一个键（键含 rating 与引用序号），不受这个窗口影响。
 */
const ASK_FEEDBACK_DEDUPE_MS = 10_000

/** 反馈去重表的键上限（进程内，只记窗口内的键）。 */
const ASK_FEEDBACK_CAP = 200

export function createAskRemotes(rc: createAskRemotesInputs) {
  return {
    submitAskFeedback(options: {
      retrievalId?: string
      rating: 'up' | 'down'
      useful?: number[]
      useless?: number[]
      question?: string
      answer?: string
    }): { ok: boolean; adaptedWeights?: RerankWeights; features?: string[]; message?: string } {
      const cfg = loadRetrievalConfig(rc.dirs().decrypted)
      if (!cfg.feedback.enabled) return { ok: false, message: '反馈闭环已在检索配置里关闭' }
      // N27：同一轮反馈的重复提交在这里挡掉。放在副作用之前 —— 挡晚了（比如在 recordFeedback
      // 之后）就等于「只去重审计、副作用照样跑两遍」。
      //
      // 键含 rating 与引用序号：用户改主意（up→down、或改标注集合）是**另一次**反馈，必须放行；
      // 键里的 answer 片段用于「客户端没给 retrievalId 也没给 question」时区分不同轮次
      // （否则两轮不同的问答会共用 `''` 这个键，被窗口误挡）。
      const dedupeKey = [
        options.retrievalId ?? '',
        options.question ?? '',
        String(options.answer ?? '').slice(0, 120),
        options.rating,
        (options.useful ?? []).join(','),
        (options.useless ?? []).join(','),
      ].join('\u0000')
      const now = Date.now()
      const until = rc.askFeedbackSeen.get(dedupeKey)
      if (until !== undefined && until > now) {
        rc.op('task', 'ask_feedback', 'ok', options.rating, '重复提交（同一轮，已忽略）')
        return { ok: false, message: '该反馈已在处理（同一轮重复提交已忽略，未重复记录）' }
      }
      boundedSet(rc.askFeedbackSeen, dedupeKey, now + ASK_FEEDBACK_DEDUPE_MS, ASK_FEEDBACK_CAP)
      const trace = options.retrievalId ? rc.askTrace.get(options.retrievalId) : undefined
      const keyOf = (i: number): string | null => (trace && i >= 1 && i <= trace.citations.length) ? trace.citations[i - 1] : null
      const pick = (idx: number[] | undefined): RerankWeights[] => {
        if (!trace) return []
        const out: RerankWeights[] = []
        for (const i of idx ?? []) {
          const k = keyOf(i)
          const f = k ? trace.features.get(k) : undefined
          if (f) out.push(f)
        }
        return out
      }
      const features = attributeFeatures(pick(options.useful), pick(options.useless))
      const rec: FeedbackRecord = {
        id: 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        question: options.question ?? trace?.question ?? '',
        answer: options.answer ?? trace?.answer ?? '',
        rating: options.rating === 'down' ? 'down' : 'up',
        citedUseful: options.useful ?? [],
        citedUseless: options.useless ?? [],
        intent: trace?.intent ?? 'open_qa',
        createdAt: Date.now(),
        features,
      }
      recordFeedback(rc.dirs().decrypted, rec, cfg.feedback.maxRecords)
      const all = listFeedback(rc.dirs().decrypted, cfg.feedback.maxRecords)
      const adapted = adaptWeights(cfg.rerank.weights, all, cfg.feedback.learningRate)
      saveAdaptedWeights(rc.dirs().decrypted, adapted)
      rc.op('task', 'ask_feedback', 'ok', options.rating, `features=${features.join(',')} total=${all.length}`)
      return { ok: true, adaptedWeights: adapted, features }
    },

    listRetrievalFeedback(options?: { limit?: number }): {
      items: FeedbackRecord[]
      stats: { total: number; up: number; down: number }
    } {
      return {
        items: listFeedback(rc.dirs().decrypted, options?.limit ?? 50),
        stats: feedbackStats(rc.dirs().decrypted),
      }
    },

    getAskHistory(options?: AskHistoryQuery): AskHistorySnapshot {
      return listAskHistory(rc.dirs().decrypted, options ?? {})
    },

    getRetrievalStatus(): {
      enabled: boolean
      config: unknown
      vector: { rows: number; dim: number; model: string }
      feedback: { total: number; up: number; down: number }
      weights: RerankWeights
      intentAccuracy: { correct: number; total: number; accuracy: number }
    } {
      const cfg = loadRetrievalConfig(rc.dirs().decrypted)
      const adapted = loadAdaptedWeights(rc.dirs().decrypted)
      return {
        enabled: cfg.enabled,
        config: cfg,
        vector: vectorIndexSummary(rc.dirs().decrypted),
        feedback: feedbackStats(rc.dirs().decrypted),
        weights: adapted ?? cfg.rerank.weights,
        intentAccuracy: syntheticIntentAccuracy(),
      }
    },

    saveRetrievalConfig(options?: { patch?: unknown } | unknown): { ok: boolean; config: unknown } {
      const patch = (options && typeof options === 'object' && 'patch' in (options as Record<string, unknown>))
        ? (options as { patch?: unknown }).patch
        : options
      const saved = saveRetrievalConfigFile(rc.dirs().decrypted, patch)
      rc.op('settings', 'save_retrieval_config', 'ok', '', JSON.stringify(patch ?? {}).slice(0, 200))
      return { ok: true, config: saved }
    },

  }
}
