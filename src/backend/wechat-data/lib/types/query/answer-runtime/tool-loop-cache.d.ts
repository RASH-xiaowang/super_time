/**
 * 工具循环的有界缓存与参数归一化小工具。
 *
 * 这些函数不依赖模型或数据库，抽出后可单独验证缓存淘汰与 deadline 参数解析。
 * @module query/answer-runtime/tool-loop-cache
 */
import type { CachedToolResult, ToolLoopInput } from './types.ts';
export declare const MAX_CACHE_ENTRIES = 64;
export declare function safeOp(input: ToolLoopInput, status: 'ok' | 'fail' | 'skip', target: string, detail?: string): void;
export declare function rememberResult(cache: Map<string, CachedToolResult>, order: CachedToolResult[], entry: CachedToolResult): void;
export declare function positiveInt(value: number | undefined, fallback: number): number;
/** 允许 0 的整数参数（0 = 关闭对应 deadline）。 */
export declare function nonNegativeInt(value: number | undefined, fallback: number): number;
