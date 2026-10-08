/**
 * 隐私闸门的函数形态：remotes 的 ctx 与 LLM 工厂共用同一份签名。
 * @param feature - 审计功能名。
 * @param stats - 本次出站的数据量。
 * @param texts - 即将发出去的文本。
 * @returns 可直接发出去的文本（开启脱敏时是副本）。
 */
export type PrivacyGateFn = (feature: string, stats: {
    sessions: number;
    messages: number;
}, texts: string[]) => string[];
/**
 * 隐私闸门：**所有**出站 LLM 调用都必须先过这里。
 *
 * @param decryptedDir - 已解密数据根。
 * @param feature - 审计里的功能名（ask_wechat / daily_summary / summary_task / period_summary…）。
 * @param stats - 本次出站涉及的数据量（会话数、消息数），写进审计。
 * @param texts - 即将发出去的文本；开启脱敏时返回脱敏后的副本。
 * @returns 可以直接发出去的文本（不脱敏时就是入参本身的内容）。
 */
export declare function privacyGateAt(decryptedDir: string, feature: string, stats: {
    sessions: number;
    messages: number;
}, texts: string[]): string[];
