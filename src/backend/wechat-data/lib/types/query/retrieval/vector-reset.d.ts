/**
 * 作废消息域向量索引：删掉 `vectors` 表与全部 meta 记录。
 *
 * 只删表、不删文件：库文件被并发读者持有时删文件会失败，而删表只是普通写事务，
 * SQLite 自己会用 busy 等待排队。删表后 `hasVectorsTable()` 为假 ⇒ 状态立刻变
 * `ready:false` ⇒ 下一次提问按既有逻辑重建。
 * @param decryptedDir - 已解密数据根。
 * @returns `true` = 已作废（或本来就没有向量库）；`false` = 被占用/出错，未能作废。
 */
export declare function resetMessageVectorIndex(decryptedDir: string): boolean;
