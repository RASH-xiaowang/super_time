/** 高风险值类型。 */
export type GroundingKind = 'amount' | 'date' | 'digits';
/** 一条「引用原文里找不到出处」的值。 */
export interface GroundingViolation {
    kind: GroundingKind;
    /** 原样出现在回答里的值（回喂给模型与提示用户都用它）。 */
    value: string;
}
/** 审计结果。 */
export interface GroundingAudit {
    /** 校验过的高风险值个数（按「类型 + 归一化值」去重）。 */
    checked: number;
    /** 引用原文里找不到出处的值（去重，封顶 {@link MAX_REPORTED}）。 */
    unsupported: GroundingViolation[];
    /** 含高风险值、却没有 [n] 标注的句子数（软问题：只触发重写，不算失败）。 */
    uncited: number;
    /** 回答真正引用到的来源序号（1 基，去重升序；越界的不算）。 */
    cited: number[];
    /** 是否通过（只有「引用原文里没有的硬值」才算不通过）。 */
    ok: boolean;
}
/** 引用原文侧的比对池。 */
interface ValuePools {
    dates: Set<string>;
    digits: string[];
    cents: Set<number>;
    /** 原文里 ≤{@link MAX_SUM_TERMS} 个金额能凑出的和（含单项本身）。 */
    sums: Set<number>;
}
/**
 * 从「回答自己引用的原文」建比对池。
 * @param evidenceTexts - 每条被引用来源的正文（窗口全文优先，退化时用 snippet）。
 * @returns 见 {@link ValuePools}。
 */
export declare function buildValuePools(evidenceTexts: readonly string[]): ValuePools;
/**
 * 审计一轮回答的接地情况。
 * @param answer - 回答正文。
 * @param evidenceTexts - **回答自己引用到的**来源正文（一条来源一段文本）。
 * @param citationCount - 本轮引用条数（用于校验 [n] 是否越界）。
 * @returns 见 {@link GroundingAudit}。
 */
export declare function auditGrounding(answer: string, evidenceTexts: readonly string[], citationCount: number): GroundingAudit;
/** 把违规值转成「回炉重写」的具体指令；没有违规时返回空串。 */
export declare function groundingRepairHint(audit: GroundingAudit): string;
export {};
