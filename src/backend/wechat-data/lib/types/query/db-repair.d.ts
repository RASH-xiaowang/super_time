import type { DbRepairResult } from '../types.ts';
/**
 * 修复解密快照里损坏的库：本地清残留 → 仍坏的从本机原始 `db_storage` 重新解密**且仅这几个**。
 *
 * 与「立即解密」共用同一条原子发布路径（`decryptAllDbs` ⇒ `sync.ts#atomicReplace`），
 * 所以修复期间并发只读查询看到的仍是旧快照（目标被占用时重试，不会半途替换）。
 * @param rawDbDir - raw WeChat db_storage dir（config 的 `db_dir`）。未配置/不存在时
 *   由 `decryptAllDbs` 给出配置类错误，本函数原样带回 `error`。
 * @param decryptedDir - decrypted snapshot root.
 * @param onProgress - per-database progress callback（done/total/message）；total 随着
 *   修复范围走（损坏几个就是几），不是全库总数。
 * @returns 修复结果（一个都没坏时 `found: 0` 且 `ok: true`，不做任何写操作）。
 */
export declare function repairCorruptDbs(rawDbDir: string, decryptedDir: string, onProgress?: (done: number, total: number, message: string) => void): Promise<DbRepairResult>;
