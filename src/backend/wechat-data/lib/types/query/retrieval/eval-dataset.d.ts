import type { RetrievedDoc } from './types.ts';
import { type EvalCase, type EvalReport } from './eval.ts';
/** 评估用的固定「现在」（2026-09-10 是周四，便于「上周三」解析成 2026-09-02）。 */
export declare const SYNTHETIC_NOW: Date;
/** 合成语料（28 条）。 */
export declare const SYNTHETIC_CORPUS: RetrievedDoc[];
/**
 * 人工标注的评测用例（相关 docKey 即 ground truth）。
 *
 * `subQueries` 模拟规划器（LLM）给出的关键词 —— 真实链路里这一步一定发生，
 * 若评测里省掉，就会把「bigram 切分把『一共转了多少笔账』切成 共转/笔账 而没有
 * 转账」这种分词缺陷误记成检索算法缺陷。给出 subQueries 才是在评测**检索阶段**。
 */
export declare const SYNTHETIC_CASES: EvalCase[];
/** 合成检索配置（默认全开；denseEnabled=false 用于消融对比）。 */
export interface SyntheticEvalOptions {
    denseEnabled?: boolean;
    sparseEnabled?: boolean;
    structuredEnabled?: boolean;
    k?: number;
    verbose?: boolean;
}
/**
 * 在合成语料上跑一遍完整「路由 → 改写 → 三通道召回 → 融合 → 重排」，返回有序 docKey。
 * @param c - 评测用例。
 * @param opts - 通道开关与 k。
 * @returns 有序命中 docKey。
 */
export declare function syntheticRetrieve(c: EvalCase, opts?: SyntheticEvalOptions): string[];
/** 跑合成评测，返回报告。 */
export declare function runSyntheticEval(opts?: SyntheticEvalOptions): EvalReport;
/** 意图分类准确率（对照用例里标注的 intent）。 */
export declare function syntheticIntentAccuracy(): {
    correct: number;
    total: number;
    accuracy: number;
};
/** 供测试引用的语料实体。 */
export declare const __corpusMeta: {
    CHEN: {
        u: string;
        n: string;
    };
    LISI: {
        u: string;
        n: string;
    };
    WANG: {
        u: string;
        n: string;
    };
    GRP: {
        u: string;
        n: string;
    };
};
