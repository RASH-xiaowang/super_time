/**
 * Resolve a user avatar.
 * Priority: head_image.db by username -> contact URL (temp cache data URL first) ->
 * contact matched by nick_name (same URL/temp-cache path) -> none.
 * @param decryptedDir - decrypted data root.
 * @param username - contact or chatroom username.
 * @param wechatBaseDir - raw WeChat install root (temp/head_image cache).
 * @param nickname - optional display name for contact-by-nickname fallback.
 * @returns kind + data URL / remote URL.
 */
export declare function resolveAvatar(decryptedDir: string, username: string, wechatBaseDir?: string, nickname?: string): {
    kind: string;
    data?: string;
    url?: string;
};
/**
 * 批量读取全部本地头像:单次打开 head_image.db,返回 username → data URL。
 * 本地优先(头像绝不走网络);未命中者不出现在结果中。
 */
export declare function resolveAvatarsLocal(decryptedDir: string, usernames: string[]): Record<string, string>;
//# sourceMappingURL=avatar.d.ts.map