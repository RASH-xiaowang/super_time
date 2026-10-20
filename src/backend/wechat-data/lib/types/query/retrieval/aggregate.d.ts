import type { RetrievedDoc } from './types.ts';
/** 一条聚合事实。 */
export interface AggregateFact {
    /** 事实的标题（如「按会话统计消息数」）。 */
    title: string;
    /** 事实正文（多行文本，直接进上下文）。 */
    body: string;
    /** 参与统计的总行数（让模型知道这是全量还是抽样）。 */
    total: number;
}
/** 聚合查询的输入。 */
export interface AggregateInput {
    decryptedDir: string;
    /** 用户原始问题（用于挑聚合维度）。 */
    question: string;
    /** 规划器关键词（用于关键词计数）。 */
    terms?: string[];
    /** 用户显式范围（硬过滤）。 */
    scope?: {
        username?: string;
        from?: string;
        to?: string;
    };
    /** 规划器给出的日期（软偏好，作为默认时间窗）。 */
    from?: string;
    to?: string;
    /** 现在时刻（可注入，便于测试）。 */
    now?: Date;
}
/** 聚合维度：从问题里识别出「要按什么分组」。 */
type Dimension = 'session' | 'day' | 'keyword' | 'distinct';
/**
 * 识别聚合维度。
 *
 * 规则是**确定性**的（可离线、可单测）：
 *   · 问「跟多少人/多少个会话/几个群」→ `distinct`（去重计数）；
 *   · 问「哪个群/谁/哪个会话最多」→ `session`（按会话分组）；
 *   · 问「哪天/哪个月」→ `day`（按天分组）；
 *   · 其余（「一共多少笔」）→ `keyword`（关键词计数）。
 *
 * `distinct` 必须**先于** `session` 判定：「我总共跟多少人聊过天」含「多少」，
 * 但它问的是**去重后的会话数**，不是「哪个会话最多」。
 * @param question - 用户问题。
 * @returns 维度。
 */
export declare function pickDimension(question: string): Dimension;
/**
 * 从问题里抽出「方向词 + 名词」的组合词（如「收到转账」「付出金额」）。
 *
 * ## 为什么需要（2026-10-16 实测踩到）
 *
 * 用户问「我一共**收到**多少笔转账」，规划器把关键词拆成了「转账」——
 * 于是聚合通道统计出「含「转账」：282 条」，而**真实答案是 240 条**
 * （含「收到转账」）。282 里混着付出，模型看出这一点后只能说
 * 「没找到你收到转账的记录」—— 聚合跑了，但答的还是错的。
 *
 * 根因：规划器做的是**分词**，而「收到/付出」是**方向**，分词会把它丢掉。
 * 方向词在微信账单文本里是**字面存在**的（「收到转账120.00元」），
 * 所以这里按字面组合去数，不做任何语义推断。
 *
 * ## 为什么允许中间插字
 *
 * 用户不会写「收到转账多少笔」，而是「收到**多少笔**转账」—— 方向词与名词之间
 * 隔着量词。所以匹配时允许中间出现**量词/助词**（多少、几、笔、了、过、的、钱…），
 * 但**不允许**出现别的实义词（否则「收到红包和转账」会被误判成「收到转账」）。
 *
 * 只认白名单里的方向词与名词，不做模糊匹配 —— 猜错会数出一个不存在的组合，比不数更糟。
 *
 * @param question - 用户问题。
 * @returns 组合词列表（可能为空）。
 */
export declare function directionTerms(question: string): string[];
/** 时间窗（epoch 秒）；两端为 0 表示不限。 */
interface Window {
    lo: number;
    hi: number;
}
/**
 * 决定聚合的时间窗。
 *
 * 优先级：用户显式范围 > 规划器日期 > 问题里的相对时间词 > 不限。
 * 「最近 N 天」这类词必须在这里换算 —— 否则「最近 7 天哪个群最多」会统计全库。
 * @param input - 聚合输入。
 * @returns 时间窗。
 */
export declare function resolveWindow(input: AggregateInput): Window;
/**
 * 跑聚合查询。
 *
 * @param input - 聚合输入。
 * @returns 聚合事实列表（空数组 = 没有可聚合的数据或库不存在）。
 */
export declare function runAggregate(input: AggregateInput): AggregateFact[];
/**
 * 把聚合事实转成「文档」，好让它走与其余通道相同的融合/压缩路径。
 *
 * 为什么复用 `RetrievedDoc` 而不是另开一条通路：融合、去重、压缩、上下文渲染
 * 都已经有一套经过验证的实现，另开一条只会让「聚合结果怎么进上下文」变成第二套逻辑。
 * 用 `source: 'agg'` 标记，让压缩阶段像 `kb` 一样**跳过窗口展开**（聚合结果没有
 * 「发生时间」，展开会得到空窗口）。
 *
 * @param facts - 聚合事实。
 * @returns 文档列表（每个事实一条）。
 */
export declare function factsToDocs(facts: AggregateFact[]): RetrievedDoc[];
export {};
