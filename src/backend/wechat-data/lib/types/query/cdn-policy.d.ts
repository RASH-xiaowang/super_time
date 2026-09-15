/**
 * 「自动获取原图（CDN）」与「原图解密方式」两个开关的判定（N24）。
 *
 * ## 背景
 *
 * 这两个开关（`cdn_enabled` / `cdn_local_decrypt`）此前**只有界面与存储、没有任何消费者**：
 * 界面上写着「自动获取原图（CDN）· 已开启/已关闭」，用户关掉后以为不再出网，而实际取图路径
 * 一个都没读它。既误导用户，也让隐私声明没法如实写。
 *
 * ## 语义（与界面文案一一对应）
 *
 * - `cdn_enabled === false` → **不发任何远端请求**，只用本机缓存；被拦下的调用返回
 *   {@link CDN_DISABLED_MESSAGE}，界面能显示成「为什么没有图」而不是无提示地转圈。
 * - `cdn_local_decrypt === false`（界面上的「服务端解密」）→ 远端取回的字节**不做本地解密**，
 *   直接按明文用；若取回的其实是加密流，会给出一条说明该开关的错，而不是「解密失败」这种
 *   与病因无关的提示。
 *
 * 两者默认都**允许**（`undefined` ≠ 关闭）：与 `query/config.ts` 里 `cdn_enabled: true` /
 * `cdn_local_decrypt: true` 的默认值一致，也保证既有调用方（未传 opts）行为不变。
 *
 * 判定放在这一处而不是各取图模块里各写一份：三个模块 + 网关都要用，语义必须只有一处口径。
 *
 * @module cdn-policy
 */
/** 被 `cdn_enabled` 拦下时的统一文案（界面直接显示给用户）。 */
export declare const CDN_DISABLED_MESSAGE = "\u5DF2\u5173\u95ED\u300C\u81EA\u52A8\u83B7\u53D6\u539F\u56FE\uFF08CDN\uFF09\u300D\uFF1A\u53EA\u4F7F\u7528\u672C\u673A\u7F13\u5B58\uFF0C\u672A\u53D1\u8D77\u7F51\u7EDC\u8BF7\u6C42\u3002\u53EF\u5728\u300C\u8BBE\u7F6E \u2192 \u56FE\u7247\u89E3\u7801\u300D\u4E2D\u91CD\u65B0\u5F00\u542F\u3002";
/** 关闭「本地解密」（即选择「服务端解密」）但远端给的仍是加密流时的说明。 */
export declare const LOCAL_DECRYPT_DISABLED_MESSAGE = "\u5F53\u524D\u4E3A\u300C\u670D\u52A1\u7AEF\u89E3\u5BC6\u300D\uFF0C\u4F46\u8FDC\u7AEF\u8FD4\u56DE\u7684\u662F\u52A0\u5BC6\u6D41\u3001\u65E0\u6CD5\u76F4\u63A5\u7528\uFF1B\u8BF7\u6539\u56DE\u300C\u672C\u5730\u89E3\u5BC6\u300D\u3002";
/**
 * 是否允许发起远端取回。
 * @param opts - 取图路径的选项（`cdnEnabled` 来自 `cdn_enabled`）。
 * @returns false 表示已被用户关闭，调用方必须**在发请求之前**返回。
 */
export declare function cdnFetchAllowed(opts?: {
    cdnEnabled?: boolean;
}): boolean;
/**
 * 是否对远端取回的字节做本地解密。
 * @param opts - 取图路径的选项（`localDecrypt` 来自 `cdn_local_decrypt`）。
 * @returns false 表示用户选择了「服务端解密」。
 */
export declare function localDecryptEnabled(opts?: {
    localDecrypt?: boolean;
}): boolean;
