import type { LedgerSnapshot } from '../types.ts';
/**
 * Compute the funds ledger snapshot.
 *
 * G（2026-09-28 性能修复）：实测 `queryLedger` 无缓存时 **125ms**，而它每次被
 * 「账本面板重渲染 / 切月 / 切回来」都整跑一遍 —— 但它的输入只有三样东西：
 * 会话库、通讯录库、消息分片目录，全都可以用文件签名判断「变没变」。
 * 所以按签名缓存（`cachedBySigAsync`，与 `queryGraph` 同一个入口）。
 *
 * 签名含 `month` 与 `selfUsername`：两者都是查询参数，混用会让「切月后拿到上月数据」
 * 这种错静默发生。等价的单张缓存示例见 `contacts.ts`（把参数编进 key）。
 * @param decryptedDir - decrypted data root.
 * @param month - optional YYYY-MM filter.
 * @param selfUsername - logged-in account wxid (direction labels).
 * @returns the ledger snapshot.
 */
export declare function queryLedger(decryptedDir: string, month?: string, selfUsername?: string): Promise<LedgerSnapshot>;
