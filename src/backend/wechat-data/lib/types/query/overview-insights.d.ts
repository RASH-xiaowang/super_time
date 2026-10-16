import type { OverviewExtras } from '../types.ts';
/**
 * 朋友圈整表扫每多少行让出一次。
 * 导出是给守卫用例**按这个数造数据**用的 —— 判据不该依赖墙上时钟（CI 机器比本机慢 20 倍，
 * 任何「跑够 25ms」的断言在那边都会假红）。
 */
export declare const SNS_YIELD_EVERY_ROWS = 2000;
export interface OverviewInsights {
    messages: {
        total: number;
        sent: number;
        received: number;
        text: number;
        image: number;
        voice: number;
        video: number;
        rich: number;
        system: number;
        revoked: number;
    };
    time: {
        activeDays: number;
        spanDays: number;
        busyHour: number;
        busyCount: number;
        hourDist: number[];
        deepNightPct: number;
        weekendPct: number;
        lastActive: string;
    };
    relations: {
        total: number;
        active: number;
        silent: number;
        groupsWithMsg: number;
        top: Array<{
            username: string;
            name: string;
            count: number;
        }>;
    };
    moments: {
        total: number;
        images: number;
        videos: number;
        likes: number;
        comments: number;
    };
    assets: {
        favorites: number;
        emoticons: number;
        files: number;
        fileBytes: number;
        mediaItems: number;
        mediaBytes: number;
    };
    health: {
        dbFiles: number;
        dbBytes: number;
        ok: boolean;
    };
    extras: OverviewExtras;
}
/**
 * Compute overview insights.
 * @param decryptedDir - decrypted data root.
 * @param selfUsername - logged-in account wxid, used to split 发出/收到.
 * @returns the insights snapshot.
 */
export declare function queryOverviewInsights(decryptedDir: string, selfUsername?: string): Promise<OverviewInsights>;
