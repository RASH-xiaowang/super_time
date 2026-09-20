interface FileItem {
    md5: string;
    fileName: string;
    fileSize: number;
    modifyTime: number;
    category: string;
    /** Source chat display name resolved from message resource, when available. */
    sessionName?: string;
    /** Source message create time, when available. */
    sourceTime?: number;
    /**
     * 来源月份（第 84 轮新增）：`dir1`/`dir2` → `dir2id` 里 `YYYY-MM` 形态的值。
     * 实测三表 100% 可解析（图片 2717、视频 131、文件 579 全部有值）。
     */
    sourceMonth?: string;
    /**
     * 来源会话显示名（第 84 轮新增）：`dir2id` 的值实测是 **md5(username)**
     * （80 个十六进制值里 79 个能反查到 username），据此可直接给出「这张图来自哪个会话」——
     * 与 message_resource 口径的 `sessionName` 独立，且对**视频/文件**同样可用。
     */
    sourceTalker?: string;
}
/**
 * Read resource files.
 *
 * 第 83 轮重写：原先按「每张表各取 cap 行 → 拼接 → 再 slice(offset, offset+limit)」做分页，
 * 这不是分页 —— 第 2 页拿到的是「拼接后第 30~60 行」，即**另一张表的前 30 行**，
 * 于是客户端翻页会跨类目跳、并且永远翻不到第三张表（图片 2717 行 > 任何一页的容量）。
 * 实测后果：「文件资产」页签只显示图片（2717），视频 131 与文件 579 **全库都打不开**。
 *
 * 现在改为一条 `UNION ALL` + 全局 `ORDER BY modify_time DESC LIMIT ? OFFSET ?`：
 * 分页跨类目按时间正确排序、也不会重叠；并新增 `category` 过滤与 `counts` 分类计数，
 * 让界面能给出「全部 / 图片 / 视频 / 文件」四个带真实条目的入口。
 *
 * @param decryptedDir - decrypted data root.
 * @param limit - page size (default 100).
 * @param offset - page offset (default 0).
 * @param category - optional category filter: 'image' | 'file' | 'video' (其它值/空 = 全部).
 * @returns the files snapshot: page rows, the filtered total and per-category counts.
 */
export declare function queryFiles(decryptedDir: string, limit?: number, offset?: number, category?: string, 
/**
 * 关键词：匹配 `file_name` **或 `md5`**。
 *
 * 为什么在服务端做：此前界面「搜索时一次性拉 500 条再本地过滤」，而文件总量实测 4305
 * —— 覆盖率 11.6%，且界面完全不提示，用户会以为「这个文件不存在」。
 * 另外客户端那个 filter 写成 `(fileName || md5)`，`||` 短路让 md5 **永远不参与比较**，
 * 所以「按 MD5 搜」在这个版本里根本没实现过。
 */
q?: string): {
    files: FileItem[];
    total: number;
    counts: Record<string, number>;
};
export {};
