import type { AnnualReview } from './annual-review-types.ts';
export type { AnnualBuddy, AnnualBusiestDay, AnnualCatchphrase, AnnualEmoji, AnnualHighlight, AnnualMonthlyStar, AnnualNight, AnnualOpener, AnnualRankRow, AnnualReply, AnnualReview, AnnualRhythm, AnnualWords, } from './annual-review-types.ts';
/** 秒 → 可读时长。 */
export declare function humanDur(sec: number): string;
export declare function queryAnnualReview(decryptedDir: string, year: number, selfUsername?: string): Promise<AnnualReview>;
