/**
 * 重排序（交叉特征重排）（目标 1 的 rerank 阶段）。
 *
 * 融合阶段只用「名次」，会丢掉各通道的相对相关度强弱；这里把通道分、词覆盖率、
 * 实体命中、时间偏好、时间新鲜度、多通道一致性 6 个特征**线性组合**成一个可解释的
 * 最终分。权重来自 config（意图策略可覆盖），因此「调参」就是改权重，不需要改代码。
 *
 * 保留了一条**硬优先级**路径：`recencyFirst`（问「最近一次 X」）时，先按时间取最新，
 * 再按分数 —— 这是旧实现踩坑最多的点（BM25 会把「讨论转账脚本」的群消息排到真正的
 * 转账通知前面），必须用时间硬压。
 */
import type { FusedDoc, RankedDoc, RerankWeights } from './types.ts';
/** 重排输入。 */
export interface RerankInput {
    fused: FusedDoc[];
    /** 检索词项（用于覆盖率特征）。 */
    terms: string[];
    /** 词 → 权重（稀有词更高）。 */
    termWeights: Map<string, number>;
    /** 意图实体（人名/群名）。 */
    entity: string;
    /** 软时间范围（毫秒；NaN 表示无）。 */
    softFromMs: number;
    softToMs: number;
    /** 是否「最近/最新」类问题。 */
    recency: boolean;
    /** 是否强制时间优先排序。 */
    recencyFirst: boolean;
    weights: RerankWeights;
    /** 当前时间（秒），用于新鲜度衰减。 */
    now: number;
}
/**
 * 交叉特征重排。
 * @param input - 见 RerankInput。
 * @returns 按最终分降序的候选（每项带完整特征，便于归因与反馈调参）。
 */
export declare function rerankDocs(input: RerankInput): RankedDoc[];
