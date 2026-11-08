import { type ToolErrorClass } from './errors.ts';
import type { ToolResult } from '../tools/types.ts';
import type { ToolLoopInput } from './types.ts';
export declare function failureResult(name: string, errorCode: NonNullable<ToolResult['errorCode']>, error: string, details?: Record<string, unknown>): ToolResult;
/** 工具把服务端等待建议放在 `errorDetails`；分类器需要它才能尊重限流退避。 */
export declare function retryAfterOption(result: ToolResult): {
    retryAfterMs?: number;
};
export declare function classifyFailure(result: ToolResult): {
    cls: ToolErrorClass;
    code?: string;
};
/** profile 明确声明有副作用的工具不能自动重放，即使错误看起来是瞬时/限流。 */
export declare function isSideEffectTool(loop: ToolLoopInput, name: string): boolean;
export declare function resultHasEvidence(result: ToolResult): boolean;
export declare function resultBlockedByScope(result: ToolResult): boolean;
