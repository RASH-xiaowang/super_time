/**
 * Emoticon queries over emoticon.db, mirroring the Rust modules/emoticons.rs:
 * custom emoticons from kNonStoreEmoticonTable and store packages from
 * kStoreEmoticonPackageTable (+ per-package file counts). Static bundled
 * emoticons have no DSH counterpart (source ships them in public/wechat/).
 */
import { DatabaseSync } from 'node:sqlite';
import { cachedBySig, fileSigOf } from "./meta.js";
import { existsSync } from 'node:fs';
import { join } from 'node:path';
/** Coerce a DB cell to a string (null -> '', else String()). */
function cellStr(v) {
    if (typeof v === 'string')
        return v;
    if (v === null || v === undefined)
        return '';
    if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol')
        return String(v);
    return '';
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
/** Pick the first present column among candidates; null when none exist. */
function col(cols, cands) {
    for (const c of cands)
        if (cols.has(c))
            return c;
    return null;
}
/**
 * Read custom emoticons + store packages.
 * @param decryptedDir - decrypted data root.
 * @param limit - max custom rows.
 * @returns the emoticons snapshot.
 */
export function queryEmoticons(decryptedDir, limit, offset = 0) {
    // Cache keyed on emoticon.db's signature; recomputed when the realtime sync
    // rewrites it, otherwise served from the 5s bounded cache.
    return cachedBySig('emoticons:' + decryptedDir + ':' + String(limit ?? '') + ':' + String(offset), fileSigOf(join(decryptedDir, 'emoticon', 'emoticon.db')), () => computeEmoticons(decryptedDir, limit, offset));
}
function computeEmoticons(decryptedDir, limit, offset = 0) {
    const path = join(decryptedDir, 'emoticon', 'emoticon.db');
    if (!existsSync(path))
        return { custom: [], static: [], packages: [], total: 0 };
    const db = new DatabaseSync(path, { readOnly: true });
    try {
        const custom = [];
        const cCols = tableColumns(db, 'kNonStoreEmoticonTable');
        if (cCols.size > 0) {
            const md5Col = col(cCols, ['md5', 'MD5', 'md5_']);
            const typeCol = col(cCols, ['type', 'Type', 'type_']);
            const captionCol = col(cCols, ['caption', 'Caption', 'caption_']);
            if (md5Col) {
                const cap = Math.min(limit ?? 500, 2000);
                const rows = db.prepare(`SELECT ${md5Col} AS md5, ${typeCol ?? '0'} AS item_type, ${captionCol ?? "''"} AS caption FROM kNonStoreEmoticonTable LIMIT ? OFFSET ?`).all(cap, offset);
                for (const r of rows) {
                    const md5 = cellStr(r.md5 ?? '').trim();
                    if (!md5)
                        continue;
                    const item = { md5, item_type: Number(r.item_type ?? 0) };
                    const caption = cellStr(r.caption ?? '').trim();
                    if (caption)
                        item.caption = caption;
                    custom.push(item);
                }
            }
        }
        const packages = [];
        const pCols = tableColumns(db, 'kStoreEmoticonPackageTable');
        if (pCols.size > 0) {
            const idCol = col(pCols, ['package_id_', 'package_id', 'product_id_', 'product_id', 'id_']);
            const nameCol = col(pCols, ['package_name_', 'name_', 'title_', 'name', 'title']);
            if (idCol && nameCol) {
                const rows = db.prepare(`SELECT ${idCol} AS pid, ${nameCol} AS name FROM kStoreEmoticonPackageTable LIMIT 500`).all();
                for (const r of rows) {
                    const pid = cellStr(r.pid ?? '').trim();
                    const name = cellStr(r.name ?? '').trim() || pid || '未命名表情包';
                    let count = 0;
                    if (pid) {
                        try {
                            const fcols = tableColumns(db, 'kStoreEmoticonFilesTable');
                            if (fcols.size > 0) {
                                const fpid = col(fcols, ['package_id_', 'package_id', 'product_id_', 'product_id']);
                                if (fpid) {
                                    count = db.prepare(`SELECT COUNT(*) AS n FROM kStoreEmoticonFilesTable WHERE ${fpid} = ?`).get(pid).n;
                                }
                            }
                        }
                        catch {
                            count = 0;
                        }
                    }
                    packages.push({ name, count });
                }
            }
        }
        let total = custom.length;
        if (cCols.size > 0) {
            try {
                total = db.prepare('SELECT COUNT(*) AS n FROM kNonStoreEmoticonTable').get().n;
            }
            catch { /* keep batch count */ }
        }
        return { custom, static: [], packages, total };
    }
    finally {
        db.close();
    }
}
//# sourceMappingURL=emoticons.js.map