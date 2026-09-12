interface FileItem {
    md5: string;
    fileName: string;
    fileSize: number;
    modifyTime: number;
    category: string;
    /** Source chat display name resolved from message resource, when available. */
    sessionName?: string;
    /** Source message create time, when available. */
    sourceTime?: number;
}
/**
 * Read resource files.
 * @param decryptedDir - decrypted data root.
 * @param limit - max rows per category.
 * @returns the files snapshot.
 */
export declare function queryFiles(decryptedDir: string, limit?: number, offset?: number): {
    files: FileItem[];
    total: number;
};
export {};
//# sourceMappingURL=files.d.ts.map