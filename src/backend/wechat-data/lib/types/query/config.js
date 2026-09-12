/**
 * WeChat configuration management, rewritten as a local module. Reads/writes
 * the owned config.json under the DSH data root, detects WeChat accounts, and
 * verifies database keys (SQLCipher 4: PBKDF2-HMAC-SHA512 + AES-256).
 */
import { execFileSync } from 'node:child_process';
import { createDecipheriv, createHmac, pbkdf2Sync } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
const PAGE_SZ = 4096;
const SALT_SZ = 16;
const IV_SZ = 16;
const HMAC_SZ = 64;
const RESERVE_SZ = 80;
const PBKDF2_ITERS = 256000;
const SQLITE_HDR = new TextEncoder().encode('SQLite format 3\x00');
/** Read only the first database page (verification needs just the header page). */
function readFirstPage(file) {
    const fd = openSync(file, 'r');
    try {
        const buf = Buffer.alloc(PAGE_SZ);
        const n = readSync(fd, buf, 0, PAGE_SZ, 0);
        return buf.subarray(0, n);
    }
    finally {
        closeSync(fd);
    }
}
/**
 * Locate the WeChat config.json for a data root. The plugin owns its config
 * under the DSH data root (`<root>/config.json`, i.e. the parent of
 * `decrypted`).
 * @param decryptedDir - decrypted data root (the parent is the owned root).
 * @returns the owned config file path.
 */
function configPath(decryptedDir) {
    return join(decryptedDir, '..', 'config.json');
}
/** Raw config file cache keyed by mtime+size (read-heavy callers: sync, media). */
const configCache = new Map();
function configSig(p) {
    try {
        const st = statSync(p);
        return `${st.mtimeMs}:${st.size}`;
    }
    catch {
        return '';
    }
}
function readRawConfig(p) {
    const sig = configSig(p);
    const hit = configCache.get(p);
    if (hit && hit.sig === sig)
        return hit.raw;
    let raw = null;
    if (sig) {
        try {
            raw = JSON.parse(readFileSync(p, 'utf8'));
        }
        catch { /* keep defaults */ }
    }
    configCache.set(p, { sig, raw });
    return raw;
}
/** Defaults for a missing config. */
function defaultConfig() {
    return { db_dir: '', keys_file: null, decrypted_dir: null, decoded_image_dir: null, wechat_process: 'Weixin.exe', image_aes_key: '', image_xor_key: 136, key_format: 'wx_key_v4.1', db_enc_key: '', api_enabled: true, api_port: 5032, api_token: '', cdn_enabled: true, cdn_local_decrypt: true };
}
/**
 * Read the full WeChat config (merged with defaults).
 * @param decryptedDir - decrypted data root (used to locate config.json).
 * @returns the merged config (defaults + file values + resolved paths).
 */
export function getConfig(decryptedDir) {
    const p = configPath(decryptedDir);
    const cfg = defaultConfig();
    const raw = readRawConfig(p);
    if (raw)
        Object.assign(cfg, raw);
    // resolved fixed output paths (relative to the data root, portable)
    const wechatRoot = join(decryptedDir, '..');
    const resolved = {
        decrypted_dir: decryptedDir,
        decoded_image_dir: join(wechatRoot, 'decoded_images'),
        keys_file: join(wechatRoot, 'all_keys.json'),
    };
    cfg['resolved'] = resolved;
    // Also surface the fixed output paths at the top level so the persisted
    // config.json carries them (rather than the confusing null defaults).
    cfg['decrypted_dir'] = resolved.decrypted_dir;
    cfg['decoded_image_dir'] = resolved.decoded_image_dir;
    cfg['keys_file'] = resolved.keys_file;
    return cfg;
}
/**
 * Save the WeChat config (merge patch into config.json).
 * @param decryptedDir - decrypted data root (used to locate config.json).
 * @param patch - config fields to merge in.
 * @returns ok, or an error description on failure.
 */
export function saveConfig(decryptedDir, patch) {
    const p = configPath(decryptedDir);
    try {
        const current = getConfig(decryptedDir);
        for (const [k, v] of Object.entries(patch)) {
            if (k === 'resolved')
                continue;
            if (v === undefined)
                continue;
            current[k] = v;
        }
        // decrypted/decoded/keys are resolved by the backend, never written back
        delete current['resolved'];
        const imgBefore = getConfig(decryptedDir);
        writeFileSync(p, JSON.stringify(current, null, 2), 'utf8');
        configCache.delete(p);
        // Image key change => previously decoded .dat images are stale (garbled),
        // so drop the decoded_images cache for a clean re-decode on demand.
        const keyStr = (v) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
        const aesChanged = keyStr(current['image_aes_key']) !== keyStr(imgBefore['image_aes_key']);
        const xorChanged = keyStr(current['image_xor_key']) !== keyStr(imgBefore['image_xor_key']);
        if (aesChanged || xorChanged)
            clearDecodedImages(join(decryptedDir, '..', 'decoded_images'));
        return { ok: true };
    }
    catch (e) {
        return { ok: false, error: e.message };
    }
}
/** Clear the decoded-images cache (stale when the image key changed). */
function clearDecodedImages(dir) {
    try {
        if (!existsSync(dir))
            return;
        for (const name of readdirSync(dir)) {
            try {
                rmSync(join(dir, name), { recursive: true, force: true });
            }
            catch { /* best effort */ }
        }
    }
    catch { /* best effort */ }
}
/** Common WeChat 4.x data bases (parents of `xwechat_files`) to scan. */
const DEFAULT_DATA_BASES = [
    'E:\\Tencent',
    'D:\\Tencent',
    'C:\\Tencent',
    process.env.USERPROFILE ? join(process.env.USERPROFILE, 'Tencent') : '',
    process.env.USERPROFILE ? join(process.env.USERPROFILE, 'Documents') : '',
].filter(Boolean);
/**
 * WeChat 4.x data bases recorded per-user in
 * `%APPDATA%/Tencent/xwechat/config/*.ini` — each line is the data root chosen
 * at install/first login (e.g. `E:\Tencent\Weixin`, the parent of
 * `xwechat_files`). The client rewrites these files on every login, so this is
 * the authoritative source for a customized data location.
 */
function iniDataBases() {
    const configDir = process.env.APPDATA
        ? join(process.env.APPDATA, 'Tencent', 'xwechat', 'config')
        : '';
    if (!configDir || !existsSync(configDir))
        return [];
    const bases = [];
    for (const name of readdirSync(configDir)) {
        if (!name.endsWith('.ini'))
            continue;
        try {
            for (const line of readFileSync(join(configDir, name), 'utf8').split(/\r?\n/)) {
                const base = line.trim();
                if (base)
                    bases.push(base);
            }
        }
        catch { /* unreadable ini is skipped */ }
    }
    return bases;
}
/**
 * WeChat 4.x install path from `HKCU\Software\Tencent\Weixin\InstallPath`
 * (Windows only; '' elsewhere). The install dir is also a valid data base when
 * the user kept the default data layout.
 */
export function weixinInstallPath() {
    if (process.platform !== 'win32')
        return '';
    try {
        const out = execFileSync('reg.exe', ['query', 'HKCU\\Software\\Tencent\\Weixin', '/v', 'InstallPath'], { encoding: 'utf8', windowsHide: true });
        const match = /\sInstallPath\s+REG_\w+\s+(.+)/i.exec(out);
        return (match?.[1] ?? '').trim();
    }
    catch { /* registry absent or reg.exe unavailable */ }
    return '';
}
/** Version-folder pattern under the WeChat install dir (e.g. 4.1.12.26). */
const VERSION_DIR_RE = /^\d+\.\d+\.\d+(?:\.\d+)?$/;
/**
 * WeChat version folder name inside the install dir.
 * @param installDir - install path (defaults to the registry InstallPath).
 * @returns the version, or '' when the install dir is unknown.
 */
export function weixinVersion(installDir) {
    const dir = installDir ?? weixinInstallPath();
    if (!dir || !existsSync(dir))
        return '';
    try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory() && VERSION_DIR_RE.test(entry.name))
                return entry.name;
        }
    }
    catch { /* unreadable install dir */ }
    return '';
}
/**
 * Collect the `xwechat_files` roots to scan: default data bases, per-user
 * config ini files, and the registry install path, deduped
 * case-insensitively. A configured base may itself already be the
 * `xwechat_files` dir, so both join forms are added; the account loop filters
 * by `db_storage` presence.
 * @returns absolute candidate roots (existence caller-checked).
 */
export function collectScanRoots() {
    const seen = new Set();
    const roots = [];
    const add = (base) => {
        if (!base)
            return;
        for (const root of [join(base, 'xwechat_files'), base]) {
            const key = root.toLowerCase();
            if (seen.has(key))
                continue;
            seen.add(key);
            roots.push(root);
        }
    };
    for (const base of [...DEFAULT_DATA_BASES, ...iniDataBases(), weixinInstallPath()])
        add(base);
    return roots;
}
/**
 * Detect installed WeChat 4.x accounts by scanning `xwechat_files` roots.
 * @param roots - explicit scan roots; defaults to {@link collectScanRoots}.
 * @returns detected accounts with db_dir, last active and db file count.
 */
export function detectWechatAccounts(roots) {
    const out = [];
    for (const root of roots ?? collectScanRoots()) {
        if (!existsSync(root))
            continue;
        for (const entry of readdirSync(root, { withFileTypes: true })) {
            if (!entry.isDirectory())
                continue;
            const dir = join(root, entry.name);
            const dbStorage = join(dir, 'db_storage');
            if (!existsSync(dbStorage))
                continue;
            // wxid is the dir name before the instance suffix (e.g. wxid_xxx_63e5)
            const wxid = normalizeWxidDir(entry.name) || '未知账号';
            let lastActive;
            try {
                const msgDir = join(dbStorage, 'message');
                if (existsSync(msgDir)) {
                    let newest = 0;
                    for (const f of readdirSync(msgDir)) {
                        try {
                            newest = Math.max(newest, statSync(join(msgDir, f)).mtimeMs);
                        }
                        catch { /* skip */ }
                    }
                    lastActive = newest ? Math.floor(newest / 1000) : undefined;
                }
            }
            catch { /* skip */ }
            const acct = { wxid, db_dir: dbStorage };
            if (lastActive)
                acct.last_active = lastActive;
            const dbs = scanDbFiles(dbStorage);
            if (dbs.length > 0)
                acct.db_files = dbs.length;
            out.push(acct);
        }
    }
    return out;
}
/** AES-256-CBC decrypt (no padding). */
function aes256CbcDecrypt(key, iv, data) {
    const d = createDecipheriv('aes-256-cbc', key, iv);
    d.setAutoPadding(false);
    return Buffer.concat([d.update(data), d.final()]);
}
/** AES-256-ECB decrypt one block. */
function aes256EcbDecryptBlock(key, block) {
    const d = createDecipheriv('aes-256-ecb', key, null);
    d.setAutoPadding(false);
    return d.update(block);
}
/**
 * SQLCipher page-1 key verification (wx_key_v4.1 PBKDF2).
 * @param page1 - first page (4096 bytes) of the encrypted database.
 * @param wxKeyBin - 32-byte raw database key.
 * @returns whether the HMAC and AES checks pass.
 */
export function verifyDbKey(page1, wxKeyBin) {
    if (page1.length < PAGE_SZ)
        return { hmacOk: false, aesOk: false };
    page1 = page1.subarray(0, PAGE_SZ);
    const salt = page1.subarray(0, SALT_SZ);
    const derivedKey = pbkdf2Sync(wxKeyBin, salt, PBKDF2_ITERS, 32, 'sha512');
    // HMAC verify
    const macSalt = Buffer.from(salt.map(b => b ^ 0x3a));
    const macKey = pbkdf2Sync(derivedKey, macSalt, 2, 32, 'sha512');
    const hmacData = page1.subarray(16, PAGE_SZ - RESERVE_SZ + IV_SZ);
    const storedHmac = page1.subarray(PAGE_SZ - HMAC_SZ, PAGE_SZ);
    const mac = createHmac('sha512', macKey);
    mac.update(hmacData);
    const pgno = Buffer.alloc(4);
    pgno.writeUInt32LE(1, 0);
    mac.update(pgno);
    const hmacOk = mac.digest().equals(Buffer.from(storedHmac));
    // AES verify
    const firstBlockDec = aes256EcbDecryptBlock(derivedKey, page1.subarray(16, 32));
    const correctedIv = Buffer.from(firstBlockDec.map((b, i) => b ^ (SQLITE_HDR[i] ?? 0)));
    const encrypted = page1.subarray(16, PAGE_SZ - RESERVE_SZ);
    const decrypted = aes256CbcDecrypt(derivedKey, correctedIv, encrypted);
    const aesOk = decrypted.subarray(0, 16).equals(Buffer.from(SQLITE_HDR));
    return { hmacOk, aesOk };
}
/**
 * Verify one database file with a 64-hex key.
 * @param dbPath - path to the encrypted database file.
 * @param encKeyHex - 64-char hex (32-byte) database key.
 * @returns validity plus per-check flags and any error.
 */
export function verifyDatabaseKey(dbPath, encKeyHex) {
    if (!existsSync(dbPath))
        return { valid: false, error: '数据库文件不存在' };
    const raw = (encKeyHex || '').trim();
    let key;
    try {
        key = Buffer.from(raw, 'hex');
    }
    catch {
        key = Buffer.alloc(0);
    }
    if (key.length !== 32)
        return { valid: false, error: '密钥必须是 64 位 hex（32 字节）' };
    try {
        const page1 = readFirstPage(dbPath);
        if (page1.length < PAGE_SZ)
            return { valid: false, error: '文件太小，不是有效的数据库' };
        const { hmacOk, aesOk } = verifyDbKey(page1, key);
        return { valid: hmacOk && aesOk, aesOk, hmacOk };
    }
    catch (e) {
        return { valid: false, error: e.message };
    }
}
/** Recursively collect .db files under a dir (depth-limited). */
export function scanDbFiles(dir, depth = 0) {
    if (depth > 4 || !existsSync(dir))
        return [];
    const out = [];
    try {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
            const p = join(dir, e.name);
            if (e.isDirectory())
                out.push(...scanDbFiles(p, depth + 1));
            else if (e.name.endsWith('.db') && !e.name.includes('-wal') && !e.name.includes('-shm'))
                out.push(p);
        }
    }
    catch { /* skip */ }
    return out;
}
/**
 * Verify all DBs in db_dir and write all_keys.json (per-db per-file keys).
 * @param dbDir - directory containing the encrypted DBs to verify.
 * @param keysFile - output all_keys.json path.
 * @param encKeyHex - 64-char hex (32-byte) database key.
 * @param keyFormat - key format recorded in the file (default wx_key_v4.1).
 * @returns ok plus verified/total DB counts, or an error description.
 */
export function generateKeysFile(dbDir, keysFile, encKeyHex, keyFormat) {
    const raw = (encKeyHex || '').trim();
    let key;
    try {
        key = Buffer.from(raw, 'hex');
    }
    catch {
        key = Buffer.alloc(0);
    }
    if (key.length !== 32)
        return { ok: false, verified: 0, total: 0, error: '密钥必须是 64 位 hex（32 字节）' };
    const dbs = scanDbFiles(dbDir);
    if (dbs.length === 0)
        return { ok: false, verified: 0, total: 0, error: '未找到任何 .db 文件' };
    const entries = {};
    let verified = 0;
    for (const db of dbs) {
        try {
            const rel = relative(dbDir, db).replace(/\\/g, '/');
            const page1 = readFirstPage(db);
            const { hmacOk, aesOk } = verifyDbKey(page1, key);
            const valid = hmacOk && aesOk;
            if (valid)
                verified += 1;
            entries[rel] = { key: raw, valid };
        }
        catch { /* skip unreadable */ }
    }
    const payload = { ...entries, _key_format: keyFormat ?? 'wx_key_v4.1', _db_dir: dbDir };
    try {
        mkdirSync(dirname(keysFile), { recursive: true });
        writeFileSync(keysFile, JSON.stringify(payload, null, 2), 'utf8');
        return { ok: true, verified, total: dbs.length };
    }
    catch (e) {
        return { ok: false, verified, total: dbs.length, error: e.message };
    }
}
/**
 * Read all_keys.json info (format + count).
 * @param decryptedDir - decrypted data root.
 * @returns key format, key count and whether the file was loaded.
 */
export function getKeysInfo(decryptedDir) {
    const p = join(decryptedDir, '..', 'all_keys.json');
    if (!existsSync(p))
        return { keyCount: 0, loaded: false };
    try {
        const raw = JSON.parse(readFileSync(p, 'utf8'));
        const keys = Object.keys(raw).filter(k => !k.startsWith('_'));
        const base = { keyCount: keys.length, loaded: true };
        if (typeof raw['_key_format'] === 'string')
            base.keyFormat = raw['_key_format'];
        return base;
    }
    catch {
        return { keyCount: 0, loaded: false };
    }
}
/**
 * Normalize a WeChat account dir name to the real wxid (strip instance suffix).
 * Account dirs look like `wxid_xxxxxx` or `wxid_xxxxxx_f312`; the wxid itself
 * has no underscore, so everything after the second underscore is the instance
 * id (mirrors st_control config/paths.rs normalize_wxid_dir).
 * @param name - account directory name (e.g. wxid_a1z2r51mzqlf22_63e5).
 * @returns the real wxid (input unchanged when it is not a wxid_ name).
 */
export function normalizeWxidDir(name) {
    if (!name.startsWith('wxid_'))
        return name;
    const rest = name.slice('wxid_'.length);
    const pos = rest.indexOf('_');
    return pos >= 0 ? 'wxid_' + rest.slice(0, pos) : name;
}
/** Self wxid from a db_dir path (the account dir is the parent of db_storage). */
function wxidFromDbDir(dbDir) {
    const d = (dbDir || '').trim().replace(/[\\/]+$/, '');
    if (!d)
        return '';
    const parts = d.split(/[\\/]/);
    const last = parts[parts.length - 1] ?? '';
    const acct = last.startsWith('wxid_') ? last : (parts[parts.length - 2] ?? '');
    return normalizeWxidDir(acct);
}
/**
 * Resolve the logged-in account wxid (self). Mirrors st_control's cfg.wxid()
 * which derives it from the account directory name. Resolution order:
 * env DSH_WECHAT_SELF_WXID -> config.json db_dir -> all_keys.json _db_dir ->
 * machine account scan. Unknown when every source is missing.
 * @param decryptedDir - decrypted data root (configPath locates config.json).
 * @returns the self wxid, or '' when it cannot be determined.
 */
export function resolveSelfUsername(decryptedDir) {
    const envVal = process.env['DSH_WECHAT_SELF_WXID'];
    if (envVal && envVal.trim().length > 0)
        return envVal.trim();
    const cfg = getConfig(decryptedDir);
    const dbDir = typeof cfg['db_dir'] === 'string' ? cfg['db_dir'] : '';
    const fromDbDir = wxidFromDbDir(dbDir);
    if (fromDbDir)
        return fromDbDir;
    try {
        const keysPath = join(decryptedDir, '..', 'all_keys.json');
        if (existsSync(keysPath)) {
            const raw = JSON.parse(readFileSync(keysPath, 'utf8'));
            const fromKeys = wxidFromDbDir(typeof raw['_db_dir'] === 'string' ? raw['_db_dir'] : '');
            if (fromKeys)
                return fromKeys;
        }
    }
    catch { /* ignore */ }
    const accounts = detectWechatAccounts();
    for (const a of accounts) {
        if (a.wxid && a.wxid.startsWith('wxid_'))
            return normalizeWxidDir(a.wxid);
    }
    return '';
}
/**
 * Resolve the raw WeChat `db_storage` directory the realtime sync watches.
 * Resolution order: config.json `db_dir`, then all_keys.json `_db_dir` (the
 * st_control layout records it even when no config.json exists), then the
 * `DSH_WECHAT_BASE_DIR` account pin with `db_storage` appended. Empty when
 * every source is missing — callers must fail loud, not skip silently.
 * @param decryptedDir - decrypted data root (locates config.json/all_keys.json).
 * @param env - environment mapping (defaults to process.env).
 * @returns the raw db_storage path, or '' when it cannot be resolved.
 */
export function resolveRawDbDir(decryptedDir, env = process.env) {
    const cfg = getConfig(decryptedDir);
    const fromCfg = typeof cfg['db_dir'] === 'string' ? cfg['db_dir'].trim() : '';
    if (fromCfg)
        return fromCfg;
    try {
        const keysPath = join(decryptedDir, '..', 'all_keys.json');
        if (existsSync(keysPath)) {
            const raw = JSON.parse(readFileSync(keysPath, 'utf8'));
            const fromKeys = typeof raw['_db_dir'] === 'string' ? raw['_db_dir'].trim() : '';
            if (fromKeys)
                return fromKeys;
        }
    }
    catch { /* ignore */ }
    const pinned = env['DSH_WECHAT_BASE_DIR'];
    if (pinned !== undefined && pinned.trim().length > 0)
        return join(pinned.trim(), 'db_storage');
    return '';
}
//# sourceMappingURL=config.js.map