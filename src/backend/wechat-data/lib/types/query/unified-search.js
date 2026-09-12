/**
 * Unified search across local WeChat data domains: messages (index), contacts,
 * moments, favorites, files, and records. Every domain is best-effort and
 * returns its own typed hit shape; one failed domain never blocks the others.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { searchIndexMessages } from "./search.js";
import { contactMeta } from "./meta.js";
/** Safe display wrapper: never throw; fall back to the raw username. */
function cellString(v) {
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
function tableColumns(db, table) {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all();
    return new Set(rows.map(r => r.name));
}
function like(q) {
    return '%' + q + '%';
}
/** Contact names: remark > nick > username, plus category label. */
function searchContacts(decryptedDir, q, cap) {
    const p = join(decryptedDir, 'contact', 'contact.db');
    if (!existsSync(p))
        return [];
    try {
        const db = new DatabaseSync(p, { readOnly: true });
        const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='contact'").get() !== undefined;
        if (!has) {
            db.close();
            return [];
        }
        const cols = tableColumns(db, 'contact');
        const userCol = cols.has('username') ? 'username' : cols.has('UserName') ? 'UserName' : '';
        const remarkCol = cols.has('remark') ? 'remark' : cols.has('Remark') ? 'Remark' : '';
        const nickCol = cols.has('nick_name') ? 'nick_name' : cols.has('NickName') ? 'NickName' : '';
        const aliasCol = cols.has('alias') ? 'alias' : '';
        const quanCol = cols.has('quan_pin') ? 'quan_pin' : '';
        if (!userCol) {
            db.close();
            return [];
        }
        const searchCols = [userCol, remarkCol, nickCol, aliasCol, quanCol].filter(Boolean);
        const likeClauses = searchCols.map(c => `${c} LIKE ?`).join(' OR ');
        if (!likeClauses) {
            db.close();
            return [];
        }
        const params = searchCols.map(() => like(q));
        const rows = db.prepare(`SELECT ${userCol} AS u, ${remarkCol || 'NULL'} AS r, ${nickCol || 'NULL'} AS n, ${aliasCol || 'NULL'} AS a FROM contact WHERE ${likeClauses} LIMIT ?`).all(...params, cap);
        db.close();
        return rows.map(r => ({
            username: cellString(r.u),
            name: cellString(r.r) || cellString(r.n) || cellString(r.a) || cellString(r.u),
            category: cellString(r.u).endsWith('@chatroom') ? 'group' : cellString(r.u).startsWith('gh_') ? 'official' : 'contact',
        }));
    }
    catch {
        return [];
    }
}
/** Moments by author + content LIKE. */
function searchMoments(decryptedDir, q, cap) {
    const dbPathCandidates = [join(decryptedDir, 'sns', 'db_sns', 'sns.db'), join(decryptedDir, 'sns', 'sns.db')];
    for (const p of dbPathCandidates) {
        if (!existsSync(p))
            continue;
        try {
            const db = new DatabaseSync(p, { readOnly: true });
            const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='SnsTimeLine'").get() !== undefined;
            if (!has) {
                db.close();
                continue;
            }
            const cols = tableColumns(db, 'SnsTimeLine');
            const uname = cols.has('user_name') ? 'user_name' : cols.has('userName') ? 'userName' : '';
            const content = cols.has('content') ? 'content' : cols.has('Content') ? 'Content' : '';
            if (!uname || !content) {
                db.close();
                continue;
            }
            const rows = db.prepare(`SELECT ${uname} AS u, ${content} AS c FROM SnsTimeLine WHERE ${content} LIKE ? LIMIT ?`).all(like(q), cap);
            db.close();
            const names = contactMeta(decryptedDir).names;
            return rows.map((r) => {
                const username = cellString(r.u);
                return { username, name: names.get(username) ?? username, snippet: cellString(r.c).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) };
            });
        }
        catch { /* try next path */ }
    }
    return [];
}
/** Favorites by content LIKE (fav_db_item in favorite.db). */
function searchFavorites(decryptedDir, q, cap) {
    const p = join(decryptedDir, 'favorite', 'favorite.db');
    if (!existsSync(p))
        return [];
    try {
        const db = new DatabaseSync(p, { readOnly: true });
        const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fav_db_item'").get() !== undefined;
        if (!has) {
            db.close();
            return [];
        }
        const cols = tableColumns(db, 'fav_db_item');
        const idCol = cols.has('local_id') ? 'local_id' : cols.has('Id') ? 'Id' : '0';
        const contentCol = cols.has('content') ? 'content' : cols.has('Content') ? 'Content' : '';
        if (!contentCol) {
            db.close();
            return [];
        }
        const rows = db.prepare(`SELECT ${idCol} AS id, ${contentCol} AS c FROM fav_db_item WHERE ${contentCol} LIKE ? LIMIT ?`).all(like(q), cap);
        db.close();
        return rows.map(r => ({ id: Number(r.id ?? 0), snippet: cellString(r.c).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) }));
    }
    catch {
        return [];
    }
}
/** Files by file_name LIKE across hardlink tables. */
function searchFiles(decryptedDir, q, cap) {
    const p = join(decryptedDir, 'hardlink', 'hardlink.db');
    if (!existsSync(p))
        return [];
    try {
        const db = new DatabaseSync(p, { readOnly: true });
        const out = [];
        for (const table of ['image_hardlink_info_v4', 'file_hardlink_info_v4', 'video_hardlink_info_v4']) {
            const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined;
            if (!has)
                continue;
            const cols = tableColumns(db, table);
            const nameCol = cols.has('file_name') ? 'file_name' : cols.has('fileName') ? 'fileName' : '';
            const md5Col = cols.has('md5') ? 'md5' : '';
            const sizeCol = cols.has('file_size') ? 'file_size' : cols.has('fileSize') ? 'fileSize' : '0';
            if (!nameCol)
                continue;
            const rows = db.prepare(`SELECT ${nameCol} AS n, ${md5Col || "'0'"} AS m, ${sizeCol} AS s FROM ${table} WHERE ${nameCol} LIKE ? LIMIT ?`).all(like(q), cap - out.length);
            for (const r of rows) {
                out.push({ fileName: cellString(r.n), md5: cellString(r.m), size: Number(r.s ?? 0) });
                if (out.length >= cap)
                    break;
            }
            if (out.length >= cap)
                break;
        }
        db.close();
        return out;
    }
    catch {
        return [];
    }
}
/** Transfers/red packets whose session matches the query. */
function searchRecords(decryptedDir, q, cap) {
    const p = join(decryptedDir, 'general', 'general.db');
    if (!existsSync(p))
        return [];
    try {
        const db = new DatabaseSync(p, { readOnly: true });
        const out = [];
        for (const [table, kind] of [['transferTable', 'transfers'], ['redEnvelopeTable', 'redpackets']]) {
            const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined;
            if (!has)
                continue;
            const cols = tableColumns(db, table);
            const sessionCol = cols.has('session_name') ? 'session_name' : cols.has('SessionName') ? 'SessionName' : '';
            if (!sessionCol)
                continue;
            const rows = db.prepare(`SELECT ${sessionCol} AS s FROM ${table} WHERE ${sessionCol} LIKE ? LIMIT ?`).all(like(q), cap - out.length);
            for (const r of rows) {
                const session = cellString(r.s);
                if (!session)
                    continue;
                out.push({ kind, name: session, session });
                if (out.length >= cap)
                    break;
            }
            if (out.length >= cap)
                break;
        }
        db.close();
        return out;
    }
    catch {
        return [];
    }
}
/**
 * Run the unified local search.
 * @param decryptedDir - decrypted data root.
 * @param query - search term.
 * @param limit - max hits per domain (default 6).
 * @returns the unified snapshot.
 */
export function searchUnified(decryptedDir, query, limit) {
    const q = (query || '').trim();
    const cap = Math.min(limit ?? 6, 12);
    const messages = q ? searchIndexMessages(decryptedDir, q, cap).hits : [];
    return {
        query: q,
        messages,
        contacts: q ? searchContacts(decryptedDir, q, cap) : [],
        moments: q ? searchMoments(decryptedDir, q, cap) : [],
        favorites: q ? searchFavorites(decryptedDir, q, cap) : [],
        files: q ? searchFiles(decryptedDir, q, cap) : [],
        records: q ? searchRecords(decryptedDir, q, cap) : [],
    };
}
//# sourceMappingURL=unified-search.js.map