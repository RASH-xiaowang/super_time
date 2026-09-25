/**
 * laya 本地决策分析的对协议类型（Remote 进出参）。
 *
 * 推理结果的形状（`LayaAnswer`）直接复用运行时那份定义——它已经是「给 UI 看」的形态
 * （概率已排序、标签已本地化），再包一层 View 只会多一次映射，没有收益。
 */
import type { LayaAnalysisResult } from './laya/analysis.ts'

export type { LayaAnswer, LayaAnswerOption, LayaAnalyzeResult } from './laya/runtime.ts'

/**
 * 一次分析的可序列化结果。
 *
 * 取 `laya/analysis.ts` 的收口结果（而不是 `laya/runtime.ts` 的原始结果）：
 * 前者已经带上「被分析的那句 / 上下文条数 / 是否真的用了模型 / 降级说明」，
 * 正是 UI 需要的那一份。
 */
export type LayaAnalysisView = LayaAnalysisResult

/** 模型下载进度（前端 500ms 轮询用，与 whisper 的 `WhisperDownloadProgress` 同款）。 */
export interface LayaDownloadProgress {
  /** 正在下载的相对路径（如 `laya-decision.onnx`）。 */
  file: string
  received: number
  total: number
}

/** 模型 + 运行时的整体状态。 */
export interface LayaStatus {
  /** 三个必需文件是否齐备且体积过下界。 */
  installed: boolean
  /** 模型目录（未安装时也给出，便于 UI 告诉用户放哪）。 */
  dir: string
  /** 模型文件路径。 */
  path: string
  /** 模型体积（字节）。 */
  bytes: number
  /** 路径来源。 */
  source: 'configured' | 'env' | 'data-dir'
  /** 缺失项说明（已安装时为空数组）。 */
  missing: string[]
  /** 当前下载任务（无则 null）。 */
  downloading: LayaDownloadProgress | null
  /** 运行时状态：是否已加载、最近一次推理耗时、最近一次错误。 */
  runtime: {
    loaded: boolean
    lastInferenceMs: number
    lastError: string
  }
}

/** 下载结果。 */
export interface LayaDownloadOutcome {
  ok: boolean
  files?: string[]
  bytes?: number
  error?: string
}
