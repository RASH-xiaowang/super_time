/**
 * 工具结果回放与错误详情白名单。
 *
 * 工具结果会进入下一轮模型上下文，必须压缩后再回放；失败详情只保留可用于
 * 纠正参数的标量字段，正文、密钥与任意嵌套对象一律丢弃。
 *
 * @module query/answer-runtime/tool-replay
 */
import type { ToolResult } from '../tools/types.ts';
/** 按字符截断，避免把代理对切成半个字符。 */
export declare function clip(value: string, max: number): string;
/** 把工具结果压缩成可安全回放的 JSON 文本。 */
export declare function serializeResult(result: ToolResult): string;
/**
 * 失败结果回给模型时只带「下一轮怎么改参数」的白名单字段。
 *
 * 工具失败文本本身已经可能含路径/片段，不能整包回放；这里进一步把
 * `errorDetails` 限成标量与短数组，既能让模型纠正 `field`/`allowed`，
 * 也不会把正文、密钥或嵌套对象带进下一轮上下文。
 */
export declare function serializeErrorDetails(details: Record<string, unknown> | undefined): Record<string, unknown> | undefined;
