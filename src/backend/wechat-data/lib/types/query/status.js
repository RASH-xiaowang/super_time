/**
 * Decrypted DB status summary, rewritten from st_control
 * handlers/data/media.rs get_wechat_db_status.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { cachedBySig } from "./meta.js";
const LABEL_MAP = [
    ['session', '会话(session)'],
    ['message', '消息(message)'],
    ['contact', '通讯录(contact)'],
    ['sns', '朋友圈(sns)'],
    ['favorite', '收藏(favorite)'],
    ['emoticon', '表情(emoticon)'],
    ['hardlink', '文件(hardlink)'],
    ['general', '通用(general)'],
    ['bizchat', '公众号(bizchat)'],
    ['head_image', '头像缓存(head_image)'],
    ['solitaire', '接龙(solitaire)'],
    ['backup', '备份(backup)'],
];
const EXCLUDED = ['monitor_cache', 'exports'];
/** Recursively check whether a directory contains any .db file (max depth 5). */
function hasDbFile(dir, depth = 0) {
    if (depth > 5 || !existsSync(dir))
        return false;
    let entries = [];
    try {
        entries = readdirSync(dir, { withFileTypes: true }).map(e => ({ name: e.name, isDir: e.isDirectory() }));
    }
    catch {
        return false;
    }
    for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDir) {
            if (hasDbFile(p, depth + 1))
                return true;
        }
        else if (e.name.endsWith('.db'))
            return true;
    }
    return false;
}
/**
 * Summarize the decrypted DB directories as status lines (cached ~5s).
 * @param decryptedDir - decrypted data root.
 * @returns status lines plus the resolved path.
 */
export function getDbStatus(decryptedDir) {
    const key = 'db-status:' + decryptedDir;
    return cachedBySig(key, 'fs-status-v1', () => computeDbStatus(decryptedDir));
}
function computeDbStatus(decryptedDir) {
    const lines = [];
    if (!existsSync(decryptedDir)) {
        lines.push('⚠️ 解密目录不存在');
        return { lines, path: decryptedDir };
    }
    let dirs = [];
    try {
        dirs = readdirSync(decryptedDir, { withFileTypes: true })
            .filter(e => e.isDirectory())
            .map(e => ({ name: e.name }))
            .sort((a, b) => a.name.localeCompare(b.name));
    }
    catch (e) {
        lines.push('⚠️ 读取目录失败: ' + e.message);
        return { lines, path: decryptedDir };
    }
    for (const d of dirs) {
        if (EXCLUDED.includes(d.name) || d.name.startsWith('.'))
            continue;
        const ok = hasDbFile(join(decryptedDir, d.name));
        const label = LABEL_MAP.find(([k]) => k === d.name)?.[1] ?? d.name;
        lines.push(ok ? label + ': ✅ 可用' : label + ': ⚠️ 空目录');
    }
    lines.push('路径: ' + decryptedDir);
    return { lines, path: decryptedDir };
}
//# sourceMappingURL=status.js.map