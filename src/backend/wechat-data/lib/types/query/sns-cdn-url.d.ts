/**
 * 朋友圈 CDN 取图的 URL 构造（**按参考项目 WeChatDataAnalysis 的实测配方**）。
 *
 * ## 为什么需要它（2026-10-08 实测）
 *
 * 微信库里存的媒体地址**直接请求一律 HTTP 400**，实测矩阵：
 *
 * | 请求 | 结果 |
 * |---|---|
 * | `https://…/0` | 400 |
 * | `https://…/0?token=<token>` | 400 |
 * | `https://…/0?token=<token>&idx=1` | **200 · image/jpeg** ✅ |
 * | `https://…/150?token=<token>&idx=1` | 400（缩略图尺寸不给） |
 *
 * 即缺三样：**https**、**尺寸段归一到 `/0`**、**追加 `&idx=1`**。
 * 参考实现见 `WeChatDataAnalysis-main/src/wechat_decrypt_tool/sns_media.py:200-237`。
 *
 * ⚠️ 返回体是 **WxIsaac64 加密**的（实测头四字节 `cb 92 4c bc`，不是 `ff d8`），
 * 必须解密后才能当图片用 —— 本函数只负责把 URL 拼对。
 *
 * @module query/sns-cdn-url
 */
/**
 * 把库里存的媒体地址构造成**能被 CDN 接受**的请求地址。
 *
 * @param rawUrl - 微信库里的地址（通常是 `http://mmsns.qpic.cn/.../0` 或 `.../150`）。
 * @param token - 媒体标签上的 `token` 属性（`<url token="…">` / `<thumb token="…">`）。
 * @returns 可直接请求的 https 地址；非腾讯系主机原样返回。
 */
export declare function snsCdnUrl(rawUrl: string, token: string | undefined): string;
