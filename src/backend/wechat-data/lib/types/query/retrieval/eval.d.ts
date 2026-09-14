/**
 * 召回评估机制（目标 2）。
 *
 * 提供标准信息检索指标，把「检索效果好不好」从主观感受变成可回归的数字：
 *   · Precision@k —— top-k 里有多少是相关的（噪声控制）；
 *   · Recall@k    —— 相关文档里有多少被 top-k 召回（漏召控制）；
 *   · MRR         —— 第一个相关结果名次的倒数（「答案排多前」）；
 *   · NDCG@k      —— 带名次折扣的排序质量（越靠前越吃分，支持分级相关度）；
 *   · AP / MAP    —— 平均精度（对全部相关项的位置敏感，适合评估整体排序）。
 *
 * 指标是**纯函数**，与数据库无关：输入「有序的命中 docKey 列表 + 相关 docKey 集合」。
 * 因此既能在合成语料上跑（eval-dataset.ts），也能在真实数据 + 人工标注上跑。
 */
import type { IntentKind } from './types.ts';
/** 一个评测用例。 */
export interface EvalCase {
    id: string;
    question: string;
    scope?: {
        username?: string;
        from?: string;
        to?: string;
    };
    /** 规划器给出的关键词（模拟 LLM 规划阶段；缺省则只看问题本身的 bigram 切分）。 */
    subQueries?: string[];
    /** 相关文档的 docKey（`username:local_id`）或可唯一命中的文本片段。 */
    relevant: string[];
    /** 可选：分级相关度（docKey → gain）。缺省时按二值（命中=1）。 */
    graded?: Record<string, number>;
    /** 期望意图（用于评估意图分类准确率）。 */
    intent?: IntentKind;
}
/** 单用例评估结果。 */
export interface CaseScore {
    id: string;
    retrieved: string[];
    precision: number;
    recall: number;
    mrr: number;
    ndcg: number;
    ap: number;
}
/** 聚合结果。 */
export interface EvalReport {
    cases: number;
    hits: number;
    precision: number;
    recall: number;
    mrr: number;
    ndcg: number;
    map: number;
    perCase: CaseScore[];
}
/** Precision@k = |相关 ∩ top-k| / k；空结果记 0。 */
export declare function precisionAtK(retrieved: string[], relevant: string[], k: number): number;
/** Recall@k = |相关 ∩ top-k| / |相关|。 */
export declare function recallAtK(retrieved: string[], relevant: string[], k: number): number;
/** MRR = 1 / 第一个相关结果的名次（无相关结果记 0）。 */
export declare function mrr(retrieved: string[], relevant: string[]): number;
/**
 * NDCG@k（支持分级相关度）。
 * DCG = Σ gain_i / log2(i+1)；IDCG 用理想排序归一化。
 * @param retrieved - 有序命中 docKey。
 * @param relevant - 相关 docKey 列表（二值场景）。
 * @param k - 截断位置。
 * @param graded - 可选分级增益（docKey → gain）；给了就用它，否则命中=1。
 */
export declare function ndcgAtK(retrieved: string[], relevant: string[], k: number, graded?: Record<string, number>): number;
/** Average Precision（对全部相关项的位置敏感）。 */
export declare function averagePrecision(retrieved: string[], relevant: string[]): number;
/** 评测主 k（Precision/Recall/NDCG 的截断位置）。 */
export interface EvaluateOptions {
    k?: number;
    /** docKey → 文本，用于「按文本片段匹配相关」的用例。 */
    textIndex?: Map<string, string>;
}
/**
 * 跑一遍评测集。
 * @param dataset - 评测用例。
 * @param retrieve - 检索函数：输入用例，返回**有序**的命中 docKey 列表。
 * @param opts - 截断 k 与文本索引。
 * @returns 聚合 + 逐用例报告。
 */
export declare function evaluate(dataset: EvalCase[], retrieve: (c: EvalCase) => string[], opts?: EvaluateOptions): EvalReport;
/** 把报告格式化成可读多行文本（写进操作日志 / 评测命令输出）。 */
export declare function formatEvalReport(name: string, report: EvalReport, k?: number): string;
