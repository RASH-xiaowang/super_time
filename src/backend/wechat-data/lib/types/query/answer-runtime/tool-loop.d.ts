import type { ToolSchema } from '@deepseek-ai/dsh-llm';
import { summarizeToolArguments } from './trace.ts';
import type { ToolLoopInput, ToolLoopResult } from './types.ts';
/** profile 白名单内的 schema；即使调用方误传全量 schema，也会在这里收口。 */
export declare function buildToolLoopSchemas(input: Pick<ToolLoopInput, 'profile' | 'profileTools' | 'tools' | 'toolContext'>): ToolSchema[];
/**
 * 跑工具循环。
 *
 * @param input - 见 {@link ToolLoopInput}。
 * @returns 最终消息、trace 与去重后的工具结果。
 */
export declare function runToolLoop(input: ToolLoopInput): Promise<ToolLoopResult>;
export { summarizeToolArguments };
