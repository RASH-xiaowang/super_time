/**
 * Resolve a 公众号 article cover to a base64 data URL（本地缓存优先，再走网络并落盘）。
 * @param contentUrl - mp.weixin.qq.com article URL from the moments XML.
 * @param cacheDir - persistent cache directory (decoded_images), optional.
 * @returns ImageDataUrlResult-like result.
 */
export declare function resolveArticleCoverDataUrl(contentUrl: string, cacheDir?: string): Promise<{
    url?: string;
    error?: string;
}>;
//# sourceMappingURL=article-cover.d.ts.map