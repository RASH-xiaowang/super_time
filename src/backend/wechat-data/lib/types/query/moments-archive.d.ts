/**
 * 归档库路径。
 *
 * 生产布局是 `<数据根>/decrypted`，所以归档放 `<数据根>/moments-archive.db`（与
 * `decoded_images` 同级，不随解密目录被重写）。显式 pin 的解密目录（`DSH_WECHAT_DECRYPTED_DIR`）
 * 或测试里直接把数据根当 `decryptedDir` 传进来时，放在该目录**里面**：
 * 共享 `%TEMP%` 上写同名库会让并行用例互相污染，那比「目录里多一个自建库」更坏。
 * @param decryptedDir - 解密数据根。
 * @returns 归档库路径。
 */
export declare function momentsArchivePath(decryptedDir: string): string;
/** 一条待归档的朋友圈（payload 已由 `moments.ts` 解析好）。 */
export interface ArchivedMomentInput {
    tid: string;
    username: string;
    /** 展示名快照（备注 → 昵称 → ID），好友删了也还能显示。 */
    author: string;
    /** 创建时间（秒）。 */
    ts: number;
    /** 原始 content XML；parser 升级后可重放。 */
    content: string;
    /** content 的 sha1（省略时由 SQL 不去重，只用于判断「内容变没变」）。 */
    contentHash: string;
    /** `JSON.stringify(MomentEntry)`；包含文本/图片/视频/位置/点赞/评论。 */
    payload: string;
}
/** 归档行（读出来交给 `moments.ts` 反序列化）。 */
export interface ArchivedMomentRow {
    tid: string;
    username: string;
    author: string;
    ts: number;
    content: string;
    contentHash: string;
    payload: string;
    archivedAt: number;
    lastSeenAt: number;
}
/**
 * 归档库是否存在（读路径不建库：没有归档时由调用方回退线上表）。
 * @param decryptedDir - 解密数据根。
 * @returns 存在且是普通文件时为 true。
 */
export declare function hasMomentsArchive(decryptedDir: string): boolean;
/**
 * 读已归档的 `tid → contentHash` 索引，用于只解析「内容变了」的行。
 * @param decryptedDir - 解密数据根。
 * @returns 索引；归档库不存在/不可读时为 `null`（调用方应按「全部未归档」处理）。
 */
export declare function readArchivedMomentHashes(decryptedDir: string): Map<string, string> | null;
/**
 * 读归档里的洞察明细（含已被删除的帖子）。
 * @param decryptedDir - 解密数据根。
 * @param author - 可选作者 username。
 * @returns `{tid, username, ts, payload}`；归档库不存在时为空数组。
 */
export interface ArchivedInsightRow {
    tid: string;
    username: string;
    ts: number;
    payload: string;
}
export declare function readArchivedInsightRows(decryptedDir: string, author?: string): ArchivedInsightRow[];
/**
 * 读一批 `tid → payload`（用于「好友删了评论/点赞/图片后，归档仍保留旧条目」的合并）。
 * @param decryptedDir - 解密数据根。
 * @param tids - 需要读的 tid。
 * @returns map；归档库不存在时为空 map。
 */
export declare function readArchivedPayloads(decryptedDir: string, tids: readonly string[]): Map<string, string>;
/**
 * 幂等写入一批归档行（`INSERT` 或更新内容/展示名/最后可见时间）。
 *
 * 为什么更新而不是 `INSERT OR IGNORE`：好友还在的帖子会新增评论/点赞，只增不改会把
 * 社交信息永远停在第一次看到的时刻；但「删帖后保留」不需要更新 —— 线上行消失后
 * 根本不会再有输入行，所以更新只发生在「仍存在」的 tid 上。
 * @param decryptedDir - 解密数据根。
 * @param records - 已解析的记录。
 * @returns 新插入/更新条数；库不可写时返回 `{added:0, updated:0}`。
 */
export declare function upsertArchivedMoments(decryptedDir: string, records: readonly ArchivedMomentInput[]): {
    added: number;
    updated: number;
};
/**
 * 从归档库读一页朋友圈（按 tid 数值倒序：新动态在前）。
 * @param decryptedDir - 解密数据根。
 * @param opts - 分页与可选作者（username，不是展示名）。
 * @returns 行与总数；归档库不存在时为 `null`（调用方回退线上表）。
 */
export declare function readArchivedMoments(decryptedDir: string, opts: {
    offset: number;
    limit: number;
    authorUsername?: string;
}): {
    rows: ArchivedMomentRow[];
    total: number;
} | null;
/**
 * 全量作者条数（来自归档库）。
 * @param decryptedDir - 解密数据根。
 * @returns 作者 username / 最近展示名 / 条数；归档库不存在时为 `null`。
 */
export declare function readArchivedAuthors(decryptedDir: string): Array<{
    username: string;
    author: string;
    count: number;
}> | null;
/**
 * 全量月度分布（来自归档库，含已被删除的帖子）。
 *
 * 展示名可能被改（备注变化），而归档里存的是**归档当时**的名字；所以作者牌过滤
 * 不能直接拿 `author = ?` 去比。传 `names`（当前 contact 名表）时按 username 映射后
 * 在 JS 里过滤，这样「改了备注」和「好友已删」都不会漏/多算。
 * @param decryptedDir - 解密数据根。
 * @param opts - 可选 username / 展示名过滤与当前展示名映射。
 * @returns `YYYY-MM → count`；归档库不存在时为 `null`。
 */
export declare function readArchivedMonthly(decryptedDir: string, opts?: {
    authorUsername?: string;
    authorName?: string;
    names?: ReadonlyMap<string, string>;
}): Array<{
    month: string;
    count: number;
}> | null;
/**
 * 归档一张头像（本地已解出的 data URL）。只在数据非空时写入；
 * `name` 也一起快照，好友被删后仍有展示名。
 * @param decryptedDir - 解密数据根。
 * @param username - 微信 username（稳定键，不能用展示名）。
 * @param name - 展示名（可为空）。
 * @param avatar - `data:image/...;base64,...`（可为空）。
 */
export declare function saveArchivedAvatar(decryptedDir: string, username: string, name: string, avatar: string): void;
/** 批量归档头像的输入。 */
export interface ArchivedAvatarInput {
    username: string;
    name: string;
    avatar: string;
}
/**
 * 批量归档头像（一个事务，避免一屏 30 个头像开 30 次库）。
 * @param decryptedDir - 解密数据根。
 * @param records - 头像记录；空记录/空 username 的项会被跳过。
 */
export declare function saveArchivedAvatars(decryptedDir: string, records: readonly ArchivedAvatarInput[]): void;
/**
 * 读归档头像（好友已删 / 本机 head_image.db 没有时的兜底）。
 * @param decryptedDir - 解密数据根。
 * @param username - 微信 username。
 * @returns data URL；没有归档/没有头像时为 null。
 */
export declare function readArchivedAvatar(decryptedDir: string, username: string): string | null;
/**
 * 批量读归档头像。
 * @param decryptedDir - 解密数据根。
 * @param usernames - 微信 username 列表。
 * @returns username → data URL（只含有头像的项）。
 */
export declare function readArchivedAvatars(decryptedDir: string, usernames: readonly string[]): Record<string, string>;
