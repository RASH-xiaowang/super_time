/**
 * List available years (descending) from actual message create_time values.
 * @param decryptedDir - decrypted data root.
 * @returns years with messages, and no count summary (a separate query owns it).
 */
export declare function queryAnnual(decryptedDir: string): {
    years: number[];
};
