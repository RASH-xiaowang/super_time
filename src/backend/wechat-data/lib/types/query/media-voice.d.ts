/**
 * server_id for (username, local_id) from the message shards.
 *
 * `local_id` is reused when WeChat shards/rebuilds old history, so a first-row
 * match is not safe. Only return a value when the voice rows agree on exactly
 * one server id; callers that already have the message's server id should pass
 * it explicitly.
 * @returns the server id as text (bigints exceed the safe-integer range).
 */
export declare function messageServerIdByLocal(decryptedDir: string, username: string, localId: number): string | null;
/**
 * Look up one voice message.
 * @param decryptedDir - decrypted data root.
 * @param username - conversation username.
 * @param localId - message local id.
 * @param explicitSvrId - the selected message's server id, when available.
 * @returns voice info; svrId as text (bigints exceed the safe-integer range);
 * decodable=false when no Node silk decoder is available.
 */
export declare function resolveVoiceInfo(decryptedDir: string, username: string, localId: number, explicitSvrId?: string): {
    available: boolean;
    svrId?: string;
    length?: number;
    decodable: boolean;
    error?: string;
};
