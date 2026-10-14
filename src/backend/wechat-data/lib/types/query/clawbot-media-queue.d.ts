/**
 * ClawBot 附件**自动取回队列** —— 收到带附件的消息后自行下载解密，不需要人点。
 *
 * ## 语义
 *
 * - 新消息到达（或启动补扫）时 `enqueue(ids)`；队列**逐条**跑（不并发打 CDN，
 *   顺序即消息顺序，日志可读）；
 * - 每条失败的可重试错误（网络类）在**同一次运行里**最多试 {@link MAX_MEDIA_ATTEMPTS} 次，
 *   用尽后计入 `failed` 并留一行日志；`permanent`（形状/白名单/超限/解密失败）**不重试**；
 * - **缓存命中由 `ensure` 自己短路**（一次 stat，不联网）—— 所以重复入队是廉价的、
 *   也是安全的（这就是「持久化」的恢复路径：重启后补扫把没取完的补齐）；
 * - 队列状态（queued / done / failed / lastError）给 `checkClawbotEnv` 之外的排障用；
 *   `idle()` 只给测试（生产不需要等它）。
 *
 * @module query/clawbot-media-queue
 */
import type { ClawbotMediaOutcome } from './clawbot-media.ts';
/** 启动补扫单次最多清点多少条（防首次启动对空缓存全量狂扫）。 */
export declare const CLAWBOT_MEDIA_SWEEP_LIMIT = 200;
/** 同一条附件在一次运行里最多尝试取回几次（只针对可重试错误）。 */
export declare const MAX_MEDIA_ATTEMPTS = 3;
/** 队列依赖（全是注入：测试零出网、零文件系统假设）。 */
export interface ClawbotMediaQueueDeps {
    /** 待取行 id（新 → 旧；由 `clawbot-message.ts#listClawbotMediaPending` 提供）。 */
    listPending: (limit: number) => number[];
    /** 单条取回（生产 = `ensureClawbotMedia` 绑好数据根）。 */
    ensure: (id: number) => Promise<ClawbotMediaOutcome>;
    /** 日志出口（缺省 `console.log` 带 `[clawbot]` 前缀）。 */
    log?: (message: string) => void;
}
/** 队列对外状态（排障面板/测试看）。 */
export interface ClawbotMediaQueueState {
    running: boolean;
    queued: number;
    done: number;
    failed: number;
    lastError: string | null;
}
/** 队列句柄。 */
export interface ClawbotMediaQueue {
    /** 入队若干条（去重；已判永久失败/尝试用尽的会被跳过）。 */
    enqueue: (ids: readonly number[]) => void;
    /** 启动补扫：清点待取行并全部入队。 */
    sweep: () => void;
    state: () => ClawbotMediaQueueState;
    /** 等队列跑空（测试用；生产不需要）。 */
    idle: () => Promise<void>;
}
/**
 * 创建队列。
 * @param deps - 依赖（见 {@link ClawbotMediaQueueDeps}）。
 * @returns 队列句柄。
 */
export declare function createClawbotMediaQueue(deps: ClawbotMediaQueueDeps): ClawbotMediaQueue;
