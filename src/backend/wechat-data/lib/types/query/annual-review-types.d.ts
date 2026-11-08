/**
 * 年度回顾结果契约。
 *
 * 这些类型是 Remote 与界面之间的稳定边界，和扫描算法分开放置，避免
 * `annual-review.ts` 因结果字段增长而继续逼近单文件行数上限。
 */
import type { AnnualMoments } from './annual-moments.ts';
import type { AnnualAssets } from './annual-assets.ts';
import type { AnnualGroups, AnnualMoney, AnnualRevoke } from './annual-extras.ts';
/** 榜单条目。 */
export interface AnnualRankRow {
    username: string;
    name: string;
    enterpriseName?: string;
    total: number;
    mine: number;
    theirs: number;
}
/** 最疯的一天。 */
export interface AnnualBusiestDay {
    date: string;
    n: number;
    ratio: number;
    share: number;
    topName: string;
    topEnterpriseName?: string;
    topUsername: string;
    topCount: number;
    firstAt: string;
    firstText: string;
    lastAt: string;
    lastText: string;
    spanMin: number;
}
/** 年度搭子（单聊里双方合计最多的一位）。 */
export interface AnnualBuddy {
    username: string;
    name: string;
    total: number;
    mine: number;
    theirs: number;
    enterpriseName?: string;
    streakDays: number;
    commonHour: number;
    replyBacks: number;
    fastestSec: number;
    slowestSec: number;
}
/** 十二个月的主演。 */
export interface AnnualMonthlyStar {
    month: number;
    username: string;
    name: string;
    enterpriseName?: string;
    count: number;
}
/** 深夜卡。 */
export interface AnnualNight {
    share: number;
    mine: number;
    theirs: number;
    topName: string;
    topEnterpriseName?: string;
    topUsername: string;
    topCount: number;
    sampleAt: string;
    sampleText: string;
}
/** 作息切片。 */
export interface AnnualRhythm {
    heat: number[];
    brightestDow: number;
    brightestHour: number;
    brightestCount: number;
    quietestHour: number;
    quietestCount: number;
    nightShare: number;
    workWeekendRatio: number;
}
/** 你说的话。 */
export interface AnnualWords {
    mineChars: number;
    receivedChars: number;
    keystrokes: number;
    voiceSentCount: number;
    voiceSentSec: number;
    voiceRecvCount: number;
    voiceRecvSec: number;
    callSec: number;
    callCount: number;
    callConnected: number;
    callMissed: number;
    videoSent: number;
    voiceMsgSent: number;
    longestVoiceSec: number;
    longestVoiceFrom: string;
    longestVoiceUsername: string;
    longestVoiceEnterpriseName?: string;
}
/** 年度口头禅。 */
export interface AnnualCatchphrase {
    phrase: string;
    count: number;
    top: Array<{
        phrase: string;
        count: number;
    }>;
    /** 出现过的短表达（去重）数量。 */
    shortTotal: number;
    /** 其中够格当「口头禅」的（出现 >= CATCH_MIN_COUNT 次）。 */
    catchTotal: number;
}
/** 回复速度。 */
export interface AnnualReply {
    medianSec: number;
    p90Sec: number;
    avgPartnerName: string;
    avgPartnerUsername: string;
    avgPartnerSec: number;
    avgPartnerEnterpriseName?: string;
    fastestName: string;
    fastestUsername: string;
    fastestSec: number;
    fastestEnterpriseName?: string;
    slowestName: string;
    slowestUsername: string;
    slowestSec: number;
    slowestEnterpriseName?: string;
}
/** 谁先开口。 */
export interface AnnualOpener {
    mine: number;
    theirs: number;
    share: number;
    mostInitiatedByMe: Array<{
        username: string;
        name: string;
        enterpriseName?: string;
        count: number;
    }>;
    mostInitiatedByThem: Array<{
        username: string;
        name: string;
        enterpriseName?: string;
        count: number;
    }>;
}
/** 表情宇宙。 */
export interface AnnualEmoji {
    /** 贴纸：甩出张数 / 攒下种数。 */
    threw: number;
    kept: number;
    perDay: number;
    days: number;
    peakDow: number;
    peakHour: number;
    peakCount: number;
    top: Array<{
        emoji: string;
        count: number;
    }>;
}
/** 「还有这些人」横向卡片。 */
export interface AnnualHighlight {
    label: string;
    name: string;
    username: string;
    enterpriseName?: string;
    value: string;
}
/** 完整结果。 */
export interface AnnualReview {
    year: number;
    sent: number;
    sentTo: number;
    sentDailyAvg: number;
    activeDaysMine: number;
    longestStreak: number;
    newFriends: number;
    mediaSent: number;
    longestSpanFrom: string;
    longestSpanTo: string;
    calendar: Array<{
        d: string;
        n: number;
    }>;
    activeDaysAll: number;
    maxDayAll: number;
    busiest: AnnualBusiestDay | null;
    buddy: AnnualBuddy | null;
    monthlyStar: AnnualMonthlyStar[];
    starName: string;
    starUsername: string;
    starMonths: number;
    starEnterpriseName?: string;
    hottestMonth: number;
    hottestMonthCount: number;
    night: AnnualNight;
    rhythm: AnnualRhythm;
    words: AnnualWords;
    catchphrase: AnnualCatchphrase;
    reply: AnnualReply;
    opener: AnnualOpener;
    ranking: AnnualRankRow[];
    emoji: AnnualEmoji;
    highlights: AnnualHighlight[];
    firstAt: string;
    firstText: string;
    lastAt: string;
    lastText: string;
    moments: AnnualMoments;
    assets: AnnualAssets;
    money: AnnualMoney;
    revoke: AnnualRevoke;
    groups: AnnualGroups;
}
