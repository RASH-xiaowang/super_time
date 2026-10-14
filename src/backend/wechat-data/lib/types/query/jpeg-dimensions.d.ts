/**
 * 从 JPEG 字节里读宽高（SOF 段）。
 *
 * 为什么自己解析而不是调 `wxam_dec_getWXGFInfo_5`：那个导出的签名没验证过，
 * 调错会崩进程；而 JPEG 的 SOF 扫描是纯 JS、可单测、失败也只是返回 null。
 * @param bytes - JPEG 字节。
 * @returns 宽高，或数据不是可解析的 JPEG 时为 null。
 */
export declare function jpegDimensions(bytes: Uint8Array): {
    width: number;
    height: number;
} | null;
