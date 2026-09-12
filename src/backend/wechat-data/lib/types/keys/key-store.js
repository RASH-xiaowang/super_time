/**
 * Key-store persistence for recovered WeChat account keys, migrated from
 * WeChatDataAnalysis `key_store.py`. The store lives in the DSH-owned
 * WeChat data root (see dirs.ts) as `keys.json`, written atomically.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveWechatDataRoot } from "../dirs.js";
/** File name of the key store inside the data root. */
export const KEY_STORE_FILE = 'keys.json';
/**
 * Resolve the key-store path for a data root.
 * @param dataRoot - DSH wechat data root.
 * @returns the absolute keys.json path.
 */
export function keyStorePath(dataRoot = resolveWechatDataRoot()) {
    return join(dataRoot, KEY_STORE_FILE);
}
/**
 * Read the whole key store (empty object when absent or corrupt).
 * @param dataRoot - DSH wechat data root.
 * @returns the parsed store.
 */
export function loadAccountKeysStore(dataRoot = resolveWechatDataRoot()) {
    const p = keyStorePath(dataRoot);
    if (!existsSync(p))
        return {};
    try {
        const raw = JSON.parse(readFileSync(p, 'utf8'));
        return typeof raw === 'object' && raw !== null ? raw : {};
    }
    catch {
        return {};
    }
}
/**
 * Read one account's stored keys.
 * @param account - canonical account id (wxid).
 * @param dataRoot - DSH wechat data root.
 * @returns the stored record (empty when absent).
 */
export function getAccountKeysFromStore(account, dataRoot = resolveWechatDataRoot()) {
    const item = loadAccountKeysStore(dataRoot)[account];
    return item ?? {};
}
/** Atomically replace the store file (write tmp then rename). */
function atomicWriteJson(file, payload) {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    renameSync(tmp, file);
}
/**
 * Upsert one account's keys into the store.
 * @param account - canonical account id (wxid).
 * @param patch - fields to set (undefined fields are left untouched).
 * @param dataRoot - DSH wechat data root.
 * @returns the updated primary record.
 */
export function upsertAccountKeysInStore(account, patch, dataRoot = resolveWechatDataRoot()) {
    const name = account.trim();
    if (name === '')
        return {};
    const store = loadAccountKeysStore(dataRoot);
    const existing = store[name] ?? {};
    const item = { ...existing };
    for (const [k, v] of Object.entries(patch)) {
        if (v === undefined)
            continue;
        item[k] = v;
    }
    item.updated_at = new Date().toISOString();
    store[name] = item;
    atomicWriteJson(keyStorePath(dataRoot), store);
    return { ...item };
}
/**
 * Remove one account from the store.
 * @param account - canonical account id (wxid).
 * @param dataRoot - DSH wechat data root.
 * @returns true when a record was removed.
 */
export function removeAccountKeysFromStore(account, dataRoot = resolveWechatDataRoot()) {
    const name = account.trim();
    if (name === '')
        return false;
    const store = loadAccountKeysStore(dataRoot);
    if (!(name in store))
        return false;
    const next = {};
    for (const [key, value] of Object.entries(store)) {
        if (key !== name)
            next[key] = value;
    }
    atomicWriteJson(keyStorePath(dataRoot), next);
    return true;
}
//# sourceMappingURL=key-store.js.map