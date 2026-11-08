import type { StreamJob } from './gateway-support.ts';
import type { StreamControl } from './query/zip.ts';
/** 一次进度推送的载荷（`getExportProgress` 与事件里是同一份形状）。 */
export interface JobProgressDetail {
    jobId: string;
    phase: string;
    done: number;
    total: number;
}
/** 终态事件额外字段；旧客户端忽略未知字段即可，轮询入口同时返回同一份状态。 */
export interface JobTerminalDetail extends JobProgressDetail {
    finished: true;
    status: 'ok' | 'error' | 'canceled';
    error?: string;
}
/** 交给 Remote 的可结算控制对象；`jobToken` 只在本进程内部使用，不过 RPC。 */
export interface ManagedStreamControl extends StreamControl {
    /** 生产控制槽总提供；测试/旧装配可省略，省略时按 jobId 结算。 */
    readonly jobToken?: symbol;
}
/**
 * 进度事件出口：由类注入（**事件名留在装配那一侧** —— `ctx.emit` 的第一参数是
 * `keyof Events`，模块里拿一个 `string` 去调它类型就不成立了）。
 */
export type JobEmit = (detail: JobProgressDetail | JobTerminalDetail) => void;
/** 判断一次失败是否属于用户取消（各层错误文案保持原样，不靠改错误类型兼容旧调用方）。 */
export declare function isCancelMessage(message: string): boolean;
/**
 * 清理已过期的终态槽位。没有定时器时也可由测试或网关直接调用。
 * @param jobs - 槽表。
 * @param now - 当前时间（测试可注入）。
 * @returns 清理数量。
 */
export declare function pruneSettledStreamJobs(jobs: Map<string, StreamJob>, now?: number): number;
/**
 * 取（或新建）一个长任务的控制槽，并包成 query 层要的 {@link StreamControl}。
 *
 * 每次调用都换一个**新的** AbortController：同一个 jobId 被复用（先取消、再重跑）时，
 * 复用一个已 abort 的令牌会让新一轮导出刚起步就抛「已取消」。同理每轮都把上一轮的
 * `progress` / `finished` / `error` 擦干净 —— 留着就会让"这次到底跑到哪了"读到上次的答复。
 * @param jobs - 类持有的那张槽表。
 * @param emit - 进度事件出口（尽力而为：抛错不影响任务本身）。
 * @param jobId - 渲染层生成的标识；缺省/空白时返回空控制（＝无进度、不可取消，
 *   旧调用方的行为完全不变）。
 * @returns 含 `signal` 与 `onProgress` 的控制对象，可直接透传给 query 层。
 */
export declare function streamControlFor(jobs: Map<string, StreamJob>, emit: JobEmit, jobId?: string): ManagedStreamControl;
/**
 * 收尾一个长任务：标记结束（**槽位留着不删**，让迟到的 `getExportProgress` 能读到终态与错误）。
 * @param jobs - 类持有的那张槽表。
 * @param jobId - 任务标识。
 * @param error - 失败/取消原因；成功时省略。
 * @param token - 本轮代次。给了 token 时只结算仍然拥有该槽的那一轮，旧任务晚到不会误伤新任务。
 * @param canceled - 是否明确是用户取消；省略时按错误文案判断。
 * @returns 无。未知 jobId 静默返回（收尾一个早被淘汰的槽不该把任务本身弄失败）。
 */
export declare function finishStreamJobIn(jobs: Map<string, StreamJob>, jobId: string, error?: string, token?: symbol, canceled?: boolean): void;
