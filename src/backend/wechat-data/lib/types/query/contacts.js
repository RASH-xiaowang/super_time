/**
 * Contact queries over st_control's decrypted contact.db, mirroring the Rust
 * modules/contacts.rs: full category semantics (friend/group/official/service/
 * enterprise/member/system/deleted), pinyin initials, group owner + member
 * counts, member's owning group, and category stats.
 */
import { DatabaseSync } from 'node:sqlite';
import { cachedBySig, fileSigOf } from "./meta.js";
import { join } from 'node:path';
function tableColumns(db, table) {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all();
    return new Set(rows.map(r => r.name));
}
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
/** Official-account check: gh_ prefix (source is_official_account). */
function isOfficialAccount(username) {
    return username.startsWith('gh_') || username.includes('gh_');
}
/** Builtin notification accounts (source is_builtin_account). */
function isBuiltinAccount(username) {
    const s = username.toLowerCase();
    return s === 'weixin' || s === 'notifymessage' || s === 'cmdamount' || s === 'floatbottle' || s.startsWith('weixin_');
}
/** Source category_of: six mutually exclusive categories by local_type + username. */
function categoryOf(localType, username, deleteFlag) {
    if (deleteFlag !== 0 || localType === 4)
        return 'deleted';
    if (username.endsWith('@chatroom'))
        return 'group';
    if (isOfficialAccount(username))
        return 'official';
    if (isBuiltinAccount(username))
        return 'system';
    if (username.endsWith('@kefu.openim'))
        return 'service';
    if (username.endsWith('@openim'))
        return 'enterprise';
    if (localType === 1)
        return 'friend';
    return 'member';
}
/** Source category_label. */
function categoryLabel(category) {
    switch (category) {
        case 'friend': return '联系人';
        case 'enterprise': return '企业微信联系人';
        case 'group': return '群聊';
        case 'service': return '服务号';
        case 'official': return '公众号';
        case 'member': return '群成员';
        case 'system': return '系统';
        case 'deleted': return '已删除';
        default: return '其他';
    }
}
/** Source initial_of: remark initial > nick initial > display first char. */
function initialOf(remarkInitial, nickInitial, display) {
    const raw = remarkInitial || nickInitial || display;
    const ch = raw.slice(0, 1).toUpperCase();
    if (/[A-Z]/.test(ch))
        return ch;
    return '#';
}
export function queryContacts(decryptedDir, options) {
    // Cache keyed on the contact snapshot's signature. The realtime sync rewrites
    // contact.db under an atomic rename, so the signature changes and this
    // recomputes immediately instead of re-scanning on every panel refresh.
    const limit = options?.limit;
    const offset = options?.offset ?? 0;
    return cachedBySig('contacts:' + decryptedDir + ':' + String(limit ?? '') + ':' + String(offset), fileSigOf(join(decryptedDir, 'contact', 'contact.db')), () => computeContacts(decryptedDir, limit, offset));
}
function computeContacts(decryptedDir, limit, offset = 0) {
    const db = new DatabaseSync(join(decryptedDir, 'contact', 'contact.db'), { readOnly: true });
    try {
        const cols = tableColumns(db, 'contact');
        const sel = (c, dft) => (cols.has(c) ? c : dft);
        const sql = [
            'SELECT',
            [sel('id', '0'), sel('username', "''"), sel('local_type', '0'), sel('alias', "''"),
                sel('delete_flag', '0'), sel('remark', "''"), sel('remark_pin_yin_initial', "''"),
                sel('nick_name', "''"), sel('pin_yin_initial', "''"), sel('quan_pin', "''"),
                sel('big_head_url', "''"), sel('small_head_url', "''"), sel('description', "''"), sel('is_in_chat_room', '0')].join(', '),
            'FROM contact',
        ].join(' ');
        const rows = db.prepare(sql).all();
        // group info: chat_room owner + member counts (chatroom_member.room_id -> id)
        const roomOwners = new Map();
        const roomUsernames = new Map();
        const memberCounts = new Map();
        const memberRooms = new Map();
        try {
            const crCols = tableColumns(db, 'chat_room');
            const crSel = (c, dft) => (crCols.has(c) ? c : dft);
            const rooms = db.prepare(`SELECT ${crSel('id', '0')} AS id, ${crSel('username', "''")} AS u, ${crSel('owner', "''")} AS o FROM chat_room`).all();
            for (const r of rooms) {
                roomUsernames.set(r.id, r.u);
                if (r.o)
                    roomOwners.set(r.id, r.o);
            }
            const cmCols = tableColumns(db, 'chatroom_member');
            if (cmCols.has('room_id') && cmCols.has('member_id')) {
                const members = db.prepare('SELECT room_id, member_id FROM chatroom_member').all();
                for (const m of members) {
                    const rid = m.room_id;
                    memberCounts.set(rid, (memberCounts.get(rid) ?? 0) + 1);
                    memberRooms.set(m.member_id, rid);
                }
            }
        }
        catch { /* no group tables */ }
        // official/service split by biz_info.type
        const bizTypes = new Map();
        try {
            const biCols = tableColumns(db, 'biz_info');
            if (biCols.has('username') && biCols.has('type')) {
                const biz = db.prepare('SELECT username, type FROM biz_info').all();
                for (const b of biz)
                    bizTypes.set(b.username, b.type);
            }
        }
        catch { /* no biz_info */ }
        const contacts = [];
        const stats = { friend: 0, enterprise: 0, group: 0, official: 0, service: 0, member: 0, system: 0, deleted: 0 };
        for (const r of rows) {
            const id = Number(r[sel('id', '0')] ?? 0);
            const username = cellString(r[sel('username', '')]);
            if (!username)
                continue;
            const nickName = cellString(r[sel('nick_name', '')]);
            const remark = cellString(r[sel('remark', '')]);
            const localType = Number(r[sel('local_type', '0')] ?? 0);
            const deleteFlag = Number(r[sel('delete_flag', '0')] ?? 0);
            let category = categoryOf(localType, username, deleteFlag);
            if (category === 'official') {
                const bt = bizTypes.get(username);
                if (bt === 1 || bt === 3 || bt === 5)
                    category = 'service';
            }
            const displayName = remark || nickName || username;
            const initial = initialOf(cellString(r[sel('remark_pin_yin_initial', '')]), cellString(r[sel('pin_yin_initial', '')]), displayName);
            stats[category] = (stats[category] ?? 0) + 1;
            const isGroup = category === 'group';
            const contact = {
                username,
                nickName,
                remark,
                displayName,
                alias: cellString(r[sel('alias', '')]),
                category,
                localTypeLabel: categoryLabel(category),
                initial,
                quanPin: cellString(r[sel('quan_pin', '')]),
                description: cellString(r[sel('description', '')]),
                inChatRoom: Number(r[sel('is_in_chat_room', '0')] ?? 0) === 1,
                localType,
            };
            const avatar = cellString(r[sel('big_head_url', '')]) || cellString(r[sel('small_head_url', '')]);
            if (avatar)
                contact.avatarUrl = avatar;
            if (isGroup) {
                const mc = memberCounts.get(id);
                if (mc !== undefined)
                    contact.memberCount = mc;
                const owner = roomOwners.get(id);
                if (owner)
                    contact.owner = owner;
            }
            else if (category === 'member') {
                const rid = memberRooms.get(id);
                if (rid !== undefined) {
                    const gname = roomUsernames.get(rid) ?? '';
                    if (gname)
                        contact.groupUsername = gname;
                    if (gname)
                        contact.groupName = gname;
                }
            }
            contacts.push(contact);
        }
        // source order: initial + quan_pin + display name
        contacts.sort((a, b) => (a.initial ?? '').localeCompare(b.initial ?? '') || (a.quanPin ?? '').localeCompare(b.quanPin ?? '') || a.displayName.localeCompare(b.displayName));
        const total = contacts.length;
        // Bound the page payload: the UI lazy-loads pages instead of one full list.
        const page = limit !== undefined ? contacts.slice(offset, offset + limit) : contacts;
        return { contacts: page, total, stats };
    }
    finally {
        db.close();
    }
}
//# sourceMappingURL=contacts.js.map