/**
 * Shared key-recovery constants and result types for the WeChat key modules
 * (migrated from WeChatDataAnalysis key_v4 / image_key_* / key_store).
 */
/** 32-byte database key length. */
export declare const KEY_SIZE = 32;
/** V4 SQLCipher PBKDF2 iteration count (wx_key_v4.1). */
export declare const PBKDF2_ITERATIONS = 256000;
/** First page size verified against. */
export declare const PAGE_SIZE = 4096;
/** SQLCipher salt size. */
export declare const SALT_SIZE = 16;
/** AES block size. */
export declare const AES_BLOCK_SIZE = 16;
/** A recovered database key result. */
export interface DbKeyResult {
    /** Whether a key was found. */
    ok: boolean;
    /** 64-char hex database key (XOR-masked form as stored by WeChat). */
    key?: string;
    /** Source describing how the key was recovered. */
    source?: string;
    /** Human-readable error when not ok. */
    error?: string;
}
/** A recovered image key pair result. */
export interface ImageKeyResult {
    /** Whether a verified image key pair was found. */
    ok: boolean;
    /** Image XOR byte (0-255). */
    xorKey?: number;
    /** 16-char ASCII AES key. */
    aesKey?: string;
    /** Verified against a real V2 image block. */
    verified?: boolean;
    /** wxid the key was derived for. */
    wxid?: string;
    /** kvcomm code used. */
    code?: number;
    /** Source template path. */
    templatePath?: string;
    /** Human-readable error when not ok. */
    error?: string;
}
/** One stored account key record (key_store format). */
export interface StoredAccountKeys {
    db_key?: string;
    db_key_source_wxid_dir?: string;
    db_key_source_db_storage_path?: string;
    image_xor_key?: string;
    image_aes_key?: string;
    image_key_verified?: boolean;
    image_key_source?: string;
    image_key_source_wxid_dir?: string;
    image_key_derived_wxid?: string;
    image_key_code?: number;
    updated_at?: string;
}
/** Key-store file: account id → record. */
export type KeyStore = Record<string, StoredAccountKeys>;
//# sourceMappingURL=types.d.ts.map