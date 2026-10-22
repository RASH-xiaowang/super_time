import type { ToolLoopInput } from './types.ts';
/**
 * 按原顺序去重工具名。
 * @param names - 候选工具名。
 * @returns 去重后的工具名。
 */
export declare function dedupeNames(names: readonly string[]): string[];
/**
 * 从问题中提取确定性兜底查询词。
 *
 * 不把自然语言整句塞给关键词工具：整句在 FTS/文件名匹配里几乎等于一个
 * 超长短语，容易稳定 0 命中。只保留至少 2 字的内容词，并过滤动作/客套词。
 * @param query - 原始问题或兜底查询。
 * @returns 最多 4 个内容词。
 */
export declare function fallbackTerms(query: string): string[];
/**
 * 为确定性兜底构造最小合法参数。
 *
 * 只填工具必填项与服务端锁定范围。缺必填项的工具直接跳过，交给证据层
 * 如实报告“未执行”，而不是尝试空查询。
 * @param name - 工具名。
 * @param loop - 工具循环输入。
 * @returns 可执行参数；该工具不适合兜底时为 undefined。
 */
export declare function fallbackArguments(name: string, loop: ToolLoopInput): Record<string, unknown> | undefined;
