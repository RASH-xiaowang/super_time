import type { KeyStore, StoredAccountKeys } from './types.ts';
/** File name of the key store inside the data root. */
export declare const KEY_STORE_FILE = "keys.json";
/**
 * Resolve the key-store path for a data root.
 * @param dataRoot - DSH wechat data root.
 * @returns the absolute keys.json path.
 */
export declare function keyStorePath(dataRoot?: string): string;
/**
 * Read the whole key store (empty object when absent or corrupt).
 * @param dataRoot - DSH wechat data root.
 * @returns the parsed store.
 */
export declare function loadAccountKeysStore(dataRoot?: string): KeyStore;
/**
 * Read one account's stored keys.
 * @param account - canonical account id (wxid).
 * @param dataRoot - DSH wechat data root.
 * @returns the stored record (empty when absent).
 */
export declare function getAccountKeysFromStore(account: string, dataRoot?: string): StoredAccountKeys;
/**
 * Upsert one account's keys into the store.
 * @param account - canonical account id (wxid).
 * @param patch - fields to set (undefined fields are left untouched).
 * @param dataRoot - DSH wechat data root.
 * @returns the updated primary record.
 */
export declare function upsertAccountKeysInStore(account: string, patch: Partial<StoredAccountKeys>, dataRoot?: string): StoredAccountKeys;
/**
 * Remove one account from the store.
 * @param account - canonical account id (wxid).
 * @param dataRoot - DSH wechat data root.
 * @returns true when a record was removed.
 */
export declare function removeAccountKeysFromStore(account: string, dataRoot?: string): boolean;
