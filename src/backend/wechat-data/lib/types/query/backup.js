/**
 * Backup manager: list / create / delete local snapshots of the decrypted
 * WeChat DBs. Plain create makes a timestamped directory copy; encrypted
 * create writes an AES-256-GCM `.wcb` bundle (scrypt key, HMAC-authenticated
 * header, per-file IVs) that restoreBackup decrypts back to a directory.
 */
import { closeSync, cpSync, createReadStream, createWriteStream, existsSync, mkdirSync, openSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync } from 'node:crypto';
const MAGIC = Buffer.from('DSHWCB1\n', 'utf8');
const SALT_LEN = 16;
const VERSION = 1;
/** Backup root dir: sibling of the decrypted dir. */
function backupDir(decryptedDir) {
    return join(dirname(decryptedDir), 'backups');
}
function skipName(name) {
    return name.endsWith('-wal') || name.endsWith('-shm');
}
function collectFiles(root) {
    const out = [];
    const walk = (dir) => {
        if (!existsSync(dir))
            return;
        for (const e of readdirSync(dir, { withFileTypes: true })) {
            if (skipName(e.name))
                continue;
            const p = join(dir, e.name);
            if (e.isDirectory())
                walk(p);
            else
                out.push({ abs: p, rel: relative(root, p).split('\\').join('/'), size: statSync(p).size });
        }
    };
    walk(root);
    return out;
}
function dirSize(dir) {
    let size = 0;
    const walk = (d) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
            const p = join(d, e.name);
            if (e.isDirectory())
                walk(p);
            else
                try {
                    size += statSync(p).size;
                }
                catch { /* skip */ }
        }
    };
    walk(dir);
    return size;
}
/** Bounded content summary (items + .db count + capability composition); caps the walk. */
function dirSummary(dir) {
    let items = 0;
    let db = 0;
    const dbNames = new Set();
    const walk = (d, depth) => {
        if (items > 20000 || depth > 6)
            return;
        for (const e of readdirSync(d, { withFileTypes: true })) {
            if (skipName(e.name))
                continue;
            items += 1;
            const p = join(d, e.name);
            if (e.isDirectory())
                walk(p, depth + 1);
            else if (e.name.endsWith('.db')) {
                db += 1;
                dbNames.add(e.name.toLowerCase());
            }
        }
    };
    try {
        walk(dir, 0);
    }
    catch { /* keep partial counts */ }
    const has = (kw) => Array.from(dbNames).some(n => n.includes(kw));
    const parts = [];
    if (has('sns'))
        parts.push('朋友圈');
    if (has('msg') || has('micro') || has('wxmsg'))
        parts.push('会话');
    if (has('contact') || has('address'))
        parts.push('通讯录');
    if (has('favorite') || has('fav'))
        parts.push('收藏');
    const comp = parts.length > 0 ? '（含 ' + parts.join('/') + ' 库）' : '';
    return (db > 0 ? `${items} 项 · ${db} 个库` : `${items} 项`) + comp;
}
/** Integrity check: dir backup looks like a DB snapshot; enc has the .wcb header. */
function backupOk(path, kind) {
    try {
        if (kind === 'enc') {
            const fd = openSync(path, 'r');
            try {
                const buf = Buffer.alloc(MAGIC.length);
                readSync(fd, buf, 0, MAGIC.length, 0);
                return buf.equals(MAGIC);
            }
            finally {
                closeSync(fd);
            }
        }
        let hasDb = false;
        for (const e of readdirSync(path, { withFileTypes: true })) {
            if (e.isDirectory()) {
                for (const sub of readdirSync(join(path, e.name))) {
                    if (sub.endsWith('.db')) {
                        hasDb = true;
                        break;
                    }
                }
            }
            else if (e.name.endsWith('.db')) {
                hasDb = true;
                break;
            }
            if (hasDb)
                break;
        }
        return hasDb;
    }
    catch {
        return false;
    }
}
/**
 * Preview a backup's contents (bounded file/db list) before restore.
 * @param decryptedDir - decrypted data root.
 * @param name - backup name.
 * @returns the preview snapshot (bounded items) or an empty result.
 */
export function previewBackup(decryptedDir, name) {
    const dir = backupDir(decryptedDir);
    const p = join(dir, name);
    if (!existsSync(p))
        return { items: [], total: 0 };
    const st = statSync(p);
    const items = [];
    const push = (rel, size, isDir) => {
        if (items.length >= 500)
            return;
        items.push({ name: rel, size, isDir });
    };
    if (st.isDirectory()) {
        const walk = (d, prefix) => {
            if (items.length >= 500)
                return;
            let entries = [];
            try {
                entries = readdirSync(d, { withFileTypes: true }).map(e => ({ n: e.name, isDir: e.isDirectory() }));
            }
            catch {
                return;
            }
            for (const e of entries) {
                if (skipName(e.n))
                    continue;
                if (items.length >= 500)
                    return;
                const abs = join(d, e.n);
                const rel = prefix ? prefix + '/' + e.n : e.n;
                if (e.isDir) {
                    push(rel, 0, true);
                    walk(abs, rel);
                }
                else {
                    let size = 0;
                    try {
                        size = statSync(abs).size;
                    }
                    catch { /* skip */ }
                    push(rel, size, false);
                }
            }
        };
        walk(p, '');
    }
    else {
        push(name, st.size, false);
    }
    return { items, total: items.length };
}
/**
 * List existing backups (name, size, modified, kind).
 * @param decryptedDir - decrypted data root.
 * @returns backup items plus total count.
 */
export function listBackups(decryptedDir) {
    const dir = backupDir(decryptedDir);
    if (!existsSync(dir))
        return { items: [], total: 0 };
    const items = [];
    for (const name of readdirSync(dir).sort().reverse()) {
        const p = join(dir, name);
        try {
            const st = statSync(p);
            if (st.isDirectory()) {
                items.push({ name, path: p, size: dirSize(p), modified: Math.floor(st.mtimeMs / 1000), kind: 'dir', summary: dirSummary(p), ok: backupOk(p, 'dir') });
            }
            else if (name.endsWith('.wcb')) {
                items.push({ name, path: p, size: st.size, modified: Math.floor(st.mtimeMs / 1000), kind: 'enc', summary: 'AES-256 加密备份', ok: backupOk(p, 'enc') });
            }
        }
        catch { /* skip unreadable */ }
    }
    return { items, total: items.length };
}
/**
 * Create a timestamped directory backup of the decrypted DBs.
 * @param decryptedDir - decrypted data root.
 * @returns the created backup entry.
 */
export function createBackup(decryptedDir) {
    const ts = new Date().toISOString().replace(/[-:]/g, '').slice(0, 14);
    const name = 'wechat_backup_' + ts;
    const dir = backupDir(decryptedDir);
    mkdirSync(dir, { recursive: true });
    const target = join(dir, name);
    if (existsSync(target))
        rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    if (existsSync(decryptedDir)) {
        for (const sub of readdirSync(decryptedDir, { withFileTypes: true })) {
            if (!sub.isDirectory())
                continue;
            if (sub.name.startsWith('.'))
                continue;
            try {
                cpSync(join(decryptedDir, sub.name), join(target, sub.name), { recursive: true });
            }
            catch { /* skip */ }
        }
    }
    const st = statSync(target);
    return { name, path: target, size: dirSize(target), modified: Math.floor(st.mtimeMs / 1000), kind: 'dir' };
}
/**
 * Create an encrypted `.wcb` backup bundle.
 * @param decryptedDir - decrypted data root.
 * @param password - encryption password.
 * @returns the created backup entry.
 */
export async function createEncryptedBackup(decryptedDir, password) {
    const ts = new Date().toISOString().replace(/[-:]/g, '').slice(0, 14);
    const name = 'wechat_backup_' + ts + '.wcb';
    const dir = backupDir(decryptedDir);
    mkdirSync(dir, { recursive: true });
    const target = join(dir, name);
    const salt = randomBytes(SALT_LEN);
    const key = scryptSync(password, salt, 32);
    const files = collectFiles(decryptedDir);
    const header = {
        version: VERSION,
        files: files.map(f => ({
            name: f.rel,
            size: f.size,
            iv: randomBytes(12).toString('base64'),
        })),
    };
    const headerBuf = Buffer.from(JSON.stringify(header), 'utf8');
    const mac = createHmac('sha256', key).update(headerBuf).digest();
    const out = createWriteStream(target);
    out.write(MAGIC);
    out.write(salt);
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(headerBuf.length);
    out.write(lenBuf);
    out.write(headerBuf);
    out.write(mac);
    for (let i = 0; i < files.length; i += 1) {
        const f = header.files[i];
        const src = files[i];
        if (!f || !src)
            continue;
        const iv = Buffer.from(f.iv, 'base64');
        const cipher = createCipheriv('aes-256-gcm', key, iv);
        for await (const chunk of createReadStream(src.abs)) {
            out.write(cipher.update(chunk));
        }
        out.write(cipher.final());
        out.write(cipher.getAuthTag());
    }
    await new Promise((resolve, reject) => {
        out.end(() => { resolve(); });
        out.on('error', reject);
    });
    const st = statSync(target);
    return { name, path: target, size: st.size, modified: Math.floor(st.mtimeMs / 1000), kind: 'enc' };
}
/**
 * Restore an encrypted `.wcb` backup into `<backups>/<name>.restored`.
 * @param decryptedDir - decrypted data root.
 * @param name - backup file name (must end .wcb).
 * @param password - encryption password.
 * @returns restore result with the extracted path.
 */
export function restoreEncryptedBackup(decryptedDir, name, password) {
    const dir = backupDir(decryptedDir);
    const src = join(dir, name);
    if (!name.endsWith('.wcb') || !existsSync(src))
        return { ok: false, error: '加密备份不存在' };
    const target = join(dir, name.replace(/\.wcb$/, '') + '.restored');
    if (existsSync(target))
        rmSync(target, { recursive: true, force: true });
    let fd = null;
    try {
        fd = openSync(src, 'r');
        const magic = readExactFd(fd, MAGIC.length);
        if (!magic.equals(MAGIC))
            return { ok: false, error: '不是有效的加密备份文件' };
        const salt = readExactFd(fd, SALT_LEN);
        const lenBuf = readExactFd(fd, 4);
        const headerLen = lenBuf.readUInt32BE(0);
        const headerBuf = readExactFd(fd, headerLen);
        const mac = readExactFd(fd, 32);
        const key = scryptSync(password, salt, 32);
        const expect = createHmac('sha256', key).update(headerBuf).digest();
        if (!mac.equals(expect))
            return { ok: false, error: '密码错误或文件被篡改' };
        const header = JSON.parse(headerBuf.toString('utf8'));
        for (const f of header.files) {
            const iv = Buffer.from(f.iv, 'base64');
            const cipherText = readExactFd(fd, f.size);
            const tag = readExactFd(fd, 16);
            const decipher = createDecipheriv('aes-256-gcm', key, iv);
            decipher.setAuthTag(tag);
            const outPath = join(target, f.name.split('/').join(process.platform === 'win32' ? '\\' : '/'));
            mkdirSync(dirname(outPath), { recursive: true });
            try {
                const plain = Buffer.concat([decipher.update(cipherText), decipher.final()]);
                writeFileSync(outPath, plain);
            }
            catch {
                return { ok: false, error: '解密校验失败（数据损坏或密码错误）' };
            }
        }
        return { ok: true, path: target };
    }
    catch (e) {
        return { ok: false, error: e.message };
    }
    finally {
        if (fd !== null)
            closeSync(fd);
    }
}
function readExactFd(fd, size) {
    const buf = Buffer.alloc(size);
    let off = 0;
    while (off < size) {
        const n = readSync(fd, buf, off, size - off, null);
        if (n <= 0)
            throw new Error('备份文件读取被截断');
        off += n;
    }
    return buf;
}
/**
 * Delete one backup by name.
 * @param decryptedDir - decrypted data root.
 * @param name - backup name to delete.
 * @returns ok, or an error description when the backup cannot be removed.
 */
export function deleteBackup(decryptedDir, name) {
    const dir = backupDir(decryptedDir);
    const target = join(dir, name);
    if (!target.startsWith(dir) || !existsSync(target))
        return { ok: false, error: '备份不存在' };
    try {
        rmSync(target, { recursive: true, force: true });
        return { ok: true };
    }
    catch (e) {
        return { ok: false, error: e.message };
    }
}
//# sourceMappingURL=backup.js.map