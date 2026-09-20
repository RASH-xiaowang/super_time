/**
 * 知识库「文件」存储层：登记（上传）/ 列表 / 删除 / 崩溃恢复，以及
 * 「读字节 → 解析 → 分块 → 落库」这条唯一写入路径。
 *
 * ── 与 `notes.ts` 的边界（刻意写在最显眼处）────────────────────────────
 *   · `notes.ts` 的文件头写着「本模块只读写本地库，不出网、不调用模型」，
 *     且它是**笔记**的真源。文件功能一律落在本模块，`notes.ts` **一行不改**；
 *   · 两者共用同一个数据根，但**各自一个库文件**：`wechat_notes.db` /
 *     `wechat_kb_files.db`。分成两个文件而不是「一个库里两组表」，是为了让
 *     「文件功能整体回退」= 删一个文件 + 摘掉 Remote 注册（计划 §三 可独立回退点）。
 *     代价是**没有跨库事务** —— 下文所有涉及两侧的写操作都必须按「先文件、后笔记」
 *     的顺序设计成可重入的（见 `kbFilesOnKbDelete`）。
 *
 * ── 两条不可违反的不变量 ─────────────────────────────────────────────
 *   ① **`src_path` 只登记，永不写、永不删、永不移。** 解析的输入是 blob 副本
 *      （`<data-root>/kb-blobs/<sha256>.<ext>`），所以用户改名 / 移动 / 删除原文件
 *      都不影响已经入库的内容（设计稿 §10 边界 3）。真机探针的第 9 步专门咬这一条。
 *   ② **`ready` 状态与它的 chunk 行必须在同一个事务里。** 否则中断会留下
 *      「状态说解析好了、但一条块都没有」的假成功，而这种行在界面上看起来最正常。
 *
 * ── 为什么 blob 用内容寻址而不是自增 id ───────────────────────────────
 *   ① 同一份内容在**不同库**里各存一行是合理的（库是作用域），但副本只该有一份；
 *   ② 「删掉这个文件时，还有没有别人在用它」于是就是一条 COUNT，不需要引用计数表，
 *      也就不会出现计数漂移导致「删掉别人还在用的 blob」。
 *   副本名只存**文件名**不存绝对路径：数据根搬家后旧路径会失效，而相对名不会。
 */
import { DatabaseSync } from 'node:sqlite';
import type { KbFileChunkPage, KbFileListSnapshot, KbFileMeta, KbFileMutationResult, KbFileRecoveryReport, KbFileRegisterInput, KbFileRegisterResult, KbFilesDeleteReport } from '../types.ts';
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
/**
 * 删除一个文件，连带它的分块 / FTS 行 / 向量 / blob 副本。
 *
 * **不碰 `src_path`** —— 这是本模块最重要的对外承诺：删的是「知识库里的这一份」，
 * 不是用户电脑上的那个文件。真机探针第 9 步咬这一条。
 * @param decryptedDir - 解密数据根。
 * @param kbId - **守卫**（不是附加信息）：归属不符时拒绝删除。文件 id 全局自增，
 *   少了这一步，拿着甲库的 id 调乙库会把甲库那一条连分块与副本一起删掉且无法撤销。
 * @param fileId - 要删的文件行 id。
 * @returns 回执（连带清掉的分块数、副本是否被删）。
 */
export declare function deleteKbFile(decryptedDir: string, kbId: number, fileId: number): KbFileMutationResult;
/**
 * 读单个文件行（`kb_id` 与 `id` 双条件）。
 *
 * 为什么单独一个而不是让调用方去 `listKbFiles` 里找：后者是分页的，
 * 「按 limit 拉一大页再线性找」既浪费又会在文件数超过 limit 时**静默找不到** ——
 * 而找不到会被调用方解释成「这个文件不存在」，那是个假结论。
 * @param decryptedDir - 解密数据根。
 * @param kbId - 目标库（守卫）。
 * @param fileId - 目标文件。
 * @returns 文件元信息；不存在或不属于该库时 `null`。
 */
export declare function getKbFile(decryptedDir: string, kbId: number, fileId: number): KbFileMeta | null;
/**
 * 写入（或清空）一个文件的模型摘要。
 *
 * 摘要是**派生物**而不是用户输入，所以它单独占三列而不是塞进 `parse_error` 之类的
 * 现成字段，并且要连模型名与时间一起存：换了配置模型之后，用户得能看出眼前这条
 * 摘要不是当前这个模型给的。
 *
 * `kbId` 是守卫而不是附加信息（与 `deleteKbFile` / `setKbFileRagFlag` 同一条纪律）：
 * 只按 `id` 更新的话，拿甲库的 id 会写进乙库那一行。
 * @param decryptedDir - 解密数据根。
 * @param kbId - 目标库。
 * @param fileId - 目标文件。
 * @param summary - 摘要正文；传空串表示清空。
 * @param model - 生成它的模型标识（`provider/model` 那种写法）。
 * @param coveredChars - 本次真正喂给模型的字符数（清空时传 0）。
 * @returns `{ ok }` 或 `{ ok: false, error }`。
 */
export declare function setKbFileSummary(decryptedDir: string, kbId: number, fileId: number, summary: string, model: string, coveredChars: number): KbFileMutationResult;
/**
 * 切换一个文件是否参与向量化（出网）。
 *
 * 有这一档是为了让「库里有合同，但我还想搜到它」成立：关掉之后该文件**完全不出网**，
 * 但仍然留在 FTS 索引里可被关键词搜到（设计稿 §9.2）。
 * @param decryptedDir - 解密数据根。
 * @param kbId - **守卫**，与 `deleteKbFile` 同口径。
 * @param fileId - 目标文件。
 * @param includeInRag - 是否参与。
 * @returns `{ ok }` 或 `{ ok: false, error }`。
 */
export declare function setKbFileRagFlag(decryptedDir: string, kbId: number, fileId: number, includeInRag: boolean): KbFileMutationResult;
/**
 * 删库时处理该库的文件：`purge` 全部删掉，`reassign` 迁给目标库。
 *
 * ⚠ **调用顺序是「先文件、后笔记」**（两个库文件之间没有跨库事务）。
 * 反过来的话，中间失败会留下「库行没了、文件还在、kb_id 指向一个不存在的库」，
 * 界面上就是文件彻底消失且无法归因；按现在的顺序失败，最坏是「文件已迁走、库还在」，
 * 用户重试一次即可，两边都能收敛。
 *
 * `reassign` 撞上目标库已有同内容文件时，该文件**不迁移**并计入 `removedFiles`：
 * 唯一索引不允许两行同 sha256，而静默合并会让用户以为文件丢了（设计稿 §10 边界 7）。
 * @param decryptedDir - 解密数据根。
 * @param kbId - 被删的库。
 * @param targetKbId - `reassign` 的目标库；不给表示 `purge`。
 * @returns 迁移 / 删除的条数。**文件为空的库也返回 `ok:true`**（没什么可做不是失败）。
 */
export declare function kbFilesOnKbDelete(decryptedDir: string, kbId: number, targetKbId?: number): KbFilesDeleteReport;
/**
 * 每个库各有多少条登记 —— **一次 GROUP BY** 拿全。
 *
 * 给 `gateway.getKbs` 用：库列表要显示 / 说明「库里有多少文件」（删库弹层不数文件就会说
 * 「这个库是空的」）。按库逐个调 `countKbFiles()` 也能得到同样的数，但那是 N 次开库 ——
 * 与 `notes.ts` 的 `listKbs` 同一条纪律：别在循环里对每个库各查一次。
 *
 * 读不到文件库时返回**空表**（调用方按「没有文件」呈现）。这是列表页的附属信息，
 * 不该因为文件库读失败就整天不显示；文件库自己的读失败有「文件」分段的 `readError` 负责。
 * @param decryptedDir - 解密数据根。
 * @returns `kb_id → 条数`；没有文件的库**不出现在表里**（调用方用 `?? 0` 兜）。
 */
export declare function countKbFilesByKb(decryptedDir: string): Map<number, number>;
/** 诊断用：某个库现有多少条登记（探针第 8 步断言「该 file_id 在库里为 0 行」时用得上）。 */
export declare function countKbFiles(decryptedDir: string, kbId: number): number;
