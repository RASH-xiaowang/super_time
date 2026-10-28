/**
 * server_id for (username, local_id) from the message shards.
 * @returns the server id as text (bigints exceed the safe-integer range).
 */
export declare function messageServerIdByLocal(decryptedDir: string, username: string, localId: number): string | null;
/**
 * Look up one voice message.
 * @param decryptedDir - decrypted data root.
 * @param username - conversation username.
 * @param localId - message local id.
 * @returns voice info; svrId as text (bigints exceed the safe-integer range);
 * decodable=false when no Node silk decoder is available.
 */
export declare function resolveVoiceInfo(decryptedDir: string, username: string, localId: number): {
    available: boolean;
    svrId?: string;
    length?: number;
    decodable: boolean;
    error?: string;
};
