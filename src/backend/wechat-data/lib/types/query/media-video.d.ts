/**
 * Resolve one video message: MD5 from packed_info_data + a decodable cover
 * thumbnail from the decoded image cache.
 * @param decryptedDir - decrypted data root.
 * @param decodedDir - decoded image cache root.
 * @param username - conversation username.
 * @param localId - message local id.
 * @returns cover data URL (jpg) when available, else an error description.
 */
export declare function resolveVideoInfo(decryptedDir: string, decodedDir: string, username: string, localId: number): {
    available: boolean;
    md5?: string;
    coverUrl?: string;
    error?: string;
};
//# sourceMappingURL=media-video.d.ts.map