/** 一次预热的结果（启动日志与单测共用）。 */
export interface ClawbotStoreWarmupResult {
    warmed: boolean;
    slots: number;
    recentMessages: number;
    pendingRuns: number;
    pendingParts: number;
    durationMs: number;
    error?: string;
}
/**
 * 全链路 trace 的最小阶段事件契约。
 *
 * 这里只标准化字段，不落库、不输出操作日志。后续接线方可在每个阶段调用
 * {@link traceStage}，并自行决定写入 trace 表或内存采样。
 */
export interface ClawbotTraceStage {
    stage: string;
    runId: string;
    partId: string | null;
    clientId: string | null;
    elapsedMs: number;
}
/** {@link traceStage} 的输入（可选字段统一收敛成 null）。 */
export interface ClawbotTraceStageInput {
    stage: string;
    runId: string;
    partId?: string | null;
    clientId?: string | null;
    elapsedMs: number;
}
/**
 * 生成稳定的阶段 trace 字段。
 *
 * 纯函数：不读时钟、不写日志；elapsedMs 只做非负整数归一，便于后续聚合。
 * @param input - 阶段标识与关联键。
 * @returns 字段顺序与形状稳定的 trace 事件。
 */
export declare function traceStage(input: ClawbotTraceStageInput): ClawbotTraceStage;
/**
 * 预热 ClawBot 本机库。
 *
 * @param decryptedDir - 解密数据根；库位于它的父目录。
 * @returns 预热统计；库不存在或失败时 `warmed:false`，且不创建空库。
 */
export declare function warmClawbotStore(decryptedDir: string): ClawbotStoreWarmupResult;
