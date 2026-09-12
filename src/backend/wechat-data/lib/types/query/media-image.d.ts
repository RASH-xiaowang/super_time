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
//# sourceMappingURL=media-image.d.ts.map