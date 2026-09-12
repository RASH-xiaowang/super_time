/**
 * Privacy scan: extract phone/ID/card/email/password/address patterns from
 * decrypted text messages, aggregating per-category counts + samples and
 * TOP contact/group rankings (mirror of wechat/privacy.rs).
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const CATEGORIES = [
    { key: 'phone', label: '手机号', icon: '📱', re: /1[3-9]\d{9}/g, insensitive: false },
    { key: 'id_card', label: '身份证号', icon: '🪪', re: /[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]/g, insensitive: false },
    { key: 'bank_card', label: '银行卡号', icon: '💳', re: /(?:62\d{14,17}|[45]\d{15,18})/g, insensitive: false },
    { key: 'email', label: '邮箱', icon: '✉️', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, insensitive: true },
    { key: 'password', label: '密码口令', icon: '🔑', re: /(?:密码|口令|pwd|password|passwd)\s*[=:：]\s*[A-Za-z0-9@#$%^&*!_.-]{4,32}/g, insensitive: true },
    { key: 'address', label: '地址信息', icon: '📍', re: /(?:住在|地址|住址|小区|门牌号|大厦|宿舍)[^\n，。！？]{2,60}/g, insensitive: false },
];
/** Build a snippet centered on the first match (source make_snippet). */
function makeSnippet(text, matched) {
    const idx = text.indexOf(matched);
    if (idx < 0)
        return text.slice(0, 60);
    const start = Math.max(0, idx - 24);
    const end = Math.min(text.length, idx + matched.length + 36);
    const mid = text.slice(start, end);
    return start > 0 ? '…' + mid : mid;
}
/** Format a unix timestamp as YYYY-MM-DD HH:MM. */
function fmtFull(ts) {
    if (!ts)
        return '';
    const d = new Date(ts * 1000);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
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
/** Message table names from the session db (source annual::load_session_usernames). */
function loadSessionUsernames(decryptedDir) {
    const out = [];
    try {
        const db = new DatabaseSync(join(decryptedDir, 'session', 'session.db'), { readOnly: true });
        const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='SessionTable'").get() !== undefined;
        if (!has) {
            db.close();
            return out;
        }
        const cols = new Set(db.prepare('PRAGMA table_info(SessionTable)').all().map(r => r.name));
        const userCol = cols.has('username') ? 'username' : cols.has('UserName') ? 'UserName' : '';
        if (!userCol) {
            db.close();
            return out;
        }
        const rows = db.prepare(`SELECT ${userCol} AS u FROM SessionTable`).all();
        for (const r of rows) {
            const u = cellStr(r.u ?? '');
            if (u)
                out.push(u);
        }
        db.close();
    }
    catch { /* session db unavailable */ }
    return out;
}
/** Contact display names (remark > nick). */
function loadDisplayNames(decryptedDir) {
    const map = new Map();
    try {
        const db = new DatabaseSync(join(decryptedDir, 'contact', 'contact.db'), { readOnly: true });
        const cols = new Set(db.prepare('PRAGMA table_info(contact)').all().map(r => r.name));
        if (!cols.has('username')) {
            db.close();
            return map;
        }
        const remark = cols.has('remark') ? 'remark' : cols.has('Remark') ? 'Remark' : 'NULL';
        const nick = cols.has('nick_name') ? 'nick_name' : cols.has('NickName') ? 'NickName' : 'nickName';
        const rows = db.prepare(`SELECT username, COALESCE(NULLIF(${remark}, ''), ${nick}) AS n FROM contact`).all();
        for (const r of rows) {
            const u = cellStr(r['username'] ?? '');
            const n = cellStr(r['n'] ?? '').trim();
            if (u && n)
                map.set(u, n);
        }
        db.close();
    }
    catch { /* contact db unavailable */ }
    return map;
}
/** Decode a BLOB/TEXT cell to UTF-8 text. */
function decodeCell(v) {
    if (v == null)
        return '';
    if (typeof v === 'string')
        return v;
    if (v instanceof Uint8Array)
        return new TextDecoder('utf-8', { fatal: false }).decode(v);
    if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol')
        return String(v);
    return '';
}
/**
 * Scan message shards for sensitive patterns.
 * @param decryptedDir - decrypted data root.
 * @param rowBudget - max scanned rows (default 600000, source budget).
 * @returns categories with samples + rankings.
 */
export function queryPrivacyScan(decryptedDir, rowBudget = 600000) {
    const msgDir = join(decryptedDir, 'message');
    const categories = CATEGORIES.map(c => ({ key: c.key, label: c.label, count: 0, icon: c.icon, samples: [] }));
    const hitsByKey = new Map();
    const perContact = new Map();
    const usernames = loadSessionUsernames(decryptedDir);
    const names = loadDisplayNames(decryptedDir);
    let scanned = 0;
    let involved = 0;
    if (existsSync(msgDir)) {
        const shards = readdirSync(msgDir).filter(f => f.endsWith('.db') && !f.includes('_shm') && !f.includes('_wal') && !f.includes('tmp'));
        // File-first pass: open each shard once, map its Msg_* tables to sessions.
        const targetUsernames = usernames.slice(0, 800);
        const tableToUser = new Map();
        for (const username of targetUsernames)
            tableToUser.set('Msg_' + createHash('md5').update(username, 'utf8').digest('hex'), username);
        const fileInfos = [];
        for (const file of shards) {
            let probe = null;
            try {
                probe = new DatabaseSync(join(msgDir, file), { readOnly: true });
            }
            catch {
                continue;
            }
            try {
                const names = probe.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'").all().map(r => r.name);
                const tables = [];
                for (const n of names) {
                    const u = tableToUser.get(n);
                    if (u)
                        tables.push([n, u]);
                }
                if (tables.length > 0)
                    fileInfos.push({ path: join(msgDir, file), tables });
            }
            catch { /* skip */ }
            finally {
                probe.close();
            }
        }
        for (const fi of fileInfos) {
            if (scanned >= rowBudget)
                break;
            let db = null;
            try {
                db = new DatabaseSync(fi.path, { readOnly: true });
            }
            catch {
                continue;
            }
            try {
                for (const [tableName, username] of fi.tables) {
                    if (scanned >= rowBudget)
                        break;
                    try {
                        const cols = new Set(db.prepare(`PRAGMA table_info(${tableName})`).all().map(r => r.name));
                        if (!cols.has('local_id') || !cols.has('create_time') || !cols.has('message_content'))
                            continue;
                        const typeCol = cols.has('local_type') ? 'local_type' : 'type';
                        const rows = db.prepare(`SELECT local_id, create_time, message_content FROM ${tableName} WHERE ${typeCol}=1`).all();
                        for (const r of rows) {
                            scanned += 1;
                            if (scanned >= rowBudget)
                                break;
                            const text = decodeCell(r.message_content);
                            if (!text || text.startsWith('<'))
                                continue;
                            const localId = r.local_id ?? 0;
                            const ts = r.create_time ?? 0;
                            let anyHit = false;
                            for (let ci = 0; ci < categories.length; ci += 1) {
                                const cat = categories[ci];
                                if (cat === undefined)
                                    continue;
                                const spec = CATEGORIES[ci];
                                if (!spec)
                                    continue;
                                const re = spec.insensitive ? new RegExp(spec.re.source, 'gi') : spec.re;
                                re.lastIndex = 0;
                                const m = re.exec(text);
                                if (!m)
                                    continue;
                                cat.count += 1;
                                const matched = m[0];
                                const samples = hitsByKey.get(cat.key) ?? [];
                                if (samples.length < 200) {
                                    samples.push({
                                        username,
                                        name: names.get(username) ?? username,
                                        local_id: localId,
                                        ts,
                                        time: fmtFull(ts),
                                        snippet: makeSnippet(text, matched),
                                    });
                                }
                                hitsByKey.set(cat.key, samples);
                                anyHit = true;
                            }
                            if (anyHit)
                                perContact.set(username, (perContact.get(username) ?? 0) + 1);
                        }
                        involved += 1;
                    }
                    catch { /* next table */ }
                }
            }
            finally {
                db.close();
            }
        }
    }
    for (const c of categories)
        c.samples = hitsByKey.get(c.key) ?? [];
    const totalHits = categories.reduce((a, c) => a + c.count, 0);
    const topContacts = Array.from(perContact.entries())
        .filter(([u]) => !u.endsWith('@chatroom') && !u.startsWith('gh_'))
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 10)
        .map(([username, count]) => ({ username, name: names.get(username) ?? username, count }));
    const topGroups = Array.from(perContact.entries())
        .filter(([u]) => u.endsWith('@chatroom'))
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 10)
        .map(([username, count]) => ({ username, name: names.get(username) ?? username, count }));
    return { categories, total_hits: totalHits, involved_sessions: involved, top_contacts: topContacts, top_groups: topGroups };
}
//# sourceMappingURL=privacy.js.map