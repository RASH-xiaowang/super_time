/**
 * `query/export.ts` 的「导出流程：会话/朋友圈/全量导出、年度报告、聊天记录媒体」部分（M21 拆分）。
 *
 * 从 `export.ts` 原样搬出，**行为逐字节不变**；`export.ts` 继续以 `export *` 转发
 * ⇒ 所有 `from './export.ts'` 的导入一行都不用改。
 *
 * @module export-flows
 */
import type { StreamControl } from './zip.ts';
import type { WechatMessage } from '../types.ts';
/** Collect merged chat-log media metadata for the ZIP manifest. */
export declare function collectChatlogMedia(msgs: WechatMessage[]): Array<Record<string, unknown>>;
/** Filter by message types and/or rich sub-types (empty lists = keep all). */
export declare function filterMessages(msgs: WechatMessage[], types?: number[], richTypes?: string[]): WechatMessage[];
/**
 * Export a conversation messages to a file under the exports dir (or dir).
 * @param decryptedDir - decrypted data root.
 * @param username - conversation username.
 * @param format - txt | csv | excel | html | md | sql | json.
 * @param count - 0 = all (max 50000), else up to count.
 * @param dir - optional output directory (default <decrypted>.parent()/exports).
 * @param types - optional message type numbers filter (empty = keep all).
 * @param richTypes - optional rich sub-type filter (appmsg link/transfer/...).
 * @param from - optional start timestamp (inclusive).
 * @param to - optional end timestamp (inclusive).
 * @param filename - optional output file basename.
 * @param zip - 把结果再包一层 zip（附 record_media.json）。
 * @param ctrl - 可选的进度/取消（收集阶段逐页检查取消；取消后不写任何文件）。
 * @returns the written file path, filename and message count.
 */
/** Sanitize a user-supplied file basename (no separators / invalid chars). */
export declare function sanitizeBasename(name: string): string;
/** 单会话导出的「计划」：收集 + 过滤 + 算出所有输出名（同步/流式两条入口共用）。 */
export interface SessionExportPlan {
    msgs: WechatMessage[];
    format: string;
    isXlsx: boolean;
    /** 内容本体用的扩展名（zip 时是内层文件的后缀）。 */
    ext: string;
    innerName: string;
    filenameOut: string;
    outPath: string;
    now: string;
}
/**
 * 算出一次单会话导出要做什么（收集消息、过滤、命名）。
 *
 * 抽出来是为了让同步入口（`exportSessionMessages`，现有 RPC 的同步返回不能动）
 * 与流式入口（`exportSessionMessagesStreamed`）**不会各自漂移出不同的文件名/条数**。
 */
export declare function planSessionExport(decryptedDir: string, username: string, format: string, count: number | undefined, dir: string | undefined, types: number[] | undefined, richTypes: string[] | undefined, from: number | undefined, to: number | undefined, filename: string | undefined, zip: boolean | undefined, ctrl?: StreamControl): SessionExportPlan;
/** 非 xlsx 格式的文本主体（同步/流式入口共用）。 */
export declare function formatTextBody(format: string, msgs: WechatMessage[], username: string, now: string): string;
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
/** 安全字符串化。 */
export declare function strOf(v: unknown): string;
/** 百分比字符串。 */
export declare function pctOf(v: unknown): string;
/** 取榜单数组的前 N 项（转成简单对象）。 */
export declare function topOf(arr: unknown, limit?: number): Array<{
    username: string;
    name: string;
    count: number;
}>;
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
