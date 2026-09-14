/**
 * Read the WeChat configuration summary (without secrets).
 * @param decryptedDir - decrypted data root.
 * @returns the config summary.
 */
export declare function queryWechatConfig(decryptedDir: string): Record<string, unknown>;
