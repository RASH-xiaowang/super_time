import type { RpaVendorAdapter } from '../types.ts';
/** RFC3986 编码（阿里云签名规定）：`A-Za-z0-9-_.~` 不编码，空格 → `%20`。 */
export declare function percentEncode(value: string): string;
/**
 * 规范化查询串：参数按 key 字典序排序，逐项 `percentEncode(k)=percentEncode(v)` 用 `&` 连接。
 * @param params - 参与签名的参数（**不含** Signature）。
 * @returns CanonicalizedQueryString。
 */
export declare function canonicalizedQuery(params: Record<string, string>): string;
/**
 * 计算阿里云 RPC 签名（HMAC-SHA1 + Base64）。
 *
 * 步骤（官方「HTTP 调用说明」）：CanonicalizedQueryString → `StringToSign =
 * HTTPMethod&percentEncode("/")&percentEncode(canonical)` → `Base64(HMAC-SHA1(AccessKeySecret + "&", StringToSign))`。
 * @param params - 参与签名的全部参数（公共参数 + 业务参数，**不含** Signature）。
 * @param accessKeySecret - RPA 控制台系统设置的 AccessKeySecret。
 * @param method - HTTP 方法（官方签名串里是大写，默认 POST）。
 * @returns Base64 签名串。
 */
export declare function aliyunRpcSign(params: Record<string, string>, accessKeySecret: string, method?: string): string;
export declare const adapter: RpaVendorAdapter;
