/**
 * Shared key-recovery constants and result types for the WeChat key modules
 * (migrated from WeChatDataAnalysis key_v4 / image_key_* / key_store).
 */
/** 32-byte database key length. */
export const KEY_SIZE = 32;
/** V4 SQLCipher PBKDF2 iteration count (wx_key_v4.1). */
export const PBKDF2_ITERATIONS = 256000;
/** First page size verified against. */
export const PAGE_SIZE = 4096;
/** SQLCipher salt size. */
export const SALT_SIZE = 16;
/** AES block size. */
export const AES_BLOCK_SIZE = 16;
//# sourceMappingURL=types.js.map