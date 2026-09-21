/**
 * `kb-files.ts` 的「存储底座：迁移、开库/事务、行→元数据、blob 读写、分块写入」部分（M21 拆分）。
 *
 * 从原模块原样搬出，**行为逐字节不变**；原文件继续以 `export *` 转发
 * ⇒ 所有既有 import 一行都不用改。
 *
 * @module kb-files-store
 */
import { DatabaseSync } from 'node:sqlite';
import type { KbFileMeta, KbFileParseState } from '../types.ts';
export { kbBlobsDir, kbFilesDbPath } from './kb-paths.ts';
/**
 * 单文件字节上限。
 *
 * 32MB：纯文本 32MB 已是千万字级别，远超「一次上传能被读完」的量级；
 * 再大只会线性拉长解析耗时与副本占用，而多出来的内容几乎不可能被检索到。
 * 拒绝发生在**读入之前**（先 `statSync` 看大小），所以超限文件不会先把内存吃掉。
 */
export declare const MAX_FILE_BYTES: number;
/** 单库文件数上限（与设计稿 §12.3 的分页口径一致：分页，不做虚拟滚动）。 */
export declare const MAX_FILES_PER_KB = 5000;
/** 列表默认页大小。 */
export declare const DEFAULT_FILE_PAGE = 200;
/**
 * 崩溃恢复要重置的中间态。
 *
 * 这三个态**物理上不可续跑**：进程没了，解析/分块的中间结果也跟着没了，
 * 没有任何机制能从一半继续。不重置就会永久停在「正在解析」转圈（设计稿 §10 边界 4）。
 */
export declare const INTERRUPTED_STATES: readonly ["parsing", "chunking", "embedding"];
/**
 * 删除一个文件的级联顺序。**唯一真源**：实现按此数组逐条执行，spec 断言数组本身。
 *
 * 顺序不是随意的，两条都是「反了就静默出错」：
 *   · `chunks` 必须早于 `fts` —— FTS 行的 rowid 就是 chunk 的 id，先把 chunk 行删了
 *     就再也问不出该删哪些 rowid（所以这一步会**先取出 id 列表**再删表）；
 *   · `blob` 必须早于 `file` —— 判断「还有没有别的行引用这个 sha256」要趁登记行还在，
 *     删完再问永远是 0，于是**共享的副本会被误删**（另一个库的文件从此读不出内容）。
 */
export declare const KB_FILE_DELETE_ORDER: readonly ["chunks", "fts", "vectors", "blob", "file"];
export type KbFileDeleteStep = (typeof KB_FILE_DELETE_ORDER)[number];
/**
 * 建表 / 建索引 / 加列，全部幂等。
 *
 * `openStore` 每次开库都会走到这里，所以这段必须能跑一百次结果一致 —— 建表一律
 * `IF NOT EXISTS`；加列必须先 `PRAGMA table_info` 查这一列在不在，不在才 `ALTER TABLE`
 * （SQLite 没有 `ADD COLUMN IF NOT EXISTS`，重跑一次就报 duplicate column）。
 * 原来这里写着「不写加列分支（本库是新增的，没有历史版本要兼容）」—— 摘要功能落地之后
 * 那句话已经不成立，已经发出去的库里确实有不含 `summary` 列的 `kb_files`，
 * 所以加列口径改成与 `notes.ts:migrate` 一致。
 */
export declare function migrate(db: DatabaseSync): void;
/** 表的列名（`PRAGMA table_info` 是唯一可靠的「有没有这一列」判据）。 */
export declare function columnNames(db: DatabaseSync, table: string): string[];
/**
 * 打开文件库（必要时建目录）。
 *
 * 与 `notes.ts` 同一套理由：用户可能在还没解密任何微信库时就想先整理文件，
 * 那时数据根还不存在，SQLite 会直接报 `unable to open database file`。
 * 建目录失败**不吞掉**（留痕即可）—— 真正的失败语义交给 `DatabaseSync`，
 * 免得「数据根的父路径是个文件」这种情形被报成『目录已存在』。
 */
export declare function openStore(decryptedDir: string): DatabaseSync;
/**
 * 在一个事务里跑一段写操作。
 *
 * `BEGIN IMMEDIATE` 而不是裸 `BEGIN`：登记文件时「写 kb_files 行 + 写 N 条 chunk +
 * 写 N 条 FTS」必须同生共死。用延迟事务的话，两个进程同时写入会在 COMMIT 时才冲突，
 * 而那时解析已经白跑了一遍。
 */
export declare function inTransaction<T>(db: DatabaseSync, fn: () => T): T;
export declare function cellStr(v: unknown): string;
export declare function errorText(e: unknown): string;
/**
 * 「写库时被别的进程占着」的识别 —— 这一类是**可以重试**的，不是「这份文件坏了」。
 *
 * 为什么需要它：`wechat_kb_files.db` 是 **rollback journal**（不是 WAL），写侧要拿到排他锁
 * 才能 `COMMIT`。只要**另一个进程**此刻还握着读锁（它的读事务没结束），写就会以
 * `errcode = 5`（`SQLITE_BUSY`）失败。真机复现（`working/kb-busy-repro.mjs`）看得很清楚：
 * `BEGIN IMMEDIATE` 与事务内的 `UPDATE` 都能过，**只有 `COMMIT` 抛**
 * `database is locked`；对端一放开，同一个写法立刻成功 —— 所以它是**暂态**的。
 *
 * 判据取 `errcode` 而不是文案：`errstr` 随 SQLite 构建与 locale 变（本机是
 * `database is locked`），拿它当判据会在换了构建之后静默失效。末行的文案兜底留给
 * 「拿不到 errcode」的极少数情形 —— 那时宁可多试几次，也不要把暂态当永久。
 * @param e - 捕获到的错误。
 * @returns 是不是「锁被占用」这一类可重试的失败。
 */
export declare function isBusyError(e: unknown): boolean;
/**
 * 撞锁时给用户看的那句话。
 *
 * 原样透出 `database is locked` 是一句他**没法行动**的话（英文，而且会让人以为数据坏了）——
 * 事实是「什么都没改动，等一下再来就好」。注册路径是同步的（重试不了），
 * 与队列路径共用这一句，免得两处各说各的。
 */
export declare const BUSY_TEXT = "\u77E5\u8BC6\u5E93\u7684\u6570\u636E\u6587\u4EF6\u6B63\u88AB\u5360\u7528\uFF08\u53E6\u4E00\u4E2A\u7A0B\u5E8F\u5728\u8BFB\u5199\u5B83\uFF09\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\uFF1A\u8FD9\u6B21\u6CA1\u6709\u6539\u52A8\u4EFB\u4F55\u6587\u4EF6";
export declare function warn(msg: string): void;
/**
 * 把来自 Remote 边界（未受类型保护的 JSON）的标识收敛成正整数，或判为无效。
 *
 * 与 `notes.ts` 的同名函数同一口径。这里**故意不复用**它：`notes.ts` 的边界是
 * 「一行不改」，而为了共用这 3 行去动它，代价远大于收益。逻辑本身极稳定，
 * 两边都不会演化。
 */
export declare function normalizePositive(value: unknown): number | undefined;
/**
 * 解析状态的白名单收敛。
 *
 * 库里出现预料之外的值时**不猜**（不当作 `ready`）—— 猜成 ready 会让界面把一个
 * 从没解析成功的文件显示成「可检索」，而那种错误没有任何症状。
 */
export declare function asParseState(s: string): KbFileParseState;
export declare function formatBytes(n: number): string;
/** blob 副本的文件名：`<sha256>.<ext>`；无扩展名时只有指纹。 */
export declare function blobFileName(sha256: string, ext: string): string;
export declare function rowToFileMeta(r: Record<string, unknown>): KbFileMeta;
/**
 * 写 blob 副本。内容寻址 ⇒ 同名即同内容，已存在就**不重写**
 * （重写会把 mtime 刷新，让「这个副本是什么时候来的」失去意义）。
 *
 * ⚠ 副本先于事务落盘，所以「登记中途失败」会留下一个没有登记行指向它的副本。
 * 这不是泄漏：内容寻址意味着同一份内容下次登记会**直接复用它**，
 * 只有「这份内容再也不会被登记」时才白占空间，而那种情况下重复计算指纹
 * 也没有任何收益。
 */
export declare function writeBlob(decryptedDir: string, blobName: string, bytes: Buffer): void;
/**
 * 删除 blob 副本 —— **只在没有任何登记行还引用这个指纹时**。
 *
 * 必须在删 `kb_files` 行**之前**调用（见 `KB_FILE_DELETE_ORDER` 的说明）：
 * 自己的那一行也算在 COUNT 里，所以「> 1」表示还有别人。
 * 删不掉只留痕不报错：副本可能已被用户手动清理，而登记行该删还是要删。
 * @returns 是否真的删掉了文件。
 */
export declare function removeBlobIfUnreferenced(db: DatabaseSync, decryptedDir: string, sha256: string, blobName: string): boolean;
/**
 * 把解析结果与截断说明合成写进 `parse_error` 的一句话。
 *
 * `unsupported` 时 `note` 必须非空（T1 的契约），而**文案纪律**是：不许把
 * 「本机没有对应解析器」写成「文件损坏」—— 前者等版本升级，后者要用户换文件。
 */
export declare function composeParseNote(note: string, truncated: boolean): string;
/** 逐块写入 `kb_chunks` 与其 FTS 索引行（rowid 与 chunk id 一一对应）。 */
export declare function insertChunks(db: DatabaseSync, fileId: number, kbId: number, chunks: readonly {
    ordinal: number;
    text: string;
    charCount: number;
    page: number;
    heading: string;
}[]): void;
