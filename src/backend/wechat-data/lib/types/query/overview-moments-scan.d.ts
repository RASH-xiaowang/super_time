/** 朋友圈表每多少行让出一次。洞察的让出测试按这个数造数据。 */
export declare const SNS_YIELD_EVERY_ROWS = 2000;
export interface MomentsScanStats {
    total: number;
    images: number;
    videos: number;
    likes: number;
    comments: number;
}
export interface MomentsAuthorDraft {
    username: string;
    name: string;
    enterpriseName?: string;
    posts: number;
}
export interface MomentsScan {
    stats: MomentsScanStats;
    authors: MomentsAuthorDraft[];
}
/**
 * 读一次朋友圈表。签名是 `sns.db` 文件指纹；库不存在时返回空结果且不写入缓存。
 * @param dec - 已解密数据根。
 */
export declare function scanMomentsShared(dec: string): Promise<MomentsScan>;
/** 作者 Top 20。显示名在这里解析，所以通讯录变化不必让朋友圈扫描缓存失效。 */
export declare function momentAuthorsFromScan(scan: MomentsScan, dec: string): MomentsAuthorDraft[];
