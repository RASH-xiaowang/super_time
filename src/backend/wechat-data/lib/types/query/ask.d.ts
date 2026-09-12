/** One citation (source message) for an Ask answer. */
export interface AskCitation {
    name: string;
    time: string;
    snippet: string;
    username: string;
    local_id: number;
}
/** Optional retrieval scope: one talker and/or an inclusive date range (YYYY-MM-DD). */
export interface AskScope {
    username?: string;
    from?: string;
    to?: string;
}
/**
 * Build the retrieval context for a question: search the message index with
 * the raw question then CJK bigrams, union the top hits, and return citations.
 * @param decryptedDir - decrypted data root.
 * @param question - the user question.
 * @param limit - max context hits (default 20).
 * @param scope - optional talker and/or date-range filter.
 * @returns the formatted context lines plus source citations.
 */
export declare function buildAskContext(decryptedDir: string, question: string, limit?: number, scope?: AskScope): {
    context: string;
    citations: AskCitation[];
};
//# sourceMappingURL=ask.d.ts.map