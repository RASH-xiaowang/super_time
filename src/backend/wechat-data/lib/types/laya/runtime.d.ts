import { type LayaItem } from './build-sequence.ts';
import { type LayaQuestions, type LayaQuestionKind } from './presets.ts';
/** 命题在 UI 层的一种呈现（概率已排序、标签已本地化）。 */
export interface LayaAnswerOption {
    key: string;
    label: string;
    probability: number;
}
export interface LayaAnswer {
    qid: string;
    kind: LayaQuestionKind;
    /** 问题文本（去掉给模型看的 `dialogue` 标记，直接可展示）。 */
    question: string;
    options: LayaAnswerOption[];
    /** 概率最高项的关键字。 */
    top: string;
    topProbability: number;
    /** `noul` 专用：真那一端的概率。 */
    yes?: number;
    /** `score` 专用：加权期望分。 */
    score?: number;
    /** `score` 专用：分值上限（如 10）。 */
    scale?: number;
    /** 归一化熵置信度（1 - H/log k），与 `laya` 的 confidence 同定义。 */
    confidence: number;
}
export interface LayaAnalyzeInput {
    /** 模型输入 state（`{ dialogue }` 或纯字符串），键必须与命题里的引用一致。 */
    state: string | Record<string, unknown>;
    questions?: LayaQuestions;
    /** 显式模型目录（默认走 `DSH_WECHAT_LAYA_DIR` / 数据目录）。 */
    modelDir?: string;
    decryptedDir?: string;
}
export interface LayaAnalyzeResult {
    ok: boolean;
    error?: string;
    /** 模型目录与体积（供 UI 显示「正在用哪个模型」）。 */
    model: {
        dir: string;
        bytes: number;
    };
    answers: LayaAnswer[];
    /** 推理耗时（不含模型加载）。 */
    inferenceMs: number;
    /** 本次输入的 token 数（批内合计）。 */
    tokens: number;
    /** 本次是否复用了已加载的会话。 */
    reused: boolean;
}
/** 运行时的可观测状态（供 Remote 暴露给前端）。 */
export interface LayaRuntimeState {
    loaded: boolean;
    dir: string;
    /** 最近一次推理耗时（毫秒），未跑过为 0。 */
    lastInferenceMs: number;
    /** 最近一次失败原因（成功一次即清空）。 */
    lastError: string;
}
/** 当前运行时状态。 */
export declare function layaRuntimeState(): LayaRuntimeState;
/** 卸载模型（释放约 1.2 GB 常驻内存；下次调用会重新加载）。 */
export declare function layaUnload(): void;
/**
 * 加载模型与分词器（幂等；模型目录变化时自动重载）。
 * 失败**不缓存**（照 koffi 的先例：一次失败不该让整个功能永久瘫痪），下次调用可重试。
 */
export declare function layaEnsureLoaded(modelDir?: string, decryptedDir?: string): Promise<{
    ok: boolean;
    error?: string;
}>;
/**
 * 跑一次分析：把 state 对一组命题做一次并行 forward，返回可展示的答案。
 *
 * 失败返回 `{ ok: false, error }`——调用方据此降级（不要抛，降级是本功能的正常路径）。
 */
export declare function layaAnalyze(input: LayaAnalyzeInput): Promise<LayaAnalyzeResult>;
/** 后处理入参（抽出来是为了能脱离 onnxruntime 单测）。 */
export interface LayaPostprocessInput {
    /** 模型原始输出，按 `[item][option]` 行主序展平（长度 = items.length × optCols）。 */
    logits: ArrayLike<number>;
    items: LayaItem[];
    questions: LayaQuestions;
    /** 与 `items` 同序的命题键。 */
    qids: string[];
    /** 每行的列数（= collate 后的 marker 列数）。 */
    optCols: number;
    temperatures: {
        base: number[];
        byOptions: Record<string, number>;
    };
}
/**
 * 把原始 logits 解释成可展示的答案——**逐行照搬 `laya/agent.py:325-362`**：
 * 按题型的温度分桶取缩放值 → softmax → 按题型组装（choice 给分布 / score 给期望分 / noul 给真值概率）。
 *
 * 抽成纯函数是为了能直接用 fixture 里的 `logits` 做回归：CI 上没有 1.2 GB 模型，
 * 但「后处理是否与 Python 一致」必须有人守。
 */
export declare function postprocessAnswers(input: LayaPostprocessInput): LayaAnswer[];
/** 供 UI 展示的模型体积文案。 */
export declare function layaModelSizeLabel(bytes: number): string;
