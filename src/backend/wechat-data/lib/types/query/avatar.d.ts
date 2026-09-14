/**
 * Resolve a user avatar.
 * Priority: head_image.db by username -> contact URL (temp cache data URL first) ->
 * 远端 https URL -> contact matched by nick_name（同样顺序）-> none.
 *
 * 第 41 轮改动：本地实在没有时**返回 https 远端 URL**（此前直接返回 none，
 * 连 URL 都丢掉）。实测本地覆盖只有 17.4%（head_image.db 356 行 + temp 缓存 28 个），
 * 而 79.2% 的联系人有可用的 https 头像 URL；前端 6 处调用点**早已**写好
 * `kind === 'url'` 分支（只是后端从不返回）。
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
