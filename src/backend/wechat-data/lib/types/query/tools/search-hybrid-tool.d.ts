/**
 * `search_hybrid` 复合检索工具（2026-10-22 新增）。
 *
 * ## 为什么需要它
 *
 * 单一工具各有明确边界：`search_messages` 只做词法召回、`search_semantic` 只做
 * 向量召回、`aggregate_messages` 只做统计……模型在「不确定该选哪个」时常常选错，
 * 而选错的表现是**静默空结果**，不是报错。
 *
 * 这个工具把问答既有的混合检索流水线（稀疏 + 稠密 + 结构化 + 聚合 + 精排）
 * 暴露成一个稳定的兜底入口：模型只需要给问题与范围，不需要理解通道细节。
 *
 * ## 为什么不在这里 import `ask-retrieval`
 *
 * `ask-retrieval.ts` 会依赖 `tools/registry.ts`（装配工具集），若工具层再反向
 * import 它，就形成 `tools -> remotes -> tools` 的循环。这里只定义**执行器接口**，
 * 由装配层把 `runAskRetrieval` 包装后注入。这样：
 *   · 工具层零知识库/问答依赖，可单独测试；
 *   · 默认工具集仍包含该工具（未注入执行器时如实报「未配置」，而不是消失）。
 *
 * @module query/tools/search-hybrid-tool
 */
import { type RetrievalTool, type ToolContext, type ToolErrorCode } from './types.ts';
/** 混合检索模式。 */
export type HybridSearchMode = 'auto' | 'messages' | 'kb';
/** 混合检索请求（已经过工具层校验与范围归一）。 */
export interface HybridSearchRequest {
    /** 用户问题（自然语言）。 */
    query: string;
    /** 有效范围：会话与日期都已是「硬过滤」。 */
    scope: {
        username?: string;
        from?: string;
        to?: string;
    };
    /** 最多返回多少条证据。 */
    limit: number;
    /** auto = 消息 + 当前知识库；messages = 只查本机消息；kb = 只查知识库。 */
    mode: HybridSearchMode;
    /** 是否要求附带确定性聚合事实。 */
    aggregate: boolean;
}
/** 与 `AskCitation` 同形的引用（刻意结构化声明，避免工具层依赖 remotes）。 */
export interface HybridSearchCitation {
    name: string;
    time: string;
    snippet: string;
    username: string;
    local_id: number;
    sender?: string;
    source?: 'msg' | 'kb' | 'agg' | 'resource';
    kb?: {
        kbId: number;
        fileId: number;
        fileName: string;
        fileExt: string;
        chunkId: number;
        ordinal: number;
        page: number;
        heading: string;
    };
}
/** 与 `AskChunk` 同形的上下文窗口（只声明工具映射用到的字段）。 */
export interface HybridSearchChunk {
    name: string;
    anchor: HybridSearchCitation;
    lines: Array<{
        time: string;
        day?: string;
        sender: string;
        text: string;
    }>;
}
/** 确定性统计事实。 */
export interface HybridSearchFact {
    title: string;
    body: string;
}
/** 执行器返回的结构化错误。 */
export interface HybridSearchExecutionError {
    code: ToolErrorCode;
    message: string;
    details?: Record<string, unknown>;
}
/**
 * 执行器返回。
 *
 * 错误也放在返回值里而不是抛异常：工具层要把「范围错误」「未配置」等稳定类别
 * 原样回给运行时，不能靠解析异常消息。
 */
export interface HybridSearchExecution {
    citations: HybridSearchCitation[];
    chunks?: HybridSearchChunk[];
    terms?: string[];
    facts?: HybridSearchFact[];
    rerankLine?: string;
    error?: HybridSearchExecutionError;
}
/**
 * 混合检索执行器。
 *
 * 由装配层实现（通常是 `runAskRetrieval` 的薄包装）。工具层不关心它内部用了
 * 哪些通道，只要求返回统一证据形状。
 */
export type HybridSearchExecutor = (request: HybridSearchRequest, ctx: ToolContext) => Promise<HybridSearchExecution> | HybridSearchExecution;
/**
 * 创建 `search_hybrid` 工具。
 *
 * @param executor - 混合检索执行器；缺省时工具仍出现在清单里，但执行会如实报
 *   `not_configured`（与 `search_semantic` 未注入 embedding 时的策略一致）。
 * @returns 工具描述。
 */
export declare function makeSearchHybridTool(executor?: HybridSearchExecutor): RetrievalTool;
