/**
 * `query/export.ts` 的「格式化器：文本/CSV/HTML/Markdown/SQL/JSON 与 xlsx 流式写出」部分（M21 拆分）。
 *
 * 从 `export.ts` 原样搬出，**行为逐字节不变**；`export.ts` 继续以 `export *` 转发
 * ⇒ 所有 `from './export.ts'` 的导入一行都不用改。
 *
 * @module export-format
 */
import type { StreamControl } from './zip.ts';
import type { WechatMessage } from '../types.ts';
/** Format a unix timestamp as YYYY-MM-DD HH:MM. */
export declare function fmtFull(ts: number): string;
/**
 * Collect a conversation messages chronologically (oldest first).
 * @param decryptedDir - decrypted data root.
 * @param username - conversation username.
 * @param count - 0 = all (max 50000), else up to count.
 * @param ctrl - 可选的进度/取消（每页检查一次取消）。
 */
export declare function collectMessages(decryptedDir: string, username: string, count: number, ctrl?: StreamControl): WechatMessage[];
/**
 * `collectMessages` 的**让出版**：翻页口径完全相同，只是每 8 页让出一次事件循环。
 *
 * 只给异步入口用（`exportSessionMessagesStreamed` / `exportAllSessions`）—— 同步入口
 * `exportSessionMessages` 的 RPC 契约必须同步返回，改不了。
 * @param decryptedDir - decrypted data root.
 * @param username - conversation username.
 * @param count - 0 = all (max 50000), else up to count.
 * @param ctrl - 可选的进度/取消。
 */
export declare function collectMessagesAsync(decryptedDir: string, username: string, count: number, ctrl?: StreamControl): Promise<WechatMessage[]>;
/** Escape a CSV cell (wrap in quotes, double inner quotes). */
export declare function csvCell(v: string): string;
/**
 * UTF-8 BOM。**所有 CSV 都必须带上它**。
 *
 * 不带的后果（用户实测报障）：文件内容确实是 UTF-8，但 **Excel 在中文 Windows 上
 * 不会自动识别无 BOM 的 UTF-8**，会按系统 ANSI（GBK）去解码，于是中文整片乱码
 * （「用户名」变成「鐢ㄦ埛鍚」这类）。BOM 是 Office 认 UTF-8 的唯一可靠信号，
 * 也是官方推荐做法；记事本/VS Code/`Import-Csv` 都能正确跳过它。
 */
export declare const UTF8_BOM = "\uFEFF";
/**
 * 由「表头 + 数据行」构造 CSV 正文（带 UTF-8 BOM）。
 *
 * 所有 CSV 出口都走这里，避免再出现「某个出口忘了加 BOM」——此前 `formatCsv`
 * 与 `exportCsv` 各写一份、两份都没 BOM，就是这个问题的来源。
 *
 * @param header - 表头各列。
 * @param rows - 数据行（每行长度应与表头一致）。
 * @returns 可直接写盘的完整 CSV 文本（含 BOM）。
 */
export declare function buildCsv(header: readonly string[], rows: ReadonlyArray<readonly string[]>): string;
/** HTML-escape a string. */
export declare function htmlEscape(v: string): string;
/** Render one message row to export columns. */
export declare function rowOf(m: WechatMessage, username: string): {
    time: string;
    sender: string;
    typeLabel: string;
    text: string;
};
/** txt export body. */
export declare function formatTxt(msgs: WechatMessage[], username: string): string;
/** csv export body. */
export declare function formatCsv(msgs: WechatMessage[], username: string): string;
/** html chat-log export body (date dividers + bubbles). */
export declare function formatHtml(msgs: WechatMessage[], username: string, now: string): string;
/** markdown chat-log export body (date dividers + bullets). */
export declare function formatMarkdown(msgs: WechatMessage[], username: string): string;
/** SQL export body (CREATE TABLE + INSERTs). */
export declare function formatSql(msgs: WechatMessage[], username: string): string;
/** JSON export body. */
export declare function formatJson(msgs: WechatMessage[], username: string): string;
/** XML-escape a value for OOXML. */
export declare function xmlEsc(v: string): string;
/** sheet 的头部（`<sheetData>` 之前）—— 内存/流式两条路径必须拼出完全相同的字符串。 */
export declare const XLSX_SHEET_HEAD: string;
/** sheet 的尾部（`</sheetData>` 之后）。 */
export declare const XLSX_SHEET_TAIL = "</sheetData></worksheet>";
/**
 * 一块里放多少行。
 *
 * 块越大压缩率越好、内存上界越大：200 行 ≈ 24KB，10 万行的峰值也就几十 KB 级别，
 * 相对于「整份 sheet（10MB+）」差三个数量级。
 */
export declare const XLSX_CHUNK_ROWS = 200;
/** xlsx 除 sheet1.xml 之外的固定部件（顺序与流式路径一致，避免两条路产物不同）。 */
export declare function xlsxStaticParts(): Array<{
    name: string;
    data: string;
}>;
/** 一行 `<row>` 的 XML（表格内容为空时也保持与改造前一致的结构）。 */
export declare function xlsxRowXml(row: string[]): string;
/**
 * 分块规则：按 `XLSX_CHUNK_ROWS` 行攒一块。
 *
 * 抽出来是为了让「内存版」和「流式版」用同一套规则 —— 否则两条路的产物一旦漂移，
 * 同一份数据经过两个入口导出的 xlsx 就不同了。
 */
export declare function makeXlsxChunker(ctrl: StreamControl | undefined, total: number): {
    push: (row: string[]) => string | null;
    finish: () => string[];
};
/**
 * sheetData 的分块源（同步行源）：内存版走这条，逐块 join 出与改造前相同的字符串。
 * @param rows - 行源（含表头）。
 * @param ctrl - 进度/取消。
 * @param total - 已知总行数（未知传 0，只影响进度展示）。
 */
export declare function xlsxSheetChunks(rows: Iterable<string[]>, ctrl?: StreamControl, total?: number): Generator<string>;
/**
 * sheetData 的分块源（同步/异步行源都可）：流式版走这条。
 *
 * 这是「xlsx 不再随行数涨内存」的关键——改造前是先把所有行变成 `rows` 数组、
 * 再由 `parts.join('')` 拼出整份 sheet，峰值与行数线性（10 万行时同时存在
 * 整份 XML 与所有行数组）。
 */
export declare function xlsxSheetChunksAsync(rows: Iterable<string[]> | AsyncIterable<string[]>, ctrl?: StreamControl, total?: number): AsyncGenerator<string>;
/** 消息 → xlsx 行（含表头）。 */
export declare function messageRows(msgs: WechatMessage[], username: string): Generator<string[]>;
/** 内存版 sheet XML（与流式路径同一套分块规则，保证解出来的字节一致）。 */
export declare function xlsxSheetXml(rows: Iterable<string[]>, ctrl?: StreamControl): string;
/**
 * Minimal real .xlsx (OOXML single sheet, no deps) —— 内存版，保持既有调用点行为不变。
 *
 * 行数不可控（整账号/大会话）时走 `writeXlsxStream`：那才是峰值与行数无关的路径。
 */
export declare function formatXlsx(msgs: WechatMessage[], username: string, ctrl?: StreamControl): Uint8Array;
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
export declare function writeXlsxStream(filePath: string, rows: Iterable<string[]> | AsyncIterable<string[]>, ctrl?: StreamControl, 
/** 行数总量（已知就传）：不传则 'format' 阶段报 total=0，界面只能显示不定量进度。 */
total?: number): Promise<void>;
