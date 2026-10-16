/** 单个分段的字符预算：一次 LLM 调用放得下的量级（约 2k token 的输入）。 */
export declare const SEGMENT_CHAR_BUDGET = 4000;
/** 段数硬上界：超过就不再取样，而不是无限增长（话痨账号一年能切出上百段）。 */
export declare const MAX_SEGMENTS = 40;
/** 一个分段。 */
export interface AnnualSegment {
    /** 人类可读的段名（「2024-03」/「2024-03（第 2 段）」）。 */
    label: string;
    /** 该段对应的月份（1-12），用于提示词与界面标签。 */
    month: number;
    /** 该段的原文行（已清洗、已截断）。 */
    lines: string[];
    /** 该段字符数（<= SEGMENT_CHAR_BUDGET，含换行）。 */
    chars: number;
}
/** 取材结果。 */
export interface AnnualSegmentsResult {
    segments: AnnualSegment[];
    /** 是否因为 `MAX_SEGMENTS` 而提前收手（如实说出，别让界面以为覆盖了整年）。 */
    truncated: boolean;
}
/**
 * 按段取材一年的文本消息。
 *
 * 让出与取消都放在**分片边界**：这一段是纯 CPU 重活（真实 @Remote 探针实测
 * 同一段扫描 4048ms），独占期间整个后端串行 worker 都动不了。检查点放在
 * 循环最前面 —— 下面有 `continue`，放末尾会让数据里成片出现的行整段不检查。
 * @param decryptedDir - 解密数据根。
 * @param year - 自然年。
 * @param opts - 可选的取消令牌 + 扫描阶段进度回调（总量未知，回调只带已扫行数）。
 * @returns 分段 + 是否被 `MAX_SEGMENTS` 截断。
 */
export declare function collectAnnualSegments(decryptedDir: string, year: number, opts?: {
    signal?: AbortSignal;
    onScanProgress?: (rows: number) => void;
}): Promise<AnnualSegmentsResult>;
