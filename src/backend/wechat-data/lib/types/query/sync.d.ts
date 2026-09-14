export declare function fullDecryptFile(dbPath: string, outPath: string, encKey: Buffer): Promise<number>;
/**
 * Patch a decrypted DB file with valid frames from an encrypted WAL.
 * @param walPath - encrypted WAL file path.
 * @param outPath - decrypted DB file to patch in place.
 * @param encKey - derived 32-byte AES-256 key.
 * @returns the number of frames patched.
 */
export declare function decryptWalPatch(walPath: string, outPath: string, encKey: Buffer): Promise<number>;
/** True when at least one WAL frame's salt epoch matches the WAL header,
 * i.e. the frames can be decrypted with the current snapshot key. WeChat
 * rotates the salt on login/checkpoint; when it does, frames carry a different
 * epoch and cannot be patched — the next main-DB rewrite (mtime change)
 * triggers a clean full decrypt instead. */
export declare function walFramesPatchable(walPath: string): Promise<boolean>;
/** Per-shard state: raw mtimes of the main db and its wal. */
interface ShardSig {
    main: number;
    wal: number;
}
/**
 * Atomically replace target with a fully-decrypted temp file (async retries).
 *
 * **不要**先 `unlink(target)`（旧实现如此）：那会在「删掉」与「改名」之间留出一个
 * 「目标不存在」的窗口，并发只读查询正好落在里面就是 ENOENT。
 * Windows 实测：rename 覆盖一个**已存在但未被打开**的文件是允许的
 * （MOVEFILE_REPLACE_EXISTING），所以正常路径下不需要删除；而目标被 SQLite 句柄
 * 打开时两种做法都会失败（rename → EPERM，unlink → EBUSY），真正让同步成功的是
 * 这里的重试等待。导出仅为让回归用例直接验证「替换期间目标始终存在」。
 * @param temp - 已解密好的临时文件。
 * @param target - 目标快照文件。
 */
export declare function atomicReplace(temp: string, target: string): Promise<void>;
/**
 * 64-hex raw key for a shard (all_keys.json per-file first, then config).
 * @param decryptedDir - decrypted data root (all_keys.json sits beside it).
 * @param relKey - per-file key entry (e.g. 'message/message_0.db').
 * @param fallbackHex - config `db_enc_key` used when no per-file entry fits.
 * @returns the 64-hex key string to use.
 */
export declare function resolveShardKey(decryptedDir: string, relKey: string, fallbackHex: string): string;
/**
 * Derive (and cache) the per-database AES-256 key.
 * @param decryptedDir - decrypted data root (cache namespace part).
 * @param relKey - per-file key entry (cache namespace part).
 * @param rawDbFile - encrypted source file (its first 16 bytes are the salt).
 * @param rawKeyHex - 64-hex raw key.
 * @param keyFormat - SQLCipher key format (`wx_key_v4.1` PBKDF2, else raw).
 * @returns the derived 32-byte key.
 */
export declare function deriveEncKeyCached(decryptedDir: string, relKey: string, rawDbFile: string, rawKeyHex: string, keyFormat: string): Buffer;
/**
 * Sync one message shard from the raw tree into the decrypted snapshot.
 * - mode 'full': re-decrypt the main DB (first sync or the main file changed)
 *   then WAL-patch the result; atomically replaces the snapshot.
 * - mode 'wal': the main snapshot is current and only the WAL grew — patch the
 *   changed frames into a staging copy of the snapshot (st_control's
 *   write-only-page model) and atomically replace.
 * @param rawMsgDir - raw message dir (encrypted).
 * @param decMsgDir - decrypted message dir.
 * @param file - shard file name (e.g. message_0.db).
 * @param rawKeyHex - fallback 64-hex raw key.
 * @param keyFormat - key format (wx_key_v4.1).
 * @param mode - full or wal-incremental.
 * @returns page counts for reporting.
 */
export declare function syncMessageShard(rawMsgDir: string, decMsgDir: string, file: string, rawKeyHex: string, keyFormat: string, mode?: 'full' | 'wal'): Promise<{
    fullPages: number;
    walPages: number;
}>;
/**
 * Scan raw shards and sync every changed one. The main file changing forces a
 * full re-decrypt; a WAL-only change applies an incremental frame patch.
 * @param rawDbDir - raw db_storage root.
 * @param decryptedDir - decrypted snapshot root.
 * @param lastState - per-shard signature state (mutated).
 * @returns descriptions of what was synced (file + mode + pages).
 */
export declare function syncChangedShards(rawDbDir: string, decryptedDir: string, lastState: Map<string, ShardSig>): Promise<string[]>;
/**
 * Sync session.db (the conversation list state) from the raw tree into the
 * decrypted snapshot — full re-decrypt when the main file changed, WAL frame
 * patch otherwise. The chat sidebar reads this table, so without it the
 * session list never reflects new messages.
 * @param rawDbDir - raw db_storage root.
 * @param decryptedDir - decrypted snapshot root.
 * @param lastState - shared per-target signature state.
 * @param rawKeyHex - fallback 64-hex raw key.
 * @param keyFormat - key format (wx_key_v4.1).
 * @returns descriptions of what was synced (empty when nothing changed).
 */
export declare function syncSessionDb(rawDbDir: string, decryptedDir: string, lastState: Map<string, ShardSig>, rawKeyHex: string, keyFormat: string): Promise<string[]>;
/**
 * Sync contact.db (contact/chatroom/friends names + members) from the raw
 * tree into the decrypted snapshot — full re-decrypt when the main file
 * changed, WAL frame patch otherwise. Without this, newly added contacts /
 * official accounts (gh_*) keep showing their raw username in the sidebar.
 * @param rawDbDir - raw db_storage root.
 * @param decryptedDir - decrypted snapshot root.
 * @param lastState - shared per-target signature state.
 * @param rawKeyHex - fallback 64-hex raw key.
 * @param keyFormat - key format (wx_key_v4.1).
 * @returns descriptions of what was synced (empty when nothing changed).
 */
export declare function syncContactDb(rawDbDir: string, decryptedDir: string, lastState: Map<string, ShardSig>, rawKeyHex: string, keyFormat: string): Promise<string[]>;
/**
 * Sync any plain "dbName" under rawRoot/<sub> -> decryptedDir/<sub> with the
 * shared full/WAL + 0-frame-upgrade policy (realtime coverage for general /
 * sns / favorite / bizchat / chatbot).
 * @returns descriptions of what was synced (empty when nothing changed).
 */
export declare function syncPlainDatabase(rawRoot: string, decryptedDir: string, sub: string, dbName: string, label: string, rawKeyHex: string, keyFormat: string, lastState: Map<string, ShardSig>): Promise<string[]>;
/**
 * Remove stale staging/temp files (`.stage_src`/`.stage_wal`/`.decrypt_tmp`)
 * left by a previously interrupted sync. A killed process can leave a
 * half-written snapshot behind, and a fresh run that reuses it can stall.
 * Real decrypted DB files are never matched.
 * @param root - decrypted snapshot root to sweep.
 */
export declare function cleanStaleStagingFiles(root: string): Promise<void>;
/**
 * Real-time sync loop: first run immediately, then poll on an interval.
 * @param rawDbDir - provider of the raw db_storage root (re-read per tick).
 * @param decryptedDir - provider of the decrypted snapshot root.
 * @param onSync - called with the shards that changed (empty when nothing new).
 * @returns a disposer that stops the loop.
 */
export declare function startRealtimeSync(rawDbDir: () => string, decryptedDir: () => string, onSync?: (shards: string[]) => void): () => void;
export {};
