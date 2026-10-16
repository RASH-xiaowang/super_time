export declare const PAGE_SZ = 4096;
export declare const SALT_SZ = 16;
export declare const IV_SZ = 16;
export declare const RESERVE_SZ = 80;
export declare const PBKDF2_ITERS = 256000;
export declare const SQLITE_HDR: Buffer<ArrayBuffer>;
/** Read exactly the first n bytes of a file (readFileSync has no length option). */
export declare function readPrefix(file: string, n: number): Buffer;
/**
 * 读 SQLite 页 1 头部偏移 20 的**预留字节数**（读不到按 0 处理）。
 *
 * 真实微信库是 SQLCipher 创建的、每页原生预留 80 字节（页尾只放 IV+HMAC）；
 * 测试夹具（node:sqlite 建的库）预留为 0（页尾是指针区）。发布前的 quick_check
 * 自检只在预留非 0 的库上有意义——零尾补丁对预留 0 的库必然破坏指针区。
 */
export declare function reserveByteOf(file: string): number;
/** Derive the per-database AES-256 key (wx_key_v4.1 PBKDF2, else raw). */
export declare function deriveEncKey(rawKey: Buffer, salt: Buffer, keyFormat?: string): Buffer;
/**
 * Decrypt one SQLCipher page (pgno is 1-based) into a plain SQLite page.
 * The per-page IV lives at the page tail; page 1 additionally prefixes the
 * decrypted payload with the SQLite header (the salt occupied those 16 bytes
 * on disk), matching st_control's decrypt_page output layout.
 */
export declare function decryptPage(encKey: Buffer, page: Buffer, pgno: number): Buffer;
