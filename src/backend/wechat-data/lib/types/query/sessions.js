/**
 * Session queries over st_control's decrypted session.db, rewritten from the
 * Rust sessions::get_session_list. Reads ordinary SQLite via node:sqlite.
 */
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { contactMeta, cachedBySig, fileSigOf } from "./meta.js";
/** Read SessionTable column names (wechat 4.x may add/remove columns). */
function tableColumns(db, table) {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all();
    return new Set(rows.map(r => r.name));
}
/** Resolve a byte/TEXT summary/draft column to a string. */
function bytesToString(v) {
    if (v === null || v === undefined)
        return '';
    if (typeof v === 'string')
        return v;
    if (v instanceof Uint8Array) {
        // summary/draft are UTF-8 text stored as BLOB or TEXT
        return new TextDecoder('utf-8', { fatal: false }).decode(v);
    }
    if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol')
        return String(v);
    return '';
}
/** Session titles from SessionNoContactInfoTable (display name source 2). */
function loadSessionTitles(db) {
    const map = new Map();
    try {
        const rows = db.prepare('SELECT username, session_title FROM SessionNoContactInfoTable').all();
        for (const r of rows) {
            const u = bytesToString(r.username);
            if (u)
                map.set(u, bytesToString(r.session_title));
        }
    }
    catch {
        // table may be absent
    }
    return map;
}
/** 客服会话识别（真实企业微信/品牌客服会话，排除占位 holder）。 */
function isKefuLike(u) {
    const s = u.toLowerCase();
    return s.includes('@weclaw') || s.includes('@kefu.openim') || s.includes('opencustomerservicemsg');
}
/**
 * Read the session list from the decrypted session.db.
 * @param decryptedDir - st_control decrypted data root (…/data/wechat/decrypted).
 * @param keyword - optional username/name filter.
 * @param limit - max rows.
 * @returns the session snapshot.
 */
export function querySessions(decryptedDir, keyword, limit, offset) {
    const key = `sessions:${decryptedDir}:${keyword ?? ''}:${limit ?? ''}:${offset ?? ''}`;
    const sig = [
        fileSigOf(join(decryptedDir, 'session', 'session.db')),
        fileSigOf(join(decryptedDir, 'contact', 'contact.db')),
    ].join('|');
    return cachedBySig(key, sig, () => computeSessions(decryptedDir, keyword, limit, offset));
}
function computeSessions(decryptedDir, keyword, limit, offset = 0) {
    const dbPath = join(decryptedDir, 'session', 'session.db');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
        const cols = tableColumns(db, 'SessionTable');
        if (!cols.has('username'))
            throw new Error('SessionTable 缺少 username 列');
        const sel = (name, dft) => (cols.has(name) ? name : dft);
        const sql = [
            'SELECT',
            [sel('username', "''"), sel('unread_count', '0'), sel('summary', 'NULL'), sel('draft', 'NULL'),
                sel('is_hidden', '0'), sel('last_timestamp', '0'), sel('sort_timestamp', 'last_timestamp'),
                sel('last_msg_type', '0'), sel('last_msg_sub_type', '0'), sel('last_msg_sender', "''"),
                sel('last_sender_display_name', "''")].join(', '),
            'FROM SessionTable',
            'ORDER BY', sel('sort_timestamp', 'last_timestamp'), 'DESC',
            'LIMIT ?',
        ].join(' ');
        const meta = contactMeta(decryptedDir);
        const contactNames = meta.names;
        const sessionTitles = loadSessionTitles(db);
        const pinned = meta.pinned;
        const bizTypes = meta.bizTypes;
        const q = (keyword ?? '').trim().toLowerCase();
        // Keyword filtering happens after contact-name resolution, and paging
        // (offset/limit) needs a stable total, so always read up to the bounded
        // 5000-row window before slicing. Rows are lightweight text summaries.
        const fetchLimit = 5000;
        const rows = db.prepare(sql).all(fetchLimit);
        const key = (cand, dft) => (cols.has(cand) ? cand : dft);
        const sessions = [];
        for (const r of rows) {
            const username = bytesToString(r[key('username', '')]);
            const displayName = contactNames.get(username) ?? sessionTitles.get(username) ?? username;
            if (q && !username.toLowerCase().includes(q) && !displayName.toLowerCase().includes(q))
                continue;
            const s = {
                username,
                displayName,
                type: username.endsWith('@chatroom') ? 'group' : 'private',
                lastTimestamp: Number(r[key('last_timestamp', '0')] ?? 0),
                summary: bytesToString(r[key('summary', 'NULL')]),
                unreadCount: Number(r[key('unread_count', '0')] ?? 0),
                draft: bytesToString(r[key('draft', 'NULL')]),
                pinned: pinned.has(username),
                hidden: Number(r[key('is_hidden', '0')] ?? 0) === 1,
                lastMsgType: Number(r[key('last_msg_type', '0')] ?? 0),
                lastMsgSubType: Number(r[key('last_msg_sub_type', '0')] ?? 0),
                lastMsgSender: bytesToString(r[key('last_msg_sender', "''")]).trim(),
                lastMsgSenderName: bytesToString(r[key('last_sender_display_name', "''")]).trim(),
            };
            if (username.startsWith('gh_')) {
                const bt = bizTypes.get(username) ?? 0;
                s.bizType = bt;
                s.accountKind = bt > 0 ? 'service' : 'official';
            }
            else if (isKefuLike(username)) {
                s.accountKind = 'kefu';
            }
            sessions.push(s);
        }
        // pinned-first ordering (stable: keeps sort_timestamp DESC within groups)
        sessions.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
        const total = sessions.length;
        const page = limit === undefined ? sessions : sessions.slice(offset, offset + limit);
        return { sessions: page, total };
    }
    finally {
        db.close();
    }
}
//# sourceMappingURL=sessions.js.map