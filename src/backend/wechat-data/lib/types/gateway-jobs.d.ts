import type { StreamJob } from './gateway-support.ts';
import type { StreamControl } from './query/zip.ts';
/** 一次进度推送的载荷（`getExportProgress` 与事件里是同一份形状）。 */
export interface JobProgressDetail {
    jobId: string;
    phase: string;
    done: number;
    total: number;
}
/**
 * 进度事件出口：由类注入（**事件名留在装配那一侧** —— `ctx.emit` 的第一参数是
 * `keyof Events`，模块里拿一个 `string` 去调它类型就不成立了）。
 */
export type JobEmit = (detail: JobProgressDetail) => void;
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
export declare function streamControlFor(jobs: Map<string, StreamJob>, emit: JobEmit, jobId?: string): StreamControl;
/**
 * 收尾一个长任务：标记结束（**槽位留着不删**，让迟到的 `getExportProgress` 能读到终态与错误）。
 * @param jobs - 类持有的那张槽表。
 * @param jobId - 任务标识。
 * @param error - 失败/取消原因；成功时省略。
 * @returns 无。未知 jobId 静默返回（收尾一个早被淘汰的槽不该把任务本身弄失败）。
 */
export declare function finishStreamJobIn(jobs: Map<string, StreamJob>, jobId: string, error?: string): void;
