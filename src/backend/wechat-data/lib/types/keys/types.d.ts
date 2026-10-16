/**
 * Shared key-recovery result types for the WeChat key modules
 * (migrated from WeChatDataAnalysis key_v4 / image_key_* / key_store).
 *
 * 这里原来还有一组「共享常量」（KEY_SIZE / PBKDF2_ITERATIONS / PAGE_SIZE / SALT_SIZE /
 * AES_BLOCK_SIZE）—— 实测**没有任何模块引用过它们**（P3-8）：真正在用的那份数值各自定义在
 * `db-key-v4.ts` / `db-key-verify.ts` / `image-key-resolver.ts` 里。留着等于"同一个数字有
 * 两处出处而只有一处承重"，改的人只会改到自己用的那一份。已删除；
 * 要收口成一处应当连同那三份一起改（那是密钥路径上的实质改动，另刀做）。
 */
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
