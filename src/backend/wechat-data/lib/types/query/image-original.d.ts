/** `resolveImageOriginalLink()` 的结果：一条消息的原图直取信息。 */
export interface ImageOriginalLink {
    /** 缓存键（来自 `packed_info_data`，不是 XML 的 `md5=`）。 */
    md5: string;
    /** 免登录预签名直链（`tphdurl` 优先，其次 `tpurl`）。 */
    url: string;
    /** 直链是否带独立的高清档（有 `tphdurl`）。 */
    hasHd: boolean;
    /** XML 声明的原图字节数（`hdlength` 优先，其次 `length`）；无声明时为 0。 */
    declaredBytes: number;
}
/**
 * 取一条图片消息的免登录原图直链。
 * @param decryptedDir - 解密数据根。
 * @param username - 会话 username。
 * @param localId - 消息 local_id。
 * @returns 直链与元信息；这条消息没有可直取的原图（只有 CDN fileid）时返回 null。
 */
export declare function resolveImageOriginalLink(decryptedDir: string, username: string, localId: number): ImageOriginalLink | null;
/** 取回并落盘一张原图。**不把字节回传给调用方** —— 原图可达十几 MB，base64 走一遍 RPC
 * 既慢又占内存；落盘后由 `getImageDataUrl` 从缓存槽读，界面只需要知道成功与否。 */
export declare function fetchImageOriginalToCache(link: ImageOriginalLink, decodedDir: string, opts?: {
    cdnEnabled?: boolean;
}): Promise<{
    format?: string;
    bytes?: number;
    error?: string;
}>;
