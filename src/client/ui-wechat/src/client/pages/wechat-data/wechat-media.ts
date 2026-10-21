/**
 * `wechat-media://` 的渲染层 URL 构造（2026-10-18）。
 *
 * 后端现在会在图片结果里带 `file`（相对 `decoded_images` 的路径，如 `wxid_x/ab12.jpg`）。
 * 渲染层把它拼成自定义协议 URL 交给 `<img src>`：Chromium 按需向 main 请求、main 流式返回
 * 磁盘文件，于是 base64 不再经过 IPC，也不进图片内存缓存（缓存里只剩几十字节的 URL）。
 *
 * 为什么单独一个模块：路径编码/越界段过滤/回退语义要可单测，且 api 层（1900 行）不该再长。
 */

/** 与 main 进程 `src/backend/media-protocol.js` 保持一致。 */
export const WECHAT_MEDIA_SCHEME = 'wechat-media'

/**
 * 把 decoded_images 下的相对路径转成可渲染的 URL。
 * @param relPath - 后端返回的 `file`（`/` 或 `\` 分隔）；空值得到空串（调用方应回退）。
 * @returns `wechat-media://decoded/<逐段编码>`。
 */
export function wechatMediaUrl(relPath: string): string {
  const rel = String(relPath ?? '').replace(/\\/g, '/').replace(/^\/+/, '')
  const segments = rel.split('/').filter((seg) => seg !== '' && seg !== '.' && seg !== '..')
  if (segments.length === 0) return ''
  return WECHAT_MEDIA_SCHEME + '://decoded/' + segments.map((seg) => encodeURIComponent(seg)).join('/')
}

/**
 * 浏览器端同一张图的 HTTP 地址（2026-10-19）。
 *
 * `wechat-media://` 是 Electron 的自定义协议，浏览器没有注册它 ⇒ `<img>` 直接裂图。
 * 交接态改为同源 `/api/media/decoded/<rel>`，由后端用同一套 decoded 根校验流式返回。
 * @param relPath - 后端返回的相对 decoded_images 路径。
 * @returns `/api/media/decoded/...`；空路径返回空串。
 */
export function wechatMediaHttpUrl(relPath: string): string {
  const protocolUrl = wechatMediaUrl(relPath)
  if (protocolUrl === '') return ''
  return '/api/media/' + protocolUrl.slice(WECHAT_MEDIA_SCHEME.length + 3)
}

/** 当前渲染环境是否支持 `wechat-media://`（由调用方按页面协议判定，纯函数不碰宿主）。 */

/**
 * 有落盘路径就优先用可渲染 URL：桌面端走协议、浏览器走 HTTP；否则保留 data URL。
 * 不修改入参对象，返回浅拷贝以便既有 `toEqual` 断言看到新字段。
 * @param row - 含 `file`/`url` 的图片结果。
 * @param useHttp - 浏览器（http/https 页面）没有自定义协议，传 true 走 `/api/media`。
 * @returns 同形状结果，`url` 已替换为可渲染地址。
 */
export function preferMediaUrl<T extends { file?: string; url?: string }>(row: T, useHttp = false): T {
  if (row === null || row === undefined) return row
  if (typeof row.file !== 'string' || row.file === '') return row
  const url = useHttp ? wechatMediaHttpUrl(row.file) : wechatMediaUrl(row.file)
  if (url === '') return row
  return { ...row, url }
}

/**
 * 给协议/HTTP 图片 URL 追加缩略图宽度参数（`?w=320`）。
 *
 * 借鉴 Alpha 的 thumb/full 两档：网格加载 thumb 档（主进程按需缩放并落盘缓存），
 * 灯箱不带这个参数（原图档）。data URL 原样返回（手机端没有协议层）。
 * @param url - `preferMediaUrl` 给出的 URL。
 * @param width - 目标宽度（像素，64–1024）；<=0 返回原 URL。
 * @returns 带 `w` 查询参数的 URL；非法输入原样返回。
 */
export function withThumbWidth(url: string, width: number): string {
  const raw = String(url ?? '')
  if (raw === '' || raw.startsWith('data:')) return raw
  const w = Math.trunc(Number(width))
  if (!Number.isFinite(w) || w <= 0) return raw
  return raw + (raw.includes('?') ? '&' : '?') + 'w=' + String(w)
}
