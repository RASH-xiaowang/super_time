/**
 * LLM / embedding 请求的有界指数退避重试。
 *
 * 这个模块是 `fetchWithRetry` 的**唯一实现源**。宿主层 `llm-bridge.js` 通过
 * `import('./wechat-data/lib/index.js')` 取同一个导出，后端各 query 模块则直接
 * 从包内导入，不再反向依赖宿主层的 CommonJS 文件（也不再有手写的 `.d.ts`
 * 第二事实源）。
 *
 * 三条边界（有意为之）：
 *   ① 只重试**可重试**的：网络异常、408、429、5xx。401/403/400 这类立刻失败；
 *   ② `Retry-After` 优先（服务端明确要求等多久），但夹在上限内；
 *   ③ 调用方传进来的 `signal` 一旦中止就**立刻停**，不做无谓重试。
 *
 * N13 起它还接管「单次尝试的超时」（`opts.timeoutMs`）：LLM 之外的四条出网点
 * （封面/表情/朋友圈视频/whisper 下载）各自原本只超时一次、失败就整件事失败。
 * 超时必须**由重试层逐次武装**，不能由调用方塞一个 `AbortSignal.timeout()`。
 */
export type TimeoutScope = 'full' | 'headers';
export interface RetryInfo {
    /** 第几次尝试（从 1 开始）。 */
    attempt: number;
    /** 本次退避要等多久。 */
    delayMs: number;
    /** 为什么重试（状态码 / 错误名）。 */
    reason: string;
}
export interface FetchWithRetryOptions {
    /** 最多尝试几次（含第一次）。 */
    maxAttempts?: number;
    /** **单次尝试**的超时毫秒数；每次重新计时。0/省略 = 不计时。 */
    timeoutMs?: number;
    /** 超时的计时范围。 */
    timeoutScope?: TimeoutScope;
    /** 每次重试前的回调（日志/进度用）。 */
    onRetry?: (info: RetryInfo) => void;
    /** 注入等待实现（测试用）。 */
    sleep?: (ms: number) => Promise<void>;
    /** 注入随机源（退避抖动，测试用）。 */
    random?: () => number;
}
/** 真正发请求的那个函数 —— 生产传 `fetch`，测试传桩。 */
export type RetryFetch = (input: string, init?: RequestInit) => Promise<Response>;
/** 可重试的 HTTP 状态：408 超时、429 限流、5xx 服务端问题。 */
export declare const RETRYABLE_STATUS: ReadonlySet<number>;
/** 默认最大尝试次数（含首次）。 */
export declare const DEFAULT_MAX_ATTEMPTS = 3;
/** 退避基数：500ms → 1500ms（×3 递增）。 */
export declare const BASE_DELAY_MS = 500;
/** 单次等待上限：避免 Retry-After 把界面吊住。 */
export declare const MAX_DELAY_MS = 5000;
/** 单次尝试超时耗尽时抛出的错误名（调用方据此区分「对端一直超时」与「用户取消」）。 */
export declare const TIMEOUT_ERROR_NAME = "TimeoutError";
export declare function isRetryableStatus(status: number): boolean;
export declare function parseRetryAfterMs(headerValue: unknown, now?: number): number | null;
export declare function backoffDelayMs(attempt: number, random?: () => number): number;
export declare function fetchWithRetry(doFetch: RetryFetch, url: string, init: RequestInit | undefined, opts?: FetchWithRetryOptions): Promise<Response>;
