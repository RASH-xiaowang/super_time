/**
 * Summarize the decrypted DB directories as status lines (cached ~5s).
 * @param decryptedDir - decrypted data root.
 * @returns status lines plus the resolved path.
 */
export declare function getDbStatus(decryptedDir: string): {
    lines: string[];
    path: string;
};
