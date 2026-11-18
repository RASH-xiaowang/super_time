import type { AnnualReview } from './annual-review-types.ts';
export declare function queryAnnualReview(decryptedDir: string, year: number, selfUsername?: string): Promise<AnnualReview>;
