/**
 * 证据结果的上游归一化与定位映射。
 *
 * 工具结果来自模型选择的工具与插件，形状不可信。本模块只处理单条结果：
 * 校验命中、生成稳定定位与引用形状，并复核 profile 的输出边界。证据包级别的
 * 去重、预算与状态判定仍由 `evidence.ts` 负责。
 *
 * @module query/answer-runtime/evidence-normalize
 */
import type { ToolHit } from '../tools/types.ts';
import type { BuildEvidenceOptions, EvidenceItem, EvidenceLocator, EvidenceSource } from './evidence-types.ts';
export declare function safeString(value: unknown): string;
export declare function isRecord(value: unknown): value is Record<string, unknown>;
/**
 * 输出侧边界复核。
 *
 * 工具参数校验发生在执行前，但工具实现、旧插件或上游缓存仍可能返回越界结果。
 * 这里只返回拒绝原因，不改写命中；调用方把它计为边界拒绝并整包阻断。
 */
export declare function boundaryViolation(tool: string, source: EvidenceSource, locator: EvidenceLocator, options: BuildEvidenceOptions): string | undefined;
export declare function allowsFact(tool: string, locator: EvidenceLocator, options: BuildEvidenceOptions): string | undefined;
export declare function itemFromHit(tool: string, hit: ToolHit, ordinal: number): EvidenceItem;
export interface NormalizedHit {
    hit?: ToolHit;
    warnings: string[];
}
export declare function normalizeHit(tool: string, raw: unknown, index: number): NormalizedHit;
