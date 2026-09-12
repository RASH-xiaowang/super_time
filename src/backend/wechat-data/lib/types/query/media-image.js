/**
 * WeChat image resolution and decoding, rewritten from st_control image.rs
 * (image/{crypto,resolve}.rs). Chain: (username, local_id) -> image MD5 from
 * the message shards (packed_info_data protobuf) or message_resource.db, then
 * a pre-decoded image in decoded_images/<username>/<md5>.<ext>, then raw .dat
 * XOR / V1 / V2 decoding. Returns a base64 data URL for the browser.
 * wxgf/HEVC images are reported as hevc-unsupported (needs a system decoder).
 */
import { createDecipheriv } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { shardCatalogDirs } from "./meta.js";
const V2_MAGIC = [0x07, 0x08, 0x56, 0x32];
const V1_MAGIC_FULL = [0x07, 0x08, 0x56, 0x31, 0x08, 0x07];
const V2_MAGIC_FULL = [0x07, 0x08, 0x56, 0x32, 0x08, 0x07];
const V1_AES_KEY = new TextEncoder().encode('cfcd208495d565ef');
const IMAGE_MAGIC = [
    ['png', [0x89, 0x50, 0x4e, 0x47]],
    ['gif', [0x47, 0x49, 0x46, 0x38]],
    ['tif', [0x49, 0x49, 0x2a, 0x00]],
    ['webp', [0x52, 0x49, 0x46, 0x46]],
    ['jpg', [0xff, 0xd8, 0xff]],
];
/** Msg_<md5(username)> table name for a talker. */
function msgTableName(username) {
    return 'Msg_' + createHash('md5').update(username, 'utf8').digest('hex');
}
/** Convert a comma-separated decimal byte list (st_control BLOB text form) to bytes. */
function commaBytesToBytes(text) {
    const parts = text.split(',').map(n => parseInt(n, 10));
    if (parts.length === 0 || parts.some(n => Number.isNaN(n)))
        return null;
    return Uint8Array.from(parts);
}
/**
 * Extract the 32-char hex image MD5 from a packed_info protobuf value.
 * Accepts a raw BLOB, or the st_control comma-separated byte-list TEXT form.
 * @param value - packed_info cell value (BLOB or comma-separated byte-list TEXT).
 * @returns the 32-char hex image MD5, or null when none is found.
 */
export function extractMd5FromPacked(value) {
    let bytes = null;
    if (value instanceof Uint8Array) {
        bytes = value;
    }
    else if (typeof value === 'string' && value) {
        if (value.includes(',')) {
            bytes = commaBytesToBytes(value);
        }
        else {
            // plain text (rare): try hex string or raw ascii
            const m = value.match(/[0-9a-f]{32}/);
            return m ? m[0] : null;
        }
    }
    if (!bytes)
        return null;
    const buf = bytes;
    // protobuf marker then 32 hex (st_control primary)
    const marker = [0x12, 0x22, 0x0a, 0x20];
    for (let i = 0; i + marker.length + 32 <= buf.length; i += 1) {
        if (marker.every((b, j) => buf[i + j] === b)) {
            const s = String.fromCharCode(...buf.slice(i + marker.length, i + marker.length + 32));
            if (/^[0-9a-f]{32}$/.test(s))
                return s;
        }
    }
    // generic: 0x22 0x20 then 32 hex (protobuf field 4, length 32)
    for (let i = 0; i + 34 <= buf.length; i += 1) {
        if (buf[i] === 0x22 && buf[i + 1] === 32) {
            const s = String.fromCharCode(...buf.slice(i + 2, i + 34));
            if (/^[0-9a-f]{32}$/.test(s))
                return s;
        }
    }
    // last resort: any 32 consecutive ascii hex digits
    let s = '';
    for (let i = 0; i < buf.length; i += 1) {
        const c = String.fromCharCode(buf[i] ?? 0);
        if (/[0-9a-f]/i.test(c)) {
            s += c;
            if (s.length === 32)
                return s.toLowerCase();
        }
        else {
            s = '';
        }
    }
    return null;
}
/**
 * Resolve image MD5 + MessageResourceDetail.data_index for (username, local_id):
 * message shard packed_info_data first, then message_resource.db
 * (ChatName2Id -> MessageResourceInfo -> MessageResourceDetail).
 * @param decryptedDir - decrypted data root.
 * @param username - conversation username.
 * @param localId - message local id.
 * @returns the 32-char hex image MD5 (or null) and the detail data_index hint.
 */
export function resolveImageResourceHint(decryptedDir, username, localId) {
    const table = msgTableName(username);
    // 分片目录缓存直接定位持有该表的分片，逐图解析不再每次遍历打开所有分片库。
    for (const shard of shardCatalogDirs(decryptedDir, ['message'])) {
        const tableMeta = shard.tables.get(table);
        if (!tableMeta)
            continue;
        let db = null;
        try {
            db = new DatabaseSync(shard.file, { readOnly: true });
        }
        catch {
            continue;
        }
        try {
            const packed = [...tableMeta.cols].find(c => c.toLowerCase().includes('packed'));
            if (packed) {
                try {
                    const row = db.prepare('SELECT "' + packed + '" AS p FROM "' + table + '" WHERE local_id = ? AND (local_type = 3 OR local_type % 4294967296 = 3) LIMIT 1').get(localId);
                    if (row) {
                        const md5 = extractMd5FromPacked(row.p);
                        if (md5)
                            return { md5, dataIndex: '' };
                    }
                }
                catch { /* try the resource fallback */ }
            }
        }
        finally {
            db.close();
        }
    }
    // fallback: message_resource.db (info -> detail)
    let dataIndex = '';
    const resDb = join(decryptedDir, 'message', 'message_resource.db');
    if (existsSync(resDb)) {
        try {
            const db = new DatabaseSync(resDb, { readOnly: true });
            const chat = db.prepare('SELECT rowid FROM ChatName2Id WHERE user_name = ?').get(username);
            if (chat) {
                const info = db.prepare('SELECT message_id, packed_info AS p FROM MessageResourceInfo WHERE chat_id = ? AND message_local_id = ? AND (message_local_type = 3 OR message_local_type % 4294967296 = 3) ORDER BY message_create_time DESC LIMIT 1').get(chat.rowid, localId);
                if (info) {
                    const md5 = extractMd5FromPacked(info.p);
                    if (md5) {
                        db.close();
                        return { md5, dataIndex: '' };
                    }
                    if (info.message_id !== undefined) {
                        const details = db.prepare('SELECT packed_info AS p, data_index AS di FROM MessageResourceDetail WHERE message_id = ? ORDER BY resource_id DESC LIMIT 20').all(info.message_id);
                        for (const d of details) {
                            const dm = extractMd5FromPacked(d.p);
                            if (dm) {
                                db.close();
                                return { md5: dm, dataIndex: dataIndexOf(d.di) };
                            }
                            const di = dataIndexOf(d.di);
                            if (di && !dataIndex)
                                dataIndex = di;
                        }
                    }
                }
            }
            db.close();
        }
        catch { /* resource db unavailable */ }
    }
    return { md5: null, dataIndex };
}
/** Normalize a MessageResourceDetail.data_index cell to a non-empty string. */
function dataIndexOf(v) {
    if (v === null || v === undefined)
        return '';
    if (typeof v === 'string')
        return v.trim();
    if (v instanceof Uint8Array)
        return new TextDecoder('utf-8', { fatal: false }).decode(v).trim();
    if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint')
        return String(v).trim();
    return '';
}
/**
 * Resolve the image MD5 for (username, local_id).
 * @param decryptedDir - decrypted data root.
 * @param username - conversation username.
 * @param localId - message local id.
 * @returns the 32-char hex image MD5, or null when not found.
 */
export function resolveImageMd5(decryptedDir, username, localId) {
    return resolveImageResourceHint(decryptedDir, username, localId).md5;
}
/**
 * Detect an image format from a decrypted header.
 * @param header - leading bytes of the (decrypted) image.
 * @returns the format name ('png' / 'jpg' / 'gif' / ...), or 'bin' when unknown.
 */
export function detectImageFormat(header) {
    for (const [fmt, magic] of IMAGE_MAGIC) {
        if (header.length >= magic.length && magic.every((b, i) => header[i] === b))
            return fmt;
    }
    if (header.length >= 2 && header[0] === 0x42 && header[1] === 0x4d)
        return 'bmp';
    return 'bin';
}
/**
 * Detect a single-byte XOR key by matching image magic bytes.
 * @param data - raw .dat bytes.
 * @returns the XOR key byte, or null when no magic matches.
 */
export function detectXorKey(data) {
    if (data.length < 4)
        return null;
    if ((data[0] ?? 0) === V2_MAGIC[0] &&
        (data[1] ?? 0) === V2_MAGIC[1] &&
        (data[2] ?? 0) === V2_MAGIC[2] &&
        (data[3] ?? 0) === V2_MAGIC[3])
        return null;
    for (const [, magic] of IMAGE_MAGIC) {
        const key = (data[0] ?? 0) ^ (magic[0] ?? 0);
        let ok = true;
        for (let i = 0; i < magic.length && i < data.length; i += 1) {
            if (((data[i] ?? 0) ^ key) !== (magic[i] ?? 0)) {
                ok = false;
                break;
            }
        }
        if (ok)
            return key;
    }
    return null;
}
/** AES-128-ECB decrypt (no padding). */
function aes128EcbDecrypt(key, data) {
    if (key.length < 16)
        throw new Error('AES key 长度不足 16 字节');
    const decipher = createDecipheriv('aes-128-ecb', Buffer.from(key), null);
    decipher.setAutoPadding(false);
    const out = Buffer.concat([decipher.update(Buffer.from(data)), decipher.final()]);
    return new Uint8Array(out);
}
/** Strip PKCS7 padding (defensive). */
function pkcs7Unpad(data) {
    if (data.length === 0)
        return data;
    const pad = data[data.length - 1] ?? 0;
    if (pad === 0 || pad > 16 || pad > data.length)
        return data;
    if (data.slice(data.length - pad).every(b => b === pad))
        return data.slice(0, data.length - pad);
    return data;
}
/** PKCS7 aligned block size. */
function alignedAesBlockSize(aesSize) {
    return aesSize % 16 === 0 ? aesSize + 16 : aesSize + (16 - (aesSize % 16));
}
/**
 * Decode raw .dat bytes (XOR / V1 / V2).
 * @param data - raw .dat file bytes.
 * @param aesKey - V2 AES key (raw bytes), optional.
 * @param xorKey - XOR key byte for the XOR tail.
 * @returns decrypted bytes + format, or an error description.
 */
export function decodeDatBytes(data, aesKey, xorKey) {
    if (data.length < 6)
        return { error: '文件太小' };
    const sig = Array.from(data.slice(0, 6));
    const isV2 = sig.every((b, i) => b === V2_MAGIC_FULL[i]);
    const isV1 = sig.every((b, i) => b === V1_MAGIC_FULL[i]);
    let decrypted;
    if (isV2 || isV1) {
        const rawKey = typeof aesKey === 'string' && aesKey.length > 0 ? Buffer.from(aesKey, 'ascii') : aesKey;
        const key = isV1 ? V1_AES_KEY : (rawKey instanceof Uint8Array ? rawKey : null);
        if (!key)
            return { error: 'V2 格式需要 AES key' };
        if (key.length < 16)
            return { error: 'AES key 长度不足 16 字节' };
        if (data.length < 15)
            return { error: 'V2 文件头不完整' };
        const aesSize = (data[6] ?? 0) | ((data[7] ?? 0) << 8) | ((data[8] ?? 0) << 16) | ((data[9] ?? 0) << 24);
        const xorSize = (data[10] ?? 0) | ((data[11] ?? 0) << 8) | ((data[12] ?? 0) << 16) | ((data[13] ?? 0) << 24);
        const aligned = alignedAesBlockSize(aesSize);
        let offset = 15;
        if (offset + aligned > data.length)
            return { error: '数据不足 AES 块' };
        const decAes = pkcs7Unpad(aes128EcbDecrypt(key, data.slice(offset, offset + aligned)));
        offset += aligned;
        const rawEnd = data.length - xorSize;
        const raw = offset < rawEnd ? data.slice(offset, Math.max(offset, rawEnd)) : new Uint8Array(0);
        offset = Math.max(offset, rawEnd);
        const xorPart = data.slice(offset).map(b => b ^ xorKey);
        const out = new Uint8Array(decAes.length + raw.length + xorPart.length);
        out.set(decAes, 0);
        out.set(raw, decAes.length);
        out.set(xorPart, decAes.length + raw.length);
        decrypted = out;
    }
    else {
        const key = detectXorKey(data);
        if (key === null)
            return { error: '无法检测 XOR key' };
        decrypted = data.map(b => b ^ key);
    }
    // wxgf -> HEVC container (needs system decoder)
    if (decrypted.length >= 4 && decrypted[0] === 0x77 && decrypted[1] === 0x78 && decrypted[2] === 0x67 && decrypted[3] === 0x66) {
        return { bytes: decrypted, format: 'hevc' };
    }
    const hdr = decrypted.length > 16 ? decrypted.slice(0, 16) : decrypted;
    const fmt = detectImageFormat(hdr);
    if (fmt === 'bin')
        return { error: '解密后无法识别图片格式 (可能是密钥错误)' };
    return { bytes: decrypted, format: fmt };
}
/** Decode bytes to a base64 data URL for a renderable format. */
function toDataUrl(format, bytes) {
    const mime = format === 'jpg' ? 'jpeg' : format;
    return 'data:image/' + mime + ';base64,' + Buffer.from(bytes).toString('base64');
}
/** Renderable image extensions (decoded cache). */
const RENDERABLE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tif'];
/**
 * Resolve and decode a message image to a base64 data URL.
 * @param decryptedDir - decrypted data root.
 * @param decodedDir - decoded image cache root (data/wechat/decoded_images).
 * @param username - conversation username.
 * @param localId - message local id.
 * @param wechatBaseDir - optional raw WeChat install dir for .dat fallback.
 * @param aesKey - optional V2 AES key (16-char ASCII string or raw bytes).
 * @param xorKey - XOR key byte, defaults to 0xFF.
 * @returns data URL + format, or an error description.
 */
export function decodeImageDataUrl(decryptedDir, decodedDir, username, localId, wechatBaseDir, aesKey, xorKey) {
    const hint = resolveImageResourceHint(decryptedDir, username, localId);
    const md5 = hint.md5;
    if (!md5 && !hint.dataIndex)
        return { error: '无法找到图片 MD5' };
    // 1a. global decoded cache (批量解密产物,与用户名无关,md5 独占)
    if (md5) {
        for (const ext of RENDERABLE_EXTS) {
            const p = join(decodedDir, md5 + '.' + ext);
            if (existsSync(p)) {
                try {
                    const bytes = readFileSync(p);
                    return { url: toDataUrl(ext === 'jpeg' ? 'jpg' : ext, new Uint8Array(bytes)), format: ext === 'jpeg' ? 'jpg' : ext };
                }
                catch (e) {
                    return { error: '读取已解码图片失败: ' + e.message };
                }
            }
        }
    }
    // 1. pre-decoded cache
    if (md5) {
        const userDir = join(decodedDir, username);
        if (existsSync(userDir)) {
            for (const ext of RENDERABLE_EXTS) {
                const p = join(userDir, md5 + '.' + ext);
                if (existsSync(p)) {
                    try {
                        const bytes = readFileSync(p);
                        return { url: toDataUrl(ext === 'jpeg' ? 'jpg' : ext, new Uint8Array(bytes)), format: ext === 'jpeg' ? 'jpg' : ext };
                    }
                    catch (e) {
                        return { error: '读取已解码图片失败: ' + e.message };
                    }
                }
            }
            const hevc = join(userDir, md5 + '.hevc');
            if (existsSync(hevc))
                return { error: 'hevc-unsupported' };
        }
    }
    // 2. raw .dat decode (requires the raw WeChat base dir)
    if (wechatBaseDir && md5) {
        const attach = join(wechatBaseDir, 'msg', 'attach', msgTableName(username).replace(/^Msg_/, ''));
        const dats = findDatFiles(attach, md5);
        if (dats.length > 0) {
            // The original is often wxgf/HEVC in wechat 4.x; prefer a renderable
            // candidate (thumbnail _t / _h), falling back to the original only when
            // it decodes to a browser-renderable format.
            const aesBytes = typeof aesKey === 'string' && aesKey.length > 0 ? Buffer.from(aesKey, 'ascii') : (aesKey ?? null);
            const ordered = [...dats].sort((a, b) => scoreDatPath(a) - scoreDatPath(b));
            for (const f of ordered) {
                try {
                    const bytes = readFileSync(f);
                    const dec = decodeDatBytes(new Uint8Array(bytes), aesBytes, xorKey ?? 0xff);
                    if ('error' in dec)
                        continue;
                    if (dec.format === 'hevc')
                        continue;
                    try {
                        writeDecodedCache(decodedDir, username, md5, dec.format, dec.bytes);
                    }
                    catch { /* cache best-effort */ }
                    return { url: toDataUrl(dec.format, dec.bytes), format: dec.format };
                }
                catch { /* try next candidate */ }
            }
            return { error: 'hevc-unsupported' };
        }
    }
    // 3. hardlink 定位表兜底 (MessageResourceDetail.data_index / md5 → .dat 路径)
    if (wechatBaseDir) {
        const hd = resolveImageFilePath(decryptedDir, wechatBaseDir, md5 ?? '', hint.dataIndex);
        if (hd) {
            const aesBytes = typeof aesKey === 'string' && aesKey.length > 0 ? Buffer.from(aesKey, 'ascii') : (aesKey ?? null);
            try {
                const bytes = readFileSync(hd);
                const dec = decodeDatBytes(new Uint8Array(bytes), aesBytes, xorKey ?? 0xff);
                if (!('error' in dec) && dec.format !== 'hevc') {
                    try {
                        writeDecodedCache(decodedDir, username, md5 || 'data-' + hint.dataIndex, dec.format, dec.bytes);
                    }
                    catch { /* cache best-effort */ }
                    return { url: toDataUrl(dec.format, dec.bytes), format: dec.format };
                }
            }
            catch { /* unreadable dat fall through */ }
        }
    }
    return { error: md5 ? '找不到 .dat 文件 (MD5=' + md5 + ')' : '无法定位图片文件 (data_index=' + hint.dataIndex + ')' };
}
/** Prefer originals over thumbnails: 0 = .dat, 1 = _h.dat, 2 = _t.dat. */
function scoreDatPath(p) {
    if (p.endsWith('_t.dat'))
        return 2;
    if (p.endsWith('_h.dat'))
        return 1;
    return 0;
}
/** Write a decoded image into the cache so later lookups hit instantly. */
function writeDecodedCache(decodedDir, username, md5, format, bytes) {
    const dir = join(decodedDir, username);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, md5 + '.' + format), Buffer.from(bytes));
}
/** Recursively find .dat files whose name starts with the image MD5. */
function findDatFiles(attachRoot, fileMd5) {
    const out = [];
    const walk = (dir) => {
        if (!existsSync(dir))
            return;
        let entries = [];
        try {
            entries = readdirSync(dir, { withFileTypes: true }).map(e => ({ name: e.name, isDir: e.isDirectory() }));
        }
        catch {
            return;
        }
        for (const e of entries) {
            const p = join(dir, e.name);
            if (e.isDir) {
                walk(p);
            }
            else if (e.name.startsWith(fileMd5) && e.name.endsWith('.dat')) {
                out.push(p);
            }
        }
    };
    walk(attachRoot);
    return out;
}
/** Stringify an SQLite cell (TEXT/NUMBER/BLOB) to a string. */
function cellText(v) {
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
/** Read dir2id (rowid → directory name) from the decrypted hardlink.db. */
function readDir2id(db) {
    const map = new Map();
    const rows = db.prepare('SELECT rowid, username FROM dir2id').all();
    for (const r of rows)
        map.set(r.rowid, cellText(r.username).trim());
    return map;
}
/** Candidate disk paths for a hardlink image file (mirrors ST candidate_paths). */
function imageCandidatePaths(baseDir, file, n1, n2) {
    const out = [];
    const push = (p) => {
        if (!out.includes(p))
            out.push(p);
    };
    const pairs = [[n1, n2], [n2, n1]];
    for (const [a, b] of pairs) {
        push(join(baseDir, 'msg', 'attach', a, b, 'Img', file));
        push(join(baseDir, 'msg', 'attach', a, b, file));
    }
    push(join(baseDir, 'msg', 'attach', n1, 'Img', file));
    push(join(baseDir, 'msg', 'attach', n1, file));
    push(join(baseDir, 'msg', 'attach', n2, file));
    return out;
}
/**
 * Resolve an image's on-disk .dat path via the decrypted hardlink.db:
 * image_hardlink_info_v4 is queried by md5 (and by MessageResourceDetail
 * data_index rowid when given), then dir1/dir2 are mapped through dir2id to
 * the real msg/attach directory names. Returns the first existing path.
 * @param decryptedDir - decrypted data root.
 * @param wechatBaseDir - raw WeChat install dir (current account root).
 * @param md5 - 32-char image md5 (optional when dataIndex is given).
 * @param dataIndex - MessageResourceDetail.data_index (rowid hint, optional).
 * @returns absolute .dat path, or null when not resolvable.
 */
export function resolveImageFilePath(decryptedDir, wechatBaseDir, md5, dataIndex) {
    const dbPath = join(decryptedDir, 'hardlink', 'hardlink.db');
    if (!existsSync(dbPath))
        return null;
    let db = null;
    try {
        db = new DatabaseSync(dbPath, { readOnly: true });
    }
    catch {
        return null;
    }
    try {
        const dirs = readDir2id(db);
        const rows = [];
        const md5l = (md5 ?? '').trim().toLowerCase();
        const di = (dataIndex ?? '').trim();
        if (md5l.length === 32) {
            const byMd5 = db.prepare('SELECT file_name, dir1, dir2 FROM image_hardlink_info_v4 WHERE lower(md5) = ? ORDER BY modify_time DESC LIMIT 8').all(md5l);
            rows.push(...byMd5);
        }
        if (di && /^\d+$/.test(di)) {
            const byRow = db.prepare('SELECT file_name, dir1, dir2 FROM image_hardlink_info_v4 WHERE _rowid_ = ? LIMIT 1').all(Number(di));
            rows.push(...byRow);
        }
        for (const r of rows) {
            const file = cellText(r.file_name).trim();
            if (!file || !file.endsWith('.dat'))
                continue;
            const n1 = dirs.get(r.dir1) ?? '';
            const n2 = dirs.get(r.dir2) ?? '';
            for (const p of imageCandidatePaths(wechatBaseDir, file, n1, n2)) {
                if (existsSync(p))
                    return p;
            }
        }
    }
    catch { /* db unreadable */ }
    finally {
        try {
            db.close();
        }
        catch { /* already closed */ }
    }
    return null;
}
//# sourceMappingURL=media-image.js.map