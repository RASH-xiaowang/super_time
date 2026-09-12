/**
 * Clear one session draft (decrypted copy only).
 * @param decryptedDir - decrypted data root.
 * @param username - session username whose draft is cleared.
 * @returns ok + rows updated.
 */
export declare function clearSessionDraft(decryptedDir: string, username: string): {
    ok: boolean;
    updated: number;
    error?: string;
};
/**
 * Clear all session drafts, returning the cleared drafts list.
 * @param decryptedDir - decrypted data root.
 * @returns cleared drafts + count.
 */
export declare function clearAllSessionDrafts(decryptedDir: string): {
    ok: boolean;
    cleared: Array<{
        username: string;
        draft: string;
    }>;
    count: number;
    error?: string;
};
//# sourceMappingURL=drafts.d.ts.map