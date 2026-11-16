import type { CallRecord, CallsSnapshot } from '../types.ts';
/**
 * `已在其它设备接听`：接通了，但本机没有时长。
 *
 * 导出给 `tools/calls-tools.ts` 复用：工具要把它写进「已接听/已在其它设备接听」
 * 的展示文案，复制一份正则就会出现两处判据漂移。
 */
export declare const ANSWERED_ELSEWHERE: RegExp;
/**
 * 一次通话查询的可选范围/预算（`get_call_history` 工具新增）。
 *
 * 为什么这些不塞进 `CallsSnapshot`：时间范围、对方与扫描预算都是**这次查询的意图**，
 * 不是数据本身。放进快照会让缓存键与「统计口径」纠缠 —— 同一个快照可能只对某次
 * 带预算的调用成立。这里把它们作为独立参数，由 `queryCalls` 拼进缓存键。
 */
export interface CallsQueryOptions {
    /** 起始时间（epoch 秒，含端点）。 */
    fromSec?: number;
    /** 截止时间（epoch 秒，含端点）。 */
    toSec?: number;
    /** 只保留这些对方 username 的通话（已由调用方把显示名解析成 username）。 */
    peers?: ReadonlySet<string>;
    /**
     * 最多检查多少条 type-50 候选行。
     *
     * 为什么不叫「最多返回多少条」：SQL 仍要扫整张表才能筛出 type-50，这个预算限制的是
     * **解码/解析的条数**（真正花 CPU 的部分），命中预算后立即停止并标记截断。
     */
    maxRows?: number;
    /** 扫描时间预算（毫秒）。大账号上按块检查，达到后停止并标记截断。 */
    maxMs?: number;
    /** 取消信号（问答运行时的 deadline/用户取消）。 */
    signal?: AbortSignal;
}
/** 本次扫描是否被预算/取消截断。 */
export interface CallsScanInfo {
    /** 实际检查过的 type-50 候选行数（含随后被对方条件过滤掉的）。 */
    scannedRows: number;
    /** 是否因预算停止（此时统计只覆盖已扫描部分）。 */
    truncated: boolean;
    /** 截断原因：rows = 行数预算；time = 时间预算。 */
    truncationReason?: 'rows' | 'time';
    /** 是否被 `signal` 取消（结果同样不完整）。 */
    cancelled: boolean;
    /** 扫描墙钟耗时（毫秒）。 */
    elapsedMs: number;
}
/**
 * 工具需要的通话明细。
 *
 * 为什么不直接给 `CallRecord`：`room_type`（0=语音/1=视频）只在原始行里有，
 * 而 `CallRecord` 属于面板契约、不该为一个工具扩展。这里用子类型携带它，
 * 旧调用方拿到的仍是原来的 `CallsSnapshot`。
 */
export interface CallHistoryRecord extends CallRecord {
    roomType?: number;
}
/** `queryCalls` 带扫描参数时的返回值（旧签名仍返回 `CallsSnapshot`）。 */
export interface CallsQueryResult extends CallsSnapshot {
    /** 过滤后的全部通话，按时间倒序（工具据此做 recent/duration/count 排序）。 */
    records: CallHistoryRecord[];
    /** 本次扫描的预算/截断信息（工具写进 note）。 */
    scan: CallsScanInfo;
}
/**
 * Compute the call inventory snapshot (cached on shard + contact fingerprints).
 *
 * 旧签名保持不变（面板仍按 4 个位置参数调用）；第 5 个参数是工具新增的
 * 范围/对方/预算，只有传了它才返回带 `records` 与 `scan` 的扩展结果。
 * @param decryptedDir - decrypted data root.
 * @param selfUsername - logged-in account wxid (direction labels).
 * @param topPeers - how many peers to return (default 20).
 * @param recentLimit - how many recent records to return (default 50).
 * @param options - 可选范围/对方/扫描预算（不传 = 旧的整份快照）。
 * @returns the calls snapshot（带 options 时额外含 records/scan）。
 */
export declare function queryCalls(decryptedDir: string, selfUsername?: string, topPeers?: number, recentLimit?: number): Promise<CallsSnapshot>;
export declare function queryCalls(decryptedDir: string, selfUsername: string | undefined, topPeers: number, recentLimit: number, options: CallsQueryOptions): Promise<CallsQueryResult>;
