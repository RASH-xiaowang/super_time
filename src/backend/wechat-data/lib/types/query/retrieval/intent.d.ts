/**
 * 查询意图识别与分类路由（目标 3）。
 *
 * 为什么必须分类：同一个检索引擎对「最近一次转账给谁」和「我一共转了多少」
 * 的最优参数是**相反**的 —— 前者要时间优先、少召回；后者要覆盖度、多召回。
 * 旧实现只有一条 `recency` 布尔线索，其余问题全走同一套参数，于是聚合类问题
 * 因为 topK 太小而漏证据、实体类问题因为通用词挤占名额而找不到人。
 *
 * 这里用**确定性规则**做主分类（可离线、零延迟、可单测），LLM 只作为可选补充
 * （pipeline 里按 config.intent.llmAssist 决定是否调用）。规则分类即便被 LLM 覆盖，
 * 也仍然作为回退基准，保证「LLM 挂了也能路由」。
 */
import type { IntentKind } from './types.ts';
/** 「最近/最新/最后」类排序意图（与既有 ask.ts 的 RECENCY_RE 保持一致语义）。 */
export declare const RECENCY_RE: RegExp;
/** 判定结果。 */
export interface IntentDecision {
    intent: IntentKind;
    /** 规则命中的依据（写进日志，便于解释路由）。 */
    reason: string;
    /** 是否含「最近/最后一次」这类排序意图（无论最终意图是什么都返回）。 */
    recency: boolean;
}
/**
 * 规则意图分类。
 *
 * 顺序即优先级：显式时间表达（time_range）与「最近」这类排序词会先被识别；
 * 聚合/对比是明确的问法特征；实体属性结构次之；最后落到 open_qa。
 * @param question - 用户原始问题。
 * @param knownEntities - 已知实体名（联系人群里的显示名），命中则实体意图更可信。
 * @returns 意图判定。
 */
export declare function classifyIntent(question: string, knownEntities?: string[]): IntentDecision;
/**
 * 用 LLM 结果修正规则分类（仅在规则判为 open_qa 且 LLM 给出更具体意图时采纳）。
 *
 * 保守策略：只有「规则说不确定、模型说具体」才采纳 —— 反向覆盖风险大于收益，
 * 规则已经能高置信识别的问题不需要模型再插一脚。
 * @param base - 规则判定。
 * @param llmIntent - 模型输出的意图字符串（可能是任意文本）。
 * @returns 修正后的判定。
 */
export declare function refineIntentWithLlm(base: IntentDecision, llmIntent: string): IntentDecision;
