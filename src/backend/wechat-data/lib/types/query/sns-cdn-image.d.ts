export interface SnsCdnImageResult {
    dataUrl?: string;
    error?: string;
}
/**
 * 从 CDN 取一张朋友圈图片并解密成 data URL。
 *
 * @param rawUrl - 库里存的媒体地址（`http://mmsns.qpic.cn/.../0` 或 `/150`）。
 * @param token - 媒体标签上的 `token` 属性。
 * @param seed - 媒体 XML 里 `<enc key="…">` 的解密种子。
 * @param fetchImpl - 取数实现（默认全局 `fetch`；测试注入用）。
 * @returns `{ dataUrl }` 或 `{ error }`。
 */
export declare function fetchSnsCdnImage(rawUrl: string, token: string | undefined, seed: string | undefined, fetchImpl?: typeof fetch): Promise<SnsCdnImageResult>;
