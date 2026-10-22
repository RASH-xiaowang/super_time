/**
 * 工具选择提示：只生成“优先检查/兜底尝试”的文本，不执行工具。
 *
 * @module query/answer-runtime/tool-guidance
 */
import type { RetrievalTool } from '../tools/types.ts';
import type { AnswerProfile } from '../tools/profiles.ts';
/** 只保留 profile 工具集里真实存在的建议，避免提示一个本轮不可用的工具。 */
export declare function profileToolHints(profile: AnswerProfile, hints: readonly string[], tools: readonly RetrievalTool[]): string[];
/** 把可用工具写成简短排序建议，仍要求模型按问题自行选择。 */
export declare function buildToolHintBlock(tools: readonly string[]): string;
