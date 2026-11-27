import type { RetryFetch } from '../net/fetch-retry.ts';
import type { RpaMediaLinkFactory } from './rpa/media-links.ts';
import type { TaskCallbackDispatchResult } from '../types.ts';
/** 投递依赖：图片解码、隐私闸与 fetch 都由调用方注入（query 层不 import gateway 侧）。 */
export interface TaskDispatchDeps {
    /**
     * 解码一张图片（`username` + `localId`）。返回 `url`（data URL）或 `file`
     * （相对 `decodedDir` 的路径）之一；两者都没有 = 这张解不出来。
     * Webhook 适配器解码字节；RPA 厂商只在图片类参数来源需要时用它取得可签直链的文件路径。
     */
    decodeImage: (username: string, localId: number, options?: {
        fileOnly?: boolean;
    }) => Promise<{
        url?: string;
        file?: string;
    }>;
    /**
     * 图片直链工厂（`imagesJson` / `imageCount` / `firstImageUrl` 三种值来源用）。
     *
     * 按**触发记录 id** 构造：令牌载荷里要带 `recordId`（见 `net/rpa-media.ts`）。
     * 由装配层按当前配置现取（`api_token` 派生密钥 + 可达基址）；缺省时那三种来源会
     * 如实写「未打开局域网访问」，而不是发一个取不到的地址。
     */
    mediaLinks?: (recordId: number) => RpaMediaLinkFactory | undefined;
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
/** 测试可注入时钟/owner/租期；生产调用不传。 */
export interface TaskDispatchOptions {
    now?: number;
    leaseMs?: number;
    /** 心跳周期；0 = 关闭（只用于模拟进程已死亡/测试过期接管）。 */
    heartbeatMs?: number;
    owner?: string;
}
export declare function dispatchTaskCallback(decryptedDir: string, decodedDir: string, triggerId: number, deps: TaskDispatchDeps, options?: TaskDispatchOptions): Promise<TaskCallbackDispatchResult>;
/**
 * 投递一批 `pending` 记录。
 *
 * 只按「记录 pending + 所属任务 ready」捞（**不再按厂商列过滤**）：同一批里最多
 * {@link DISPATCH_CONCURRENCY} 条同时出网。未配置/厂商下线的记录会被 skipped 并写明原因
 * （**落库为 skipped**，否则同一批 pending 会每拍重复占用名额、队头阻塞）。单条失败不连坐
 * （错误只收集前 10 条）；这一批成功写满上限时立刻再捞，最多 {@link DISPATCH_DRAIN_ROUNDS} 轮。
 * @param decryptedDir - 解密数据根。
 * @param decodedDir - 图片解码缓存根。
 * @param deps - 解码 / 隐私闸 / fetch 注入。
 * @param limit - 每一轮最多捞几条（默认 10）。写满且这一轮有成功时会再捞，最多 4 轮。
 * @returns 成功/失败计数与失败原因。
 */
export declare function dispatchPendingTaskCallbacks(decryptedDir: string, decodedDir: string, deps: TaskDispatchDeps, limit?: number): Promise<PendingDispatchResult>;
