/**
 * 工具调用 trace 的脱敏与稳定键。
 *
 * trace 会进入操作日志、数据库与界面。参数里可能有整段聊天正文、文件名、
 * token 或本地路径，因此这里只输出短摘要；缓存键则必须保留完整参数值，
 * 否则「两个不同查询被当成同一次调用」会静默返回错误结果。
 *
 * @module query/answer-runtime/trace
 */
import type { ToolCallTrace } from './types.ts';
/**
 * 失败正文只保留诊断所需的一小段。
 *
 * 工具错误可能夹带供应商回显、鉴权头或整段用户输入；trace 会落库并进入界面，
 * 因此先去掉常见凭据形式，再做定长截断。
 */
export declare function sanitizeToolErrorMessage(value: string): string;
/**
 * 生成人类可读的参数摘要。
 * @param args - 已修复或原始参数。
 * @returns 形如 `{"limit":8,"query":"合同"}` 的短摘要。
 */
export declare function summarizeToolArguments(args: Record<string, unknown>): string;
/**
 * 缓存键用的稳定序列化（保留完整值，只排序键）。
 *
 * 不走 `JSON.stringify` 的默认键序：同一组参数因对象插入顺序不同会产生不同键，
 * 去重会失效。数组顺序保留（它可能影响结果）。
 * @param value - 任意 JSON 值。
 * @returns 稳定字符串。
 */
export declare function stableArgumentStringify(value: unknown): string;
/** 工具名 + 规范化参数的缓存键。 */
export declare function toolCallCacheKey(name: string, args: Record<string, unknown>): string;
/** `createToolCallTrace` 的输入。 */
export interface ToolCallTraceInput {
    index: number;
    round: number;
    callId: string;
    name: string;
    args?: Record<string, unknown>;
    argumentsSummary?: string;
    ok: boolean;
    deduplicated?: boolean;
    attempts?: number;
    elapsedMs?: number;
    errorClass?: ToolCallTrace['errorClass'];
    errorCode?: string;
    errorMessage?: string;
    hits?: number;
    facts?: number;
    deadlineExceeded?: boolean;
    skipped?: boolean;
    note?: string;
}
/**
 * 构造一条 trace；统一把 attempts/retries 口径写在这里。
 * @param input - trace 字段。
 * @returns 可直接落库的 trace。
 */
export declare function createToolCallTrace(input: ToolCallTraceInput): ToolCallTrace;
