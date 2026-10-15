/**
 * 「本机 index 里有没有这张图」的探测函数（A4，2026-09-28 性能修复）。
 *
 * 由调用方注入而不是这里 import：`article-cover.ts` 不认识微信目录/AES 密钥，
 * 而 `moments-media.ts` 两边都有。返回非空字符串表示**本机确实有**（值本身只用于日志）。
 */
export type LocalCoverProbe = (contentUrl: string) => Promise<string | undefined>;
/**
 * Resolve a 公众号 article cover to a base64 data URL（本地缓存优先，再走网络并落盘）。
 * @param contentUrl - mp.weixin.qq.com article URL from the moments XML.
 * @param cacheDir - persistent cache directory (decoded_images), optional.
 * @param localCover - A4 本机封面探测（见 {@link LocalCoverProbe}）；省略时行为与加它之前一致。
 * @returns ImageDataUrlResult-like result.
 */
export declare function resolveArticleCoverDataUrl(contentUrl: string, cacheDir?: string, localCover?: LocalCoverProbe): Promise<{
    url?: string;
    error?: string;
}>;
/**
 * 批量解析封面（A1，2026-09-28 性能修复）。
 *
 * ## 为什么需要它
 *
 * 现场日志里 `getArticleCover` 是**最高频的慢**：1221 次（占全部慢调用 73.6%）、均 1920ms。
 * 原因是前端逐个发单张 RPC（`moments-media.ts` 的 `for (const url of todo)`），一屏 30 篇
 * 就是 30 个 RPC × 每个 2 次网络往返（抓 HTML + 抓图），且**全部排在同一个同步后端队列里**。
 *
 * 批量版把 N 个 RPC 收成 1 个，并在后端按 {@link COVER_CONCURRENCY} 分批并发；
 * 每批之间让出（{@link yieldToLoop}），不独占事件循环。
 * @param urls - 待解析的文章链接（去重；空格/空串忽略）。
 * @param cacheDir - 解码缓存根（落盘位置）。
 * @param localCover - A4 本机封面探测（见 {@link LocalCoverProbe}）。
 */
export declare function resolveArticleCoversDataUrls(urls: readonly string[], cacheDir?: string, localCover?: LocalCoverProbe): Promise<Array<{
    url: string;
    dataUrl?: string;
    error?: string;
}>>;
