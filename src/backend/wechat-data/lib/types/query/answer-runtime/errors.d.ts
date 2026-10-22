/**
 * 检索工具错误的统一分类与重试策略。
 *
 * 工具失败不等于「再试一次就会好」：
 *   · 参数错、找不到、越权、范围越界 —— 重试必然还是同一个结果；
 *   · 超时、限流、瞬时网络/数据库错误 —— 可以在有界次数内重试；
 *   · 有副作用的工具 —— 即使错误看起来可重试，也不能自动重放。
 *
 * 本模块只做纯分类，不真正 sleep / 重试，便于 runtime 与测试复用。
 *
 * @module query/answer-runtime/errors
 */
import type { ToolResult } from '../tools/types.ts';
/** 工具错误分类（主运行时约定名）。 */
export type ToolErrorClass = 'invalid_arguments' | 'not_found' | 'timeout' | 'rate_limited' | 'unauthorized' | 'scope_blocked' | 'transient' | 'internal';
/** 分类的兼容别名。 */
export type ToolErrorCategory = ToolErrorClass;
/** 错误分类选项。 */
export interface ToolErrorClassificationOptions {
    tool?: string;
    /** 工具是否有副作用；true 时任何自动重试都被禁止。 */
    sideEffect?: boolean;
    /** 调用方已确定是范围越界（优先级高于普通错误文本）。 */
    scopeBlocked?: boolean;
    httpStatus?: number;
    code?: string;
    retryAfterMs?: number;
    category?: ToolErrorCategory;
}
/** 主运行时直接使用的分类结果。 */
export interface ClassifiedToolError {
    cls: ToolErrorClass;
    retryable: boolean;
    message: string;
    /** 总尝试次数（首次 + 允许的重试）。 */
    maxAttempts: number;
}
/** 带诊断字段的完整分类结果。 */
export interface DetailedToolErrorClassification extends ClassifiedToolError {
    category: ToolErrorClass;
    /** 除首次执行外，安全允许的自动重试次数。 */
    maxRetries: number;
    /** 服务端要求的等待时间（若有）。 */
    retryAfterMs?: number;
    reason: string;
    tool?: string;
}
/**
 * 将一个未知错误分类，并给出安全重试策略（含诊断字段）。
 *
 * @param error - 错误对象、字符串或结构化错误。
 * @param options - 调用方掌握的状态码、错误码、副作用等附加信息。
 * @returns 分类结果。
 */
export declare function classifyToolErrorDetailed(error: unknown, options?: ToolErrorClassificationOptions): DetailedToolErrorClassification;
/**
 * 主运行时入口：分类一个工具错误。
 *
 * 第二参数兼容两种写法：
 *   · 工具名（`classifyToolError(error, 'search_messages')`）；
 *   · 完整选项（状态码、副作用、显式 scopeBlocked 等）。
 *
 * @param error - 错误对象、字符串或结构化错误。
 * @param toolOrOptions - 工具名或分类选项。
 * @returns 含 `cls` / `retryable` / `message` / `maxAttempts` 的结果。
 */
export declare function classifyToolError(error: unknown, toolOrOptions?: string | ToolErrorClassificationOptions): ClassifiedToolError;
/**
 * 分类一个 `ToolResult` 的失败信息。
 * @param result - 工具结果。
 * @param options - 附加分类信息。
 * @returns 分类结果。
 */
export declare function classifyToolResultError(result: Pick<ToolResult, 'tool' | 'ok' | 'error'>, options?: ToolErrorClassificationOptions): ClassifiedToolError;
/** 是否允许自动重试。 */
export declare function isRetryableToolError(error: unknown, options?: ToolErrorClassificationOptions): boolean;
