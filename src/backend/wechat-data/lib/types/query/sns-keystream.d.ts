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
