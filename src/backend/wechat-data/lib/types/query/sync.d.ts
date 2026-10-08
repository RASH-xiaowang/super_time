/**
 * Cached raw-dir entries; refreshed when the directory signature changes.
 *
 * P1-1：这里原先 `catch { return [] }` —— 目录读不动（被占用 / 权限 / 网络盘断了 / 它是
 * 个文件）与「目录真的是空的」压成同一个值。后果不是少几行日志：`syncChangedShards`
 * 拿到空列表就是「所有分片都没变」，于是**实时同步静默停摆**，界面上的表现是
 * 「新消息永远不出现」，而原因完全查不到（第 47 轮那条「读失败不许当没有数据」的同族）。
 */
export interface DirListing {
    files: string[];
    error?: string;
}
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
/**
 * 源库签名。**用字符串而不是毫秒数**（2026-09-29 第 47 轮对齐缓存层口径）：
 * 缓存侧早已是 `mtimeNs + size`（`meta.ts` 的 `fileSig`，同口径），
 * 而这里一直只比 `mtimeMs` —— 同毫秒内的写入它**看不见**，`mode` 会误判成 `wal`，
 * 于是那个分片的改动要等下一次变得更多才会被同步到。
 * 现在改成纳秒 + 大小（NTFS 100ns 精度，实测 `statSync(...,{bigint:true})` 与普通 stat 开销无差别）。
 */
interface ShardSig {
    main: string;
    wal: string;
}
/**
 * 「这页解对了没有」的判据 —— 只看 SQLite 页 1 头部里**不能被合成**的字段。
 *
 * 为什么必须有：`decryptPage` 给页 1 无条件贴上 `SQLite format 3\0`（磁盘上那 16 字节是
 * salt，明文里本来就该有魔数），所以**魔数不构成证据** —— 旧实现拿前 15 字节比对魔数，
 * 密钥错也永远为真，于是「解密结果无效」这道闸门（本文件 9 处 + 全量解密 1 处）形同虚设：
 * 错密钥会把一坨乱码发布成快照，面板读到的是「库打不开/查无数据」，而日志一片绿。
 * 真正的证据是加密区里的头部字段：偏移 16-17 的页大小必须是 `[512, 65536]` 内的 2 的幂
 * （`65536` 编码成 1），随机明文撞上它的概率约 16/65536 ≈ 0.02%。
 *
 * 为什么还要再看 18/19/21/22/23：**0.02% 不是抽象风险** —— 全量解密一次要判几百个库，
 * 每轮同步都在判，跑得够久就一定撞得上一次，而撞上的表现是「一个错密钥的乱码库被发布成
 * 快照」（正是这条判据要防的事）。SQLite 规范写死这三个字段：读/写格式只能是 1 或 2，
 * 三个 payload fraction 必须是 64/32/32。加上它们，随机撞过的概率降到约 10⁻¹²。
 * 刻意**不**校验偏移 20 的 reserved（微信那类库这里是 80，不是 0）与偏移 40 的 encoding
 * （要为此多读文件头，收益一样、风险更大）。
 * @param head - 解密产物的前若干字节（至少 24 个）。
 * @returns 是否像一个真库。
 */
export declare function plausibleSqliteHeader(head: Buffer): boolean;
/**
 * True when the target exists and its data (not mtime) is usable.
 * 导出是为了让「全量解密」与「实时同步」共用同一个判据（两处各写一份就等于没写）。
 */
export declare function looksDecrypted(dbPath: string): boolean;
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
 * 只清空 full-decrypt 冷却（测试用）。
 *
 * 为什么要与上面的退避分开：`syncPlainDatabase` 这类路径上"没有重试"可能来自**两个**原因
 * （退避，或 6 秒的 full-decrypt 冷却）。测试要能**分别**把这两个原因钉住 ——
 * 只清冷却、保留退避，若仍然没有重试，那就是退避在起作用（见
 * `tests/sync-failure-backoff.spec.ts` 的集成用例）。
 */
export declare function forgetFullDecryptCooldown(): void;
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
 * @returns `synced` = 同步了什么；`errors` = 哪些读取失败了（**空数组才是「真的没变化」**）。
 */
export declare function syncChangedShards(rawDbDir: string, decryptedDir: string, lastState: Map<string, ShardSig>): Promise<{
    synced: string[];
    errors: string[];
}>;
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
