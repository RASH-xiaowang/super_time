import type { StreamControl } from './zip.ts';
/**
 * 把「一行一条记录」的流写成 .xlsx 文件（流式，峰值与行数无关）。
 *
 * 供大数据量导出使用：sheet XML 逐块产出 → `ZipFileWriter.addStream` 流式 deflate
 * → temp + rename 原子落地。取消/失败都不留半成品。
 *
 * @param filePath - 目标路径。
 * @param rows - 行源（含表头；同步或异步迭代器）。
 * @param ctrl - 可选的进度/取消。
 */
export declare function writeXlsxStream(filePath: string, rows: Iterable<string[]> | AsyncIterable<string[]>, ctrl?: StreamControl): Promise<void>;
export declare function exportSessionMessages(decryptedDir: string, username: string, format: string, count?: number, dir?: string, types?: number[], richTypes?: string[], from?: number, to?: number, filename?: string, zip?: boolean, ctrl?: StreamControl): {
    path: string;
    filename: string;
    count: number;
};
/**
 * `exportSessionMessages` 的流式版：同一份输入产出**同样内容**的文件，但
 * ① xlsx 的 sheet 逐块流式压缩（峰值与行数无关）；② 带进度/取消。
 *
 * 为什么不直接改同步版：`gateway.exportSessionMessages` 是同步返回的现有 RPC 契约
 * （`gateway.ts:747` 直接 `return r`），改成 async 会连带改网关；所以这里另开一个
 * 异步入口，由网关侧（下一步）显式切换。
 *
 * @param decryptedDir - decrypted data root.
 * @param options - 与同步入口同样的字段 + `onProgress`/`signal`。
 * @returns 目标路径、文件名与条数。
 */
export declare function exportSessionMessagesStreamed(decryptedDir: string, options: {
    username: string;
    format: string;
    count?: number;
    dir?: string;
    types?: number[];
    richTypes?: string[];
    from?: number;
    to?: number;
    filename?: string;
    zip?: boolean;
} & StreamControl): Promise<{
    path: string;
    filename: string;
    count: number;
}>;
/**
 * Export a data category to CSV under the exports dir.
 * @param decryptedDir - decrypted data root.
 * @param kind - contacts | favorites | records | moments | privacy.
 * @param recordsKind - record category when kind=records.
 * @param dest - 用户在保存对话框里选定的**完整目标路径**。给定时直接写到那里；
 *   未给（例如自动化/旧调用方）则回退到 `<数据根>/exports/<kind>_<时间>.csv`。
 * @param category - kind=contacts 时只导出该分类（与界面页签口径一致）。
 * @returns the written file path, filename and row count.
 */
export declare function exportCsv(decryptedDir: string, kind: string, recordsKind?: string, dest?: string, category?: string): {
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
 * @param opts - format/username/from/to/dir/filename + 可选的 onProgress/signal。
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
} & StreamControl): Promise<{
    path: string;
    filename: string;
    count: number;
}>;
/**
 * Export ALL sessions as a single txt ZIP archive (账号归档).
 * @param decryptedDir - decrypted data root.
 * @param opts - optional dir/filename + 可选的 onProgress/signal（逐会话上报、可取消）。
 * @returns written zip path + filename + total messages.
 */
export declare function exportAllSessions(decryptedDir: string, opts?: {
    dir?: string;
    filename?: string;
} & StreamControl): Promise<{
    path: string;
    filename: string;
    count: number;
}>;
