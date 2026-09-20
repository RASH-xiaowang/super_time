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
    /**
     * 与 `embedFn` **同源**的模型名（由 gateway 的 `embedModelName()` 给出）。
     * 知识库稠密召回要用它判「库里那批向量是不是同一个模型算的」——
     * 维度相同、语义空间不同的两个模型是维度检查唯一抓不到的错配。
     */
    embedModel?: string;
    /**
     * 模型精排函数（由 gateway 注入，已含隐私闸门）。
     *
     * 只给「查询 + 候选文本」，回「与输入同长的分数数组」。
     * 未注入 ⇒ 整段精排跳过，`rerankInfo.used` 为假并说明用的是本地加权。
     */
    rerank?: (query: string, documents: string[]) => Promise<number[]>;
    /** 精排用的模型名（只用于回带给界面显示，不参与任何计算）。 */
    rerankModel?: string;
    /** 已知实体名（用于意图识别与实体召回）。 */
    knownEntities?: string[];
    /** 可选：LLM 意图判定回调（config.intent.llmAssist 时调用）。 */
    llmIntent?: () => Promise<string>;
    /** 预置的打分权重（来自反馈调参）；缺省用 config 默认。 */
    weightsOverride?: RetrievalConfig['rerank']['weights'];
    /**
     * 当前知识库 id（知识库通道的作用域）。
     *
     * **必填语义在调用方**：不传 = 本次提问不检索知识库（通道 `active:false` + note），
     * 而不是「搜所有库」。与 `kbId` 在其余知识库接口上的纪律一致 —— 没有「所有库」这种模式。
     */
    kbId?: number;
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
    /**
     * 这次到底有没有用模型精排。
     *
     * 必须回带给界面：`used:false` 与 `used:true` 是两种不同的可信度 ——
     * 前者说明「顺序是本地启发式给的」，后者说明「有一个模型读过这些候选」。
     * 不显示的话，用户会把「没配模型」读成「模型认为这些最相关」。
     */
    rerankInfo: {
        used: true;
        model: string;
        candidates: number;
        kept: number;
    } | {
        used: false;
        note: string;
    };
}
/**
 * 跑完整检索流水线。
 * @param input - 见 PipelineInput。
 * @returns 引用 / 窗口 / 词项 / 计划 / 策略 / 特征 / 统计。
 */
export declare function runRetrievalPipeline(input: PipelineInput): Promise<PipelineOutput>;
/** 稀疏索引是否已就绪（gateway 决定是否先建索引）。 */
export declare function sparseIndexExists(decryptedDir: string): boolean;
