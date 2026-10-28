/**
 * `rpa-media.js` 的类型声明（2026-10-23）。
 *
 * 宿主侧 RPA 图片签名直链：验签模块按需动态加载，这里只声明路由与工具函数。
 * **手写**声明（不是构建产物），供 tests 的 tsc 棘轮使用，并在实现改导出时由
 * `host-decl-alignment.spec.ts` 双向比对。
 */

/** 直链路径前缀（与后端 `net/rpa-media.ts` 的常量一致）。 */
export const RPA_MEDIA_PATH_PREFIX: '/api/rpa-media/'

/** 直链路由与 Host 例外名单的依赖。 */
export interface RpaMediaHandlerDeps {
  /** decoded_images 根（未就绪时为空串）。 */
  getDecodedRoot: () => string
  /** 每次现取：`api_token` 与 `rpa_media_base_url`。 */
  getMediaConfig: () => { token: string; mediaBaseUrl?: string }
}

/** 响应对象的最小形状（只用到 writeHead/end）。 */
export interface RpaMediaResponse {
  writeHead: (status: number, headers?: Record<string, string | number>) => unknown
  end: (body?: unknown) => unknown
}

/** 宿主侧处理器。 */
export interface RpaMediaHandler {
  /** 处理 `GET /api/rpa-media/<token>`；失败一律 404。 */
  handleRpaMedia: (res: RpaMediaResponse, token: string) => Promise<void>
  /** Host 校验的额外允许主机名（本机 IPv4 + 配置的公网入口）。 */
  allowedHosts: () => string[]
}

/** 建一个直链处理器。 */
export function createRpaMediaHandler(
  deps: RpaMediaHandlerDeps,
  options?: { loadTokenModule?: () => Promise<unknown> },
): RpaMediaHandler

/** 本机非 internal 的 IPv4 地址（不排序）。 */
export function localIPv4Addresses(): string[]

/** 从配置的基址取小写主机名；空/非 http(s) 返回空串。 */
export function hostnameOfBaseUrl(baseUrl: string): string
