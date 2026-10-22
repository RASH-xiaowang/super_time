/**
 * 问答检索工具的**注册表**（2026-10-16 新增）。
 *
 * ## 它解决什么问题
 *
 * 工具散在四个文件里（message / aggregate / contact / content / kb），
 * 而调用方（问答链路、未来的 tool-use 循环、测试）需要的是**一份完整清单**。
 * 这里做三件事：
 *   ① 汇总所有工具（`allTools`）；
 *   ② 按名字执行（`runTool`）—— 带**统一的错误兜底**与耗时统计；
 *   ③ 投影成模型能看的 schema 清单（`toolSchemas`）。
 *
 * ## 为什么 `runTool` 要兜底
 *
 * 工具的 `run` 约定「不抛错」，但那是**约定**不是**保证** —— 一个没被 catch 的
 * 异常会让整次问答崩掉。这里再兜一层：任何异常都变成 `{ ok: false, error }`。
 * 两层防护不是冗余：内层让工具能给出**具体**的失败原因（「索引不存在」），
 * 外层保证**任何**失败都不会冒泡成崩溃。
 *
 * @module query/tools/registry
 */
import type { EmbedFn } from '../retrieval/embedding.ts';
import { type HybridSearchExecutor } from './search-hybrid-tool.ts';
import { type RetrievalTool, type ToolContext, type ToolName, type ToolResult } from './types.ts';
/**
 * 组装完整的工具集。
 *
 * `search_semantic` 需要注入 `embedFn`（它含隐私闸门，属于装配层的事），
 * 所以这里用工厂函数而不是常量 —— 没注入时该工具**仍然存在**，
 * 只是执行时如实返回「未配置向量模型」（而不是从清单里消失：
 * 消失会让模型以为「没有这个能力」，而实际上是「这次没配」）。
 * @param opts.embedFn - 向量化函数（含隐私闸门）。
 * @param opts.embedModel - 向量模型名（只用于展示）。
 * @param opts.hybridExecutor - 混合检索执行器（由装配层注入 `runAskRetrieval`）。
 * @returns 完整工具集。
 */
export declare function buildTools(opts?: {
    embedFn?: EmbedFn;
    embedModel?: string;
    hybridExecutor?: HybridSearchExecutor;
}): RetrievalTool[];
/** 默认工具集（不含语义检索的 embedFn —— 调用方按需用 `buildTools` 组装）。 */
export declare const allTools: readonly RetrievalTool[];
/** 工具名清单（供测试与文档用）。 */
export declare const TOOL_NAMES: readonly ToolName[];
/**
 * 按名字执行一个工具。
 *
 * @param tools - 工具集（用 `buildTools` 组装的那份）。
 * @param name - 工具名（**不可信**：模型可能给一个不存在的名字）。
 * @param args - 参数（**不可信**：形状由工具的 schema 约束，但必须按不可信输入处理）。
 * @param ctx - 执行上下文。
 * @returns 结构化结果；工具不存在或抛错时 `ok: false`。
 */
export declare function runTool(tools: readonly RetrievalTool[], name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
/** 把工具集投影成「发给模型」的 schema 清单。 */
export declare function toolSchemas(tools?: readonly RetrievalTool[]): Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}>;
export type { RetrievalTool, ToolContext, ToolResult, ToolName };
