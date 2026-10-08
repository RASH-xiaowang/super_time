/**
 * 一条「算进本年度」的朋友圈在扫描期的中间形态。
 *
 * 导出它只为让 {@link summarizeAnnualMoments} 的签名在 `lib/types` 里自洽
 * （`tsc` 会把出现在导出签名里的类型一并写进 .d.ts）；业务上不需要自己构造它。
 */
export interface ScannedPost {
    /** 正文（已折成单行纯文本，见 {@link plainText}）。 */
    text: string;
    /** `createTime`（unix 秒）；0 表示这条 XML 里读不到时间。 */
    ts: number;
    likes: number;
    comments: number;
}
/** 年度朋友圈统计。 */
export interface AnnualMoments {
    /** 全年朋友圈条数。 */
    count: number;
    /** 最热一条：点赞+评论总数最多（并列取更早的那条）；没有则 null。 */
    topPost: {
        at: string;
        likes: number;
        comments: number;
        excerpt: string;
    } | null;
    /** 发得最多的月份（1..12）与条数；没有则 null。 */
    topMonth: {
        month: number;
        count: number;
    } | null;
    /** 0..6 点发的条数。 */
    lateNight: number;
    /** 数据来源是否可用（没有朋友圈库时为 false —— 界面据此显示"未读取到朋友圈数据"，不许显示 0 当真实值）。 */
    available: boolean;
}
/**
 * 纯函数：把「本年度的条目」折成卡片数据。**不碰数据库**，便于用例直接钉口径。
 *
 * 口径：
 *   · `count` 就是传进来的条数；
 *   · `topPost` = 点赞+评论总数最多的一条，**并列取更早的那条**（`ts` 小的胜；
 *     `ts` 都是 0 时保持扫描顺序里的第一条，因为无法比较先后）；
 *   · `topMonth` = 条数最多的月份，**并列取更小的月份**（读者预期是「年初那个」）；
 *   · `lateNight` = 0..6 点（含 6 点整）的条数；`ts` 为 0 的条目**不计入**，
 *     因为它没有时刻可言，凭空算进任一小时都是编数。
 * @param posts - 本年度条目（扫描顺序）。
 * @returns 年度朋友圈统计（`available` 由调用方按数据源情况覆盖）。
 */
export declare function summarizeAnnualMoments(posts: ScannedPost[]): Omit<AnnualMoments, 'available'>;
/**
 * 年度报告 · 朋友圈年度统计。
 * @param decryptedDir - 解密库根目录。
 * @param year - 年份。
 * @returns 全年条数 / 最热一条 / 发得最多的月份 / 深夜条数，以及数据源是否可用。
 */
export declare function queryAnnualMoments(decryptedDir: string, year: number): Promise<AnnualMoments>;
