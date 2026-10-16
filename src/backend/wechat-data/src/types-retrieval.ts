/**
 * RAG 检索层经过 Remote 边界传输的类型。
 *
 * 与 `query/retrieval/` 的内部类型分开：前者包含文件路径、回调、管道中间态等
 * 不应进 IPC 的细节；这里只放面板和诊断脚本需要看到的稳定 wire shape。
 * 所有跨进程类型都从 `types.ts` 导出，前端只做 `export type` 转发。
 */
import type { RetrievalConfig } from './query/retrieval/config.ts'
import type { RerankWeights } from './query/retrieval/types.ts'

export type { RetrievalConfig }

/** `getRetrievalStatus` 的完整返回值。 */
export interface RetrievalStatus {
  enabled: boolean
  config: RetrievalConfig
  vector: { rows: number; dim: number; model: string }
  feedback: { total: number; up: number; down: number }
  weights: RerankWeights
  intentAccuracy: { correct: number; total: number; accuracy: number }
}

/** 深合并补丁：每一层字段都可省略，数组按元素深合并。 */
type DeepPartial<T> = T extends Array<infer U>
  ? Array<DeepPartial<U>>
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T

/** `saveRetrievalConfig` 接受的部分配置（直接传，或包在 `{ patch }` 里）。 */
export type RetrievalConfigPatch = DeepPartial<RetrievalConfig>

/** `buildRagVectorIndex` 的传输结果（在底层 `VectorBuildResult` 外加 `ok`）。 */
export interface VectorBuildResult {
  ok: boolean
  status: string
  rows: number
  embedded: number
  elapsed_ms: number
  message?: string
}

/** 一组检索指标的字段。 */
export interface RetrievalEvalMetrics {
  precision: number
  recall: number
  mrr: number
  ndcg: number
  map: number
  cases: number
  hits: number
}

/** `evaluateRetrieval` 的返回值：可读报告 + 混合/稀疏消融指标。 */
export interface RetrievalEvalResult {
  report: string
  hybrid: RetrievalEvalMetrics
  sparseOnly: RetrievalEvalMetrics
  intentAccuracy: { correct: number; total: number; accuracy: number }
}
