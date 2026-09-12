import type { WechatSession } from '../types.ts';
/**
 * Read the session list from the decrypted session.db.
 * @param decryptedDir - st_control decrypted data root (…/data/wechat/decrypted).
 * @param keyword - optional username/name filter.
 * @param limit - max rows.
 * @returns the session snapshot.
 */
export declare function querySessions(decryptedDir: string, keyword?: string, limit?: number, offset?: number): {
    sessions: WechatSession[];
    total: number;
};
//# sourceMappingURL=sessions.d.ts.map