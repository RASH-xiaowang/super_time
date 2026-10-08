/**
 * **视频**只有头这一段是加密的（字节数）。
 *
 * ⚠️ 别把它当成 SNS 媒体的通用上限：**图片是整文件加密**（2026-10-08 真机实测 9/9 张，
 * 见 `tests/sns-image-tail-probe.manual.spec.ts`），所以图片走 `decryptSnsAll`。
 * 这个常量只服务于 `decryptSnsHead`（视频链路）。
 */
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
 * 与 `decryptSnsHead` 的区别：**视频**只有前 128 KB 加密，而**图片是整文件加密**
 * （2026-10-08 真机实测 9/9 张：整份解密后都是合法 JPEG，头 `ff d8 ff e0`；
 * 只解头则 9/9 张都缺结束标记）。所以图片必须走这里。
 *
 * ⚠️ 曾经把「一屏 9 张全挂」归因于本函数缺失，那个归因**是错的**：
 * 真正的拦截点是 `sns-cdn-image.ts` 的结尾判据（微信 CDN 在 EOI 之后恒定挂 24 字节签名块，
 * 旧判据要求最后两字节必须是 `ff d9`）。本函数一直是对的。
 *
 * @param buf - CDN 取回的原始字节。
 * @param seed - `<enc key>` 十进制字符串（图片实际取 `<url key>` / `<thumb key>`）。
 * @returns 解密后的字节与实际解密的长度。
 */
export declare function decryptSnsAll(buf: Buffer, seed: string): Promise<{
    bytes: Buffer;
    decrypted: number;
}>;
