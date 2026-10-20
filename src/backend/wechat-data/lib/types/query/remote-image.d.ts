/**
 * 一次批量最多几张（C2，2026-09-28 性能修复：40 → 20）。
 *
 * 现场日志 `getRemoteImages` 127 次 / 均 14s / 峰值 86.5s，与「最坏 40 张 ÷ 6 并发 × 12s 超时 ≈ 80s」
 * 吻合 —— 单次请求要背 40 张的**最坏超时**，任何一张慢就把整批拖到分钟级。降到 20 后最坏值砍半，
 * 而调用方（`drainMedia` 的 `MEDIA_BATCH`，2026-10-16 起为 4）本来就在分批，单次 20 张仍有 5 批余量。
 */
export declare const MAX_IMAGES_PER_CALL = 20;
/**
 * 同时在途的请求数（C2：6 → 10）。
 * 6 是为了避开 CDN 对突发并发回 400 而定的；但一屏几十张时 6 并发太窄。
 * 10 仍远低于「一次性全发」（后者才是 400 的诱因），是并发与友好度之间的折中。
 */
export declare const FETCH_CONCURRENCY = 10;
/** 缓存子目录名（导出给清理与测试用口径）。 */
export declare const REMOTE_IMAGE_CACHE_DIRNAME = "remote-images";
export interface RemoteImageResult {
    /** 请求的那个地址（批量结果里用它当键回给调用方）。 */
    url: string;
    /** 取回 / 缓存命中后的 data URL；失败时没有。 */
    dataUrl?: string;
    /** 这次是否直接从本机缓存拿到的（审计与「关掉开关后还出不出网」的断言都用它）。 */
    fromCache?: boolean;
    /** 给用户看的原因（开关关闭 / 主机不在清单 / 不是可渲染的图片…）。 */
    error?: string;
}
/**
 * 取一张远程图片（缓存优先，未命中才出网）。
 * @param rawUrl - 消息里的图片地址；http(s) 且主机在微信 CDN 清单内才会被请求。
 * @param decodedDir - 解码缓存根（`<数据根>/decoded_images`）。
 * @param opts - `cacheIndex`：可选的缓存索引快照（缺省时本函数自己建）。
 */
export declare function fetchRemoteImage(rawUrl: string, decodedDir: string, opts?: {
    cacheIndex?: ReadonlyMap<string, string>;
}): Promise<RemoteImageResult>;
/**
 * 批量取图（一屏卡片或朋友圈一次问完，避免每张一个 RPC）。
 * @param urls - 待取地址；去重后最多 {@link MAX_IMAGES_PER_CALL} 张，超出的直接回错误。
 * @param decodedDir - 解码缓存根。
 */
export declare function fetchRemoteImages(urls: readonly string[], decodedDir: string): Promise<RemoteImageResult[]>;
