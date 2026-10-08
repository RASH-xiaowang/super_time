import type { RecordItem } from '../types.ts';
/**
 * Query one records kind.
 * @param decryptedDir - decrypted data root.
 * @param kind - records kind key.
 * @param limit - max rows.
 * @param offset - page offset.
 * @param q - optional session/user/id keyword (applied server-side per kind).
 * @returns the records snapshot.
 */
export declare function queryRecords(decryptedDir: string, kind: string, limit?: number, offset?: number, q?: string, opts?: {
    from?: number;
    to?: number;
    direction?: 'asc' | 'desc';
}): {
    items: RecordItem[];
    total: number;
};
/**
 * 撤回消息列表（2026-09-29 起：**优先读我们自己的归档库**，见 `anti-revoke-archive.ts`）。
 *
 * 数据来源两处，形状一致（sender / type_label / content / create_time，按时间倒序）：
 *   ① 我们的归档库 `<数据根>/anti-revoke-archive.db` —— 只增不改，原文永久保留；
 *   ② 第三方反撤回插件的缓存表 `*_weflow_anti_revoke_deleted_cache` —— 仅作来源与降级直读。
 * @param decryptedDir - decrypted data root.
 * @param limit - max rows (default 200, capped 500).
 * @param offset - 偏移。
 * @param q - 关键词（匹配原文 / 发送者 id）。
 * @returns the revoked snapshot.
 */
export declare function queryRevoked(decryptedDir: string, limit?: number, offset?: number, 
/** 关键词：匹配撤回内容 / 发送者 id。放在服务端，避免只搜到已加载那一页。 */
q?: string): {
    items: Array<{
        sender: string;
        type_label: string;
        content: string;
        create_time: number;
    }>;
    total: number;
};
