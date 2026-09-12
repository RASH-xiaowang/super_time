/**
 * SNS (朋友圈) video cover resolution: WeChat caches moments videos under
 * cache/<month>/Sns/Video/<sha>/<hash>.mp4 with a sibling <hash>.jpg cover.
 * The cover is a plain JPEG, unlike the image blobs, so no AES key is needed.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const coverCache = new Map();
// Base64 the cached .mp4/.mov once per lookup key; moments videos are short so
// the inflated data URL is acceptable for inline <video> playback.
const videoUrlCache = new Map();
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
        else if (e.name.toLowerCase().endsWith('.jpg') || e.name.toLowerCase().endsWith('.jpeg') || e.name.toLowerCase().endsWith('.png'))
            out.push(p);
    }
}
/** Gather cache/<month>/Sns/Video roots. */
function snsVideoRoots(wechatBaseDir) {
    const cacheRoot = join(wechatBaseDir, 'cache');
    const out = [];
    if (!existsSync(cacheRoot))
        return out;
    try {
        for (const e of readdirSync(cacheRoot, { withFileTypes: true })) {
            if (!e.isDirectory())
                continue;
            const root = join(cacheRoot, e.name, 'Sns', 'Video');
            if (existsSync(root))
                out.push(root);
        }
    }
    catch {
        // ignore
    }
    return out;
}
function dataUrlOf(path) {
    try {
        const bytes = readFileSync(path);
        const low = path.toLowerCase();
        const mime = low.endsWith('.png') ? 'png' : 'jpeg';
        return 'data:image/' + mime + ';base64,' + Buffer.from(bytes).toString('base64');
    }
    catch {
        return null;
    }
}
function firstExisting(root, sub, rest) {
    for (const ext of ['.jpg', '.jpeg', '.png']) {
        const p = join(root, sub, rest + ext);
        if (existsSync(p))
            return p;
    }
    return null;
}
/**
 * Resolve one SNS video cover to an offline base64 data URL.
 * @param wechatBaseDir - raw WeChat install dir (current account root).
 * @param md5 - optional media md5 from the moments XML (fallback to msg/video).
 * @param timelineId - optional timeline id (cache-key input).
 * @param mediaId - optional media id (cache-key input).
 * @returns data URL or an error description.
 */
export function resolveSnsVideoCoverDataUrl(wechatBaseDir, md5, timelineId, mediaId) {
    const hashInput = timelineId && mediaId ? createHash('md5').update(timelineId + '_' + mediaId + '_2', 'utf8').digest('hex') : '';
    const key = hashInput || (md5 || '').trim().toLowerCase();
    if (!key)
        return { error: '缺少视频标识' };
    if (coverCache.has(key)) {
        const cached = coverCache.get(key) ?? '';
        if (cached)
            return { url: cached };
    }
    if (!wechatBaseDir)
        return { error: '未配置微信原始目录，无法离线解码' };
    if (timelineId && mediaId) {
        for (const suffix of ['_2', '_1', '_0', '']) {
            const h = createHash('md5').update(timelineId + '_' + mediaId + suffix, 'utf8').digest('hex');
            const sub = h.slice(0, 2);
            const rest = h.slice(2);
            for (const root of snsVideoRoots(wechatBaseDir)) {
                const p = firstExisting(root, sub, rest);
                if (p) {
                    const data = dataUrlOf(p);
                    if (data) {
                        coverCache.set(key, data);
                        return { url: data };
                    }
                }
            }
        }
    }
    // 兜底：msg/video/<md5>_thumb.jpg（聊天视频封面，通常为明文 jpg）
    if (md5) {
        const videoRoot = join(wechatBaseDir, 'msg', 'video');
        if (existsSync(videoRoot)) {
            const files = [];
            walkFiles(videoRoot, files, 0);
            for (const f of files) {
                const base = f.split(/[\\/]/).pop() ?? '';
                if (base.startsWith(md5) || base.startsWith(md5.toLowerCase()) || base.startsWith(md5.toUpperCase())) {
                    const data = dataUrlOf(f);
                    if (data) {
                        coverCache.set(key, data);
                        return { url: data };
                    }
                }
            }
        }
    }
    return { error: '未找到匹配的本地 SNS 视频封面' };
}
function dataUrlOfVideo(path) {
    try {
        const bytes = readFileSync(path);
        const low = path.toLowerCase();
        const mime = low.endsWith('.mov') ? 'quicktime' : 'mp4';
        return 'data:video/' + mime + ';base64,' + Buffer.from(bytes).toString('base64');
    }
    catch {
        return null;
    }
}
function firstExistingVideo(root, sub, rest) {
    for (const ext of ['.mp4', '.mov']) {
        const p = join(root, sub, rest + ext);
        if (existsSync(p))
            return p;
    }
    return null;
}
/**
 * Resolve one SNS (朋友圈) video body to an offline base64 data URL so it can be
 * played inline. The cached container sits beside its cover under
 * cache/<month>/Sns/Video/<sha>/<hash>.mp4; fall back to msg/video/<md5>.mp4.
 * @param wechatBaseDir - raw WeChat install dir (current account root).
 * @param md5 - optional media md5 from the moments XML.
 * @param timelineId - optional timeline id (cache-key input).
 * @param mediaId - optional media id (cache-key input).
 * @returns data URL or an error description.
 */
export function resolveSnsVideoDataUrl(wechatBaseDir, md5, timelineId, mediaId) {
    const hashInput = timelineId && mediaId ? createHash('md5').update(timelineId + '_' + mediaId + '_2', 'utf8').digest('hex') : '';
    const key = hashInput || (md5 || '').trim().toLowerCase();
    if (!key)
        return { error: '缺少视频标识' };
    if (videoUrlCache.has(key)) {
        const cached = videoUrlCache.get(key) ?? '';
        if (cached)
            return { url: cached };
    }
    if (!wechatBaseDir)
        return { error: '未配置微信原始目录，无法离线解码' };
    if (timelineId && mediaId) {
        for (const suffix of ['_2', '_1', '_0', '']) {
            const h = createHash('md5').update(timelineId + '_' + mediaId + suffix, 'utf8').digest('hex');
            const sub = h.slice(0, 2);
            const rest = h.slice(2);
            for (const root of snsVideoRoots(wechatBaseDir)) {
                const p = firstExistingVideo(root, sub, rest);
                if (p) {
                    const data = dataUrlOfVideo(p);
                    if (data) {
                        videoUrlCache.set(key, data);
                        return { url: data };
                    }
                }
            }
        }
    }
    // Fallback: msg/video/<md5>_<...>.mp4 (chat video container).
    if (md5) {
        const videoRoot = join(wechatBaseDir, 'msg', 'video');
        if (existsSync(videoRoot)) {
            const files = [];
            walkFiles(videoRoot, files, 0);
            for (const f of files) {
                const base = f.split(/[\\/]/).pop() ?? '';
                const low = base.toLowerCase();
                if ((base.startsWith(md5) || base.startsWith(md5.toLowerCase()) || base.startsWith(md5.toUpperCase())) && (low.endsWith('.mp4') || low.endsWith('.mov'))) {
                    const data = dataUrlOfVideo(f);
                    if (data) {
                        videoUrlCache.set(key, data);
                        return { url: data };
                    }
                }
            }
        }
    }
    return { error: '未找到匹配的本地 SNS 视频' };
}
//# sourceMappingURL=sns-video.js.map