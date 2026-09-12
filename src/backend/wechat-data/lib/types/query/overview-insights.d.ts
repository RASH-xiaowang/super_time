import type { OverviewExtras } from '../types.ts';
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
export declare function queryOverviewInsights(decryptedDir: string): OverviewInsights;
//# sourceMappingURL=overview-insights.d.ts.map