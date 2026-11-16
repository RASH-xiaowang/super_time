import type { DbHealthSnapshot, DbIntegrityResult } from '../types.ts';
/**
 * Compute the data-health snapshot (cached ~5s so repeated open/close does
 * not rescan the whole decrypted tree).
 * @param decryptedDir - decrypted data root.
 * @returns the health snapshot.
 */
export declare function queryDbHealth(decryptedDir: string): DbHealthSnapshot;
/** 「本机没有这个模块/分词器」的原话 —— 万一 DDL 里没写出来，还能按这句把类判对。 */
export declare const MISSING_MODULE_RE: RegExp;
/**
 * 这个库**本机体检不了**的原因（`null` = 能体检）。
 *
 * 判据只看 `sqlite_master` 里的虚拟表 DDL，**不看错误文案**：错误文案是
 * `SQL logic error` 这种通用句，拿它当判据等于没判。看得到分词器名字，才说得清
 * 「为什么检不了、为什么退出微信也没用」。
 * @param abs - 库的绝对路径。
 * @returns 说清原因的一句话，或 null。
 */
export declare function uncheckableReason(abs: string): string | null;
/**
 * 逐库跑 `PRAGMA integrity_check`（**按需显式动作**，不在健康快照里）。
 *
 * 三件必须说清的事：
 *   ① **为什么不在 `queryDbHealth` 的快照里**：那张快照被「原图链路自检」等面板
 *      启动时顺带读取（`Hook.tsx`），把几十万页的完整性扫描挂上去等于给每次挂载
 *      加几秒阻塞；体检是用户点「重新检查 / 修复」时才做的显式动作。
 *   ② **让出的粒度是「一个库」**：`node:sqlite` 全是同步 API，单个库的
 *      integrity_check 是一次性同步扫描（本机最大的 message 分片要论秒），
 *      这一步躲不掉；库与库之间让出，别的请求才插得进 gap。
 *   ③ **成败分类**（见 {@link DbIntegrityResult}）：查不了 ≠ 坏了 ≠ 本机检不了。
 *      三类分开报 —— 上一版只有前两类，于是三个「本机检不了」的 FTS 库被说成
 *      「多半被微信独占」，用户去退微信只会白等（见 {@link uncheckableReason}）。
 * @param decryptedDir - decrypted data root.
 * @returns 每个库的结论：损坏（本地清残留 / 重解密可修）/ 查不了（占用等）/ 本机检不了。
 */
export declare function checkDecryptedIntegrity(decryptedDir: string): Promise<DbIntegrityResult>;
