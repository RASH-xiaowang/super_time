/**
 * `ask_history.runtime_trace` 的有界归一化。
 *
 * 历史轨迹只在本机保存，用于回看一次问答的工具轮次、分段思考与核对阶段。
 * 它不是审计日志，也不是完整的模型上下文：参数、工具结果正文和错误正文都不落库。
 *
 * 所有上限同时应用在写入与读取两侧。旧版本写入的 JSON、手工破坏的数据或未来
 * 版本多出来的字段，都只能收敛成这里定义的稳定形状；读取失败由调用方降级为
 * “没有轨迹”，不能影响问题、回答与引用等主字段。
 *
 * @module query/ask-history-trace
 */
import type { AskHistoryRuntimeTrace } from '../types.ts';
/** 写入侧可提供的轨迹来源；除旧式 `reasoning` 外都与运行结果同形。 */
export interface AskHistoryTraceInput {
    reasoning?: unknown;
    reasoningSegments?: unknown;
    stages?: unknown;
    toolCalls?: unknown;
}
/**
 * 把运行结果或已落库 JSON 收敛成稳定的有界轨迹。
 * @param input - 运行结果字段或读取出的旧轨迹对象。
 * @returns 可展示轨迹；没有任何思考/阶段/工具时返回 undefined。
 */
export declare function normalizeHistoryRuntimeTrace(input: AskHistoryTraceInput | Record<string, unknown> | null | undefined): AskHistoryRuntimeTrace | undefined;
