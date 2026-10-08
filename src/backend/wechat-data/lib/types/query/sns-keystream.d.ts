/** 头这一段是加密的（字节数）。 */
export declare const SNS_HEAD_ENCRYPTED_BYTES = 131072;
/**
 * 生成 WxIsaac64 密钥流。
 * @param seed - 朋友圈 XML 里 `<enc key="NNNN">` 的十进制字符串。
 * @param size - 需要的字节数。
 * @returns 密钥流（长度 = size）。
 */
export declare function wxIsaac64Keystream(seed: string, size: number): Promise<Buffer>;
/**
 * 解密 SNS 媒体的加密头（返回新 Buffer，不改入参）。
 * @param buf - CDN 取回的原始字节。
 * @param seed - `<enc key>` 十进制字符串。
 * @returns 解密后的字节与实际解密的长度。
 */
export declare function decryptSnsHead(buf: Buffer, seed: string): Promise<{
    bytes: Buffer;
    decrypted: number;
}>;
/**
 * 解密 SNS 媒体的**整份**字节。
 *
 * 与 `decryptSnsHead` 的区别（2026-10-08 修）：视频只有前 128 KB 加密，图片是**整文件**加密。
 * 用只解头的版本处理图片会得到「头是 JPEG、尾是密文」的坏文件 —— RPC 成功返回 data URL，
 * 但浏览器渲染失败（实测表现：一屏 9 张全挂，且卡片只能显示默认文案）。
 *
 * @param buf - CDN 取回的原始字节。
 * @param seed - `<enc key>` 十进制字符串。
 * @returns 解密后的字节与实际解密的长度。
 */
export declare function decryptSnsAll(buf: Buffer, seed: string): Promise<{
    bytes: Buffer;
    decrypted: number;
}>;
