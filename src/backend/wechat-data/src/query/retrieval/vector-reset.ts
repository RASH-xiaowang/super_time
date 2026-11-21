/**
 * 稀疏索引重建后的**向量库作废**（2026-11-19）。
 *
 * ## 为什么必须有一份这样的代码
 *
 * 全量重建 `message_meta` 时会 `DROP TABLE` 再建，`rowid` 从 1 重新分配 ——
 * 同一个 `rowid` 指向的是**完全不同的消息**。而消息域向量表
 * （`wechat_rag_vectors.db` 的 `vectors`）以 `fts_rowid` 为主键：
 *
 * ```
 * 重建前：rowid 42 → 消息 A   向量(42) = embed(A)
 * 重建后：rowid 42 → 消息 B   向量(42) 仍是 embed(A)
 * ```
 *
 * 于是 `searchDense` 用 `JOIN message_meta ON rowid` 取回正文时，拿到的是 B 而分数来自 A。
 * 表现是**分数正常、内容不是它** —— 比"搜不到"更糟：用户无法自证，而且会污染引用与总结。
 *
 * ## 为什么是"整份作废"而不是"逐个校验"
 *
 * 校验需要跨库比对（稀疏库的 rowid ↔ 向量库的 rowid），那要在**每次提问**的热路径上
 * 多开一个连接读一次 meta —— 实测会破坏 `vector-status.spec.ts` 钉住的
 * 「一次提问 ≤1 次连接」性能契约（N14）。
 *
 * 而重建是**用户手动、低频**的动作。把它换成"重建后向量作废、下次按需重建"是一次
 * 一次性成本换掉一条热路径成本，方向明确。
 *
 * ## 失败不致命
 *
 * 若此刻有并发读者持有向量库（Windows 上会 `EBUSY`），这里**不能**让重建整体失败 ——
 * 稀疏索引本身是好的。此时静默跳过：`runBuildVectorIndex` 里还有一层代次兜底
 * （它读搜索库时顺带比对 `src_epoch`，不等就整份重算），所以最终仍会自愈。
 *
 * @module query/retrieval/vector-reset
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from '../db-open.ts'
import { retrievalRoot } from './config.ts'

/**
 * 作废消息域向量索引：删掉 `vectors` 表与全部 meta 记录。
 *
 * 只删表、不删文件：库文件被并发读者持有时删文件会失败，而删表只是普通写事务，
 * SQLite 自己会用 busy 等待排队。删表后 `hasVectorsTable()` 为假 ⇒ 状态立刻变
 * `ready:false` ⇒ 下一次提问按既有逻辑重建。
 * @param decryptedDir - 已解密数据根。
 * @returns `true` = 已作废（或本来就没有向量库）；`false` = 被占用/出错，未能作废。
 */
export function resetMessageVectorIndex(decryptedDir: string): boolean {
  const p = join(retrievalRoot(decryptedDir), 'wechat_rag_vectors.db')
  if (!existsSync(p)) return true
  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(p)
    // 并发读者可能正持有读连接：给 3s 排队窗口，超出就按失败处理（下次自愈）。
    try { db.exec('PRAGMA busy_timeout = 3000') } catch { /* 老版本忽略 */ }
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec('DROP TABLE IF EXISTS vectors')
      // meta 保留表结构、清空内容：`src_epoch` 等键必须一并消失，否则读侧会以为还是同代。
      try { db.exec('DELETE FROM meta') } catch { /* meta 表不存在 */ }
      db.exec('COMMIT')
    } catch (e) {
      try { db.exec('ROLLBACK') } catch { /* 无活动事务 */ }
      throw e
    }
    return true
  } catch {
    return false
  } finally {
    try { if (db !== null && db.isOpen) db.close() } catch { /* 关不上不掩盖上层结果 */ }
  }
}
