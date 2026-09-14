/** 榜单条目。 */
export interface AnnualRankRow {
    username: string;
    name: string;
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
    count: number;
}
/** 深夜卡。 */
export interface AnnualNight {
    share: number;
    mine: number;
    theirs: number;
    topName: string;
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
    avgPartnerSec: number;
    fastestName: string;
    fastestSec: number;
    slowestName: string;
    slowestSec: number;
}
/** 谁先开口。 */
export interface AnnualOpener {
    mine: number;
    theirs: number;
    share: number;
    mostInitiatedByMe: Array<{
        name: string;
        count: number;
    }>;
    mostInitiatedByThem: Array<{
        name: string;
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
}
/** 秒 → 可读时长。 */
export declare function humanDur(sec: number): string;
/**
 * 计算某年的完整年度回顾。
 * @param decryptedDir - 解密数据根。
 * @param year - 自然年。
 * @param selfUsername - 登录账号 wxid（「我发出的」归属判据）。
 * @returns 年度回顾结果。
 */
export declare function queryAnnualReview(decryptedDir: string, year: number, selfUsername?: string): AnnualReview;
