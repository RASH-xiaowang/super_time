/**
 * Message queries over st_control's decrypted message DBs (wechat 4.x).
 * Each talker's messages live in a `Msg_<md5(username)>` table spread across
 * message_<n>.db / biz_message_<n>.db shards; the shard is located by scanning
 * for the table.
 *
 * Sender identity mirrors st_control: `real_sender_id` is an internal rowid
 * resolved through each shard's Name2Id table (rowid -> wxid); when that is
 * empty the content `wxid_xxx:\n` prefix is used. `is_sender` is computed
 * (the raw column does not exist in wechat 4.x) by comparing the sender with
 * the logged-in account wxid.
 *
 * Pagination is keyset-based on `sort_seq` (the millisecond-level stable
 * order key), matching st_control: newer messages have a larger sort_seq, and
 * the next page cursor is the smallest sort_seq of the current page. Sorting
 * by `create_time` + OFFSET is unstable — many WeChat 4.x rows share a
 * second-precision create_time, so OFFSET pages silently skip/duplicate rows.
 * `message_content` may be zstd-compressed (magic 0x28B52FFD) or GBK; both
 * are decoded here so text/rich parsing sees the real content.
 */
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { statSync } from 'node:fs';
import { decompress } from 'fzstd';
import { parseMessageContent } from "./parse.js";
import { contactMeta, senderNameMap, shardCatalog } from "./meta.js";
/** zstd magic bytes (WCDB compressed blobs). */
const ZSTD_MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD]);
/**
 * Normalize a wechat local_type (high-bit masks).
 * @param localType - raw local_type value from the DB.
 * @returns the normalized type value.
 */
export function normalizeMsgType(localType) {
    const mask = 0x100000000;
    return localType > mask ? localType % mask : localType;
}
/**
 * Human label for a normalized message type (mirror st_control).
 * @param localType - raw local_type value from the DB.
 * @returns the Chinese display label for the type.
 */
export function msgTypeLabel(localType) {
    switch (normalizeMsgType(localType)) {
        case 1: return '文本';
        case 3: return '图片';
        case 34: return '语音';
        case 42: return '名片';
        case 43: return '视频';
        case 47: return '表情';
        case 48: return '位置';
        case 49: return '链接';
        case 50: return '语音通话';
        case 244:
        case 246: return '文件';
        case 10000: return '系统消息';
        case 10002: return '撤回消息';
        case 859832288:
        case 922746960: return '拍一拍';
        case 244135593199: return '小程序';
        default: return '未知消息';
    }
}
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
/** Decode a DB cell (TEXT or BLOB) to UTF-8 text, handling zstd + GBK. */
function decodeBlobText(v) {
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
/** Read a TEXT-or-BLOB column as raw bytes (rusqlite get_bytes equivalent). */
function cellBytes(v) {
    if (v instanceof Uint8Array)
        return Buffer.from(v);
    if (typeof v === 'string')
        return Buffer.from(v, 'utf8');
    return Buffer.alloc(0);
}
/**
 * Extract the group sender username from decoded message content.
 * The content is often a binary header + 'wxid_xxx:\n' + body; scan for a
 * username-like token followed by ':\n' anywhere, and skip binary blobs.
 */
function senderFromContent(content) {
    if (!content)
        return null;
    let printable = 0;
    for (let i = 0; i < content.length && i < 512; i += 1) {
        const c = content.charCodeAt(i);
        if ((c >= 0x20 && c <= 0x7e) || c >= 0x80)
            printable += 1;
    }
    if (content.length > 0 && printable / Math.min(content.length, 512) < 0.6)
        return null;
    const m = content.match(/([A-Za-z0-9_@.\-]{3,64}):\n/);
    if (!m)
        return null;
    const head = m[1] ?? '';
    if (head.includes('<'))
        return null;
    return head;
}
/**
 * Resolve wechat system-message placeholders: `$wxid_xxx$` to the contact’s
 * display name. System messages (type 10000) reference a sender by id and
 * must render as the contact name (e.g. the red-packet notice).
 * @param text - raw display text.
 * @param contactNames - username -> display-name map.
 * @returns text with resolved names (unknown ids stay as-is).
 */
function resolveSysRefs(text, contactNames) {
    const D = String.fromCharCode(36);
    let out = '';
    let rest = text;
    for (;;) {
        const s = rest.indexOf(D);
        if (s < 0) {
            out += rest;
            break;
        }
        const e = rest.indexOf(D, s + 1);
        if (e < 0) {
            out += rest;
            break;
        }
        const id = rest.slice(s + 1, e);
        if (/^[A-Za-z0-9_.@-]{3,64}$/.test(id) && contactNames.has(id)) {
            out += rest.slice(0, s) + ' ' + (contactNames.get(id) ?? id) + ' ';
            rest = rest.slice(e + 1);
        }
        else {
            out += rest.slice(0, e + 1);
            rest = rest.slice(e + 1);
        }
    }
    return out;
}
/**
 * Strip XML tags from a wechat message_content to a plain-text preview.
 * @param content - raw message content.
 * @returns a plain-text preview (max 200 chars).
 */
export function msgText(content) {
    if (!content)
        return '';
    return content
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200);
}
function msgTableName(username) {
    return 'Msg_' + createHash('md5').update(username, 'utf8').digest('hex');
}
/** Fill sender username from SenderName2Id when the shard Name2Id missed it. */
function applySenderFallback(rows, decryptedDir) {
    let map = null;
    for (const row of rows) {
        if (row.senderUsername || !row.realSenderId)
            continue;
        if (map === null)
            map = senderNameMap(decryptedDir);
        const u = map.get(row.realSenderId) ?? '';
        if (u)
            row.senderUsername = u;
    }
}
/** Locate every shard DB containing the talker's Msg table (catalog-backed). */
function findShards(decryptedDir, table) {
    const out = [];
    for (const shard of shardCatalog(decryptedDir)) {
        const meta = shard.tables.get(table);
        if (!meta)
            continue;
        try {
            const db = new DatabaseSync(shard.file, { readOnly: true });
            out.push({ db, file: shard.file, cols: meta.cols, name2id: meta.name2id });
        }
        catch {
            // try next shard
        }
    }
    return out;
}
/**
 * Query one shard page (keyset by sort_seq, falling back to local_id).
 * @param shard - shard with the talker table.
 * @param table - Msg table name.
 * @param cursor - smallest sort_seq already loaded (exclusive), or undefined for the newest page.
 * @param limit - max rows from this shard.
 * @returns raw rows in descending order.
 */
function queryShardRows(shard, table, cursor, limit) {
    return queryShardRowsWith(shard, table, cursor, undefined, limit, false);
}
/** Shared shard row query: newest-page / older-page / newer-than-after. */
function queryShardRowsWith(shard, table, cursor, after, limit, ascending) {
    const { db, cols } = shard;
    const has = (c) => cols.has(c);
    const sel = (c, dft) => (has(c) ? c : dft);
    if (!has('local_id') || !has('create_time'))
        return [];
    const orderCol = has('sort_seq') ? 'sort_seq' : 'local_id';
    let whereClause = '';
    if (after !== undefined) {
        whereClause = has('sort_seq') ? 'WHERE sort_seq > ?' : 'WHERE local_id > ?';
    }
    else if (cursor !== undefined) {
        whereClause = has('sort_seq') ? 'WHERE sort_seq < ?' : 'WHERE local_id < ?';
    }
    const serverSel = has('server_id') ? 'CAST(server_id AS TEXT) AS server_id' : "'0' AS server_id";
    const sql = [
        'SELECT',
        [sel('local_id', '0'), sel('sort_seq', 'local_id'), sel('local_type', '0'), sel('is_sender', '0'),
            sel('create_time', '0'), sel('real_sender_id', '0'), sel('message_content', 'NULL'), serverSel].join(', '),
        'FROM ' + table,
        whereClause,
        'ORDER BY ' + orderCol + (ascending ? ' ASC' : ' DESC'),
        'LIMIT ?',
    ].filter(Boolean).join(' ');
    const param = after !== undefined ? after : cursor !== undefined ? cursor : undefined;
    const rows = param === undefined
        ? db.prepare(sql).all(limit)
        : db.prepare(sql).all(param, limit);
    return rows.map((r) => {
        const realSenderId = Number(r[sel('real_sender_id', '0')] ?? 0);
        return {
            localId: Number(r[sel('local_id', '0')] ?? 0),
            sortSeq: Number(r[sel('sort_seq', 'local_id')] ?? 0),
            localType: Number(r[sel('local_type', '0')] ?? 0),
            isSender: Number(r[sel('is_sender', '0')] ?? 0),
            createTime: Number(r[sel('create_time', '0')] ?? 0),
            senderUsername: shard.name2id.get(realSenderId) ?? '',
            content: cellBytes(r[sel('message_content', 'NULL')]),
            realSenderId,
            ...(typeof r['server_id'] === 'string' ? { serverId: r['server_id'] } : {}),
        };
    });
}
/**
 * Map raw rows to WechatMessage (decode + parse + sender/is_self resolution).
 * @param rows - raw rows in display order.
 * @param talker - conversation username.
 * @param isGroup - whether the talker is a chatroom.
 * @param contactNames - username -> display-name map.
 * @param selfUsername - logged-in account wxid (empty => private heuristic).
 * @returns the mapped messages.
 */
function toWechatMessages(rows, talker, isGroup, contactNames, selfUsername) {
    return rows.map((r) => {
        const normType = normalizeMsgType(r.localType);
        const content = decodeBlobText(r.content);
        const parsed = parseMessageContent(normType, content, isGroup);
        // sender identity: Name2Id first (reliable for every message type), then
        // the content wxid_xxx:\n prefix as fallback (mirrors st_control).
        const prefixSender = senderFromContent(content);
        const sender = r.senderUsername || prefixSender || '';
        // is_self: exact wxid match when the account is known; otherwise the
        // private-chat heuristic (sender is not the other party => mine).
        const self = selfUsername && selfUsername.length > 0 ? selfUsername : '';
        const isSelf = self.length > 0
            ? sender === self
            : !isGroup && sender.length > 0 && sender !== talker;
        const msg = {
            localId: r.localId,
            ...(r.serverId ? { serverId: r.serverId } : {}),
            sortSeq: r.sortSeq,
            type: normType,
            isSender: isSelf ? 1 : 0,
            createTime: r.createTime,
            msgContent: content,
            strContent: content,
            typeLabel: msgTypeLabel(r.localType),
        };
        const displayText = parsed.text || msgText(content);
        if (displayText)
            msg.displayText = resolveSysRefs(displayText, contactNames);
        if (parsed.rich)
            msg.rich = parsed.rich;
        // group chats: per-message member identity (incl. own messages, so the
        // UI can show the right avatar side/letter when it wants to).
        if (isGroup && sender) {
            msg.sender = sender;
            const name = contactNames.get(sender);
            if (name)
                msg.senderName = name;
        }
        return msg;
    });
}
/**
 * Incrementally fetch messages newer than a sort_seq watermark (real-time
 * polling). Mirrors st_control's monitor delta: any message whose order key
 * is above the seen high-water mark is returned oldest-first for appending.
 * @param decryptedDir - decrypted data root.
 * @param talker - conversation username.
 * @param after - only rows with sort_seq > this watermark are returned.
 * @param limit - max rows to return (default 200).
 * @param selfUsername - logged-in account wxid (see {@link queryMessages}).
 * @returns the newer messages (empty when nothing arrived).
 */
export function queryNewMessages(decryptedDir, talker, after, limit, selfUsername) {
    const table = msgTableName(talker);
    const shards = findShards(decryptedDir, table);
    if (shards.length === 0)
        return { messages: [], total: 0 };
    try {
        const cap = Math.min(limit ?? 200, 1000);
        const merged = [];
        for (const shard of shards) {
            merged.push(...queryShardRowsWith(shard, table, undefined, after, cap + 1, true));
        }
        merged.sort((a, b) => a.sortSeq - b.sortSeq || a.localId - b.localId);
        const rows = merged.slice(0, cap);
        applySenderFallback(rows, decryptedDir);
        const contactNames = contactMeta(decryptedDir).names;
        const isGroup = talker.endsWith('@chatroom');
        const messages = toWechatMessages(rows, talker, isGroup, contactNames, selfUsername);
        const out = { messages, total: messages.length };
        if (selfUsername && selfUsername.length > 0)
            out.selfWxid = selfUsername;
        return out;
    }
    finally {
        for (const shard of shards) {
            try {
                shard.db.close();
            }
            catch { /* already closed */ }
        }
    }
}
const statsCache = new Map();
/** Fingerprint the shard files backing one talker's table (mtime+size). */
function shardStatsFingerprint(shards) {
    return shards.map((s) => {
        try {
            const st = statSync(s.file);
            return `${s.file}:${st.mtimeMs}:${st.size}`;
        }
        catch {
            return s.file + ':?';
        }
    }).join('|');
}
/** Cached per-talker typeStats + total; invalidated by shard file signatures. */
function messageStats(decryptedDir, table, shards) {
    const sig = shardStatsFingerprint(shards);
    const key = decryptedDir + ':' + table;
    const hit = statsCache.get(key);
    if (hit && hit.sig === sig)
        return hit.stats;
    const statsMap = new Map();
    for (const shard of shards) {
        const { db, cols } = shard;
        if (!cols.has('local_type'))
            continue;
        try {
            const rows = db.prepare('SELECT local_type AS t, COUNT(*) AS c FROM ' + table + ' GROUP BY local_type').all();
            for (const r of rows) {
                const key2 = normalizeMsgType(r.t);
                statsMap.set(key2, (statsMap.get(key2) ?? 0) + r.c);
            }
        }
        catch { /* skip */ }
    }
    const typeStats = [...statsMap.entries()]
        .map(([type, count]) => ({ type, label: msgTypeLabel(type), count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);
    const total = shards.reduce((a, s) => {
        try {
            return a + Number(s.db.prepare('SELECT COUNT(*) AS c FROM ' + table).get()?.c ?? 0);
        }
        catch {
            return a;
        }
    }, 0);
    const stats = { total, typeStats };
    statsCache.set(key, { sig, stats });
    return stats;
}
/**
 * Read one talker's messages (keyset pagination across all shards).
 * @param decryptedDir - decrypted data root.
 * @param talker - conversation username.
 * @param limit - max rows (per page).
 * @param cursor - previous page's smallest sort_seq (exclusive), or undefined for the newest page.
 * @param selfUsername - logged-in account wxid (used to mark own messages);
 *   when empty, a private-chat heuristic compares the sender against the talker.
 * @returns the messages snapshot.
 */
export function queryMessages(decryptedDir, talker, limit, cursor, selfUsername) {
    const table = msgTableName(talker);
    const shards = findShards(decryptedDir, table);
    if (shards.length === 0)
        return { messages: [], total: 0 };
    try {
        const pageSize = Math.min(limit ?? 100, 1000);
        // Read one extra row per shard to detect hasMore, like st_control.
        const limitPerShard = pageSize + 1;
        const merged = [];
        for (const shard of shards) {
            merged.push(...queryShardRows(shard, table, cursor, limitPerShard));
        }
        // Global sort: sort_seq DESC, local_id DESC (stable across shards).
        merged.sort((a, b) => b.sortSeq - a.sortSeq || b.localId - a.localId);
        const hasMore = merged.length > pageSize;
        const pageRows = merged.slice(0, pageSize);
        applySenderFallback(pageRows, decryptedDir);
        const lastRow = pageRows[pageRows.length - 1];
        const nextCursor = lastRow ? lastRow.sortSeq : 0;
        const contactNames = contactMeta(decryptedDir).names;
        const isGroup = talker.endsWith('@chatroom');
        // pageRows are newest-first; the UI prepends older pages, so emit oldest→newest.
        const messages = toWechatMessages(pageRows.reverse(), talker, isGroup, contactNames, selfUsername);
        const stats = messageStats(decryptedDir, table, shards);
        const base = { messages, total: stats.total, typeStats: stats.typeStats };
        if (selfUsername && selfUsername.length > 0)
            base.selfWxid = selfUsername;
        return hasMore
            ? { ...base, hasMore, cursor: nextCursor }
            : { ...base, hasMore: false };
    }
    finally {
        for (const shard of shards) {
            try {
                shard.db.close();
            }
            catch { /* already closed */ }
        }
    }
}
/**
 * Resolve one message by its server_id (merged chat-log nested pointers).
 * Scans every message shard / Msg table; only type-49 appmsg cards are
 * resolved.
 * @param decryptedDir - decrypted data root.
 * @param serverId - server_id as string (may exceed 2^53).
 * @returns found flag plus the parsed message (when found).
 */
export function queryMessageByServerId(decryptedDir, serverId) {
    const sid = serverId;
    // 纯数字 server_id 先走整型等值命中索引，未命中再回退 CAST 文本（兼容
    // 文本存储/非数字 id），避免 askWechat/resolveChatHistory 每表全量 CAST 扫描。
    let numeric = null;
    if (/^\d+$/.test(sid)) {
        try {
            numeric = BigInt(sid);
        }
        catch { /* keep text path */ }
    }
    const tryLookup = (predicate, param) => {
        for (const shard of shardCatalog(decryptedDir)) {
            let db;
            // readBigInts: 64 位 server_id 原样读回，避免 double 精度损失。
            try {
                db = new DatabaseSync(shard.file, { readOnly: true, readBigInts: true });
            }
            catch {
                continue;
            }
            try {
                for (const [table, meta] of shard.tables) {
                    if (!meta.cols.has('server_id') || !meta.cols.has('local_type'))
                        continue;
                    try {
                        const sql = 'SELECT local_id, sort_seq, local_type, is_sender, create_time, real_sender_id, message_content FROM "' + table + '" WHERE ' + predicate + ' = ? AND (local_type & 4294967295) = 49 LIMIT 1';
                        const row = db.prepare(sql).get(param);
                        if (!row)
                            continue;
                        const normType = normalizeMsgType(Number(row['local_type'] ?? 0));
                        const content = decodeBlobText(row['message_content']);
                        const parsed = parseMessageContent(normType, content, false);
                        const msg = {
                            localId: Number(row['local_id'] ?? 0),
                            sortSeq: Number(row['sort_seq'] ?? 0),
                            type: normType,
                            isSender: 0,
                            createTime: Number(row['create_time'] ?? 0),
                            msgContent: content,
                            strContent: content,
                            typeLabel: msgTypeLabel(normType),
                        };
                        if (parsed.text)
                            msg.displayText = parsed.text;
                        if (parsed.rich)
                            msg.rich = parsed.rich;
                        return { found: true, message: msg };
                    }
                    catch {
                        // try the next table
                    }
                }
            }
            finally {
                db.close();
            }
        }
        return { found: false };
    };
    if (numeric !== null) {
        const hit = tryLookup('server_id', numeric);
        if (hit.found)
            return hit;
    }
    return tryLookup('CAST(server_id AS TEXT)', sid);
}
//# sourceMappingURL=messages.js.map