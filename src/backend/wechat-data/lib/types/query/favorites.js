/**
 * Favorites queries over st_control's decrypted favorite.db (fav_db_item).
 * Parses content XML (favitem type/desc/dataitem) into title/desc/url and
 * resolves sources via contact names, mirroring st_control modules/favorites.rs.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { contactMeta } from "./meta.js";
/** Coerce a DB cell to a string (null -> '', else String()). */
function cellStr(v) {
    if (typeof v === 'string')
        return v;
    if (v === null || v === undefined)
        return '';
    if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol')
        return String(v);
    if (v instanceof Uint8Array)
        return new TextDecoder('utf-8', { fatal: false }).decode(v);
    return '';
}
/** Unescape XML/HTML entities (keep newlines/tabs). */
function decodeFavText(s) {
    return s
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#x0A;/gi, '\n')
        .replace(/&#10;/g, '\n')
        .replace(/&#x0D;/gi, '\r')
        .replace(/&#13;/g, '\r')
        .replace(/&#x09;/gi, '\t')
        .replace(/&#9;/g, '\t');
}
/** Extract text between <tag ...> and </tag> (first occurrence). */
function xmlTagText(xml, tag) {
    const openExact = '<' + tag + '>';
    const openAttr = '<' + tag + ' ';
    const start = xml.indexOf(openExact) >= 0 ? xml.indexOf(openExact) : xml.indexOf(openAttr);
    if (start < 0)
        return null;
    const contentStart = xml.startsWith(openExact, start) ? start + openExact.length : (xml.indexOf('>', start) + 1);
    const close = xml.indexOf('</' + tag + '>', contentStart);
    if (close < 0)
        return null;
    return xml.slice(contentStart, close);
}
/** Extract an attribute value from a tag open (first occurrence). */
function xmlTagAttr(xml, tag, attr) {
    const openExact = '<' + tag + '>';
    const openAttr = '<' + tag + ' ';
    const start = xml.indexOf(openExact) >= 0 ? xml.indexOf(openExact) : xml.indexOf(openAttr);
    if (start < 0)
        return null;
    const tagStr = xml.slice(start, xml.indexOf('>', start));
    const search = attr + '="';
    const a = tagStr.indexOf(search);
    if (a < 0)
        return null;
    const v = a + search.length;
    const e = tagStr.indexOf('"', v);
    if (e < 0)
        return null;
    return tagStr.slice(v, e);
}
/** Extract text of the first nested tag inside a parent tag. */
function xmlNestedText(xml, parent, child) {
    const open = '<' + parent + '>';
    const start = xml.indexOf(open);
    if (start < 0)
        return null;
    const close = xml.indexOf('</' + parent + '>', start + open.length);
    if (close < 0)
        return null;
    return xmlTagText(xml.slice(start, close + open.length + parent.length + 3), child);
}
/** 收藏类型标签（微信 fav type）。 */
export function favTypeLabel(t) {
    switch (t) {
        case 1: return '文本';
        case 2: return '图片';
        case 3: return '语音';
        case 4: return '视频';
        case 5: return '链接';
        case 6: return '位置';
        case 7: return '音乐';
        case 8: return '文件';
        case 14: return '聊天记录';
        case 16: return '商品';
        case 18: return '笔记';
        case 19: return '小程序';
        case 20: return '视频号';
        default: return '其他';
    }
}
/** Strip XML tags for text-type fallback. */
function stripXmlTags(xml) {
    return decodeFavText(xml.replace(/<[^>]+>/g, '')).trim();
}
/** Parse favourites content XML into (title, desc, url). */
function parseFavContent(favType, xml) {
    if (!xml)
        return { title: '', desc: '', url: '' };
    const t = 'title';
    const d = 'desc';
    const title = xmlTagText(xml, t) ?? '';
    const descRaw = xmlTagText(xml, d) ?? '';
    if (favType === 1) {
        if (xml.includes('<')) {
            const desc = descRaw || title || stripXmlTags(xml);
            return { title: '', desc, url: '' };
        }
        return { title: '', desc: xml, url: '' };
    }
    if (favType === 5) {
        const url = (xmlTagText(xml, 'url') ?? '').replace(/&amp;/g, '&');
        return { title, desc: decodeFavText(descRaw), url };
    }
    if (favType === 14 || favType === 18) {
        const rt = xmlNestedText(xml, 'recordinfo', t) || title;
        const rd = xmlNestedText(xml, 'recordinfo', d) || descRaw;
        return { title: rt, desc: decodeFavText(rd), url: '' };
    }
    if (favType === 6) {
        const name = xmlTagAttr(xml, 'location', 'poiname') || title;
        const label = xmlTagAttr(xml, 'location', 'label') || descRaw;
        return { title: name, desc: decodeFavText(label), url: '' };
    }
    return { title, desc: decodeFavText(descRaw), url: '' };
}
/** Parse `<datalist><dataitem>` entries into typed parts (mirror parse_fav_detail). */
function parseFavParts(xml) {
    const out = [];
    let pos = 0;
    for (;;) {
        const start = xml.indexOf('<dataitem', pos);
        if (start < 0)
            break;
        const end = xml.indexOf('</dataitem>', start);
        const body = end >= 0 ? xml.slice(start, end) : xml.slice(start);
        const datatype = Number.parseInt(xmlTagAttr(body, 'dataitem', 'datatype') ?? '0', 10) || 0;
        const dataid = (xmlTagAttr(body, 'dataitem', 'dataid') ?? '').trim().toLowerCase();
        const md5 = (xmlTagText(body, 'fullmd5') ?? '').trim().toLowerCase() || dataid;
        const thumbMd5 = (xmlTagText(body, 'thumbfullmd5') ?? '').trim().toLowerCase();
        const text = decodeFavText(xmlTagText(body, 'datadesc') ?? '') || decodeFavText(xmlTagText(body, 'datatitle') ?? '');
        const sourceName = xmlTagText(body, 'datasrcname') ?? '';
        const sourceTime = xmlTagText(body, 'datasrctime') ?? '';
        const sourceHead = xmlTagText(body, 'sourceheadurl') ?? '';
        const metaPart = () => {
            const p = { kind: 'text' };
            if (sourceName)
                p.sourceName = sourceName;
            if (sourceTime)
                p.sourceTime = sourceTime;
            if (sourceHead)
                p.sourceHead = sourceHead;
            return p;
        };
        const pushPart = (part) => { out.push(part); };
        if (datatype === 1) {
            if (text) {
                const p = metaPart();
                p.text = text;
                pushPart(p);
            }
        }
        else if (datatype === 2) {
            const p = metaPart();
            p.kind = 'image';
            if (thumbMd5)
                p.md5 = thumbMd5;
            else if (md5)
                p.md5 = md5;
            if (text)
                p.text = text;
            pushPart(p);
        }
        else if (datatype === 3) {
            const p = metaPart();
            p.kind = 'voice';
            if (md5)
                p.md5 = md5;
            pushPart(p);
        }
        else if (datatype === 4) {
            const p = metaPart();
            p.kind = 'video';
            if (md5)
                p.md5 = md5;
            const dur = Number.parseFloat(xmlTagText(body, 'duration') ?? '0');
            if (dur > 0)
                p.duration = dur;
            if (text)
                p.text = text;
            pushPart(p);
        }
        else if (datatype === 5 || datatype === 19 || datatype === 36) {
            const p = metaPart();
            p.kind = 'link';
            if (text)
                p.text = text;
            const u = (xmlTagText(body, 'stream_weburl') ?? xmlTagText(body, 'url') ?? '').replace(/&amp;/g, '&');
            if (u)
                p.url = u;
            pushPart(p);
        }
        else if (datatype === 8) {
            const p = metaPart();
            p.kind = 'file';
            const n = xmlTagText(body, 'datatitle') ?? '';
            if (n)
                p.name = n;
            const e = xmlTagText(body, 'datafmt') ?? '';
            if (e)
                p.ext = e;
            const sz = Number.parseInt(xmlTagText(body, 'fullsize') ?? '0', 10);
            if (sz > 0)
                p.size = sz;
            pushPart(p);
        }
        pos = end >= 0 ? end + 10 : xml.length;
    }
    return out;
}
/** Format a unix timestamp as `YYYY-MM-DD HH:mm`. */
function fmtDateTime(ts) {
    if (!ts)
        return '';
    const d = new Date(ts * 1000);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
/**
 * Read the favorites list with parsed title/desc/url/source.
 * @param decryptedDir - decrypted data root.
 * @param limit - max rows.
 * @returns the favorites snapshot.
 */
export function queryFavorites(decryptedDir, limit, offset = 0) {
    const db = new DatabaseSync(join(decryptedDir, 'favorite', 'favorite.db'), { readOnly: true });
    try {
        const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fav_db_item'").get() !== undefined;
        if (!has)
            return { favorites: [], total: 0 };
        const cols = new Set(db.prepare('PRAGMA table_info(fav_db_item)').all().map(r => r.name));
        const sel = (c, dft) => (cols.has(c) ? c : dft);
        const cap = Math.min(limit ?? 200, 2000);
        const sql = [
            'SELECT',
            [sel('local_id', '0'), sel('type', '0'), sel('update_time', '0'), sel('content', "''"), sel('fromusr', "''"), sel('realchatname', "''")].join(', '),
            'FROM fav_db_item',
            'ORDER BY', sel('update_time', 'local_id'), 'DESC',
            'LIMIT ? OFFSET ?',
        ].join(' ');
        const rows = db.prepare(sql).all(cap, offset);
        const total = db.prepare('SELECT COUNT(*) AS n FROM fav_db_item').get()?.n ?? rows.length;
        const names = contactMeta(decryptedDir).names;
        const favorites = rows.map((r) => {
            const type = Number(r[sel('type', '0')] ?? 0);
            const xml = cellStr(r[sel('content', '')] ?? '');
            const fromUsr = cellStr(r[sel('fromusr', '')] ?? '');
            const chatName = cellStr(r[sel('realchatname', '')] ?? '');
            const parsed = parseFavContent(type, xml);
            const source = chatName ? (names.get(chatName) ?? chatName) : (fromUsr ? (names.get(fromUsr) ?? fromUsr) : '');
            const updateTime = Number(r[sel('update_time', '0')] ?? 0);
            return {
                localId: Number(r[sel('local_id', '0')] ?? 0),
                type,
                typeLabel: favTypeLabel(type),
                title: parsed.title,
                desc: parsed.desc,
                url: parsed.url,
                updateTime,
                time: fmtDateTime(updateTime),
                content: xml,
                fromUsr,
                chatName,
                source,
                items: parseFavParts(xml),
            };
        });
        return { favorites, total };
    }
    finally {
        db.close();
    }
}
/**
 * Delete favorite items by local_id (writes to favorite.db copy).
 * @param decryptedDir - decrypted data root.
 * @param ids - local_ids to delete.
 * @returns deleted count.
 */
export function deleteFavoriteItems(decryptedDir, ids) {
    if (ids.length === 0)
        return { ok: true, deleted: 0 };
    const dbPath = join(decryptedDir, 'favorite', 'favorite.db');
    if (!existsSync(dbPath))
        return { ok: false, deleted: 0, error: '收藏库不存在' };
    try {
        const db = new DatabaseSync(dbPath);
        const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fav_db_item'").get() !== undefined;
        if (!has) {
            db.close();
            return { ok: false, deleted: 0, error: 'fav_db_item 表不存在' };
        }
        const stmt = db.prepare('DELETE FROM fav_db_item WHERE local_id = ?');
        let deleted = 0;
        for (const id of ids) {
            deleted += Number(stmt.run(id).changes);
        }
        db.close();
        return { ok: true, deleted };
    }
    catch (e) {
        return { ok: false, deleted: 0, error: e.message };
    }
}
//# sourceMappingURL=favorites.js.map