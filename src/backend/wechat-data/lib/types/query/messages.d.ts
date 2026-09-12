import type { MessagesSnapshot, WechatMessage } from '../types.ts';
/**
 * Normalize a wechat local_type (high-bit masks).
 * @param localType - raw local_type value from the DB.
 * @returns the normalized type value.
 */
export declare function normalizeMsgType(localType: number): number;
/**
 * Human label for a normalized message type (mirror st_control).
 * @param localType - raw local_type value from the DB.
 * @returns the Chinese display label for the type.
 */
export declare function msgTypeLabel(localType: number): string;
/**
 * Strip XML tags from a wechat message_content to a plain-text preview.
 * @param content - raw message content.
 * @returns a plain-text preview (max 200 chars).
 */
export declare function msgText(content: string): string;
/**
 * Incrementally fetch messages newer than a sort_seq watermark (real-time
 * polling). Mirrors st_control's monitor delta: any message whose order key
 * is above the seen high-water mark is returned oldest-first for appending.
 * @param decryptedDir - decrypted data root.
 * @param talker - conversation username.
 * @param after - only rows with sort_seq > this watermark are returned.
 * @param limit - max rows to return (default 200).
 * @param selfUsername - logged-in account wxid (see {@link queryMessages}).
 * @returns the newer messages (empty when nothing arrived).
 */
export declare function queryNewMessages(decryptedDir: string, talker: string, after: number, limit?: number, selfUsername?: string): MessagesSnapshot;
/**
 * Read one talker's messages (keyset pagination across all shards).
 * @param decryptedDir - decrypted data root.
 * @param talker - conversation username.
 * @param limit - max rows (per page).
 * @param cursor - previous page's smallest sort_seq (exclusive), or undefined for the newest page.
 * @param selfUsername - logged-in account wxid (used to mark own messages);
 *   when empty, a private-chat heuristic compares the sender against the talker.
 * @returns the messages snapshot.
 */
export declare function queryMessages(decryptedDir: string, talker: string, limit?: number, cursor?: number, selfUsername?: string): MessagesSnapshot;
/**
 * Resolve one message by its server_id (merged chat-log nested pointers).
 * Scans every message shard / Msg table; only type-49 appmsg cards are
 * resolved.
 * @param decryptedDir - decrypted data root.
 * @param serverId - server_id as string (may exceed 2^53).
 * @returns found flag plus the parsed message (when found).
 */
export declare function queryMessageByServerId(decryptedDir: string, serverId: string): {
    found: boolean;
    message?: WechatMessage;
};
//# sourceMappingURL=messages.d.ts.map