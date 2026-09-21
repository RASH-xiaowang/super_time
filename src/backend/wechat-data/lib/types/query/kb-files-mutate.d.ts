/**
 * `kb-files.ts` 的「变更与统计：删除级联、摘要/RAG 标记、按库统计」部分（M21 拆分）。
 *
 * 从原模块原样搬出，**行为逐字节不变**；原文件继续以 `export *` 转发
 * ⇒ 所有既有 import 一行都不用改。
 *
 * @module kb-files-mutate
 */
import { DatabaseSync } from 'node:sqlite';
import type { KbFileMeta, KbFileMutationResult, KbFilesDeleteReport } from '../types.ts';
import { CascadeContext } from './kb-files-register.ts';
/** 按 `KB_FILE_DELETE_ORDER` 逐条执行级联。 */
export declare function cascadeDeleteFile(ctx: CascadeContext): void;
/** 读出一行的 sha256 / blob_name，造一个级联上下文。 */
export declare function contextFor(db: DatabaseSync, decryptedDir: string, fileId: number): CascadeContext;
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
