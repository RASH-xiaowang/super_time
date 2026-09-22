/**
 * 隐私库读不到时的统一文案。
 *
 * 「读不到」必须与「没开拦截」区分开：前者拦下并说明原因，后者放行。
 * 2026-09-20 之前两处 catch 都把异常翻译成「放行」，于是一个显式开了
 * 「出站拦截」的用户，在 `wechat_privacy.db` 损坏/被锁的那一刻就开始静默出网。
 */
export declare function privacyStoreUnreadable(feature: string, detail: string): string;
/** Resolved data layout (per gateway instance, so tests can stub env). */
export interface ResolvedDirs {
    /** Decrypted SQLite libraries the queries read. */
    decrypted: string;
    /** Decoded-images cache the media queries write. */
    decoded: string;
}
/**
 * Raw WeChat data base dir (the account root, parent of db_storage): env pin
 * first, then the live config db_dir. Resolved per call — config.json may be
 * bootstrapped or re-pointed after the gateway started, and a startup
 * snapshot would stay empty and leave media resolution dead.
 * @param decrypted - decrypted data root (locates config.json).
 * @returns the account root, or '' when config has no usable db_dir.
 */
export declare function rawWechatBase(decrypted: string): string;
/** Resolve the data layout and run the one-time bootstrap. */
export declare function resolveDirs(): ResolvedDirs;
/**
 * 一个长任务（导出/加密备份）的控制槽（M3）。
 *
 * 为什么不能把 `onProgress` / `AbortSignal` 直接当 RPC 参数传：**两者都过不了 IPC** ——
 * 回调是函数、signal 是宿主对象，序列化时会被丢掉（或被拒）。所以渲染层只带一个自己生成的
 * `jobId`：进度由网关通过 `wechat-export/progress` 事件推出去（与 `wechat-data/updated`、
 * `wechat-ask/delta` 同一种做法），取消走 `cancelExportJob({ jobId })` 唤醒这里的令牌。
 */
export interface StreamJob {
    /** 本轮取消令牌；每次开跑都换新的（否则「取消过一次的 jobId 再也跑不动」）。 */
    ctrl: AbortController;
    /** 最近一次进度；终态也留着，供迟到的轮询读到。 */
    progress: {
        phase: string;
        done: number;
        total: number;
    } | null;
    finished: boolean;
    error?: string;
}
/** 控制槽上限：槽位只服务「正在跑 + 刚跑完」的任务，超出先丢最老的。 */
export declare const STREAM_JOB_CAP = 20;
/** 导出/备份进度事件名（渲染层按 jobId 过滤）。 */
export declare const EXPORT_PROGRESS_EVENT = "wechat-export/progress";
/**
 * 解码缓存的扩展名候选（与 `media-image.ts` 的 `RENDERABLE_EXTS` 同集合）。
 * 只用来判「这张图已经有解码产物了吗」——有就别再解一遍。
 */
export declare const CACHED_IMAGE_EXTS: string[];
/**
 * 规整渲染层传来的 jobId：只当**不透明标识**用（不落盘、不回显），所以限长截断即可。
 * @param jobId - 原始值（可能缺省/非字符串）。
 * @returns 可用的标识；不可用时为空串（＝调用方没打算订阅进度）。
 */
export declare function normalizeJobId(jobId?: unknown): string;
