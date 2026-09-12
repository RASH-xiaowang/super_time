/**
 * WeChat full-text message search index (FTS5), rewritten from st_control
 * chat_search_index.rs. The index DB lives next to the decrypted dir
 * (data/wechat/wechat_search.db); search prefers the index and falls back
 * to a bounded full-table scan over the message shards.
 */
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { decompress } from 'fzstd';
import { contactMeta, shardCatalog } from "./meta.js";
/** zstd magic bytes (WCDB compressed blobs). */
const ZSTD_MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD]);
/** Decode raw column bytes: zstd-decompress when the magic matches. */
function tryDecompress(data) {
    if (data.length >= 4 && data.subarray(0, 4).equals(ZSTD_MAGIC)) {
        try {
            return Buffer.from(decompress(data));
        }
        catch {
            return null;
        }
    }
    return null;
}
/**
 * Index DB path: sibling of the decrypted dir.
 * @param decryptedDir - decrypted data root.
 * @returns the absolute path of the search index DB.
 */
export function searchIndexPath(decryptedDir) {
    return join(dirname(decryptedDir), 'wechat_search.db');
}
/** Msg_<md5(username)> table name for a talker. */
function msgTableName(username) {
    return 'Msg_' + createHash('md5').update(username, 'utf8').digest('hex');
}
/** Decode a BLOB or TEXT cell to UTF-8 text (zstd + GBK aware). */
function decodeCell(v) {
    if (v === null || v === undefined)
        return '';
    if (typeof v === 'string')
        return v;
    if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol')
        return String(v);
    const raw = Buffer.from(v instanceof Uint8Array ? v : []);
    const decompressed = tryDecompress(raw);
    const bytes = decompressed ?? raw;
    // UTF-8 first; GBK fallback for legacy-encoded fields.
    try {
        return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    }
    catch {
        return new TextDecoder('gbk', { fatal: false }).decode(bytes);
    }
}
/** Message shard DB files under <decrypted>/message (catalog-backed, sorted). */
function messageShardFiles(decryptedDir) {
    return shardCatalog(decryptedDir).map(s => s.file);
}
/** Session usernames from session.db (SessionTable or Session). */
function loadSessionUsernames(decryptedDir) {
    const dbPath = join(decryptedDir, 'session', 'session.db');
    if (!existsSync(dbPath))
        return [];
    const out = [];
    try {
        const db = new DatabaseSync(dbPath, { readOnly: true });
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
        const table = tables.includes('SessionTable') ? 'SessionTable' : tables.includes('Session') ? 'Session' : '';
        if (table) {
            const rows = db.prepare('SELECT username FROM "' + table + '"').all();
            for (const r of rows) {
                const u = decodeCell(r['username']).trim();
                if (u)
                    out.push(u);
            }
        }
        db.close();
    }
    catch {
        // session.db unavailable
    }
    return out;
}
/** Display names: contact remark/nick then session titles. */
function loadDisplayNames(decryptedDir) {
    const names = new Map();
    for (const [u, n] of contactMeta(decryptedDir).names)
        names.set(u, n);
    const sessionDb = join(decryptedDir, 'session', 'session.db');
    if (existsSync(sessionDb)) {
        try {
            const db = new DatabaseSync(sessionDb, { readOnly: true });
            const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='SessionNoContactInfoTable'").get() !== undefined;
            if (has) {
                const rows = db.prepare('SELECT username, session_title FROM SessionNoContactInfoTable').all();
                for (const r of rows) {
                    const u = decodeCell(r['username']);
                    const t = decodeCell(r['session_title']).trim();
                    if (u && t && !names.has(u))
                        names.set(u, t);
                }
            }
            db.close();
        }
        catch {
            // session.db unavailable
        }
    }
    return names;
}
/**
 * Search index status.
 * @param decryptedDir - decrypted data root.
 * @returns whether the index exists plus row count and built_at timestamp.
 */
export function getSearchIndexStatus(decryptedDir) {
    const p = searchIndexPath(decryptedDir);
    if (!existsSync(p))
        return { exists: false, rows: 0, built_at: null };
    try {
        const db = new DatabaseSync(p, { readOnly: true });
        const rows = db.prepare('SELECT COUNT(*) AS c FROM message_meta').get().c;
        const built = db.prepare("SELECT value FROM meta WHERE key='built_at'").get();
        db.close();
        return { exists: true, rows, built_at: built?.value ?? null };
    }
    catch {
        return { exists: true, rows: 0, built_at: null };
    }
}
/**
 * Build (or rebuild) the FTS5 search index over text messages.
 * @param decryptedDir - decrypted data root.
 * @param force - drop and rebuild even when an index exists.
 * @returns build result with status and row count.
 */
export function buildSearchIndex(decryptedDir, force) {
    const p = searchIndexPath(decryptedDir);
    const db = new DatabaseSync(p);
    const init = () => {
        db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
        db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(text, username UNINDEXED, create_time UNINDEXED, local_id UNINDEXED, sort_seq UNINDEXED, tokenize='unicode61')");
        db.exec('CREATE TABLE IF NOT EXISTS message_meta (rowid INTEGER PRIMARY KEY, text TEXT NOT NULL, username TEXT NOT NULL, create_time INTEGER NOT NULL DEFAULT 0, sort_seq INTEGER NOT NULL DEFAULT 0, local_id INTEGER NOT NULL DEFAULT 0)');
    };
    try {
        init();
        const existing = db.prepare('SELECT COUNT(*) AS c FROM message_meta').get().c;
        if (!force && existing > 0) {
            return { status: 'exists', rows: existing, message: '索引已存在，使用 force=true 可重建' };
        }
        db.exec('DROP TABLE IF EXISTS message_fts');
        db.exec('DROP TABLE IF EXISTS message_meta');
        init();
        db.exec("DELETE FROM meta WHERE key='built_at'");
        const started = Date.now();
        const usernames = loadSessionUsernames(decryptedDir);
        const shards = messageShardFiles(decryptedDir);
        db.exec('BEGIN');
        let total = 0;
        let batch = [];
        const flush = () => {
            if (batch.length === 0)
                return;
            const insMeta = db.prepare('INSERT INTO message_meta(text, username, create_time, sort_seq, local_id) VALUES(?, ?, ?, ?, ?)');
            const insFts = db.prepare('INSERT INTO message_fts(rowid, text, username, create_time, local_id, sort_seq) VALUES(?, ?, ?, ?, ?, ?)');
            for (const [text, username, createTime, sortSeq, localId] of batch) {
                const r = insMeta.run(text, username, createTime, sortSeq, localId);
                insFts.run(Number(r.lastInsertRowid), text, username, createTime, localId, sortSeq);
            }
            batch = [];
        };
        for (const username of usernames) {
            const table = msgTableName(username);
            for (const shard of shards) {
                let sdb = null;
                try {
                    sdb = new DatabaseSync(shard, { readOnly: true });
                }
                catch {
                    continue;
                }
                const has = sdb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined;
                if (!has) {
                    sdb.close();
                    continue;
                }
                try {
                    const sql = 'SELECT local_id, create_time, sort_seq, message_content FROM "' + table + '" WHERE local_type=1';
                    const rows = sdb.prepare(sql).all();
                    for (const r of rows) {
                        const localId = Number(r['local_id'] ?? 0);
                        const createTime = Number(r['create_time'] ?? 0);
                        const sortSeq = Number(r['sort_seq'] ?? localId);
                        const text = decodeCell(r['message_content']).trim();
                        if (!text || text.startsWith('<'))
                            continue;
                        batch.push([text, username, createTime, sortSeq, localId]);
                        if (batch.length >= 500)
                            flush();
                    }
                }
                catch {
                    // skip unreadable shard
                }
                finally {
                    sdb.close();
                }
            }
            if (batch.length >= 500)
                flush();
        }
        flush();
        db.exec('COMMIT');
        total = db.prepare('SELECT COUNT(*) AS c FROM message_meta').get().c;
        const builtAt = new Date().toISOString().slice(0, 19).replace('T', ' ');
        db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('built_at', ?)").run(builtAt);
        return { status: 'ok', rows: total, built_at: builtAt, elapsed_ms: Date.now() - started };
    }
    catch (e) {
        try {
            db.exec('ROLLBACK');
        }
        catch { /* no active tx */ }
        throw new Error('构建搜索索引失败: ' + e.message);
    }
    finally {
        db.close();
    }
}
/** Strip the group-message sender prefix (wxid_xxx:\n) from display text. */
function stripGroupPrefix(text, username) {
    if (!username.endsWith('@chatroom'))
        return text;
    const m = text.match(/^[A-Za-z0-9_@.\-]{3,64}:\n/);
    return m ? text.slice(m[0].length) : text;
}
/** Format a unix timestamp as YYYY-MM-DD HH:MM. */
function formatFullTime(ts) {
    if (!ts)
        return '';
    const d = new Date(ts * 1000);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
/**
 * Search WeChat's own message_fts.db (message_fts_v4_* + ImgFts*) which
 * covers text AND image messages, mapping session_id back through name2id.
 * @returns hits (empty when the built-in index is absent/empty).
 */
function searchWechatFts(decryptedDir, q, cap, names) {
    const p = join(decryptedDir, 'message', 'message_fts.db');
    if (!existsSync(p))
        return { hits: [] };
    try {
        const db = new DatabaseSync(p, { readOnly: true });
        const sessions = new Map();
        try {
            const rows = db.prepare('SELECT rowid AS id, username AS u FROM name2id').all();
            for (const r of rows)
                sessions.set(r.id, decodeCell(r.u));
        }
        catch { /* no name2id */ }
        const out = [];
        const like = '%' + q.replace(/[%_]/g, ' ') + '%';
        for (const [content, aux] of [
            ['message_fts_v4_0_content', 'message_fts_v4_aux_0'],
            ['message_fts_v4_1_content', 'message_fts_v4_aux_1'],
            ['message_fts_v4_2_content', 'message_fts_v4_aux_2'],
            ['message_fts_v4_3_content', 'message_fts_v4_aux_3'],
        ]) {
            try {
                const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(content) !== undefined;
                if (!exists)
                    continue;
                const sql = 'SELECT c.c0 AS c, a.message_local_id AS lid, a.sort_seq AS ss, a.session_id AS sid FROM "' + content + '" c LEFT JOIN "' + aux + '" a ON a.rowid = c.id WHERE c.c0 LIKE ? ORDER BY c.id DESC LIMIT ?';
                const rows = db.prepare(sql).all(like, cap);
                for (const r of rows) {
                    const username = sessions.get(Number(r['sid'])) ?? '';
                    const text = decodeCell(r['c']);
                    const display = stripGroupPrefix(text, username);
                    out.push({
                        text,
                        username,
                        create_time: 0,
                        local_id: Number(r['lid'] ?? 0),
                        name: names.get(username) ?? username,
                        time: '',
                        snippet: display.slice(0, 120),
                    });
                    if (out.length >= cap)
                        break;
                }
            }
            catch { /* shard unavailable */ }
            if (out.length >= cap)
                break;
        }
        db.close();
        return { hits: out };
    }
    catch {
        return { hits: [] };
    }
}
/**
 * Search text messages: FTS5 index first, bounded full-table scan fallback.
 * @param decryptedDir - decrypted data root.
 * @param query - search term.
 * @param limit - max hits.
 * @param username - optional scope: only search one talker (chatroom).
 * @returns hits plus whether the index was used.
 */
export function searchIndexMessages(decryptedDir, query, limit, username) {
    const q = (query || '').trim();
    if (!q)
        return { hits: [], total: 0, indexed: false };
    const cap = Math.min(limit ?? 100, 300);
    const names = loadDisplayNames(decryptedDir);
    // ---- our FTS5 index path ----
    // ---- FTS5 path ----
    const p = searchIndexPath(decryptedDir);
    if (existsSync(p)) {
        try {
            const db = new DatabaseSync(p, { readOnly: true });
            const exists = db.prepare('SELECT COUNT(*) AS c FROM message_meta').get().c;
            if (exists > 0) {
                const safe = /^[\w\s]+$/.test(q) ? q : '"' + q.replace(/"/g, '\"\"') + '"';
                const ftsSql = username
                    ? 'SELECT text, username, create_time, local_id FROM message_fts WHERE message_fts MATCH ? AND username = ? ORDER BY rank LIMIT ?'
                    : 'SELECT text, username, create_time, local_id FROM message_fts WHERE message_fts MATCH ? ORDER BY rank LIMIT ?';
                const rows = username
                    ? db.prepare(ftsSql).all(safe, username, cap)
                    : db.prepare(ftsSql).all(safe, cap);
                const hits = rows.map((r) => {
                    const text = decodeCell(r['text']);
                    const username = decodeCell(r['username']);
                    const createTime = Number(r['create_time'] ?? 0);
                    const localId = Number(r['local_id'] ?? 0);
                    const display = stripGroupPrefix(text, username);
                    return {
                        text,
                        username,
                        create_time: createTime,
                        local_id: localId,
                        name: names.get(username) ?? username,
                        time: formatFullTime(createTime),
                        snippet: display.slice(0, 120),
                    };
                });
                db.close();
                if (hits.length > 0)
                    return { hits, total: hits.length, indexed: true };
            }
            else {
                db.close();
            }
        }
        catch {
            // index unreadable: fall through to scan
        }
    }
    // ---- WeChat built-in content tables (LIKE, tokenizer-independent) ----
    const builtin = searchWechatFts(decryptedDir, q, cap, names);
    if (builtin.hits.length > 0)
        return { hits: builtin.hits, total: builtin.hits.length, indexed: false };
    // ---- Full-table scan fallback ----
    const hits = [];
    const qLower = q.toLowerCase();
    let budget = 800_000;
    const shards = messageShardFiles(decryptedDir);
    const scopeUsernames = username ? [username] : loadSessionUsernames(decryptedDir).slice(0, 800);
    for (const username of scopeUsernames) {
        if (hits.length >= cap || budget <= 0)
            break;
        const table = msgTableName(username);
        for (const shard of shards) {
            if (hits.length >= cap || budget <= 0)
                break;
            let sdb = null;
            try {
                sdb = new DatabaseSync(shard, { readOnly: true });
            }
            catch {
                continue;
            }
            const has = sdb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined;
            if (!has) {
                sdb.close();
                continue;
            }
            try {
                const sql = 'SELECT local_id, create_time, message_content FROM "' + table + '" WHERE local_type=1';
                const rows = sdb.prepare(sql).all();
                for (const r of rows) {
                    budget -= 1;
                    if (hits.length >= cap || budget <= 0)
                        break;
                    const localId = Number(r['local_id'] ?? 0);
                    const ts = Number(r['create_time'] ?? 0);
                    const text = decodeCell(r['message_content']).replace(/\n/g, ' ').trim();
                    if (!text || !text.toLowerCase().includes(qLower))
                        continue;
                    const display = stripGroupPrefix(text, username);
                    const dIdx = display.toLowerCase().indexOf(qLower);
                    const dStart = Math.max(0, dIdx < 0 ? 0 : dIdx - 20);
                    const snippet = (dStart > 0 ? '…' : '') + display.slice(dStart, dStart + 100);
                    hits.push({
                        text,
                        username,
                        create_time: ts,
                        local_id: localId,
                        name: names.get(username) ?? username,
                        time: formatFullTime(ts),
                        snippet,
                    });
                }
            }
            catch {
                // skip unreadable shard
            }
            finally {
                sdb.close();
            }
        }
    }
    return { hits, total: hits.length, indexed: false };
}
//# sourceMappingURL=search.js.map