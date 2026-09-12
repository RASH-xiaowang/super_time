/**
 * WeChat user avatar resolution, rewritten from st_control modules/avatar.rs.
 * Priority: head_image.db image_buffer (data URL) -> contact small/big_head_url.
 */
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
/** Sniff an image format from magic bytes. */
function sniffImageFormat(data) {
    if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff)
        return 'jpeg';
    if (data.length >= 4 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47)
        return 'png';
    if (data.length >= 4 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38)
        return 'gif';
    if (data.length >= 12 && data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50)
        return 'webp';
    return 'jpeg';
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
/** Avatar from head_image.db image_buffer. */
function avatarFromHeadImageDb(decryptedDir, username) {
    const dbPath = join(decryptedDir, 'head_image', 'head_image.db');
    if (!existsSync(dbPath))
        return null;
    try {
        const db = new DatabaseSync(dbPath, { readOnly: true });
        const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='head_image'").get() !== undefined;
        if (!has) {
            db.close();
            return null;
        }
        const row = db.prepare('SELECT image_buffer AS b FROM head_image WHERE username = ? ORDER BY update_time DESC LIMIT 1').get(username);
        db.close();
        if (!row)
            return null;
        const buf = row.b instanceof Uint8Array ? row.b : null;
        if (!buf || buf.length < 16)
            return null;
        const fmt = sniffImageFormat(buf);
        return 'data:image/' + fmt + ';base64,' + Buffer.from(buf).toString('base64');
    }
    catch {
        return null;
    }
}
/** Avatar URL from contact table (small then big). */
function avatarUrlFromContact(decryptedDir, username) {
    const dbPath = join(decryptedDir, 'contact', 'contact.db');
    if (!existsSync(dbPath))
        return null;
    try {
        const db = new DatabaseSync(dbPath, { readOnly: true });
        const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='contact'").get() !== undefined;
        if (!has) {
            db.close();
            return null;
        }
        const cols = db.prepare('PRAGMA table_info(contact)').all().map(r => r.name);
        if (!cols.includes('username')) {
            db.close();
            return null;
        }
        const small = cols.includes('small_head_url') ? 'small_head_url' : 'NULL';
        const big = cols.includes('big_head_url') ? 'big_head_url' : 'NULL';
        const row = db.prepare('SELECT COALESCE(NULLIF(' + small + ", ''), " + big + ') AS u FROM contact WHERE username = ? LIMIT 1').get(username);
        db.close();
        const url = row?.u ? cellStr(row.u) : '';
        return url ? url : null;
    }
    catch {
        return null;
    }
}
/** Avatar from the raw temp/head_image cache (file name = md5(avatar URL), plain JPEG/PNG). */
function avatarFromTempHeadFile(wechatBaseDir, url) {
    if (!wechatBaseDir || !url)
        return null;
    const hash = createHash('md5').update(Buffer.from(url, 'utf8')).digest('hex');
    const f = join(wechatBaseDir, 'temp', 'head_image', hash);
    if (!existsSync(f))
        return null;
    try {
        const buf = readFileSync(f);
        if (buf.length < 16)
            return null;
        const fmt = sniffImageFormat(new Uint8Array(buf));
        return 'data:image/' + fmt + ';base64,' + buf.toString('base64');
    }
    catch {
        return null;
    }
}
/** Contact row (username + avatar URL + head_img_md5) found by exact nick_name. */
function contactByNickname(decryptedDir, nickname) {
    if (!nickname)
        return null;
    const dbPath = join(decryptedDir, 'contact', 'contact.db');
    if (!existsSync(dbPath))
        return null;
    try {
        const db = new DatabaseSync(dbPath, { readOnly: true });
        const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='contact'").get() !== undefined;
        if (!has) {
            db.close();
            return null;
        }
        const cols = db.prepare('PRAGMA table_info(contact)').all().map(r => r.name);
        if (!cols.includes('username') || !cols.includes('nick_name')) {
            db.close();
            return null;
        }
        const small = cols.includes('small_head_url') ? 'small_head_url' : 'NULL';
        const big = cols.includes('big_head_url') ? 'big_head_url' : 'NULL';
        const md = cols.includes('head_img_md5') ? 'head_img_md5' : 'NULL';
        const sql = `SELECT username, COALESCE(NULLIF(${small}, ''), ${big}) AS u, ${md} AS m ` +
            `FROM contact WHERE nick_name = ? AND COALESCE(NULLIF(${small}, ''), ${big}) != '' LIMIT 1`;
        const row = db.prepare(sql).get(nickname);
        db.close();
        if (!row)
            return null;
        const username = cellStr(row.username);
        const url = cellStr(row.u);
        return username && url ? { username, url, md5: cellStr(row.m) } : null;
    }
    catch {
        return null;
    }
}
/**
 * Resolve a user avatar.
 * Priority: head_image.db by username -> contact URL (temp cache data URL first) ->
 * contact matched by nick_name (same URL/temp-cache path) -> none.
 * @param decryptedDir - decrypted data root.
 * @param username - contact or chatroom username.
 * @param wechatBaseDir - raw WeChat install root (temp/head_image cache).
 * @param nickname - optional display name for contact-by-nickname fallback.
 * @returns kind + data URL / remote URL.
 */
export function resolveAvatar(decryptedDir, username, wechatBaseDir, nickname) {
    const data = avatarFromHeadImageDb(decryptedDir, username);
    if (data)
        return { kind: 'data', data };
    const url = avatarUrlFromContact(decryptedDir, username);
    if (url) {
        const temp = avatarFromTempHeadFile(wechatBaseDir, url);
        if (temp)
            return { kind: 'data', data: temp };
        // 本地无该头像:不回退远程 URL(头像必须本地)
        return { kind: 'none' };
    }
    if (nickname) {
        const c = contactByNickname(decryptedDir, nickname);
        if (c) {
            const temp = avatarFromTempHeadFile(wechatBaseDir, c.url);
            if (temp)
                return { kind: 'data', data: temp };
            const head = avatarFromHeadImageDb(decryptedDir, c.username);
            if (head)
                return { kind: 'data', data: head };
            return { kind: 'none' };
        }
    }
    return { kind: 'none' };
}
/**
 * 批量读取全部本地头像:单次打开 head_image.db,返回 username → data URL。
 * 本地优先(头像绝不走网络);未命中者不出现在结果中。
 */
export function resolveAvatarsLocal(decryptedDir, usernames) {
    const out = {};
    if (usernames.length === 0)
        return out;
    const dbPath = join(decryptedDir, 'head_image', 'head_image.db');
    if (!existsSync(dbPath))
        return out;
    try {
        const db = new DatabaseSync(dbPath, { readOnly: true });
        const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='head_image'").get() !== undefined;
        if (!has) {
            db.close();
            return out;
        }
        const stmt = db.prepare('SELECT image_buffer AS b FROM head_image WHERE username = ? ORDER BY update_time DESC LIMIT 1');
        for (const username of usernames) {
            const row = stmt.get(username);
            if (!row)
                continue;
            const buf = row.b instanceof Uint8Array ? row.b : null;
            if (!buf || buf.length < 16)
                continue;
            const fmt = sniffImageFormat(buf);
            out[username] = 'data:image/' + fmt + ';base64,' + Buffer.from(buf).toString('base64');
        }
        db.close();
    }
    catch { /* best effort */ }
    return out;
}
//# sourceMappingURL=avatar.js.map