/**
 * Daily message counts for one talker in a month (local time).
 * @param decryptedDir - decrypted data root.
 * @param username - conversation username.
 * @param year - calendar year.
 * @param month - calendar month (1-12).
 * @returns day -> count plus the requested year/month.
 */
export declare function getDailyCounts(decryptedDir: string, username: string, year: number, month: number): {
    counts: Record<string, number>;
    year: number;
    month: number;
};
