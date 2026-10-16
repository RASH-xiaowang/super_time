/** 收藏 / 文件总量盘点结果。 */
export interface AnnualAssets {
    /** 收藏条数（**总量，不是按年** —— 收藏表没有时间列，界面上必须写清）。 */
    favorites: number;
    /** 收发的文件类消息条数（总量）。 */
    files: number;
    /** 文件总大小（字节，总量）。 */
    bytes: number;
    /** 我发出的文件条数（总量）。 */
    sentFiles: number;
    /** 数据来源是否可用。 */
    available: boolean;
}
/**
 * 年度报告 · 收藏 / 文件总量盘点。
 *
 * ⚠️ 返回的是**至今总量**，不是"这一年的"：收藏表与文件表没有可靠的按年时间列
 * （为什么、以及哪一列不能用，见本文件头部「口径」表）。界面必须写「总量盘点」。
 * @param decryptedDir - 解密库根目录。
 * @param selfUsername - 登录账号 wxid（用于统计"我发出的文件"；不传则 `sentFiles` 恒为 0）。
 * @returns 收藏条数 / 文件条数 / 文件总字节 / 我发出的文件条数，以及数据源是否可用。
 */
export declare function queryAnnualAssets(decryptedDir: string, selfUsername?: string): Promise<AnnualAssets>;
