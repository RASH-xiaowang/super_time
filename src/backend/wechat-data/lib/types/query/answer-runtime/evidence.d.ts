/**
 * 工具结果到统一证据包的收敛。
 *
 * 工具返回的 `hits` 与 `facts` 形状相同但语义不同：
 *   · hits 是可点击回原文/文件/资源的片段；
 *   · facts 是确定性统计结论。
 *
 * 本模块把它们收敛成同一种 {@link EvidenceItem}，并负责：
 *   · 生成稳定 evidenceId（消息 / 知识库 / 聚合事实）；
 *   · 跨工具去重与合并；
 *   · 可解释排序；
 *   · 按条数与字符预算截断；
 *   · 统计与证据充分性判定。
 *
 * @module query/answer-runtime/evidence
 */
import { EVIDENCE_BUDGET_DEFAULTS, EVIDENCE_SOURCE_MIN_CHARS, EVIDENCE_SOURCE_MIN_SCORE, type AnswerStatus, type BuildEvidenceOptions, type CitationShape, type EvidenceAssessment, type EvidenceBundle, type EvidenceBundleStats, type EvidenceItem, type EvidenceLocator, type EvidenceSource, type EvidenceStatus, type EvidenceSufficiency } from './evidence-types.ts';
export { EVIDENCE_BUDGET_DEFAULTS, EVIDENCE_SOURCE_MIN_CHARS, EVIDENCE_SOURCE_MIN_SCORE, };
export type { AnswerStatus, BuildEvidenceOptions, CitationShape, EvidenceAssessment, EvidenceBundle, EvidenceBundleStats, EvidenceItem, EvidenceLocator, EvidenceSource, EvidenceStatus, EvidenceSufficiency, };
/** 判断证据包是否为空。 */
export declare function isEvidenceMissing(evidence: Pick<EvidenceBundle, 'items'> | readonly EvidenceItem[], options?: Pick<BuildEvidenceOptions, 'minItems' | 'minSnippetChars' | 'aggregateIntent'>): boolean;
/**
 * 评估证据是否充分。
 *
 * - 没有任何条目 → missing；
 * - 有条目但可用条目不足 → insufficient；
 * - 否则 sufficient。
 */
export declare function assessEvidence(evidence: Pick<EvidenceBundle, 'items'> | readonly EvidenceItem[], options?: Pick<BuildEvidenceOptions, 'minItems' | 'minSnippetChars' | 'aggregateIntent'>): EvidenceAssessment;
/**
 * 把多次工具结果收敛成一个有预算的证据包。
 *
 * 入参按 `unknown` 接收：主运行时可能在工具循环中途拿到未校验对象，
 * 这里只接受形状合法的 `ToolResult`；畸形 hit/fact 会逐条拒绝并计入统计，
 * 同一结果里仍有可用证据时整包降级而不是伪装成成功。
 *
 * @param results - 工具结果（顺序不影响排序与 evidenceId）。
 * @param options - 条数/字符预算与充分性阈值。
 * @returns 去重、排序、截断后的证据包。
 */
export declare function buildEvidenceBundle(results: readonly unknown[], options?: BuildEvidenceOptions): EvidenceBundle;
