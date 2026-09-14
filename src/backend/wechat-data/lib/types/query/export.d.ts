export declare function exportSessionMessages(decryptedDir: string, username: string, format: string, count?: number, dir?: string, types?: number[], richTypes?: string[], from?: number, to?: number, filename?: string, zip?: boolean): {
    path: string;
    filename: string;
    count: number;
};
/**
 * Export a data category to CSV under the exports dir.
 * @param decryptedDir - decrypted data root.
 * @param kind - contacts | favorites | records | moments.
 * @param recordsKind - record category when kind=records.
 * @returns the written file path, filename and row count.
 */
export declare function exportCsv(decryptedDir: string, kind: string, recordsKind?: string): {
    path: string;
    filename: string;
    count: number;
};
/**
 * Export the annual report as markdown / html / json.
 * @param decryptedDir - decrypted data root.
 * @param year - report year.
 * @param format - md | html | json.
 * @param dir - optional target directory (default exports dir).
 * @param filename - optional file name (without extension).
 * @returns written file path + filename + message count.
 */
export declare function exportAnnualReport(decryptedDir: string, year: number, format: string, dir?: string, filename?: string): {
    path: string;
    filename: string;
    count: number;
};
/**
 * Export moments (朋友圈) as txt / html / json / csv with optional
 * author + time-range filters.
 * @param decryptedDir - decrypted data root.
 * @param opts - format/username/from/to/dir/filename.
 * @returns written file path + filename + count.
 */
export declare function exportMoments(decryptedDir: string, opts?: {
    format?: string;
    username?: string;
    authorName?: string;
    q?: string;
    images?: boolean;
    media?: string;
    month?: string;
    mine?: string;
    zip?: boolean;
    from?: number;
    to?: number;
    dir?: string;
    filename?: string;
}): Promise<{
    path: string;
    filename: string;
    count: number;
}>;
/**
 * Export ALL sessions as a single txt ZIP archive (账号归档).
 * @param decryptedDir - decrypted data root.
 * @param opts - optional dir/filename.
 * @returns written zip path + filename + total messages.
 */
export declare function exportAllSessions(decryptedDir: string, opts?: {
    dir?: string;
    filename?: string;
}): Promise<{
    path: string;
    filename: string;
    count: number;
}>;
