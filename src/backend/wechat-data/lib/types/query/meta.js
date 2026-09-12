/**
 * Shared in-process metadata caches for the WeChat read path.
 *
 * The decrypted snapshot is an external read-only DB tree that the realtime
 * sync loop rewrites in place (atomic rename). Every cache here keys on the
 * owning file's mtime+size fingerprint, so a rewritten file invalidates the
 * entry naturally; callers never see data older than the file that produced
 * it. A short max-age bounds fingerprint drift on the same file.
 */
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
const MAX_AGE_MS = 5_000;
const entries = new Map();
function decode(v) {
    if (v === null || v === undefined)
        return '';
    if (typeof v === 'string')
        return v;
    if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol')
        return String(v);
    if (v instanceof Uint8Array)
        return new TextDecoder('utf-8', { fatal: false }).decode(v);
    return '';
}
function fileSig(path) {
    try {
        const st = statSync(path);
        return `${st.mtimeMs}:${st.size}`;
    }
    catch {
        return '';
    }
}
function dirSig(dir) {
    try {
        const st = statSync(dir);
        return `${st.mtimeMs}:${st.size}`;
    }
    catch {
        return '';
    }
}
function get(key, sig, loader, maxAgeMs = MAX_AGE_MS) {
    const hit = entries.get(key);
    if (hit && hit.sig === sig && hit.at + maxAgeMs > Date.now())
        return hit.value;
    const value = loader();
    entries.set(key, { at: Date.now(), sig, value });
    return value;
}
function tableColumns(db, table) {
    try {
        const rows = db.prepare(`PRAGMA table_info(${table})`).all();
        return new Set(rows.map(r => r.name));
    }
    catch {
        return new Set();
    }
}
/**
 * Read contact.db once and derive all contact metadata.
 * @param decryptedDir - decrypted data root.
 * @returns contact names (remark > nick > username), pinned set, biz types.
 */
export function contactMeta(decryptedDir) {
    const p = join(decryptedDir, 'contact', 'contact.db');
    const sig = fileSig(p);
    return get('contact-meta:' + decryptedDir, sig, () => {
        const names = new Map();
        const pinned = new Set();
        const bizTypes = new Map();
        if (!sig)
            return { names, pinned, bizTypes };
        try {
            const db = new DatabaseSync(p, { readOnly: true });
            try {
                const cols = tableColumns(db, 'contact');
                const userCol = cols.has('username') ? 'username' : cols.has('UserName') ? 'UserName' : '';
                const remarkCol = cols.has('remark') ? 'remark' : cols.has('Remark') ? 'Remark' : '';
                const nickCol = cols.has('nick_name') ? 'nick_name' : cols.has('NickName') ? 'NickName' : 'nickName';
                const flagCol = cols.has('flag') ? 'flag' : cols.has('Flag') ? 'Flag' : '';
                if (userCol) {
                    const remarkSel = remarkCol || "''";
                    const nickSel = nickCol;
                    const rows = db.prepare(`SELECT ${userCol} AS u, ${remarkSel} AS r, ${nickSel} AS n, ${flagCol || '0'} AS f FROM contact`).all();
                    for (const row of rows) {
                        const u = decode(row.u);
                        if (!u)
                            continue;
                        const remark = decode(row.r).trim();
                        const nick = decode(row.n).trim();
                        names.set(u, remark || nick || u);
                        const flag = Number(row.f ?? 0);
                        if ((flag & 0x800) !== 0)
                            pinned.add(u);
                    }
                }
                const biCols = tableColumns(db, 'biz_info');
                if (biCols.has('username') && biCols.has('type')) {
                    const rows = db.prepare('SELECT username AS u, type AS t FROM biz_info').all();
                    for (const row of rows) {
                        const u = decode(row.u);
                        if (u)
                            bizTypes.set(u, Number(row.t ?? 0));
                    }
                }
            }
            finally {
                db.close();
            }
        }
        catch { /* contact.db unavailable: keep empty maps */ }
        return { names, pinned, bizTypes };
    });
}
/** SenderName2Id fallback (message_resource.db rowid -> wxid). */
export function senderNameMap(decryptedDir) {
    const p = join(decryptedDir, 'message', 'message_resource.db');
    const sig = fileSig(p);
    return get('sender-names:' + decryptedDir, sig, () => {
        const map = new Map();
        if (!sig)
            return map;
        try {
            const db = new DatabaseSync(p, { readOnly: true });
            try {
                const rows = db.prepare('SELECT rowid AS id, user_name AS u FROM SenderName2Id').all();
                for (const row of rows) {
                    const u = decode(row.u).trim();
                    if (u)
                        map.set(row.id, u);
                }
            }
            catch { /* table absent */ }
            finally {
                db.close();
            }
        }
        catch { /* resource db unavailable */ }
        return map;
    });
}
function loadShardMeta(dbFile) {
    const tables = new Map();
    try {
        const db = new DatabaseSync(dbFile, { readOnly: true });
        try {
            const name2id = new Map();
            for (const t of ['Name2Id', 'name2id']) {
                try {
                    const rows = db.prepare('SELECT rowid AS id, user_name AS u FROM ' + t).all();
                    for (const row of rows) {
                        const u = decode(row.u).trim();
                        if (u)
                            name2id.set(row.id, u);
                    }
                    if (name2id.size > 0)
                        break;
                }
                catch { /* try the other casing */ }
            }
            const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'").all();
            for (const row of rows) {
                tables.set(row.name, { cols: tableColumns(db, row.name), name2id });
            }
        }
        finally {
            db.close();
        }
    }
    catch { /* skip file */ }
    return { file: dbFile, tables };
}
/**
 * Cached message shard catalog across one or more sub-directories (message,
 * bizchat, ...). Returns the Msg_% tables each file holds.
 * @param decryptedDir - decrypted data root.
 * @param dirs - sub-directory names to scan (default ['message']).
 * @returns shard metadata keyed by file path (cache invalidated by file sigs).
 */
export function shardCatalogDirs(decryptedDir, dirs) {
    const key = 'shard-catalog:' + decryptedDir + ':' + dirs.join('|');
    const sigParts = [];
    const entries = [];
    for (const dirName of dirs) {
        const dir = join(decryptedDir, dirName);
        const dSig = dirSig(dir);
        if (!dSig)
            continue;
        sigParts.push(`${dirName}:${dSig}`);
        let files = [];
        try {
            files = readdirSync(dir).filter(f => f.endsWith('.db') && !f.includes('_shm') && !f.includes('_wal') && !f.includes('monitor_cache') && !f.includes('fts') && !f.includes('resource') && !f.includes('media')).sort();
        }
        catch {
            continue;
        }
        for (const f of files) {
            const full = join(dir, f);
            const fs = fileSig(full);
            sigParts.push(`${f}:${fs}`);
            entries.push({ file: full });
        }
    }
    return get(key, sigParts.join('|'), () => entries.map(e => loadShardMeta(e.file)));
}
/** Convenience: message-directory-only catalog (the chat hot path). */
export function shardCatalog(decryptedDir) {
    return shardCatalogDirs(decryptedDir, ['message']);
}
/** Signature string for the directories a catalog covers (cache keys). */
export function shardCatalogSig(decryptedDir, dirs) {
    const parts = [];
    for (const dirName of dirs) {
        const dir = join(decryptedDir, dirName);
        parts.push(`${dirName}:${dirSig(dir)}`);
        let files = [];
        try {
            files = readdirSync(dir).filter(f => f.endsWith('.db') && !f.includes('_shm') && !f.includes('_wal') && !f.includes('monitor_cache') && !f.includes('fts') && !f.includes('resource') && !f.includes('media')).sort();
        }
        catch {
            continue;
        }
        for (const f of files)
            parts.push(`${f}:${fileSig(join(dir, f))}`);
    }
    return parts.join('|');
}
/** Signature of one file (mtime+size); '' when absent. */
export function fileSigOf(path) {
    return fileSig(path);
}
/** Generic mtime/fingerprint-bounded process cache (see {@link get}). */
export function cachedBySig(key, sig, loader, maxAgeMs = MAX_AGE_MS) {
    return get(key, sig, loader, maxAgeMs);
}
/** Insert with a simple FIFO capacity bound (evicts the oldest key). */
export function boundedSet(map, key, value, cap = 300) {
    if (!map.has(key) && map.size >= cap) {
        const first = map.keys().next();
        if (!first.done && first.value !== undefined)
            map.delete(first.value);
    }
    map.set(key, value);
}
/** Drop every cached snapshot (called after a rewrite event when needed). */
export function invalidateWechatMeta() {
    entries.clear();
}
//# sourceMappingURL=meta.js.map