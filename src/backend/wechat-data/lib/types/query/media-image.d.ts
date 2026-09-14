/**
 * Extract the 32-char hex image MD5 from a packed_info protobuf value.
 * Accepts a raw BLOB, or the st_control comma-separated byte-list TEXT form.
 * @param value - packed_info cell value (BLOB or comma-separated byte-list TEXT).
 * @returns the 32-char hex image MD5, or null when none is found.
 */
export declare function extractMd5FromPacked(value: unknown): string | null;
/**
 * Resolve image MD5 + MessageResourceDetail.data_index for (username, local_id):
 * message shard packed_info_data first, then message_resource.db
 * (ChatName2Id -> MessageResourceInfo -> MessageResourceDetail).
 * @param decryptedDir - decrypted data root.
 * @param username - conversation username.
 * @param localId - message local id.
 * @returns the 32-char hex image MD5 (or null) and the detail data_index hint.
 */
export declare function resolveImageResourceHint(decryptedDir: string, username: string, localId: number): {
    md5: string | null;
    dataIndex: string;
};
/**
 * Resolve the image MD5 for (username, local_id).
 * @param decryptedDir - decrypted data root.
 * @param username - conversation username.
 * @param localId - message local id.
 * @returns the 32-char hex image MD5, or null when not found.
 */
export declare function resolveImageMd5(decryptedDir: string, username: string, localId: number): string | null;
/**
 * Detect an image format from a decrypted header.
 * @param header - leading bytes of the (decrypted) image.
 * @returns the format name ('png' / 'jpg' / 'gif' / ...), or 'bin' when unknown.
 */
export declare function detectImageFormat(header: Uint8Array): string;
/**
 * Detect a single-byte XOR key by matching image magic bytes.
 * @param data - raw .dat bytes.
 * @returns the XOR key byte, or null when no magic matches.
 */
export declare function detectXorKey(data: Uint8Array): number | null;
/**
 * Decode raw .dat bytes (XOR / V1 / V2).
 * @param data - raw .dat file bytes.
 * @param aesKey - V2 AES key (raw bytes), optional.
 * @param xorKey - XOR key byte for the XOR tail.
 * @returns decrypted bytes + format, or an error description.
 */
export declare function decodeDatBytes(data: Uint8Array, aesKey: Uint8Array | string | null, xorKey: number): {
    bytes: Uint8Array;
    format: string;
} | {
    error: string;
};
/**
 * Resolve and decode a message image to a base64 data URL.
 * @param decryptedDir - decrypted data root.
 * @param decodedDir - decoded image cache root (data/wechat/decoded_images).
 * @param username - conversation username.
 * @param localId - message local id.
 * @param wechatBaseDir - optional raw WeChat install dir for .dat fallback.
 * @param aesKey - optional V2 AES key (16-char ASCII string or raw bytes).
 * @param xorKey - XOR key byte, defaults to 0xFF.
 * @returns data URL + format, or an error description.
 */
export declare function decodeImageDataUrl(decryptedDir: string, decodedDir: string, username: string, localId: number, wechatBaseDir?: string, aesKey?: string | Uint8Array, xorKey?: number): {
    url?: string;
    format?: string;
    error?: string;
};
/**
 * Resolve a file-library image (hardlink_info md5) from the decoded cache only.
 * 只读取已解密 JPG（decoded_images/<md5>.jpg|.jpeg），不做任何 .dat 解密，
 * 未命中直接报错，前端保持占位图标。
 */
export declare function decodeFileImageDataUrl(decryptedDir: string, decodedDir: string, wechatBaseDir: string | undefined, md5: string | undefined, aesKey?: string | Uint8Array, xorKey?: number): {
    url?: string;
    error?: string;
};
/**
 * Resolve a custom emoticon (sticker) md5 to a base64 data URL.
 *
 * 自定义表情文件不在会话消息目录下，而是散落在 `msg/attach/<hash>/<YYYY-MM>/Img/<md5>.dat`
 * （同一条表情可能被多个会话各缓存一份）。策略：
 *  1. 先读 `decoded_images/<md5>.<ext>`（批量解密/上次解码缓存）；
 *  2. 再扫 `msg/attach` 找 `<md5>.dat` / `<md5>_t.dat`，优先缩略图（小、可渲染）；
 *  3. 解码成功后写回 decoded 缓存，避免重复全量扫描。
 * @param decryptedDir - decrypted data root（仅用于缓存路径约定）。
 * @param decodedDir - decoded image cache root.
 * @param wechatBaseDir - raw WeChat account root (contains msg/attach).
 * @param md5 - emoticon md5 from message XML.
 * @param aesKey - V2 AES key.
 * @param xorKey - XOR key byte.
 * @returns data URL or error.
 */
export declare function decodeEmoticonDataUrl(decryptedDir: string, decodedDir: string, wechatBaseDir: string | undefined, md5: string | undefined, aesKey?: string | Uint8Array, xorKey?: number): {
    url?: string;
    format?: string;
    error?: string;
};
/**
 * 远端取一张自定义表情并落进 decoded 缓存（本地缓存解不开时的兜底）。
 *
 * 为什么需要：微信把表情图放在 `business/emoticon/*` 与 `cache/<月>/Emoticon/*`，
 * 那些文件是**加密**的（16 字节对齐；单字节 XOR、配置里的 image_aes_key、
 * 消息里的 aeskey 都试过解不开，见 `output/probe-sticker-crypt*.mjs`）。
 * 而消息 XML 里的 `cdnurl` 提供的是**未加密**的那一份：实测
 * （`output/probe-sticker-cdn2.mjs`）去掉 `&amp;` 转义后 6/6 返回 200 与明文
 * GIF/PNG/JPEG，体积与消息里的 `len` 逐字节一致。
 *
 * 取到后按 `<decoded>/<md5>.<ext>` 落盘，于是**下次（含离线）就走本地解码路径**，
 * 网络只花一次。失败一律返回 error，界面退回占位芯片。
 * @param url - the sticker CDN url from the message XML (`<emoji cdnurl>`).
 * @param decodedDir - decoded cache dir.
 * @param md5 - sticker md5 (used as the cache file name).
 * @returns a data URL + format, or an error message.
 */
export declare function fetchEmoticonRemote(url: string, decodedDir: string, md5: string): Promise<{
    url?: string;
    format?: string;
    error?: string;
}>;
/**
 * Resolve an image's on-disk .dat path via the decrypted hardlink.db:
 * image_hardlink_info_v4 is queried by md5 (and by MessageResourceDetail
 * data_index rowid when given), then dir1/dir2 are mapped through dir2id to
 * the real msg/attach directory names. Returns the first existing path.
 * @param decryptedDir - decrypted data root.
 * @param wechatBaseDir - raw WeChat install dir (current account root).
 * @param md5 - 32-char image md5 (optional when dataIndex is given).
 * @param dataIndex - MessageResourceDetail.data_index (rowid hint, optional).
 * @returns absolute .dat path, or null when not resolvable.
 */
export declare function resolveImageFilePath(decryptedDir: string, wechatBaseDir: string, md5?: string, dataIndex?: string): string | null;
