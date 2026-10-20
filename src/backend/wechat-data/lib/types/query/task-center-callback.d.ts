import type { RetryFetch } from '../net/fetch-retry.ts';
import type { TaskCallbackDispatchResult } from '../types.ts';
/** 投递依赖：图片解码、隐私闸与 fetch 都由调用方注入（query 层不 import gateway 侧）。 */
export interface TaskDispatchDeps {
    /**
     * 解码一张图片（`username` + `localId`）。返回 `url`（data URL）或 `file`
     * （相对 `decodedDir` 的路径）之一；两者都没有 = 这张解不出来。
     */
    decodeImage: (username: string, localId: number) => Promise<{
        url?: string;
        file?: string;
    }>;
    /** 隐私闸（脱敏 + 审计）；返回可直接发出去的文本。 */
    gate: (feature: string, stats: {
        sessions: number;
        messages: number;
    }, texts: string[]) => string[];
    /** 测试注入用；生产省略 = 全局 `fetch`。 */
    fetchImpl?: RetryFetch;
}
/** 一批待投递记录的处理结果（扫描器把它并进 `TaskTriggerScanResult`）。 */
export interface PendingDispatchResult {
    dispatched: number;
    failed: number;
    errors?: string[];
}
/**
 * 手动 / 扫描后投递一条触发记录的回调。
 *
 * 只投「任务已完善 + 配置了回调地址」的记录；文本先过隐私闸（脱敏 + 审计）。
 * 失败不抛异常：`{ok:false, status:'failed', error}` 并落进记录，供前端重试。
 * @param decryptedDir - 解密数据根。
 * @param decodedDir - 图片解码缓存根。
 * @param triggerId - 触发记录 id。
 * @param deps - 解码 / 隐私闸 / fetch 注入。
 * @returns 投递结果（含 skipped 的三种可读原因）。
 */
export declare function dispatchTaskCallback(decryptedDir: string, decodedDir: string, triggerId: number, deps: TaskDispatchDeps): Promise<TaskCallbackDispatchResult>;
/**
 * 投递一批 `pending` 记录（只取所属任务仍「已完善」且有回调地址的）。
 *
 * 扫描器每拍「扫描 → 投递」；单条失败不连坐（错误只收集前 10 条）。
 * @param decryptedDir - 解密数据根。
 * @param decodedDir - 图片解码缓存根。
 * @param deps - 解码 / 隐私闸 / fetch 注入。
 * @param limit - 本次最多投几条（默认 10）。
 * @returns 成功/失败计数与失败原因。
 */
export declare function dispatchPendingTaskCallbacks(decryptedDir: string, decodedDir: string, deps: TaskDispatchDeps, limit?: number): Promise<PendingDispatchResult>;
