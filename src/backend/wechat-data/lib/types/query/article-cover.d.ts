/**
 * Resolve a 公众号 article cover to a base64 data URL（本地缓存优先，再走网络并落盘）。
 * @param contentUrl - mp.weixin.qq.com article URL from the moments XML.
 * @param cacheDir - persistent cache directory (decoded_images), optional.
 * @param opts - `cdnEnabled`：关闭「自动获取原图（CDN）」时**不发起请求**（N24）。缓存仍可用。
 * @returns ImageDataUrlResult-like result.
 */
export declare function resolveArticleCoverDataUrl(contentUrl: string, cacheDir?: string, opts?: {
    cdnEnabled?: boolean;
}): Promise<{
    url?: string;
    error?: string;
}>;
