import type { SessionsSnapshot } from '../types.ts';
export declare function isSyntheticSessionHolder(username: string): boolean;
/**
 * Read the session list from the decrypted session.db.
 * @param decryptedDir - st_control decrypted data root (…/data/wechat/decrypted).
 * @param keyword - optional username/name filter.
 * @param limit - max rows.
 * @returns the session snapshot.
 */
export declare function querySessions(decryptedDir: string, keyword?: string, limit?: number, offset?: number): Promise<SessionsSnapshot>;
/**
 * 界面全局搜索使用的可取消会话查询。
 *
 * 普通调用仍走按文件签名缓存；带 signal 的操作不能复用缓存 Promise，也不能把
 * 中途取消的部分结果写回缓存，否则下一次同一关键词会命中残缺快照。这里直接
 * 计算并在分片解析的让出点检查取消。
 */
export declare function querySessionsCancellable(decryptedDir: string, keyword?: string, limit?: number, offset?: number, signal?: AbortSignal): Promise<SessionsSnapshot>;
