/**
 * 任务中心的纯数据清洗工具。
 *
 * 这些函数既不读库也不依赖运行时状态，抽出来可避免任务中心主文件继续膨胀，
 * 同时保持 `task-center.ts` 的既有导出面不变。
 */
/** 一次批量删除最多处理多少条；超过时整单拒绝，避免静默只删一部分。 */
export declare const TASK_BATCH_DELETE_MAX = 500;
/** 错误文本（Error.message 优先，非 Error 一律 String()）。 */
export declare function taskErrorText(e: unknown): string;
export declare function taskCellStr(v: unknown): string;
export declare function taskCellNum(v: unknown): number;
/** 整数夹取（非数字按 fallback，其余夹到 [min, max]）。 */
export declare function clampTaskInt(v: unknown, fallback: number, min: number, max: number): number;
/**
 * 清洗批量删除 id：只保留唯一正整数，并拒绝空选择和过大批次。
 *
 * Remote 入参来自序列化 JSON，不能只靠 TypeScript 类型；重复 id 去重后返回，
 * 超过上限时整单拒绝而不是截断 —— 用户勾了 501 条却只删 500 条更难排查。
 */
export declare function cleanTaskBatchIds(raw: unknown, max?: number): {
    ids: number[];
    error?: string;
};
