import type { QueryPlan, RetrievalPolicy, RetrievalStats, RankedDoc } from './types.ts';
import { compressContext } from './compress.ts';
import { type RetrievalConfig } from './config.ts';
import { type EmbedFn } from './embedding.ts';
/** 流水线输入。 */
export interface PipelineInput {
    decryptedDir: string;
    question: string;
    /** 规划器关键词。 */
    subQueries?: string[];
    /** 规划器点名的人。 */
    entity?: string;
    /** 规划器给出的绝对日期（软偏好）。 */
    from?: string;
    to?: string;
    /** 用户显式检索范围（硬过滤）。 */
    scope?: {
        username?: string;
        from?: string;
        to?: string;
    };
    /** 最终保留的引用条数。 */
    limit?: number;
    config: RetrievalConfig;
    /** 稠密通道的 embedding 函数；未注入则稠密通道不可用（自动降级并记录）。 */
    embedFn?: EmbedFn;
    /** 已知实体名（用于意图识别与实体召回）。 */
    knownEntities?: string[];
    /** 可选：LLM 意图判定回调（config.intent.llmAssist 时调用）。 */
    llmIntent?: () => Promise<string>;
    /** 预置的打分权重（来自反馈调参）；缺省用 config 默认。 */
    weightsOverride?: RetrievalConfig['rerank']['weights'];
    /** 现在时刻（可注入，便于测试）。 */
    now?: Date;
}
/** 流水线输出。 */
export interface PipelineOutput {
    citations: Array<{
        name: string;
        time: string;
        snippet: string;
        username: string;
        local_id: number;
        sender?: string;
    }>;
    chunks: ReturnType<typeof compressContext>['chunks'];
    terms: string[];
    plan: QueryPlan;
    policy: RetrievalPolicy;
    /** 逐篇的特征向量（反馈归因用）。 */
    rankedFeatures: Array<{
        docKey: string;
        features: RankedDoc['features'];
    }>;
    stats: RetrievalStats;
}
/**
 * 跑完整检索流水线。
 * @param input - 见 PipelineInput。
 * @returns 引用 / 窗口 / 词项 / 计划 / 策略 / 特征 / 统计。
 */
export declare function runRetrievalPipeline(input: PipelineInput): Promise<PipelineOutput>;
/** 稀疏索引是否已就绪（gateway 决定是否先建索引）。 */
export declare function sparseIndexExists(decryptedDir: string): boolean;
