/**
 * Records queries (撤回/转账/红包/视频号/小程序/好友验证) over general.db,
 * rewritten from st_control general_records/lists.rs. The revoked cache lives
 * in message shards (handlers/data/revoked.rs mirror).
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { contactMeta } from "./meta.js";
/** Stringify an SQLite cell (TEXT/NUMBER/BLOB) to a string. */
function cellString(v) {
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
function countIn(db, table) {
    try {
        return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    }
    catch {
        return 0;
    }
}
/** Count rows with an optional WHERE clause. */
function countWhere(db, table, whereSql) {
    try {
        if (!whereSql)
            return countIn(db, table);
        return db.prepare('SELECT COUNT(*) AS n FROM ' + table + whereSql).get().n;
    }
    catch {
        return 0;
    }
}
/** Query one records table with limit/offset/keyword/direction, returning rows as objects. */
function queryTable(db, table, cols, orderCol, limit, offset, whereSql = '', direction = 'desc') {
    try {
        const sel = cols.map(c => c).join(', ');
        const dir = direction === 'asc' ? 'ASC' : 'DESC';
        const sql = 'SELECT ' + sel + ' FROM ' + table + whereSql + ' ORDER BY ' + orderCol + ' ' + dir + ' LIMIT ? OFFSET ?';
        return db.prepare(sql).all(limit, offset);
    }
    catch {
        return [];
    }
}
/** Build a numeric time-range WHERE fragment for a time column. */
function timeRangeSql(timeCol, from, to) {
    const parts = [];
    if (from > 0)
        parts.push(' ' + timeCol + ' >= ' + String(Math.floor(from)));
    if (to > 0)
        parts.push(' ' + timeCol + ' <= ' + String(Math.floor(to)));
    return parts.length > 0 ? parts.join(' AND') : '';
}
/** Locate the revoke cache table across message shards. */
function findRevokeTable(decryptedDir) {
    const msgDir = join(decryptedDir, 'message');
    if (!existsSync(msgDir))
        return { db: null, table: '' };
    for (const file of readdirSync(msgDir)) {
        if (!file.endsWith('.db') || file.includes('_shm') || file.includes('_wal'))
            continue;
        try {
            const db = new DatabaseSync(join(msgDir, file), { readOnly: true });
            const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => String(r.name));
            const hit = tables.find(t => t.includes('_weflow_anti_revoke_deleted_cache'));
            if (hit)
                return { db, table: hit };
            db.close();
        }
        catch { /* next */ }
    }
    return { db: null, table: '' };
}
/** 为记录追加「人类可读」展示字段（显示名）。 */
function enrichRecords(items, kind, names) {
    const dn = (v) => {
        const s = cellString(v);
        return s ? (names.get(s) ?? '') : '';
    };
    for (const it of items) {
        if (kind === 'revokes')
            it['session_display'] = dn(it['session_name']);
        if (kind === 'transfers') {
            it['session_display'] = dn(it['session_name']);
            it['receiver_display'] = dn(it['pay_receiver']);
            it['payer_display'] = dn(it['pay_payer']);
        }
        if (kind === 'redpackets') {
            it['session_display'] = dn(it['session_name']);
            it['sender_display'] = dn(it['sender_user_name']);
        }
        if (kind === 'finder')
            it['username_display'] = dn(it['finder_username']);
        if (kind === 'friendverifications')
            it['user_display'] = dn(it['user_name_']);
    }
}
/** Record-type words that are data-source names, not record content (source stopwords). */
function isRecordTypeStopword(q) {
    return [
        '红包', '转账', '转帐', '收款', '付款', '收红包', '发红包', '红包记录', '转账记录',
        'redpacket', 'red_packet', 'transfer', '转账明细', '红包明细',
    ].includes(q.trim().toLowerCase());
}
/**
 * Query one records kind.
 * @param decryptedDir - decrypted data root.
 * @param kind - records kind key.
 * @param limit - max rows.
 * @param offset - page offset.
 * @param q - optional session/user/id keyword (applied server-side per kind).
 * @returns the records snapshot.
 */
export function queryRecords(decryptedDir, kind, limit, offset, q, opts) {
    const gdb = join(decryptedDir, 'general', 'general.db');
    if (!existsSync(gdb))
        return { items: [], total: 0 };
    const db = new DatabaseSync(gdb, { readOnly: true });
    try {
        const cap = Math.min(limit ?? 50, 500);
        const off = offset ?? 0;
        const kw = (q ?? '').trim();
        const from = Math.max(0, opts?.from ?? 0);
        const to = Math.max(0, opts?.to ?? 0);
        const direction = opts?.direction === 'asc' ? 'asc' : 'desc';
        const esc = (v) => v.replace(/'/g, "''");
        const names = contactMeta(decryptedDir).names;
        // per-kind column sets mirror general_records/lists.rs; the frontend maps
        // them to per-kind tables (会话/类型/收款方/…)
        const spec = {
            revokes: {
                table: 'revokebatchmessage',
                cols: ['local_id', 'batch_id', 'msg_unique_id', 'session_name', 'msg_local_id', 'msg_create_time'],
                order: 'msg_create_time',
                timeCol: 'msg_create_time',
                where: kw ? ` WHERE session_name LIKE '%${esc(kw)}%' OR msg_unique_id LIKE '%${esc(kw)}%'` : '',
            },
            transfers: {
                table: 'transferTable',
                cols: ['transfer_id', 'transcation_id', 'CAST(message_server_id AS TEXT) AS message_server_id', 'CAST(second_message_server_id AS TEXT) AS second_message_server_id', 'session_name', 'pay_sub_type', 'pay_receiver', 'pay_payer', 'begin_transfer_time', 'last_modified_time', 'invalid_time', 'last_update_time', 'delay_confirm_flag'],
                order: 'begin_transfer_time',
                timeCol: 'begin_transfer_time',
                where: kw && !isRecordTypeStopword(kw) ? ` WHERE session_name LIKE '%${esc(kw)}%' OR transfer_id LIKE '%${esc(kw)}%'` : '',
            },
            redpackets: {
                table: 'redEnvelopeTable',
                cols: ['CAST(message_server_id AS TEXT) AS message_server_id', 'session_name', 'sender_user_name', 'native_url', 'send_id', 'scene_id', 'hb_status', 'hb_type', 'receive_status'],
                order: 'message_server_id',
                where: kw && !isRecordTypeStopword(kw) ? ` WHERE session_name LIKE '%${esc(kw)}%' OR sender_user_name LIKE '%${esc(kw)}%'` : '',
            },
            finder: {
                table: 'wcfinderlivestatus',
                cols: ['finder_live_id', 'finder_username', 'finder_export_id', 'live_status', 'replay_status', 'charge_flag'],
                order: 'finder_live_id',
            },
            miniprograms: {
                table: 'wacontact',
                cols: ['user_name', 'type', 'brand_icon_url', 'external_info', 'app_id'],
                order: 'user_name',
                timeCol: 'last_update_time',
            },
            friendverifications: {
                table: 'FMessageTable',
                cols: ['user_name_', 'type_', 'timestamp_', 'content_', 'is_sender_', 'scene_', 'remark_'],
                order: 'timestamp_',
                timeCol: 'timestamp_',
                where: kw ? ` WHERE user_name_ LIKE '%${esc(kw)}%' OR remark_ LIKE '%${esc(kw)}%' OR content_ LIKE '%${esc(kw)}%'` : '',
            },
        };
        const s = spec[kind];
        if (!s)
            return { items: [], total: 0 };
        // Combine the keyword WHERE clause (may contain OR) with the time range.
        const combineWhere = (base, time) => {
            const b = base.trim();
            const t = time.trim();
            if (!b)
                return t ? ' WHERE ' + t : '';
            if (!t)
                return b;
            const inner = b.replace(/^WHERE\s+/i, '');
            return ' WHERE (' + inner + ') AND ' + t;
        };
        const timeSql = (timeCol) => timeRangeSql(timeCol, from, to);
        // miniprograms: LEFT JOIN the WeApp table for last_update_time and parse
        // the display nickname out of external_info JSON (source lists.rs). Base
        // columns are prefixed with w. because WeApp shares user_name.
        if (kind === 'miniprograms') {
            const prefixed = s.cols.map(c => 'w.' + c).join(', ');
            const sel = prefixed + ', COALESCE(a.last_update_time, 0) AS last_update_time';
            const baseWhere = kw ? ' WHERE w.user_name LIKE \'' + esc(kw) + '%\'' : '';
            const whereSql = combineWhere(baseWhere, s.timeCol ? timeSql('a.' + s.timeCol) : '');
            const dir = direction === 'asc' ? 'ASC' : 'DESC';
            const sql = 'SELECT ' + sel + ' FROM wacontact w LEFT JOIN WeAppBizAttrSyncBufferTableV02 a ON a.user_name = w.user_name' + whereSql + ' ORDER BY COALESCE(a.last_update_time, 0) ' + dir + ', w.user_name ASC LIMIT ? OFFSET ?';
            let items = [];
            try {
                items = db.prepare(sql).all(cap, off);
            }
            catch {
                items = [];
            }
            for (const it of items) {
                const ext = String(it['external_info'] ?? '');
                let nickname = '';
                try {
                    const v = JSON.parse(ext);
                    nickname = cellString(v.RegisterSource?.NickName || v.NickName || '');
                }
                catch { /* not JSON */ }
                it['nickname'] = nickname;
            }
            enrichRecords(items, kind, names);
            let total = 0;
            try {
                total = db.prepare('SELECT COUNT(*) AS n FROM wacontact w LEFT JOIN WeAppBizAttrSyncBufferTableV02 a ON a.user_name = w.user_name' + whereSql).get().n;
            }
            catch {
                total = 0;
            }
            return { items, total };
        }
        const whereSql = combineWhere(s.where ?? '', s.timeCol ? timeSql(s.timeCol) : '');
        const items = queryTable(db, s.table, s.cols, s.order, cap, off, whereSql, direction);
        enrichRecords(items, kind, names);
        return { items, total: countWhere(db, s.table, whereSql) };
    }
    finally {
        db.close();
    }
}
/** WeChat message local_type → Chinese label (mirror handlers/data/revoked.rs). */
function revokeTypeLabel(t) {
    switch (t) {
        case 1: return '文本';
        case 3: return '图片';
        case 34: return '语音';
        case 42: return '名片';
        case 43: return '视频';
        case 47: return '表情';
        case 48: return '位置';
        case 49: return '文件/链接';
        case 10000: return '系统消息';
        default: return '其他';
    }
}
/** Parse message_content `sender:\n内容` (mirror handlers/data/revoked.rs). */
function parseRevokeContent(raw, fallbackSender) {
    if (raw == null)
        return { sender: fallbackSender, content: '（无内容副本）' };
    const nl = raw.indexOf('\n');
    let sender = fallbackSender;
    let body = raw;
    if (nl >= 0) {
        const head = raw.slice(0, nl).replace(/:+$/, '').trim();
        if (head)
            sender = head;
        body = raw.slice(nl + 1);
    }
    const content = body.trim();
    return { sender, content: content || '（内容为编码/压缩格式，无法预览）' };
}
/**
 * Query revoked messages from the anti-revoke cache (source shape:
 * sender / type_label / content / create_time, time-descending).
 * @param decryptedDir - decrypted data root.
 * @param limit - max rows (default 200, capped 500).
 * @returns the revoked snapshot.
 */
export function queryRevoked(decryptedDir, limit, offset = 0) {
    const { db, table } = findRevokeTable(decryptedDir);
    if (db === null || !table)
        return { items: [], total: 0 };
    try {
        const cap = Math.min(limit ?? 200, 500);
        const cols = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name));
        const sel = (cand, dft) => (cols.has(cand) ? cand : dft);
        const rows = db.prepare(`SELECT ${sel('local_type', '0')} AS lt, ${sel('real_sender_id', '0')} AS rid, ${sel('create_time', '0')} AS ct, ${sel('message_content', "''")} AS mc FROM ${table} ORDER BY create_time DESC LIMIT ? OFFSET ?`).all(cap, offset);
        const items = rows.map((r) => {
            const t = r.lt ?? 0;
            const realId = r.rid ?? 0;
            const fallback = realId > 0 ? `发送者#${realId}` : '未知发送者';
            const { sender, content } = parseRevokeContent(cellString(r.mc), fallback);
            return { sender, type_label: revokeTypeLabel(t), content, create_time: r.ct ?? 0 };
        });
        const total = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? items.length;
        return { items, total };
    }
    finally {
        db.close();
    }
}
//# sourceMappingURL=records.js.map