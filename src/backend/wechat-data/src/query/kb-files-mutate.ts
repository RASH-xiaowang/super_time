/**
 * `kb-files.ts` 的「变更与统计：删除级联、摘要/RAG 标记、按库统计」部分（M21 拆分）。
 *
 * 从原模块原样搬出，**行为逐字节不变**；原文件继续以 `export *` 转发
 * ⇒ 所有既有 import 一行都不用改。
 *
 * @module kb-files-mutate
 */

import { DatabaseSync } from 'node:sqlite'
import type {
  KbFileChunkPage,
  KbFileListSnapshot,
  KbFileMeta,
  KbFileMutationResult,
  KbFileParseState,
  KbFileRecoveryReport,
  KbFileRegisterInput,
  KbFileRegisterResult,
  KbFilesDeleteReport,
} from '../types.ts'
import { deleteKbVectorsForFile, reassignKbVectors } from './kb-vectors.ts'
import { KB_FILE_DELETE_ORDER, cellStr, errorText, inTransaction, normalizePositive, openStore, rowToFileMeta, warn } from './kb-files-store.ts'
import { CASCADE_STEPS, CascadeContext, listKbFiles } from './kb-files-register.ts'

/** 按 `KB_FILE_DELETE_ORDER` 逐条执行级联。 */
export function cascadeDeleteFile(ctx: CascadeContext): void {
  for (const step of KB_FILE_DELETE_ORDER) CASCADE_STEPS[step](ctx)
}

/** 读出一行的 sha256 / blob_name，造一个级联上下文。 */
export function contextFor(db: DatabaseSync, decryptedDir: string, fileId: number): CascadeContext {
  const row = db.prepare('SELECT sha256, blob_name FROM kb_files WHERE id = ?').get(fileId) as Record<string, unknown> | undefined
  return {
    db,
    decryptedDir,
    fileId,
    sha256: cellStr(row?.['sha256']),
    blobName: cellStr(row?.['blob_name']),
    chunkIds: [],
    removedChunks: 0,
    removedBlob: false,
  }
}

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
export function deleteKbFile(decryptedDir: string, kbId: number, fileId: number): KbFileMutationResult {
  const kb = normalizePositive(kbId)
  const id = normalizePositive(fileId)
  if (kb === undefined) return { ok: false, error: '知识库标识无效' }
  if (id === undefined) return { ok: false, error: '文件标识无效' }
  try {
    const db = openStore(decryptedDir)
    try {
      // 归属不符时报「不存在」——与文件真的不在时同一句话：不向调用方暴露
      // 「这个 id 在别的库里存在」这一事实。
      const exists = db.prepare('SELECT id FROM kb_files WHERE id = ? AND kb_id = ?').get(id, kb)
      if (exists === undefined) return { ok: false, error: '文件不存在（可能已被删除）' }
      const ctx = contextFor(db, decryptedDir, id)
      inTransaction(db, () => cascadeDeleteFile(ctx))
      return { ok: true, removedChunks: ctx.removedChunks, removedBlob: ctx.removedBlob }
    } finally {
      try {
        db.close()
      } catch {
        /* 已关闭 */
      }
    }
  } catch (e) {
    return { ok: false, error: errorText(e) }
  }
}

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
export function getKbFile(decryptedDir: string, kbId: number, fileId: number): KbFileMeta | null {
  const kb = normalizePositive(kbId)
  const id = normalizePositive(fileId)
  if (kb === undefined || id === undefined) return null
  try {
    const db = openStore(decryptedDir)
    try {
      const row = db.prepare('SELECT * FROM kb_files WHERE id = ? AND kb_id = ?').get(id, kb) as Record<string, unknown> | undefined
      return row === undefined ? null : rowToFileMeta(row)
    } finally {
      try {
        db.close()
      } catch {
        /* 已关闭 */
      }
    }
  } catch (e) {
    console.warn('[kb-files] 单文件读取失败：' + errorText(e))
    return null
  }
}

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
export function setKbFileSummary(
  decryptedDir: string, kbId: number, fileId: number, summary: string, model: string, coveredChars: number,
): KbFileMutationResult {
  const kb = normalizePositive(kbId)
  const id = normalizePositive(fileId)
  if (kb === undefined) return { ok: false, error: '知识库标识无效' }
  if (id === undefined) return { ok: false, error: '文件标识无效' }
  try {
    const db = openStore(decryptedDir)
    try {
      const text = summary.trim()
      const res = db.prepare(
        'UPDATE kb_files SET summary = ?, summary_model = ?, summary_at = ?, summary_covered_chars = ?, updated_at = ? '
        + 'WHERE id = ? AND kb_id = ?',
      ).run(
        text, text === '' ? '' : model, text === '' ? 0 : Date.now(),
        text === '' ? 0 : Math.max(0, Math.trunc(coveredChars)), Date.now(), id, kb,
      )
      if (Number(res.changes ?? 0) === 0) return { ok: false, error: '文件不存在（可能已被删除）' }
      return { ok: true }
    } finally {
      try {
        db.close()
      } catch {
        /* 已关闭 */
      }
    }
  } catch (e) {
    return { ok: false, error: errorText(e) }
  }
}

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
export function setKbFileRagFlag(decryptedDir: string, kbId: number, fileId: number, includeInRag: boolean): KbFileMutationResult {
  const kb = normalizePositive(kbId)
  const id = normalizePositive(fileId)
  if (kb === undefined) return { ok: false, error: '知识库标识无效' }
  if (id === undefined) return { ok: false, error: '文件标识无效' }
  try {
    const db = openStore(decryptedDir)
    try {
      const res = db.prepare('UPDATE kb_files SET include_in_rag = ?, updated_at = ? WHERE id = ? AND kb_id = ?')
        .run(includeInRag ? 1 : 0, Date.now(), id, kb)
      if (Number(res.changes ?? 0) === 0) return { ok: false, error: '文件不存在（可能已被删除）' }
      /**
       * 关掉开关时**必须连已有向量一起清掉**。
       *
       * 只改标志位挡不住**已经躺在向量库里的那一份**：粗筛照样会把它选出来
       *（回读时的 `include_in_rag=1` 会把它过滤掉，但那意味着「不许出网的文件每次都在参与粗筛」，
       * 而且它的向量已经落在磁盘上了）。用户关开关的意思是「别再算了、也别再留着」，两件都要做。
       *
       * 重新打开**不**顺手重建：重建要出网，出网必须由用户显式触发（或下一次提问的既有路径去补）。
       * 这里只做减法、不做加法。
       */
      if (!includeInRag) deleteKbVectorsForFile(decryptedDir, id)
      return { ok: true }
    } finally {
      try {
        db.close()
      } catch {
        /* 已关闭 */
      }
    }
  } catch (e) {
    return { ok: false, error: errorText(e) }
  }
}

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
export function kbFilesOnKbDelete(decryptedDir: string, kbId: number, targetKbId?: number): KbFilesDeleteReport {
  const kb = normalizePositive(kbId)
  if (kb === undefined) return { ok: false, movedFiles: 0, removedFiles: 0, error: '知识库标识无效' }
  const target = normalizePositive(targetKbId)
  const reassign = target !== undefined && target !== kb
  try {
    const db = openStore(decryptedDir)
    try {
      const rows = db.prepare('SELECT id FROM kb_files WHERE kb_id = ?').all(kb) as Array<Record<string, unknown>>
      const ids = rows.map((r) => Number(r['id'] ?? 0)).filter((n) => n > 0)
      if (ids.length === 0) return { ok: true, movedFiles: 0, removedFiles: 0 }

      let moved = 0
      let removed = 0
      inTransaction(db, () => {
        for (const id of ids) {
          if (!reassign) {
            cascadeDeleteFile(contextFor(db, decryptedDir, id))
            removed += 1
            continue
          }
          const row = db.prepare('SELECT sha256 FROM kb_files WHERE id = ?').get(id) as Record<string, unknown> | undefined
          const sha = cellStr(row?.['sha256'])
          const clash = sha !== ''
            && db.prepare('SELECT id FROM kb_files WHERE kb_id = ? AND sha256 = ?').get(target, sha) !== undefined
          if (clash) {
            cascadeDeleteFile(contextFor(db, decryptedDir, id))
            removed += 1
            continue
          }
          const now = Date.now()
          db.prepare('UPDATE kb_files SET kb_id = ?, updated_at = ? WHERE id = ?').run(target, now, id)
          // 分块也要跟着换归属，否则新库检索不到它、旧库又能搜到（隔离被破坏）。
          // FTS 表里没有 kb_id（作用域一律走 JOIN），所以不需要同步。
          db.prepare('UPDATE kb_chunks SET kb_id = ? WHERE file_id = ?').run(target, id)
          /**
           * 向量行的归属**也要跟着换**（跨库，所以进不了这个事务）。
           * 漏了它的后果是静默的：向量行还在，但 `kb_id` 指向那个即将消失的库 ⇒ 目标库的
           * 稠密检索按 `WHERE kb_id = ?` 把它挡掉、源库也没了 ⇒ 这些块在稠密通道里「凭空消失」，
           * 而稀疏通道照样搜得到。表现为「关键词搜得到、换个说法就搜不到」，极难归因。
           */
          reassignKbVectors(decryptedDir, id, target)
          moved += 1
        }
      })
      return { ok: true, movedFiles: moved, removedFiles: removed }
    } finally {
      try {
        db.close()
      } catch {
        /* 已关闭 */
      }
    }
  } catch (e) {
    return { ok: false, movedFiles: 0, removedFiles: 0, error: errorText(e) }
  }
}

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
export function countKbFilesByKb(decryptedDir: string): Map<number, number> {
  const map = new Map<number, number>()
  try {
    const db = openStore(decryptedDir)
    try {
      const rows = db.prepare('SELECT kb_id, COUNT(*) AS n FROM kb_files GROUP BY kb_id').all() as Array<Record<string, unknown>>
      for (const r of rows) {
        const kb = normalizePositive(r['kb_id'])
        if (kb !== undefined) map.set(kb, Number(r['n'] ?? 0))
      }
    } finally {
      try {
        db.close()
      } catch {
        /* 已关闭 */
      }
    }
  } catch {
    /* 读不到就按「没有文件」呈现；见上面的头注 */
  }
  return map
}

/** 诊断用：某个库现有多少条登记（探针第 8 步断言「该 file_id 在库里为 0 行」时用得上）。 */
export function countKbFiles(decryptedDir: string, kbId: number): number {
  const kb = normalizePositive(kbId)
  if (kb === undefined) return 0
  try {
    const db = openStore(decryptedDir)
    try {
      const row = db.prepare('SELECT COUNT(*) AS n FROM kb_files WHERE kb_id = ?').get(kb) as Record<string, unknown> | undefined
      return Number(row?.['n'] ?? 0)
    } finally {
      try {
        db.close()
      } catch {
        /* 已关闭 */
      }
    }
  } catch {
    return 0
  }
}
