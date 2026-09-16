/** Optional retrieval scope: one talker and/or an inclusive date range (YYYY-MM-DD). */
export interface AskScope {
    username?: string;
    from?: string;
    to?: string;
}
/** One citation (source message) for an Ask answer. */
export interface AskCitation {
    name: string;
    time: string;
    snippet: string;
    username: string;
    local_id: number;
    /** 群聊里这条消息的发送者显示名（单聊为空）。 */
    sender?: string;
}
/** 规划器给出的结构化检索线索。 */
export interface AskHints {
    /** 关键词组（规划器已去停用词）。 */
    subQueries?: string[];
    /** 问题里隐含的绝对日期范围，由规划器换算成 YYYY-MM-DD。 */
    from?: string;
    to?: string;
    /** 问题里点名的人：命中其会话名或群内发送者时加分。 */
    person?: string;
}
/** 检索统计（写进操作日志，便于回答「为什么没检索到」）。 */
export interface AskRetrievalStats {
    terms: number;
    probed: number;
    candidates: number;
    kept: number;
    scope: string;
    recency: boolean;
    /** 规划器推断出的时间线索（软偏好，非硬过滤）。 */
    timeHint: string;
    /** 保留的引用里落在时间线索范围内的条数。 */
    hintHits: number;
    /** 命中消息聚类后的对话窗口数（chunk 级检索）。 */
    chunks: number;
    /** 窗口展开实际取回的消息条数。 */
    windowMessages: number;
    /** 召回通道：bm25 = 自建 bigram 索引（相关度排序）；like = 索引未就绪时的兜底扫描。 */
    recall: 'bm25' | 'like';
}
/**
 * 一个对话窗口（chunk）—— RAG 的检索单元。
 *
 * 为什么按「窗口」而不是按「单条消息」检索：微信里一条消息经常只有几个字
 * （「好的」「我没答应」「明天吧」），单独看无法判断它回答了谁的什么问题。
 * 「谁答应过我下周交报告」的答案往往分散在相邻两三条里（对方问 → 我答）。
 * 所以召回仍然按消息做（精确），但**送给模型的单元是它所在的对话窗口**。
 */
export interface AskChunk {
    username: string;
    name: string;
    /** 窗口里最匹配的那条消息 —— 引用卡片与「点击跳转原文」都以它为锚点。 */
    anchor: AskCitation;
    /** 窗口内的连续消息（按时间升序）；day 为该行自己的日期，窗口跨天时用它。 */
    lines: Array<{
        time: string;
        day?: string;
        sender: string;
        text: string;
    }>;
    score: number;
    /** 锚点是否落在时间线索范围内；排序时优先（与消息级排序保持同一套语义）。 */
    pref: number;
    /** 锚点时间（秒）。窗口级打分并列时按时间新→旧兜底 ——
     *  否则「最近一次转账」这类问题会在聚类后丢掉时间序（实测踩到过）。 */
    createTime: number;
}
/** 问题是否在问「最近/最后一次」。 */
export declare function hasRecencyIntent(question: string): boolean;
/**
 * 把一段文字拆成检索词：拉丁/数字整段 + 中文内容 bigram。
 * 中文没有分词器，bigram 是 FTS5 unicode61 下唯一可行的近似 —— 但要剔除
 * 纯功能词组合，否则「的是什么/给我/我的」这类词会吃满召回名额。
 * @param text - 待拆分的文本（问题或规划器给出的关键词）。
 * @returns 去重后的检索词（保持出现顺序）。
 */
export declare function extractAskTerms(text: string): string[];
/**
 * 按「规划器关键词 + 问题 bigram」召回候选并统一打分。
 * @param decryptedDir - decrypted data root.
 * @param question - 用户原始问题。
 * @param hints - 规划器给出的关键词/时间/人物线索。
 * @param scope - 用户显式设置的会话与时间范围。
 * @param limit - 最终保留条数（默认 24）。
 * @returns 排序后的引用 + 统计。
 */
export declare function retrieveAskCitations(decryptedDir: string, question: string, hints?: AskHints, scope?: AskScope, limit?: number): {
    citations: AskCitation[];
    chunks: AskChunk[];
    terms: string[];
    stats: AskRetrievalStats;
};
/**
 * 把检索结果格式化成给 LLM 的上下文块。
 *
 * 每个 [n] 是一个**对话窗口**而不是单条消息：窗口头给出会话、日期与命中时间点，
 * 下面按时间顺序列出这段对话（群聊带发言人）。模型因此能看到「谁问的、谁答的」，
 * 而不是一条孤立的「我没答应」。
 * @param citations - 已排序的引用（与 chunks 一一对应）。
 * @param meta - 意图 / 关键词 / 范围 / 时间线索，写进上下文头，便于模型判断证据是否充分。
 * @param chunks - 与 citations 对应的对话窗口；缺省时退化为逐条消息。
 * @returns 上下文文本。
 */
export declare function formatAskContext(citations: AskCitation[], meta?: {
    intent?: string;
    terms?: string[];
    scope?: string;
    recency?: boolean;
    timeHint?: string;
    hintHits?: number;
}, chunks?: AskChunk[]): string;
/**
 * 单轮检索入口（保留旧签名，供既有调用方与测试使用）。
 * @param decryptedDir - decrypted data root.
 * @param question - the user question.
 * @param limit - max context hits (default 24).
 * @param scope - optional talker and/or date-range filter.
 * @returns the formatted context lines plus source citations.
 */
export declare function buildAskContext(decryptedDir: string, question: string, limit?: number, scope?: AskScope): {
    context: string;
    citations: AskCitation[];
};
/** 解析检索规划 LLM 的 JSON 输出（容忍 ```json 围栏与前后杂文；取不到时返回空规划）。 */
export declare function parseAskPlan(text: string): {
    intent: string;
    subQueries: string[];
    from: string;
    to: string;
    person: string;
};
/** 从回答正文里解析模型实际引用的来源序号（1 基），用于给「来源」列表做标记。 */
export declare function parseCitedIndexes(answer: string, citationCount: number): number[];
/** 解析提问优化 LLM 的 JSON 输出（容忍围栏/杂文；解析失败时由调用方兜底）。 */
export declare function parseAskOptimize(text: string): {
    optimized: string;
    suggestions: string[];
};
