import type { FeedbackRecord, RerankWeights } from './types.ts';
/** 反馈库路径。 */
export declare function feedbackDbPath(decryptedDir: string): string;
/** 写入一条反馈（超出上限时淘汰最旧）。 */
export declare function recordFeedback(decryptedDir: string, rec: FeedbackRecord, maxRecords?: number): void;
/** 读取最近 N 条反馈（新→旧）。 */
export declare function listFeedback(decryptedDir: string, limit?: number): FeedbackRecord[];
/** 反馈统计（前端展示「已收集多少反馈」）。 */
export declare function feedbackStats(decryptedDir: string): {
    total: number;
    up: number;
    down: number;
};
/**
 * 用反馈微调权重。
 *
 * 规则：每条 'up' 反馈把其 `features` 里的特征权重 +lr；'down' 则 −lr。
 * 这是「相关性反馈（Rocchio 思想）」在权重空间上的最简形式 —— 因为特征本身
 * 已经是归一化到 0~1 的分数，直接调权重即可，不需要重新训练任何东西。
 * @param base - 基准权重（config 默认）。
 * @param recs - 反馈记录。
 * @param lr - 步长。
 * @returns 微调后的权重（已 clamp）。
 */
export declare function adaptWeights(base: RerankWeights, recs: FeedbackRecord[], lr: number): RerankWeights;
/** 调参结果落盘（`<数据根>/rag-weights.json`），供 gateway 下次加载。 */
export declare function weightsPath(decryptedDir: string): string;
/** 读取已保存的调参权重（无则返回 null）。 */
export declare function loadAdaptedWeights(decryptedDir: string): RerankWeights | null;
/** 保存调参权重。 */
export declare function saveAdaptedWeights(decryptedDir: string, w: RerankWeights): void;
/**
 * 从「本轮引用是否被用户判为有用」反推特征归因。
 *
 * 用途：给每条反馈填 `features` —— 只保留「有用集合里显著高于无用集合」的特征，
 * 避免把噪声特征也带进调参。
 * @param usefulProfiles - 有用引用的特征向量。
 * @param uselessProfiles - 无用引用的特征向量。
 * @returns 归因到的特征名。
 */
export declare function attributeFeatures(usefulProfiles: Array<Record<keyof RerankWeights, number>>, uselessProfiles: Array<Record<keyof RerankWeights, number>>): Array<keyof RerankWeights>;
