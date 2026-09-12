/**
 * Member / contact search (成员搜索). Uses the local contact_fts index in
 * wechat_search.db when available (built lazily on first use) and falls back to
 * a LIKE scan over contact.db; room-scoped searches join chatroom_member.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { searchIndexPath } from "./search.js";
const CONTACT_FTS_META = 'contact_rows';
/** Stringify an SQLite cell (TEXT/NUMBER/BLOB) to a string. */
function cellText(v) {
    if (v === null || v === undefined)
        return '';
    if (typeof v === 'string')
        return v;
    if (v instanceof Uint8Array)
        return new TextDecoder('utf-8', { fatal: false }).decode(v);
    if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol')
        return String(v);
    return '';
}
/** Whether a table exists in this database. */
function tableExists(db, table) {
    try {
        return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined;
    }
    catch {
        return false;
    }
}
/** Map raw contact rows to member-search hits. */
function hitsFromRows(rows, roomName) {
    const out = [];
    for (const r of rows) {
        const username = cellText(r['username']).trim();
        if (!username)
            continue;
        const name = cellText(r['remark']).trim() || cellText(r['nick_name']).trim() || username;
        const hit = { username, name };
        const head = cellText(r['small_head_url']).trim() || cellText(r['big_head_url']).trim();
        if (head)
            hit.head = head;
        const room = cellText(r['room']).trim();
        if (room)
            hit.roomUsername = room;
        if (roomName)
            hit.roomName = roomName;
        const sig = cellText(r['signature']).trim();
        if (sig)
            hit.signature = sig;
        const region = cellText(r['region']).trim();
        if (region)
            hit.region = region;
        out.push(hit);
    }
    return out;
}
/** Build (once) the local contact_fts index from contact.db. */
function ensureContactFts(db, decryptedDir) {
    db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS contact_fts USING fts5(name, username UNINDEXED, remark UNINDEXED, alias UNINDEXED, quanpin UNINDEXED, local_type UNINDEXED, tokenize='unicode61')");
    const row = db.prepare('SELECT value FROM meta WHERE key=?').get(CONTACT_FTS_META);
    if (row && Number(row.value ?? 0) > 0)
        return;
    const contactPath = join(decryptedDir, 'contact', 'contact.db');
    if (!existsSync(contactPath))
        return;
    let cdb = null;
    try {
        cdb = new DatabaseSync(contactPath, { readOnly: true });
        if (!tableExists(cdb, 'contact'))
            return;
        const rows = cdb.prepare('SELECT username, remark, nick_name, alias, quan_pin FROM contact').all();
        db.exec('BEGIN');
        try {
            const ins = db.prepare('INSERT INTO contact_fts(name, username, remark, alias, quanpin, local_type) VALUES(?, ?, ?, ?, ?, 0)');
            for (const r of rows) {
                const username = cellText(r['username']).trim();
                if (!username)
                    continue;
                ins.run(cellText(r['remark']).trim() || cellText(r['nick_name']).trim() || username, username, cellText(r['remark']).trim(), cellText(r['alias']).trim(), cellText(r['quan_pin']).trim());
            }
            db.exec('COMMIT');
            db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)').run(CONTACT_FTS_META, String(rows.length));
        }
        catch {
            try {
                db.exec('ROLLBACK');
            }
            catch { /* no active tx */ }
        }
    }
    catch {
        // contact db unavailable
    }
    finally {
        try {
            cdb?.close();
        }
        catch { /* already closed */ }
    }
}
/** Global search: prefer contact_fts, otherwise LIKE over contact.db. */
function searchGlobalMembers(decryptedDir, term, cap) {
    const p = searchIndexPath(decryptedDir);
    if (existsSync(p)) {
        try {
            const db = new DatabaseSync(p);
            try {
                ensureContactFts(db, decryptedDir);
                const escaped = '"' + term.replace(/"/g, '""') + '"';
                const rows = db.prepare('SELECT name, username, remark, alias FROM contact_fts WHERE contact_fts MATCH ? ORDER BY rank LIMIT ?').all(escaped, cap * 4);
                if (rows.length > 0) {
                    const items = [];
                    const cdbPath = join(decryptedDir, 'contact', 'contact.db');
                    let cdb = null;
                    try {
                        cdb = new DatabaseSync(cdbPath, { readOnly: true });
                    }
                    catch {
                        cdb = null;
                    }
                    const headStmt = cdb && tableExists(cdb, 'contact') ? cdb.prepare('SELECT small_head_url, big_head_url FROM contact WHERE username=?') : null;
                    for (const r of rows) {
                        const username = cellText(r['username']).trim();
                        if (!username)
                            continue;
                        const hit = { username, name: cellText(r['name']).trim() || username };
                        if (headStmt) {
                            try {
                                const hr = headStmt.get(username);
                                const head = cellText(hr?.small_head_url ?? '').trim() || cellText(hr?.big_head_url ?? '').trim();
                                if (head)
                                    hit.head = head;
                            }
                            catch { /* skip */ }
                        }
                        items.push(hit);
                    }
                    try {
                        cdb?.close();
                    }
                    catch { /* already closed */ }
                    return { items: items.slice(0, cap), total: items.length, source: 'fts' };
                }
            }
            finally {
                db.close();
            }
        }
        catch { /* fts unavailable, try LIKE */ }
    }
    return searchGlobalLike(decryptedDir, term, cap);
}
/** LIKE fallback over contact.db (remark / nick / username / alias / quan_pin). */
function searchGlobalLike(decryptedDir, term, cap) {
    const p = join(decryptedDir, 'contact', 'contact.db');
    if (!existsSync(p))
        return { items: [], total: 0, source: 'like' };
    try {
        const db = new DatabaseSync(p, { readOnly: true });
        try {
            if (!tableExists(db, 'contact'))
                return { items: [], total: 0, source: 'like' };
            const like = '%' + term + '%';
            const sql = 'SELECT username, remark, nick_name, alias, small_head_url, big_head_url FROM contact WHERE remark LIKE ? OR nick_name LIKE ? OR username LIKE ? OR alias LIKE ? OR quan_pin LIKE ? ORDER BY remark, nick_name LIMIT ?';
            const rows = db.prepare(sql).all(like, like, like, like, like, cap);
            return { items: hitsFromRows(rows), total: rows.length, source: 'like' };
        }
        finally {
            db.close();
        }
    }
    catch {
        return { items: [], total: 0, source: 'like' };
    }
}
/** Room-scoped search: chatroom_member join contact + chat room display name. */
function searchRoomMembers(decryptedDir, roomUsername, term, cap) {
    const p = join(decryptedDir, 'contact', 'contact.db');
    if (!existsSync(p))
        return { items: [], total: 0, source: 'like' };
    try {
        const db = new DatabaseSync(p, { readOnly: true });
        try {
            if (!tableExists(db, 'chat_room') || !tableExists(db, 'chatroom_member') || !tableExists(db, 'contact')) {
                return { items: [], total: 0, source: 'like' };
            }
            const room = db.prepare('SELECT id FROM chat_room WHERE username=?').get(roomUsername);
            if (room?.id === undefined)
                return { items: [], total: 0, source: 'like' };
            const display = db.prepare('SELECT nick_name, remark FROM contact WHERE username=?').get(roomUsername);
            const roomName = (display ? cellText(display.remark).trim() || cellText(display.nick_name).trim() : '') || roomUsername;
            const like = '%' + term + '%';
            const sql = 'SELECT c.username, c.remark, c.nick_name, c.small_head_url, c.big_head_url, cr.username AS room FROM chatroom_member m JOIN contact c ON c.id=m.member_id JOIN chat_room cr ON cr.id=m.room_id WHERE m.room_id=? AND (c.remark LIKE ? OR c.nick_name LIKE ? OR c.username LIKE ?) ORDER BY c.remark, c.nick_name LIMIT ?';
            const rows = db.prepare(sql).all(room.id, like, like, like, cap);
            return { items: hitsFromRows(rows, roomName), total: rows.length, source: 'like' };
        }
        finally {
            db.close();
        }
    }
    catch {
        return { items: [], total: 0, source: 'like' };
    }
}
/**
 * Search contacts / group members.
 * @param decryptedDir - decrypted data root.
 * @param q - search term (name/remark/username/alias/pinyin).
 * @param opts - optional limit and room scope (roomUsername).
 * @returns matching members + total + source.
 */
export function searchMembers(decryptedDir, q, opts) {
    const term = q.trim();
    if (!term)
        return { items: [], total: 0, source: 'like' };
    const cap = Math.min(opts?.limit ?? 50, 200);
    if (opts?.roomUsername)
        return searchRoomMembers(decryptedDir, opts.roomUsername, term, cap);
    return searchGlobalMembers(decryptedDir, term, cap);
}
//# sourceMappingURL=members.js.map