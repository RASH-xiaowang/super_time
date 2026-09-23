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
 * @param rawUrl - 消息里的图片地址；只有 https 且主机在微信 CDN 清单内才会被请求。
 * @param decodedDir - 解码缓存根（`<数据根>/decoded_images`）。
 * @param opts - `cdnEnabled` 来自界面上的「自动获取原图（CDN）」开关。
 */
export declare function fetchRemoteImage(rawUrl: string, decodedDir: string, opts?: {
    cdnEnabled?: boolean;
}): Promise<RemoteImageResult>;
/**
 * 批量取图（一屏卡片或朋友圈一次问完，避免每张一个 RPC）。
 * @param urls - 待取地址；去重后最多 {@link MAX_IMAGES_PER_CALL} 张，超出的直接回错误。
 * @param decodedDir - 解码缓存根。
 * @param opts - CDN 开关。
 */
export declare function fetchRemoteImages(urls: readonly string[], decodedDir: string, opts?: {
    cdnEnabled?: boolean;
}): Promise<RemoteImageResult[]>;
