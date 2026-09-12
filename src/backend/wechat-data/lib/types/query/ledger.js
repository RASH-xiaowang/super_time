/**
 * Funds ledger: aggregates transferTable / redEnvelopeTable rows, resolves
 * amounts and timestamps from message shards by server_id, and derives
 * per-contact totals plus fund anomaly warnings.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { decompress } from 'fzstd';
import { parseMessageContent } from "./parse.js";
import { contactMeta, shardCatalogDirs } from "./meta.js";
const ZSTD_MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD]);
/** Decode a BLOB/TEXT cell to UTF-8 text (zstd + GBK aware). */
function decodeCell(v) {
    if (v === null || v === undefined)
        return '';
    if (typeof v === 'string')
        return v;
    if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol')
        return String(v);
    const raw = Buffer.from(v instanceof Uint8Array ? v : []);
    const decompressed = raw.length >= 4 && raw.subarray(0, 4).equals(ZSTD_MAGIC)
        ? (() => { try {
            return Buffer.from(decompress(raw));
        }
        catch {
            return raw;
        } })()
        : raw;
    try {
        return new TextDecoder('utf-8', { fatal: false }).decode(decompressed);
    }
    catch {
        return new TextDecoder('gbk', { fatal: false }).decode(decompressed);
    }
}
/** Resolve server ids to raw message rows (amount via XML, create_time). */
function resolveMessagesByServerIds(decryptedDir, serverIds) {
    const out = new Map();
    if (serverIds.length === 0)
        return out;
    const pending = [...new Set(serverIds)].filter(Boolean);
    // 纯数字 id 先用整型等值走 server_id 索引（大 64 位值用 BigInt 保精度），
    // 未命中的再用 CAST 文本形式兜底，避免每表全量 CAST 扫描废掉索引。
    const numeric = new Map();
    for (const id of pending) {
        if (/^\d+$/.test(id)) {
            try {
                numeric.set(id, BigInt(id));
            }
            catch { /* non-numeric fallback below */ }
        }
    }
    const shards = shardCatalogDirs(decryptedDir, ['message']);
    const scan = (serverExpr, params) => {
        const placeholders = params.map(() => '?').join(',');
        for (const shard of shards) {
            let db;
            // readBigInts: 64 位 server_id 以 BigInt 原样读回，避免 double 精度损失。
            try {
                db = new DatabaseSync(shard.file, { readOnly: true, readBigInts: true });
            }
            catch {
                continue;
            }
            try {
                for (const [table, meta] of shard.tables) {
                    if (!meta.cols.has('server_id') || !meta.cols.has('message_content'))
                        continue;
                    const sel = [
                        meta.cols.has('local_id') ? 'local_id' : '0',
                        meta.cols.has('create_time') ? 'create_time' : '0',
                        'message_content',
                        `${serverExpr} AS server_id`,
                    ].join(', ');
                    try {
                        const rows = db.prepare(`SELECT ${sel} FROM "${table}" WHERE ${serverExpr} IN (${placeholders})`).all(...params);
                        for (const r of rows) {
                            const sid = decodeCell(r['server_id']).trim();
                            if (sid && !out.has(sid)) {
                                out.set(sid, {
                                    createTime: Number(r['create_time'] ?? 0),
                                    content: decodeCell(r['message_content']),
                                });
                            }
                        }
                    }
                    catch { /* table unreadable */ }
                }
            }
            finally {
                db.close();
            }
        }
    };
    // Pass 1: indexed integer equality for all pure-digit ids.
    const numericIds = [...numeric.values()];
    if (numericIds.length > 0) {
        for (let i = 0; i < numericIds.length; i += 400) {
            scan('server_id', numericIds.slice(i, i + 400));
        }
    }
    // Pass 2: text CAST fallback for ids still missing (text-stored or non-numeric).
    const leftover = pending.filter(id => !out.has(id));
    if (leftover.length > 0) {
        for (let i = 0; i < leftover.length; i += 400) {
            scan('CAST(server_id AS TEXT)', leftover.slice(i, i + 400));
        }
    }
    return out;
}
/** Extract a numeric amount from a payment card title (￥0.01 / 8.88). */
function parseAmount(s) {
    const str = typeof s === 'string' || typeof s === 'number' ? String(s) : '';
    const m = str.match(/[\d.]+/);
    return m ? Number(m[0]) : 0;
}
/** Parse a payment message content into amount + kind. */
function paymentFromContent(content) {
    if (!content)
        return { amount: 0, kind: null };
    const parsed = parseMessageContent(49, content, false);
    const rich = parsed.rich;
    if (!rich)
        return { amount: 0, kind: null };
    if (rich.type === 'transfer')
        return { amount: parseAmount(rich.title), kind: 'transfer' };
    if (rich.type === 'redpacket')
        return { amount: parseAmount(rich.amount), kind: 'redpacket' };
    return { amount: 0, kind: null };
}
/** Month start/end epoch seconds for YYYY-MM (local midnight). */
function monthRange(month) {
    if (!month || !/^\d{4}-\d{2}$/.test(month))
        return { from: 0, to: 0 };
    const parts = month.split('-');
    const y = Number(parts[0]);
    const m = Number(parts[1]);
    const from = Math.floor(new Date(y, m - 1, 1).getTime() / 1000);
    const to = Math.floor(new Date(y, m, 1).getTime() / 1000) - 1;
    return { from, to };
}
/**
 * Compute the funds ledger snapshot.
 * @param decryptedDir - decrypted data root.
 * @param month - optional YYYY-MM filter.
 * @param selfUsername - logged-in account wxid (direction labels).
 * @returns the ledger snapshot.
 */
export function queryLedger(decryptedDir, month, selfUsername) {
    const names = contactMeta(decryptedDir).names;
    const self = (selfUsername ?? '').trim();
    const { from, to } = monthRange(month);
    const now = Math.floor(Date.now() / 1000);
    const gdb = join(decryptedDir, 'general', 'general.db');
    const transfers = [];
    const redpackets = [];
    const serverIds = new Set();
    if (existsSync(gdb)) {
        const db = new DatabaseSync(gdb, { readOnly: true });
        try {
            const tCols = new Set(db.prepare('PRAGMA table_info(transferTable)').all().map(r => r.name));
            if (tCols.has('session_name') && tCols.has('message_server_id')) {
                const t = tCols.has('begin_transfer_time') ? 'begin_transfer_time' : '0';
                const inv = tCols.has('invalid_time') ? 'invalid_time' : '0';
                const where = from > 0 && t !== '0' ? ` WHERE ${t} >= ${from} AND ${t} <= ${to}` : '';
                try {
                    const sql = `SELECT session_name, CAST(message_server_id AS TEXT) AS message_server_id, CAST(second_message_server_id AS TEXT) AS second_message_server_id, pay_receiver, pay_payer, ${t} AS begin_transfer_time, ${inv} AS invalid_time FROM transferTable${where}`;
                    const rows = db.prepare(sql).all();
                    for (const r of rows) {
                        const sid = decodeCell(r['message_server_id']).trim();
                        const sid2 = decodeCell(r['second_message_server_id']).trim();
                        if (sid)
                            serverIds.add(sid);
                        if (sid2 && sid2 !== '0')
                            serverIds.add(sid2);
                        const payer = decodeCell(r['pay_payer']).trim();
                        const receiver = decodeCell(r['pay_receiver']).trim();
                        const session = decodeCell(r['session_name']).trim();
                        const direction = self && payer === self ? 'out' : self && receiver === self ? 'in' : 'unknown';
                        transfers.push({
                            session,
                            payer,
                            receiver,
                            direction,
                            time: Number(r['begin_transfer_time'] ?? 0),
                            invalidTime: Number(r['invalid_time'] ?? 0),
                            serverIds: [sid, sid2].filter(Boolean),
                        });
                    }
                }
                catch { /* transferTable unreadable */ }
            }
            const rpCols = new Set(db.prepare('PRAGMA table_info(redEnvelopeTable)').all().map(r => r.name));
            if (rpCols.has('session_name') && rpCols.has('message_server_id')) {
                const senderCol = rpCols.has('sender_user_name') ? 'sender_user_name' : "'' AS sender_user_name";
                const hbStatus = rpCols.has('hb_status') ? 'hb_status' : '0';
                try {
                    const sql = `SELECT session_name, CAST(message_server_id AS TEXT) AS message_server_id, ${senderCol} AS sender_user_name, ${hbStatus} AS hb_status FROM redEnvelopeTable`;
                    const rows = db.prepare(sql).all();
                    for (const r of rows) {
                        const sid = decodeCell(r['message_server_id']).trim();
                        if (sid)
                            serverIds.add(sid);
                        const sender = decodeCell(r['sender_user_name']).trim();
                        const session = decodeCell(r['session_name']).trim();
                        const direction = self && sender === self ? 'out' : self ? 'in' : 'unknown';
                        redpackets.push({
                            session,
                            sender,
                            direction,
                            returned: Number(r['hb_status'] ?? 0) === 2,
                            serverId: sid,
                        });
                    }
                }
                catch { /* redEnvelopeTable unreadable */ }
            }
        }
        finally {
            db.close();
        }
    }
    // Resolve amounts + times for all referenced server ids in one shard pass.
    const resolved = resolveMessagesByServerIds(decryptedDir, [...serverIds]);
    const byMsg = new Map();
    for (const [sid, info] of resolved) {
        const pay = paymentFromContent(info.content);
        if (pay.kind)
            byMsg.set(sid, { amount: pay.amount, time: info.createTime });
    }
    const contactAgg = new Map();
    const addContact = (username, amount, direction, count = 1) => {
        if (!username)
            return;
        const key = username + ':' + direction;
        const cur = contactAgg.get(key);
        if (cur) {
            cur.count += count;
            cur.amount += amount;
        }
        else {
            contactAgg.set(key, { username, name: names.get(username) ?? username, count, amount, direction });
        }
    };
    const warnings = [];
    let transferIn = 0;
    let transferOut = 0;
    let transferInAmount = 0;
    let transferOutAmount = 0;
    let transferCount = 0;
    for (const t of transfers) {
        transferCount += 1;
        const msg = t.serverIds.map(s => byMsg.get(s)).find(Boolean);
        const amount = msg?.amount ?? 0;
        const time = msg?.time ?? t.time;
        if (t.direction === 'in') {
            transferIn += 1;
            transferInAmount += amount;
            addContact(t.receiver === self ? t.session : t.payer || t.receiver || t.session, amount, 'in');
        }
        else if (t.direction === 'out') {
            transferOut += 1;
            transferOutAmount += amount;
            addContact(t.payer === self ? (t.receiver || t.session) : t.session, amount, 'out');
        }
        else {
            addContact(t.session || t.receiver || t.payer, amount, 'unknown');
        }
        if (t.invalidTime > 0 && t.invalidTime <= now) {
            warnings.push({ kind: 'transfer-timeout', label: '转账超时/未确认', username: t.session, name: names.get(t.session) ?? t.session, time, amount });
        }
    }
    let rpSent = 0;
    let rpReceived = 0;
    let rpSentAmount = 0;
    let rpReceivedAmount = 0;
    let rpKnownReceived = 0;
    for (const r of redpackets) {
        const msg = byMsg.get(r.serverId);
        const amount = msg?.amount ?? 0;
        const time = msg?.time ?? 0;
        if (from > 0 && (time <= 0 || time < from || time > to))
            continue;
        const direction = r.direction;
        if (direction === 'out') {
            rpSent += 1;
            rpSentAmount += amount;
            addContact(r.session, amount, 'out');
        }
        else if (direction === 'in') {
            rpReceived += 1;
            rpReceivedAmount += amount;
            rpKnownReceived += 1;
            addContact(r.sender || r.session, amount, 'in');
        }
        else {
            rpReceived += 1;
            rpReceivedAmount += amount;
            addContact(r.sender || r.session, amount, 'unknown');
        }
        if (r.returned) {
            warnings.push({ kind: 'redpacket-returned', label: '红包已退回', username: r.sender || r.session, name: names.get(r.sender) ?? r.sender, time, amount });
        }
    }
    const byContactRows = [...contactAgg.values()]
        .sort((a, b) => b.amount - a.amount || b.count - a.count)
        .slice(0, 20);
    const totalIn = transferInAmount + rpReceivedAmount;
    const totalOut = transferOutAmount + rpSentAmount;
    const receivedAmounts = redpackets.filter(r => r.direction !== 'out' && byMsg.get(r.serverId)?.amount).map(r => byMsg.get(r.serverId)?.amount ?? 0);
    const redpacketBest = receivedAmounts.length > 0 ? Math.max(...receivedAmounts) : 0;
    const redpacketAvg = rpKnownReceived > 0 ? rpReceivedAmount / rpKnownReceived : 0;
    return {
        month: month ?? null,
        summary: {
            transfers: transferCount,
            transferIn,
            transferOut,
            transferAmountIn: transferInAmount,
            transferAmountOut: transferOutAmount,
            redpacketsSent: rpSent,
            redpacketsReceived: rpReceived,
            redpacketAmountSent: rpSentAmount,
            redpacketAmountReceived: rpReceivedAmount,
            totalAmountIn: totalIn,
            totalAmountOut: totalOut,
        },
        byContact: byContactRows,
        redpacket: {
            sentCount: rpSent,
            receivedCount: rpReceived,
            sentAmount: rpSentAmount,
            receivedAmount: rpReceivedAmount,
            bestAmount: redpacketBest,
            avgAmount: redpacketAvg,
        },
        warnings,
        updatedAt: now,
    };
}
//# sourceMappingURL=ledger.js.map