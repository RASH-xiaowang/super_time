/**
 * Group chat info (群聊信息) queries over st_control's decrypted contact.db:
 * chatroom name/remark, announcement (chat_room_info_detail), own alias and
 * member grid (chatroom_member joined to contact for names/avatars).
 */
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { buildRegion, cellText, parseContactExtra, readVarint } from "./region.js";
/** Strip the WeChat instance suffix (wxid_xxx_f312 -> wxid_xxx). */
function cleanWxid(username) {
    const m = username.match(/^(wxid_[A-Za-z0-9]+)(?:_[A-Za-z0-9]+)?$/);
    return m ? (m[1] ?? username) : username;
}
/**
 * Parse the chat_room.ext_buffer member snapshot (protobuf).
 * Outer message = repeated field-1 MemberInfo entries; each entry has field 1
 * (member username), field 3 (role flag varint) and field 4 (inviter username);
 * trailing outer fields 3/4/5 are counters/status and are ignored.
 */
export function parseChatRoomExtBuffer(raw) {
    const out = [];
    let idx = 0;
    const n = raw.length;
    while (idx < n) {
        const tag = readVarint(raw, idx);
        if (!tag)
            break;
        idx = tag.next;
        const field = tag.value >> 3;
        const wire = tag.value & 0x7;
        if (wire !== 2) {
            if (wire === 0) {
                const v = readVarint(raw, idx);
                if (!v)
                    break;
                idx = v.next;
            }
            else if (wire === 1)
                idx += 8;
            else if (wire === 5)
                idx += 4;
            else
                break;
            continue;
        }
        const len = readVarint(raw, idx);
        if (!len)
            break;
        idx = len.next;
        const end = idx + len.value;
        if (end > n)
            break;
        if (field === 1) {
            const entry = raw.subarray(idx, end);
            const item = { username: '' };
            let i = 0;
            while (i < entry.length) {
                const et = readVarint(entry, i);
                if (!et)
                    break;
                i = et.next;
                const ef = et.value >> 3;
                const ew = et.value & 0x7;
                if (ew === 0) {
                    const v = readVarint(entry, i);
                    if (!v)
                        break;
                    i = v.next;
                    if (ef === 3)
                        item.roleFlag = v.value;
                }
                else if (ew === 2) {
                    const el = readVarint(entry, i);
                    if (!el)
                        break;
                    i = el.next;
                    const ee = i + el.value;
                    if (ee > entry.length)
                        break;
                    const text = new TextDecoder('utf-8', { fatal: false }).decode(entry.subarray(i, ee)).trim();
                    if (ef === 1)
                        item.username = text;
                    else if (ef === 4)
                        item.inviter = text;
                    i = ee;
                }
                else if (ew === 1)
                    i += 8;
                else if (ew === 5)
                    i += 4;
                else
                    break;
            }
            if (item.username)
                out.push(item);
        }
        idx = end;
    }
    return out;
}
/** Enterprise WeChat official wording map: wording_id(@im.wxwork) -> wording. */
let _openimNames = null;
function openimNames(decryptedDir) {
    if (_openimNames && _openimNames.dir === decryptedDir)
        return _openimNames.map;
    const map = new Map();
    try {
        const db = new DatabaseSync(join(decryptedDir, 'contact', 'contact.db'), { readOnly: true });
        try {
            const rows = db.prepare('SELECT wording_id AS id, wording AS w FROM openim_wording').all();
            for (const r of rows) {
                const id = cellText(r.id).trim();
                const w = cellText(r.w).trim();
                if (id && w)
                    map.set(id, w);
            }
        }
        catch { /* table absent */ }
        db.close();
    }
    catch { /* contact db unavailable */ }
    _openimNames = { dir: decryptedDir, map };
    return map;
}
/** Clean a profile text that may carry a protobuf prefix + JSON (enterprise WeChat). */
function cleanProfileText(raw) {
    const start = raw.indexOf('{');
    if (start >= 0) {
        const json = raw.slice(start);
        try {
            const obj = JSON.parse(json);
            {
                const ci = obj['custom_info'];
                if (Array.isArray(ci) && ci.length > 0) {
                    const parts = [];
                    for (const rawCard of ci) {
                        const card = rawCard;
                        const t = typeof card['title'] === 'string' ? card['title'].trim() : '';
                        if (t && !parts.includes(t))
                            parts.push(t);
                        const det = card['detail'];
                        if (Array.isArray(det)) {
                            for (const rawD of det) {
                                const d = rawD;
                                const desc = typeof d['desc'] === 'string' ? d['desc'].trim() : '';
                                if (!desc || /@im\.wxwork$/i.test(desc))
                                    continue;
                                if (!parts.includes(desc))
                                    parts.push(desc);
                            }
                        }
                        else if (typeof det === 'string' && det.trim() && !parts.includes(det.trim())) {
                            parts.push(det.trim());
                        }
                    }
                    return parts.join(' · ').slice(0, 120);
                }
                const sig = obj['signature'] ?? obj['desc'] ?? obj['title'];
                if (typeof sig === 'string' && sig.trim())
                    return sig.trim().slice(0, 120);
            }
        }
        catch {
            // not JSON: continue to raw cleanup
        }
    }
    return raw.replace(/^[^\u4e00-\u9fa5A-Za-z0-9{]+/, '').trim().slice(0, 120);
}
/**
 * Load group info for one chatroom.
 * @param decryptedDir - st_control decrypted data root.
 * @param username - chatroom username (e.g. 123456789@chatroom).
 * @param selfUsername - logged-in account wxid (instance suffix tolerated).
 * @returns snapshot with the group (null when the chatroom is unknown).
 */
export function queryGroupInfo(decryptedDir, username, selfUsername) {
    const dbPath = join(decryptedDir, 'contact', 'contact.db');
    let db = null;
    try {
        db = new DatabaseSync(dbPath, { readOnly: true });
        const row = db.prepare('SELECT username, nick_name, remark, chat_room_notify, flag FROM contact WHERE username=?').get(username);
        if (!row)
            return { group: null };
        const name = cellText(row['nick_name']).trim() || username;
        const remark = cellText(row['remark']).trim();
        const notify = Number(row['chat_room_notify'] ?? 1);
        const flag = Number(row['flag'] ?? 0);
        const cr = db.prepare('SELECT owner FROM chat_room WHERE username=?').get(username);
        const info = db.prepare('SELECT announcement_, announcement_editor_, announcement_publish_time_ FROM chat_room_info_detail WHERE username_=?').get(username);
        const members = [];
        let totalMembers = 0;
        const roomRow = db.prepare('SELECT id, ext_buffer FROM chat_room WHERE username=?').get(username);
        const roomId = roomRow?.id;
        const roomExt = roomRow?.ext_buffer;
        const selfClean = selfUsername ? cleanWxid(selfUsername) : '';
        const seenMembers = new Set();
        const pushMember = (mUsername, r) => {
            if (!mUsername || seenMembers.has(mUsername))
                return;
            seenMembers.add(mUsername);
            const memName = r ? cellText(r['remark']).trim() || cellText(r['nick_name']).trim() || mUsername : mUsername;
            const member = {
                username: mUsername,
                name: memName,
            };
            if (r) {
                const head = cellText(r['small_head_url']).trim() || cellText(r['big_head_url']).trim();
                if (head)
                    member.head = head;
                const eb = r['extra_buffer'];
                const ebBuf = eb instanceof Uint8Array
                    ? Buffer.from(eb)
                    : typeof eb === 'string' && eb.length > 0
                        ? Buffer.from(eb, 'utf8')
                        : Buffer.alloc(0);
                if (ebBuf.length > 0) {
                    const extra = parseContactExtra(ebBuf);
                    if (extra.signature) {
                        const clean = cleanProfileText(extra.signature);
                        if (clean)
                            member.signature = clean;
                    }
                    if (mUsername.endsWith('@openim') && member.name === mUsername && extra.wordingId) {
                        const w = openimNames(decryptedDir).get(extra.wordingId);
                        if (w)
                            member.name = w;
                    }
                    if (extra.gender !== undefined)
                        member.gender = extra.gender;
                    const region = buildRegion(extra.country ?? '', extra.province ?? '', extra.city ?? '');
                    if (region)
                        member.region = region;
                }
            }
            if (selfClean && cleanWxid(mUsername) === selfClean)
                member.isSelf = true;
            members.push(member);
        };
        if (roomId !== undefined) {
            try {
                const rows = db.prepare('SELECT c.username, c.nick_name, c.remark, c.small_head_url, c.big_head_url, c.extra_buffer ' +
                    'FROM chatroom_member m LEFT JOIN contact c ON c.id = m.member_id ' +
                    'WHERE m.room_id = ? ORDER BY m.rowid').all(roomId);
                for (const r of rows) {
                    const mUsername = cellText(r['username']);
                    if (mUsername)
                        pushMember(mUsername, r);
                }
            }
            catch {
                // member table unavailable
            }
        }
        // chat_room.ext_buffer 成员快照：补全 chatroom_member 缺失/被裁剪的成员
        let snapCount = 0;
        const extBuf = roomExt instanceof Uint8Array
            ? Buffer.from(roomExt)
            : typeof roomExt === 'string' && roomExt.length > 0
                ? Buffer.from(roomExt, 'utf8')
                : Buffer.alloc(0);
        if (extBuf.length > 0) {
            const snap = parseChatRoomExtBuffer(extBuf);
            snapCount = snap.length;
            const contactStmt = db.prepare('SELECT username, nick_name, remark, small_head_url, big_head_url, extra_buffer FROM contact WHERE username=?');
            for (const s of snap) {
                if (!s.username || seenMembers.has(s.username))
                    continue;
                let c;
                try {
                    c = contactStmt.get(s.username);
                }
                catch {
                    c = undefined;
                }
                pushMember(s.username, c);
            }
        }
        totalMembers = Math.max(snapCount, seenMembers.size);
        let myAlias;
        const selfRow = members.find(m => m.isSelf);
        if (selfRow)
            myAlias = selfRow.name;
        const group = {
            username,
            name,
            remark,
            announcement: cellText(info?.announcement_ ?? '').trim(),
            totalMembers,
            members,
            settings: {
                // chat_room_notify: 1 = 通知已开启 (免打扰 off); 0 = 免打扰开启.
                muted: notify === 0,
                pinned: (flag & 0x800) !== 0,
                savedToContacts: false,
                showMemberNickname: true,
            },
        };
        if (cr) {
            const owner = cellText(cr.owner).trim();
            if (owner)
                group.owner = owner;
        }
        if (info) {
            const editor = cellText(info.announcement_editor_).trim();
            if (editor)
                group.announcementEditor = editor;
            const pubTime = Number(info.announcement_publish_time_ ?? 0);
            if (pubTime > 0)
                group.announcementTime = pubTime;
        }
        if (myAlias)
            group.myAlias = myAlias;
        return { group };
    }
    finally {
        try {
            db?.close();
        }
        catch { /* already closed */ }
    }
}
//# sourceMappingURL=group-info.js.map