/**
 * 聚合类检索工具（2026-10-16 新增）。
 *
 * ## 为什么它必须是一个**独立工具**而不是检索的一个参数
 *
 * 「我一共收到多少笔转账」「哪个群消息最多」这类问题的答案**不在任何一条消息里** ——
 * 它需要 `COUNT(*)` / `GROUP BY`。改造前检索管线只有「片段召回」一种操作，
 * 于是模型从 10 条片段里「数出」一个数（实测答「14 条」，真实 282 条），
 * 或者干脆说「判断不了」。
 *
 * 把它做成独立工具之后，模型可以**明确地**选择「这次要统计而不是检索」——
 * 而不是靠一堆正则去猜意图（`classifyIntent` 的 `AGG_RE` 就是那种猜法，
 * 实测漏掉了「哪个群聊消息最多」）。
 *
 * ## 与 `retrieval/aggregate.ts` 的关系
 *
 * 那个模块是**实现**（跑 SQL），这里是**工具包装**（参数校验 + 结果整形）。
 * 刻意不合并：实现要能被流水线直接调用（不必经过工具层），
 * 而工具层要处理「模型给的参数不可信」这件事（实现层不该关心）。
 *
 * @module query/tools/aggregate-tools
 */
import { pickDimension } from '../retrieval/aggregate.ts';
import { type RetrievalTool } from './types.ts';
/** 聚合统计消息（计数 / 排名 / 去重）。 */
export declare const aggregateMessagesTool: RetrievalTool;
/** 聚合类工具集。 */
export declare const AGGREGATE_TOOLS: readonly RetrievalTool[];
/** 供测试直接用的维度判定（避免测试去构造完整工具调用）。 */
export { pickDimension };
