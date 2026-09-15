/**
 * SQLCipher 4 密钥校验与 `all_keys.json` 生成（密钥层的一部分）。
 *
 * 为什么从 `query/config.ts` 搬到这里（M24）：`keys/db-key-v4.ts` 校验内存里捞出来的候选密钥
 * 时需要 `verifyDbKey`，而 keys 是最底层能力 —— 让 keys 反向 import 上层的 query 就会与
 * `query/image-key.ts` → `keys/key-store.ts` 构成双向依赖。这里只依赖 `config/**`（更低的层）。
 *
 * SQLCipher 4: PBKDF2-HMAC-SHA512 + AES-256。
 */
/**
 * SQLCipher page-1 key verification (wx_key_v4.1 PBKDF2).
 * @param page1 - first page (4096 bytes) of the encrypted database.
 * @param wxKeyBin - 32-byte raw database key.
 * @returns whether the HMAC and AES checks pass.
 */
export declare function verifyDbKey(page1: Buffer, wxKeyBin: Buffer): {
    hmacOk: boolean;
    aesOk: boolean;
};
/**
 * Verify one database file with a 64-hex key.
 * @param dbPath - path to the encrypted database file.
 * @param encKeyHex - 64-char hex (32-byte) database key.
 * @returns validity plus per-check flags and any error.
 */
export declare function verifyDatabaseKey(dbPath: string, encKeyHex: string): {
    valid: boolean;
    aesOk?: boolean;
    hmacOk?: boolean;
    error?: string;
};
/**
 * Verify all DBs in db_dir and write all_keys.json (per-db per-file keys).
 * @param dbDir - directory containing the encrypted DBs to verify.
 * @param keysFile - output all_keys.json path.
 * @param encKeyHex - 64-char hex (32-byte) database key.
 * @param keyFormat - key format recorded in the file (default wx_key_v4.1).
 * @returns ok plus verified/total DB counts, or an error description.
 */
export declare function generateKeysFile(dbDir: string, keysFile: string, encKeyHex: string, keyFormat?: string): {
    ok: boolean;
    verified: number;
    total: number;
    error?: string;
};
