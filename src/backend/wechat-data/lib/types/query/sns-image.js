/**
 * SNS (朋友圈) offline image resolution: scans WeChat's cache/<month>/Sns/Img
 * directories for V2-encrypted image blobs, decrypts them with the image AES
 * key and matches the plaintext MD5 against the media md5 from the moments XML.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { decodeDatBytes } from "./media-image.js";
import { boundedSet } from "./meta.js";
const md5UrlCache = new Map();
const snsImageIndex = new Map();
/** Signature of the Sns/Img cache trees + key pair; rebuilds when either changes. */
function snsImageIndexSig(wechatBaseDir, aesKey, xorKey) {
    const cacheRoot = join(wechatBaseDir, 'cache');
    let sig = (aesKey ?? '') + '|' + String(xorKey);
    if (!existsSync(cacheRoot))
        return sig;
    try {
        for (const month of readdirSync(cacheRoot)) {
            const root = join(cacheRoot, month, 'Sns', 'Img');
            if (!existsSync(root))
                continue;
            const st = statSync(root);
            sig += `|${month}:${st.mtimeMs}:${st.size}`;
        }
    }
    catch {
        // signature degradation: keep the key-only part
    }
    return sig;
}
/** Build (or reuse) the Sns/Img plaintext-md5 index for one account root. */
function snsImageIndexFor(wechatBaseDir, aesKey, xorKey) {
    const sig = snsImageIndexSig(wechatBaseDir, aesKey, xorKey);
    const cached = snsImageIndex.get(wechatBaseDir);
    if (cached && cached.sig === sig)
        return cached;
    const byMd5 = new Map();
    for (const root of snsImgRoots(wechatBaseDir)) {
        const files = [];
        walkFiles(root, files, 0);
        for (const f of files) {
            try {
                const dec = decodeDatBytes(new Uint8Array(readFileSync(f)), aesKey ?? null, xorKey);
                if ('error' in dec)
                    continue;
                const key = md5Of(dec.bytes);
                if (!byMd5.has(key))
                    byMd5.set(key, f);
            }
            catch {
                // next file
            }
        }
    }
    const index = { sig, byMd5 };
    snsImageIndex.set(wechatBaseDir, index);
    return index;
}
function md5Of(bytes) {
    return createHash('md5').update(Buffer.from(bytes)).digest('hex');
}
function walkFiles(dir, out, depth) {
    if (depth > 5 || !existsSync(dir))
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
        if (e.isDir)
            walkFiles(p, out, depth + 1);
        else if (!e.name.endsWith('.db') && !e.name.includes('_shm') && !e.name.includes('_wal'))
            out.push(p);
    }
}
/**
 * Resolve one SNS media md5 to an offline base64 data URL.
 * @param wechatBaseDir - raw WeChat install dir (current account root).
 * @param aesKey - image AES key (16-char ASCII string), optional.
 * @param xorKey - XOR key byte.
 * @param md5 - 32-char media md5 from the moments XML.
 * @returns data URL or an error description.
 */
function dataUrlOf(dec) {
    const mime = dec.format === 'jpg' ? 'jpeg' : dec.format;
    return 'data:image/' + mime + ';base64,' + Buffer.from(dec.bytes).toString('base64');
}
/** Decode one cache file; returns data URL or null. */
function decodeCachedFile(f, aesKey, xorKey) {
    try {
        const bytes = readFileSync(f);
        const dec = decodeDatBytes(new Uint8Array(bytes), aesKey ?? null, xorKey);
        if ('error' in dec)
            return null;
        return dataUrlOf(dec);
    }
    catch {
        return null;
    }
}
/** Gather cache/<month>/Sns/Img roots. */
function snsImgRoots(wechatBaseDir) {
    const cacheRoot = join(wechatBaseDir, 'cache');
    const out = [];
    if (!existsSync(cacheRoot))
        return out;
    try {
        for (const e of readdirSync(cacheRoot, { withFileTypes: true })) {
            if (!e.isDirectory())
                continue;
            const root = join(cacheRoot, e.name, 'Sns', 'Img');
            if (existsSync(root))
                out.push(root);
        }
    }
    catch {
        // ignore
    }
    return out;
}
export function resolveSnsImageDataUrl(wechatBaseDir, aesKey, xorKey, md5, timelineId, mediaId) {
    const key = (md5 || '').trim().toLowerCase();
    const cacheKey = (timelineId && mediaId)
        ? createHash('md5').update(timelineId + '_' + mediaId + '_2', 'utf8').digest('hex')
        : key;
    if (!cacheKey)
        return { error: '缺少图片标识' };
    if (md5UrlCache.has(cacheKey)) {
        const cached = md5UrlCache.get(cacheKey) ?? '';
        if (cached)
            return { url: cached };
    }
    if (!wechatBaseDir)
        return { error: '未配置微信原始目录，无法离线解码' };
    // 优先：tid_mediaid_type 缓存键路径（WDA 同款算法，兼容 _2/_1/_0/无后缀）
    if (timelineId && mediaId) {
        for (const suffix of ['_2', '_1', '_0', '']) {
            const k = createHash('md5').update(timelineId + '_' + mediaId + suffix, 'utf8').digest('hex');
            const sub = k.slice(0, 2);
            const rest = k.slice(2);
            for (const root of snsImgRoots(wechatBaseDir)) {
                const p = join(root, sub, rest);
                if (existsSync(p)) {
                    const data = decodeCachedFile(p, aesKey, xorKey);
                    if (data) {
                        boundedSet(md5UrlCache, cacheKey, data);
                        return { url: data };
                    }
                }
            }
        }
    }
    // 无 MD5 时不能全量（会误匹配任意图片），直接失败
    if (!key) {
        return { error: '未找到匹配的本地 SNS 图片' };
    }
    // 索引优先：按明文 md5 一次构建、反复 O(1) 查找（哈希路径压不中的主力方案）
    const idx = snsImageIndexFor(wechatBaseDir, aesKey, xorKey);
    const indexed = idx?.byMd5.get(key);
    if (indexed) {
        const data = decodeCachedFile(indexed, aesKey, xorKey);
        if (data) {
            boundedSet(md5UrlCache, cacheKey, data);
            return { url: data };
        }
    }
    // 兜底：按解密后 MD5 全量扫描（索引缺失/过期时）
    const files = [];
    for (const root of snsImgRoots(wechatBaseDir))
        walkFiles(root, files, 0);
    for (const f of files) {
        try {
            const bytes = readFileSync(f);
            const dec = decodeDatBytes(new Uint8Array(bytes), aesKey ?? null, xorKey);
            if ('error' in dec)
                continue;
            if (key && md5Of(dec.bytes) !== key)
                continue;
            const data = dataUrlOf(dec);
            boundedSet(md5UrlCache, cacheKey, data);
            return { url: data };
        }
        catch {
            // next file
        }
    }
    // 兜底2：聊天/附件目录 msg/attach（.dat 加密）按 md5 匹配
    const attachRoot = join(wechatBaseDir, 'msg', 'attach');
    if (existsSync(attachRoot)) {
        const attachFiles = [];
        walkFiles(attachRoot, attachFiles, 0);
        // 先找缩略图（_t/_h/_b，通常为 jpg，浏览器可直接显示）；HEVC/HEIC 大图回退到最后
        let hevcFallback = null;
        for (const f of attachFiles) {
            try {
                const bytes = readFileSync(f);
                const dec = decodeDatBytes(new Uint8Array(bytes), aesKey ?? null, xorKey);
                if ('error' in dec)
                    continue;
                const nameBase0 = f.split(/[\\/]/).pop() ?? '';
                const nameBase = nameBase0.replace(/\.dat$/i, '').replace(/_(t|h|b|thumb.*)$/i, '');
                const nameMatch = nameBase === key || nameBase.startsWith(key) || key.startsWith(nameBase);
                if (md5Of(dec.bytes) !== key && !nameMatch)
                    continue;
                const data = dataUrlOf(dec);
                const lower = f.toLowerCase();
                const isThumb = lower.includes('_t.') || lower.includes('_h.') || lower.includes('_b.') || lower.includes('_thumb');
                if (isThumb) {
                    boundedSet(md5UrlCache, cacheKey, data);
                    return { url: data };
                }
                if (!hevcFallback)
                    hevcFallback = { data };
            }
            catch {
                // next file
            }
        }
        if (hevcFallback) {
            boundedSet(md5UrlCache, cacheKey, hevcFallback.data);
            return { url: hevcFallback.data };
        }
    }
    return { error: '未找到匹配的本地图片' };
}
//# sourceMappingURL=sns-image.js.map