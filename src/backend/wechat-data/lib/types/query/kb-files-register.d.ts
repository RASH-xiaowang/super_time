/**
 * `kb-files.ts` 的「登记与读取：registerKbFile、列表/分块分页、中断恢复」部分（M21 拆分）。
 *
 * 从原模块原样搬出，**行为逐字节不变**；原文件继续以 `export *` 转发
 * ⇒ 所有既有 import 一行都不用改。
 *
 * @module kb-files-register
 */
import { DatabaseSync } from 'node:sqlite';
import type { KbFileChunkPage, KbFileListSnapshot, KbFileRecoveryReport, KbFileRegisterInput, KbFileRegisterResult } from '../types.ts';
import { KbFileDeleteStep } from './kb-files-store.ts';
/**
 * 登记一个文件：读原文件字节 → 算指纹 → 查重 → 落 blob 副本 → 解析 → 分块 → 入库。
 *
 * 为什么**分两档**而不是一刀切：
 *   · A / A' 档（纯文本 / HTML / CSV）一步做完 —— 解析是**同步毫秒级**的，拆成两步
 *     只会凭空造出一个中途态，用户看到「正在解析」闪一下又没了；
 *   · B 档（pdf / docx / xlsx / xls）只落一行 `queued`，正文由 `kb-queue.ts` 的执行器
 *     稍后填（那三个库要几百毫秒到几秒，见 `kb/parse-async.ts`）。
 *
 * ⚠ 用户点下「添加」到正文可检索，B 档中间有一段等待。触发执行器的**不是**这里
 * （那会让存储层反向依赖队列），而是 `gateway.addKbFiles` 与网关启动时的清扫
 * —— 两个入口都在 `gateway.ts` 里，一处不漏地看得见。
 *
 * 失败一律**返回**而不是抛：调用方是 `@Remote`，抛出去会变成一句无从下手的
 * 「调用失败」，而这里的每一种失败都能说清楚（重复 / 太大 / 类型不支持 / 读不到）。
 * @param decryptedDir - 解密数据根（库与 blob 都在它的父目录下）。
 * @param input - 目标库、原文件路径、是否参与向量化。
 * @returns 成功时带上落地的那一行；失败时带 `code` 与人话原因。
 */
export declare function registerKbFile(decryptedDir: string, input: KbFileRegisterInput): KbFileRegisterResult;
/** 列表分页参数。 */
export interface KbFileListOptions {
    limit?: number;
    offset?: number;
}
/**
 * 列出一个库里的文件（新上传的在前）。
 *
 * ⚠ **每一处查询都带 `WHERE kb_id = ?`** —— 少一处，单库测试全绿、多库才串数据，
 * 而那时已经很难归因了（这是计划里点名的「静默失效」之一，变异测试第 1 条咬的就是它）。
 * @param decryptedDir - 解密数据根。
 * @param kbId - 目标库。
 * @param opts - 分页。
 * @returns 列表；库读不到时给 `readError`，而不是把空列表伪装成「一个文件都没有」。
 */
export declare function listKbFiles(decryptedDir: string, kbId: number, opts?: KbFileListOptions): KbFileListSnapshot;
/** 一次最多回多少个块。 */
export declare const MAX_CHUNK_PAGE = 200;
/** 默认每页块数（一屏读得完的量）。 */
export declare const DEFAULT_CHUNK_PAGE = 60;
/**
 * 列出一个文件解析出来的正文块。
 *
 * 这是「读这篇文档」的唯一出口：界面上原先只有登记台账（大小 / 块数 / 指纹 / 路径），
 * 正文虽然确实进了 `kb_chunks.text`，却只在**搜索命中**时以摘要片段的形式露出来 ——
 * 不输入关键词就读不到内容。
 *
 * ⚠ **两个作用域条件都要**：`file_id` 定位文件，`kb_id` 确认它属于当前库。
 * 只卡 `file_id` 的话，传一个别的库的 fileId 就能读到那个库的正文 ——
 * 单库测试全绿，多库才串，而且这条串的是**内容**不是计数，比 `listKbFiles` 那边更严重。
 *
 * 返回的是**解析出来的文本**，不是原文件的排版：PDF/DOCX 的表格、图片、页眉页脚
 * 在解析阶段就已经丢了。所以界面上必须说清「这是检索与问答实际看到的正文」，
 * 不能让用户以为在看原稿 —— 那两种读法得到的结论可以不一样。
 * @param decryptedDir - 解密数据根。
 * @param kbId - 目标库（必填，没有「所有库」模式）。
 * @param fileId - 目标文件。
 * @param opts - 分页（按 `ordinal` 升序，即文档原有顺序）。
 * @returns 块列表与总数；读不到或文件不在本库时给 `readError`。
 */
export declare function listKbFileChunks(decryptedDir: string, kbId: number, fileId: number, opts?: {
    limit?: number;
    offset?: number;
}): KbFileChunkPage;
/**
 * 已经做过崩溃恢复的数据根（按库文件路径记）。
 *
 * **只在进程启动时重置一次**，而不是每次读列表时判断 —— 后者是这类功能最常见的
 * 走捷径写法，它的 bug 是：用户正在上传一个大文件（状态 = `parsing`），
 * 此时任何一次列表刷新都会把它判成「崩溃残留」并打回 `queued`，
 * 于是一次正常的解析被自己的读操作打断（计划 R7）。
 */
export declare const recoveredRoots: Set<string>;
/**
 * 把上次进程留下的中间态重置为 `queued`。
 *
 * **调用点是网关启动时一次**，不要在读路径里调。
 * 同一个数据根在本进程内只做一次：第二次返回 `{ reset: 0, skipped: true }`，
 * 好让「只做一次」这件事可被断言，而不是只能靠读代码相信。
 * @param decryptedDir - 解密数据根。
 * @returns 本次重置的行数与是否被跳过。
 */
export declare function recoverInterrupted(decryptedDir: string): KbFileRecoveryReport;
/** 仅供用例清掉「只做一次」的进程内记忆（`recoverInterrupted` 的守卫本身不被绕过）。 */
export declare function resetRecoveryGuardForTest(): void;
/** 级联删除的上下文：字段在步骤之间传递（`chunks` 填 `chunkIds`，`fts` 用）。 */
export interface CascadeContext {
    db: DatabaseSync;
    decryptedDir: string;
    fileId: number;
    sha256: string;
    blobName: string;
    chunkIds: number[];
    removedChunks: number;
    removedBlob: boolean;
}
/**
 * 五个删除步骤的实现表。**键就是 `KB_FILE_DELETE_ORDER` 的元素** ——
 * 顺序由那个数组决定，这里只管每一步做什么，不重复表达次序。
 */
export declare const CASCADE_STEPS: Record<KbFileDeleteStep, (c: CascadeContext) => void>;
