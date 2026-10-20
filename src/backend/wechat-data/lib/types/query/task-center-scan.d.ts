import type { TaskTriggerScanResult } from '../types.ts';
/** 扫描参数（网关把登录账号 wxid 注进来，query 层不 import gateway 侧）。 */
export interface ScanTaskTriggersOptions {
    /** 登录账号 wxid（用于判定单聊里"对方发的"）。 */
    selfUsername?: string;
}
/**
 * 同步扫描一次：对每个已完善任务，从水位之后拉新消息、命中关键词就落一条触发记录。
 *
 * 单任务失败不连坐（错误只收集前 10 条）；水位只在**确实见过更大的 sort_seq** 时推进，
 * 无消息时不动。记录写入用 `INSERT OR IGNORE`（UNIQUE 冲突 = 已经记过，跳过）。
 * @param decryptedDir - 解密数据根。
 * @param opts - 扫描参数（登录账号 wxid）。
 * @returns 扫描结果（tasks / scanned / created / dispatched 恒有；失败带 error / errors）。
 */
export declare function scanTaskTriggers(decryptedDir: string, opts?: ScanTaskTriggersOptions): TaskTriggerScanResult;
