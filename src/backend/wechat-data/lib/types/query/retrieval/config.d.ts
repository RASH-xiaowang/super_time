import type { ChannelName, IntentKind, RerankWeights, RetrievalPolicy } from './types.ts';
/** 重排特征默认权重。数值含义：相对大小决定影响，绝对大小与归一化后的特征量级匹配。 */
export declare const DEFAULT_RERANK_WEIGHTS: RerankWeights;
/** 完整检索配置。 */
export interface RetrievalConfig {
    /** 总开关：关闭时 askWechat 退回旧的单通道检索（灰度/回滚用）。 */
    enabled: boolean;
    embedding: {
        enabled: boolean;
        /** 向量模型名；为空时回退到 chat model（部分厂商同名可用）。 */
        model: string;
        /** 单次 embedding 请求最多多少条文本（厂商通常有 batch 上限）。 */
        batchSize: number;
        /**
         * 同时在飞的 embedding 请求数上限（M10）。
         *
         * 原先是一批一批串行 await：`maxDocsPerBuild: 40000` / `batchSize: 16` ⇒ 单次建库 2500 次
         * 往返，全程被网络延迟支配。厂商普遍有速率限制，所以这个值**故意保守**，且运行时会被
         * 夹到 [1, 16]。调高只对「延迟高但允许更高并发」的自建服务有意义。
         */
        concurrency: number;
        /** 一次索引构建最多处理多少条消息（防止首次提问卡太久）。 */
        maxDocsPerBuild: number;
        /** 向量库命中缓存条数。 */
        cacheSize: number;
        /** 文本截断长度（超过部分不参与向量，省 token）。 */
        maxCharsPerDoc: number;
    };
    channels: {
        sparse: {
            enabled: boolean;
            topK: number;
        };
        dense: {
            enabled: boolean;
            topK: number;
            minSimilarity: number;
            candidatePool: number;
        };
        structured: {
            enabled: boolean;
            topK: number;
        };
    };
    fusion: {
        /** RRF 平滑常数 k；k 越大越弱化头部名次差异（经验值 60）。 */
        k: number;
        /** 融合后保留候选数（进入重排）。 */
        keep: number;
    };
    rerank: {
        weights: RerankWeights;
        /** 低于该分数直接丢弃（0 = 不设下限）。 */
        minScore: number;
    };
    compress: {
        /** 送进 LLM 的上下文字符预算。 */
        maxChars: number;
        /** 最多保留多少个对话窗口。 */
        maxChunks: number;
        /** 每个窗口最多几行。 */
        linesPerChunk: number;
        /** 近似重复文本的 Jaccard 阈值，超过则去重。 */
        dedupThreshold: number;
    };
    intent: {
        /** 是否用 LLM 辅助意图分类（失败时始终回退到规则分类）。 */
        llmAssist: boolean;
    };
    feedback: {
        enabled: boolean;
        /** 权重微调步长。 */
        learningRate: number;
        /** 反馈记录上限（超出淘汰最旧）。 */
        maxRecords: number;
    };
}
/** 内置默认配置。 */
export declare function defaultRetrievalConfig(): RetrievalConfig;
/** 数据根 = 解密目录的父目录（与 wechat_search.db 同址）。 */
export declare function retrievalRoot(decryptedDir: string): string;
/** 配置文件路径。 */
export declare function retrievalConfigPath(decryptedDir: string): string;
/**
 * 读取检索配置（文件缺失/损坏时回退默认值）。
 * @param decryptedDir - 解密数据根。
 * @returns 完整配置。
 */
export declare function loadRetrievalConfig(decryptedDir: string): RetrievalConfig;
/**
 * 写入检索配置（以**当前文件内容**为基准合并后落盘）。
 *
 * 基准必须是磁盘上的现值，而不是内置默认值：设置面板只暴露了一部分参数
 * （`embedding.maxDocsPerBuild` / `channels.sparse.topK` / `rerank.weights` /
 * `compress.*` 明细 / `feedback.maxRecords` 等都不在界面上）。以默认值为基准合并，
 * 等于用户每点一次「保存检索设置」就把这些没暴露的参数静默重置回默认 ——
 * 手工调过 `rag-config.json` 的人一保存就丢配置。
 * （UI 自动化验收实测：面板保存后 `embedding.maxDocsPerBuild` 从 400 变回 40000，
 *   单次建向量索引因此发出 2501 次 embedding 请求。）
 * @param decryptedDir - 解密数据根。
 * @param patch - 要更新的字段（可只给子集）。
 * @returns 落盘后的完整配置。
 */
export declare function saveRetrievalConfig(decryptedDir: string, patch: unknown): RetrievalConfig;
/** 把配置与意图策略合成一次查询的有效参数。 */
export interface EffectiveParams {
    config: RetrievalConfig;
    policy: RetrievalPolicy;
    /** 权重 = 意图策略覆盖后的最终值。 */
    weights: RerankWeights;
    channelTopK: Record<ChannelName, number>;
}
/** 合成一次查询的有效参数（意图策略覆盖配置默认）。 */
export declare function effectiveParams(config: RetrievalConfig, policy: RetrievalPolicy): EffectiveParams;
/**
 * 意图 → 默认策略表。
 *
 * 「分类路由」的核心：每种意图给出不同的通道组合 / topK / 权重 / 排序方式。
 * 这张表本身也是可调参的对象（未来可由反馈闭环更新）。
 */
export declare function defaultPolicyFor(intent: IntentKind): RetrievalPolicy;
