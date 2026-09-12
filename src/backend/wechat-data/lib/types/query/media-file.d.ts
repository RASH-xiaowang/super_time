/**
 * Resolve a received message file to a base64 data URL from msg/file.
 * @param wechatBaseDir - raw WeChat install dir (current account root).
 * @param fileName - original file name (e.g. 测试报告.pdf).
 * @returns ImageDataUrlResult-like result.
 */
export declare function resolveMessageFileDataUrl(wechatBaseDir: string | undefined, fileName: string): {
    url?: string;
    error?: string;
};
//# sourceMappingURL=media-file.d.ts.map