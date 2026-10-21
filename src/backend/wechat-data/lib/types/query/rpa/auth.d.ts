import type { RpaHttpRequest, RpaHttpResponse, RpaInvocationContext, RpaVendorAdapter } from './types.ts';
/** 换 token 请求的发送函数（由 dispatch.ts 注入它自己的出网函数）。 */
export interface RpaAuthDeps {
    send: (req: RpaHttpRequest) => Promise<RpaHttpResponse>;
}
/** token 缓存项。 */
interface TokenCacheEntry {
    token: string;
    expiresAt: number;
}
/** 清空 token 缓存（测试用：不同用例之间的 mock 响应不能互相污染）。 */
export declare function clearTokenCache(): void;
/**
 * 对已渲染的请求执行描述符声明的鉴权。
 * @param adapter - 厂商适配器。
 * @param req - 已渲染（未鉴权）的请求。
 * @param ctx - 投递上下文（含 config/secrets）。
 * @param deps - 发送函数（换 token 请求用）。
 * @param cache - token 缓存（测试可注入独立 Map）。
 * @returns 鉴权后的请求（不改入参）。
 * @throws 鉴权模式不匹配 / 凭据缺失 / 换 token 失败时抛可读错误。
 */
export declare function applyAuth(adapter: RpaVendorAdapter, req: RpaHttpRequest, ctx: RpaInvocationContext, deps: RpaAuthDeps, cache?: Map<string, TokenCacheEntry>): Promise<RpaHttpRequest>;
export {};
