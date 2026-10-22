/** Which field the editor is changing. `text` is guarded to plain text rows only. */
export type MessageEditMode = 'text' | 'source';
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
 * Edit one message while preserving its original SQLite storage family.
 * @param decryptedDir - decrypted data root.
 * @param username - conversation username.
 * @param localId - message local id.
 * @param newContent - new visible text (text mode) or raw source (source mode).
 * @param mode - `text` rejects non-text rows; `source` allows structured payloads.
 * @returns result with ok + edited localId.
 */
export declare function editChatMessage(decryptedDir: string, username: string, localId: number, newContent: string, mode?: MessageEditMode): {
    ok: boolean;
    error?: string;
    localId?: number;
};
/**
 * Restore every snapshotted column to its original value and storage type.
 * @param decryptedDir - decrypted data root.
 * @param username - conversation username.
 * @param localId - message local id to restore.
 * @returns result with ok.
 */
export declare function resetEditedMessage(decryptedDir: string, username: string, localId: number): {
    ok: boolean;
    error?: string;
};
