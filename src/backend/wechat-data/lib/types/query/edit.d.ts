/** One edited-message record. */
export interface EditedMessageRecord {
    sessionId: string;
    db: string;
    tableName: string;
    localId: number;
    lastEditedAt: number;
    editCount: number;
    originalMsgJson: string;
}
/**
 * List edited messages (optionally for one session).
 * @param decryptedDir - decrypted data root.
 * @param sessionId - optional session to filter by.
 * @returns edited message records plus total count.
 */
export declare function listEditedMessages(decryptedDir: string, sessionId?: string): {
    items: EditedMessageRecord[];
    total: number;
};
/**
 * Edit one message content (writes to the decrypted shard + records the edit).
 * @param decryptedDir - decrypted data root.
 * @param username - conversation username.
 * @param localId - message local id.
 * @param newContent - new message content text.
 * @returns result with ok + edited localId.
 */
export declare function editChatMessage(decryptedDir: string, username: string, localId: number, newContent: string): {
    ok: boolean;
    error?: string;
    localId?: number;
};
/**
 * Restore a message to its original content from the edit store.
 * @param decryptedDir - decrypted data root.
 * @param username - conversation username.
 * @param localId - message local id to restore.
 * @returns result with ok.
 */
export declare function resetEditedMessage(decryptedDir: string, username: string, localId: number): {
    ok: boolean;
    error?: string;
};
