/**
 * Moments (朋友圈) queries over st_control's decrypted sns.db.
 * Timeline rows live in SnsTimeLine (tid/user_name/content XML); the content
 * XML is parsed into text/media/location/link fields mirroring the Rust
 * modules/moments.rs parse_sns_xml. Author names resolve via contact.db.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
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
/** Resolve the sns.db path (sns/db_sns/sns.db or sns/sns.db). */
function snsDb(decryptedDir) {
    for (const p of [join(decryptedDir, 'sns', 'db_sns', 'sns.db'), join(decryptedDir, 'sns', 'sns.db')]) {
        if (existsSync(p))
            return p;
    }
    return null;
}
/** Unescape common XML entities. */
function unescapeXml(s) {
    return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'");
}
/** Extract text between <tag ...> and </tag>, tolerating attributes on the open tag. */
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
    const tagEnd = xml.indexOf('>', start);
    if (tagEnd < 0)
        return null;
    const tagStr = xml.slice(start, tagEnd);
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
/** Extract text of the first tag among candidates (first non-empty wins). */
function tagTextFirst(xml, tags) {
    for (const t of tags) {
        const v = xmlTagText(xml, t);
        if (v != null && v.trim() !== '')
            return unescapeXml(v).trim();
    }
    return '';
}
/** Iterate <media ...>...</media> blocks. */
function mediaBlocks(xml) {
    const out = [];
    let pos = 0;
    for (;;) {
        const rest = xml.slice(pos);
        let idx = rest.indexOf('<media>');
        const idxAttr = rest.indexOf('<media ');
        if (idxAttr >= 0 && (idx < 0 || idxAttr < idx))
            idx = idxAttr;
        if (idx < 0)
            break;
        const tagStart = pos + idx;
        const tagClose = xml.indexOf('>', tagStart);
        if (tagClose < 0)
            break;
        const mediaClose = xml.indexOf('</media>', tagClose + 1);
        if (mediaClose < 0)
            break;
        out.push(xml.slice(tagClose + 1, mediaClose));
        pos = mediaClose + 8;
    }
    return out;
}
/** Whether a URL points at a video (video media is not an image). */
function isVideoUrl(u) {
    const l = u.toLowerCase();
    return l.includes('snsvideodownload') || l.includes('video.qq.com') || l.includes('.mp4');
}
/** Parse one moments content XML (mirror parse_sns_xml). */
export function parseSnsXml(xml) {
    const text = tagTextFirst(xml, ['contentDesc', 'ContentDesc']);
    const createTime = Number.parseInt(tagTextFirst(xml, ['createTime', 'CreateTime']), 10) || 0;
    const mediaCount = xml.split('<media>').length - 1 + xml.split('<media ').length - 1;
    const hasVideo = xml.includes('<type>6</type>') || xml.includes('<type>4</type>') || xml.includes('<type>15</type>');
    const mediaDesc = mediaCount === 0 ? '' : hasVideo ? '视频' : `图片×${mediaCount}`;
    const images = [];
    const videos = [];
    const timelineId = tagTextFirst(xml, ['id', 'Id']) || undefined;
    for (const inner of mediaBlocks(xml)) {
        const url = tagTextFirst(inner, ['url', 'Url', 'cdnUrl', 'cdnurl']);
        const thumb = tagTextFirst(inner, ['thumb', 'Thumb', 'cdnThumbUrl', 'cdnthumburl', 'thumbUrl', 'thumburl', 'coverUrl', 'coverurl']);
        const key = xmlTagAttr(inner, 'enc', 'key') ?? xmlTagAttr(inner, 'thumb', 'key') ?? xmlTagAttr(inner, 'url', 'key') ?? '';
        const md5 = xmlTagAttr(inner, 'url', 'md5') ?? '';
        const mediaId = tagTextFirst(inner, ['id', 'Id']) || undefined;
        const duration = Number.parseFloat(tagTextFirst(inner, ['videoDuration'])) || 0;
        if (url && isVideoUrl(url)) {
            const videoEntry = { url, thumb, key, md5, duration };
            if (mediaId)
                videoEntry.id = mediaId;
            if (timelineId)
                videoEntry.timelineId = timelineId;
            videos.push(videoEntry);
        }
        else if (url) {
            const mediaEntry = { thumb, url, key, md5 };
            if (mediaId)
                mediaEntry.id = mediaId;
            if (timelineId)
                mediaEntry.timelineId = timelineId;
            images.push(mediaEntry);
        }
    }
    const location = xmlTagAttr(xml, 'location', 'poiName') ?? xmlTagAttr(xml, 'location', 'poiname') ?? '';
    const linkTitle = unescapeXml(xmlNestedText(xml, 'ContentObject', 'title') ?? '') || unescapeXml(xmlNestedText(xml, 'contentObject', 'title') ?? '') || '';
    const linkUrl = unescapeXml(xmlTagText(xml, 'contentUrl') ?? '') || unescapeXml(xmlTagText(xml, 'ContentUrl') ?? '') || '';
    const contentType = Number.parseInt(tagTextFirst(xml, ['type', 'Type']), 10) || 0;
    const sourceNickName = tagTextFirst(xml, ['sourceNickName', 'SourceNickName']) || '';
    const publicUserName = tagTextFirst(xml, ['publicUserName', 'PublicUserName']) || '';
    const nickname = tagTextFirst(xml, ['nickname', 'NickName', 'nickName']) || '';
    return {
        text,
        createTime,
        mediaCount,
        mediaDesc,
        images,
        videos,
        location,
        linkTitle,
        linkUrl,
        contentType,
        sourceNickName,
        publicUserName,
        nickname,
    };
}
/**
 * Parse likes + comments embedded in the moments XML LocalExtraInfo.
 * <comment_user_list><user_comment>…</user_comment>…; type 1 = like, type 2 = comment.
 * Reply comments reference ref_comment_id, resolved to the target comment author.
 */
export function parseSnsLikesComments(xml) {
    const likes = [];
    const comments = [];
    const start = xml.indexOf('<LocalExtraInfo>');
    if (start < 0)
        return { likes, comments };
    const listEnd = xml.indexOf('</LocalExtraInfo>', start);
    const list = listEnd > 0 ? xml.slice(start, listEnd) : xml.slice(start);
    const raws = [];
    let pos = 0;
    for (;;) {
        const bi = list.indexOf('<user_comment>', pos);
        if (bi < 0)
            break;
        const bc = list.indexOf('</user_comment>', bi);
        if (bc < 0)
            break;
        const b = list.slice(bi + 14, bc);
        raws.push({
            id: xmlTagText(b, 'comment_id') ?? '',
            username: xmlTagText(b, 'username') ?? '',
            nickname: unescapeXml(xmlTagText(b, 'nickname') ?? ''),
            content: unescapeXml(xmlTagText(b, 'content') ?? ''),
            ts: Number.parseInt(xmlTagText(b, 'create_time') ?? '0', 10) || 0,
            ref: xmlTagText(b, 'ref_comment_id') ?? '0',
            type: Number.parseInt(xmlTagText(b, 'type') ?? '0', 10) || 0,
            block: b,
        });
        pos = bc + 15;
    }
    const byId = new Map();
    for (const r of raws) {
        if (r.id)
            byId.set(r.id, r);
    }
    for (const r of raws) {
        if (r.type === 1) {
            likes.push({ username: r.username, nickname: r.nickname });
            continue;
        }
        const refC = r.ref && r.ref !== '0' ? byId.get(r.ref) : undefined;
        const comment = {
            username: r.username,
            nickname: r.nickname,
            to_username: refC ? refC.username : '',
            to_nickname: refC ? refC.nickname : '',
            content: r.content,
            ts: r.ts,
        };
        const b = r.block;
        const ii = b.indexOf('<imageinfo>');
        if (ii >= 0) {
            const ie = b.indexOf('</imageinfo>', ii);
            const ib = ie > 0 ? b.slice(ii + 11, ie) : b.slice(ii + 11);
            const image = {};
            const iu = unescapeXml(xmlTagText(ib, 'url') ?? '');
            if (iu)
                image.url = iu;
            const it = unescapeXml(xmlTagText(ib, 'thumb_url') ?? '');
            if (it)
                image.thumb = it;
            const imd = xmlTagText(ib, 'md5') ?? '';
            if (imd)
                image.md5 = imd;
            const imid = xmlTagText(ib, 'media_id') ?? '';
            if (imid)
                image.mediaId = imid;
            if (Object.keys(image).length > 0)
                comment.image = image;
        }
        comments.push(comment);
    }
    return { likes, comments };
}
/** Format a unix timestamp as a moments time label (relative days). */
function fmtTime(ts) {
    if (!ts)
        return '';
    const d = new Date(ts * 1000);
    const now = new Date();
    const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const dayDiff = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
    const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    if (dayDiff <= 0)
        return `今天 ${hhmm}`;
    if (dayDiff === 1)
        return `昨天 ${hhmm}`;
    if (dayDiff < 365)
        return `${dayDiff}天前`;
    return `${Math.floor(dayDiff / 30)}个月前`;
}
/**
 * Read moments page (XML parsed; likes/comments resolved from SnsMessage_tmp3).
 * @param decryptedDir - decrypted data root.
 * @param offset - page offset.
 * @param limit - page size.
 * @param authorUsername - optional author filter.
 * @returns the moments snapshot.
 */
export function queryMoments(decryptedDir, offset, limit, authorUsername, selfUsername) {
    const dbPath = snsDb(decryptedDir);
    if (dbPath === null)
        return { moments: [], total: 0 };
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
        const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='SnsTimeLine'").get() !== undefined;
        if (!has)
            return { moments: [], total: 0 };
        const cols = new Set(db.prepare('PRAGMA table_info(SnsTimeLine)').all().map(r => r.name));
        const tid = cols.has('tid') ? 'tid' : 'Id';
        const uname = cols.has('user_name') ? 'user_name' : 'userName';
        const content = cols.has('content') ? 'content' : 'Content';
        const cap = Math.min(limit ?? 50, 500);
        const off = offset ?? 0;
        const where = authorUsername ? ` WHERE ${uname} = ?` : '';
        const totalRow = db.prepare(`SELECT COUNT(*) AS n FROM SnsTimeLine${where}`).all(...(authorUsername ? [authorUsername] : []))[0];
        const rows = db.prepare(`SELECT CAST(${tid} AS TEXT) AS t, ${uname} AS u, ${content} AS c FROM SnsTimeLine${where} ORDER BY ${tid} DESC LIMIT ? OFFSET ?`).all(...(authorUsername ? [authorUsername] : []), cap, off);
        const names = contactMeta(decryptedDir).names;
        const self = selfUsername ?? '';
        const moments = rows.map((r) => {
            const username = cellString(r.u);
            const xml = cellString(r.c);
            const parsed = parseSnsXml(xml);
            const social = parseSnsLikesComments(xml);
            const author = names.get(username) || parsed.nickname || username || '未知';
            const entry = {
                tid: cellString(r.t),
                username,
                author,
                text: parsed.text,
                ts: parsed.createTime,
                time: fmtTime(parsed.createTime),
                media_count: parsed.mediaCount,
                media_desc: parsed.mediaDesc,
                images: parsed.images,
                videos: parsed.videos,
                location: parsed.location,
                link_title: parsed.linkTitle,
                link_url: parsed.linkUrl,
                is_self: username === self,
                likes: social.likes,
                comments: social.comments,
            };
            if (parsed.contentType)
                entry.contentType = parsed.contentType;
            if (parsed.sourceNickName)
                entry.sourceNickName = parsed.sourceNickName;
            if (parsed.publicUserName)
                entry.publicUserName = parsed.publicUserName;
            return entry;
        });
        return { moments, total: totalRow.n };
    }
    finally {
        db.close();
    }
}
/**
 * Author-activity counts across the FULL moments table (SQL GROUP BY, no XML
 * parse), mapped to display names, ranked by count descending.
 * @param decryptedDir - decrypted data root.
 * @returns author name + moment count, highest first.
 */
export function queryMomentsAuthors(decryptedDir) {
    const dbPath = snsDb(decryptedDir);
    if (dbPath === null)
        return [];
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
        const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='SnsTimeLine'").get() !== undefined;
        if (!has)
            return [];
        const cols = new Set(db.prepare('PRAGMA table_info(SnsTimeLine)').all().map(r => r.name));
        const uname = cols.has('user_name') ? 'user_name' : 'userName';
        const rows = db.prepare(`SELECT ${uname} AS u, COUNT(*) AS n FROM SnsTimeLine GROUP BY ${uname} ORDER BY n DESC`).all();
        const names = contactMeta(decryptedDir).names;
        return rows.map(r => ({ name: names.get(cellString(r.u)) || cellString(r.u) || '未知', count: r.n ?? 0 }));
    }
    finally {
        db.close();
    }
}
//# sourceMappingURL=moments.js.map