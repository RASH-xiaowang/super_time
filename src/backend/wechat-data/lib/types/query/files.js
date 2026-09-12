/**
 * Files queries over st_control's decrypted hardlink.db (v4 tables).
 * File source chat is resolved best-effort from message_resource.db (packed_info)
 * joined to contact.db display names, so the read-only file grid can show where a
 * media asset came from instead of only a hash name.
 */
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { contactMeta } from "./meta.js";
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
const FILE_TABLES = [
    ['image_hardlink_info_v4', 'image'],
    ['file_hardlink_info_v4', 'file'],
    ['video_hardlink_info_v4', 'video'],
];
/** Read a byte array from a packed_info cell (object of index->byte, or Uint8Array). */
function packedBytes(v) {
    if (v instanceof Uint8Array)
        return v;
    if (Array.isArray(v))
        return new Uint8Array(v.map(Number));
    if (v && typeof v === 'object') {
        const vals = Object.values(v);
        if (vals.every(x => typeof x === 'number'))
            return new Uint8Array(vals.map(Number));
    }
    return new Uint8Array(0);
}
/** Extract a 32-char lowercase hex file key from packed_info. */
function fileKeyFromPacked(packed) {
    const latin = Buffer.from(packedBytes(packed)).toString('latin1');
    const m = /[0-9a-f]{32}/.exec(latin);
    return m ? m[0] : null;
}
/**
 * Best-effort map from file key to { source session display name, create time }.
 * Joins MessageResourceInfo.packed_info (file key) -> chat_id -> contact name.
 * @param decryptedDir - decrypted data root.
 * @returns map keyed by the stripped file name.
 */
function loadFileSources(decryptedDir) {
    const map = new Map();
    let resDb = null;
    try {
        resDb = new DatabaseSync(join(decryptedDir, 'message', 'message_resource.db'), { readOnly: true });
    }
    catch {
        return map;
    }
    try {
        const chatMap = new Map();
        const chatRows = resDb.prepare('SELECT rowid, user_name FROM ChatName2Id').all();
        for (const r of chatRows)
            chatMap.set(Number(r.rowid), cellStr(r.user_name));
        const nameMap = contactMeta(decryptedDir).names;
        const infos = resDb.prepare('SELECT chat_id, message_create_time, packed_info FROM MessageResourceInfo').all();
        for (const row of infos) {
            const key = fileKeyFromPacked(row.packed_info);
            if (!key || map.has(key))
                continue;
            const user = chatMap.get(Number(row.chat_id)) ?? '';
            map.set(key, { session: nameMap.get(user) || user, time: Number(row.message_create_time) || 0 });
        }
    }
    catch {
        // source resolution is best-effort; absence is not an error.
    }
    finally {
        resDb.close();
    }
    return map;
}
/**
 * Read resource files.
 * @param decryptedDir - decrypted data root.
 * @param limit - max rows per category.
 * @returns the files snapshot.
 */
export function queryFiles(decryptedDir, limit, offset = 0) {
    const db = new DatabaseSync(join(decryptedDir, 'hardlink', 'hardlink.db'), { readOnly: true });
    try {
        const cap = Math.min(limit === undefined ? 100 : limit + offset, 1000);
        const files = [];
        let total = 0;
        for (const [table, category] of FILE_TABLES) {
            const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined;
            if (!has)
                continue;
            try {
                total += db.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n;
            }
            catch { /* skip */ }
            const cols = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name));
            const sel = (c, dft) => (cols.has(c) ? c : dft);
            const sql = [
                'SELECT',
                [sel('md5', "''"), sel('file_name', "''"), sel('file_size', '0'), sel('modify_time', '0')].join(', '),
                'FROM', table,
                'ORDER BY', sel('modify_time', '_rowid_'), 'DESC',
                'LIMIT ?',
            ].join(' ');
            try {
                const rows = db.prepare(sql).all(cap);
                for (const r of rows) {
                    files.push({
                        md5: cellStr(r[sel('md5', '')] ?? ''),
                        fileName: cellStr(r[sel('file_name', '')] ?? ''),
                        fileSize: Number(r[sel('file_size', '0')] ?? 0),
                        modifyTime: Number(r[sel('modify_time', '0')] ?? 0),
                        category,
                    });
                }
            }
            catch {
                // skip table
            }
        }
        const sources = loadFileSources(decryptedDir);
        for (const f of files) {
            const key = f.fileName.replace(/\.dat$/i, '').replace(/_(t|h|b|thumb.*)$/i, '');
            const src = sources.get(key);
            if (src) {
                f.sessionName = src.session;
                f.sourceTime = src.time;
            }
        }
        const page = limit === undefined ? files : files.slice(offset, offset + limit);
        return { files: page, total };
    }
    finally {
        db.close();
    }
}
//# sourceMappingURL=files.js.map