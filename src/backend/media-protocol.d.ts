/**
 * `media-protocol.js` 的类型声明（2026-10-18）。
 *
 * 实现故意保持纯 CJS 常量/函数（main 进程 require、测试直接 import），
 * 这里只补最小类型给 tests 的 tsc 棘轮用。
 */

/** 协议名（与渲染层 `wechat-media.ts` 一致）。 */
export const WECHAT_MEDIA_SCHEME: 'wechat-media'

/** 允许经协议暴露的扩展名 → MIME。 */
export const MIME_BY_EXT: Readonly<Record<string, string>>

/** 解析 `wechat-media://decoded/<rel>`；非法形状返回 null。 */
export function parseDecodedUrl(rawUrl: string): string | null

/** 把 decoded 根的相对路径解析成允许读取的真实文件；越界/非图片/不存在返回 null。 */
export function resolveDecodedFile(root: string, rel: string): string | null

/** 解析 `?w=<px>` 缩略图宽度（64–1024 整数）；缺失/非法返回 null（回原图）。 */
export function parseThumbWidth(rawUrl: string): number | null

/** 为一个 `wechat-media://` 请求构造流式响应（200 或 404）。 */
export function mediaResponse(root: string, rawUrl: string): Response
