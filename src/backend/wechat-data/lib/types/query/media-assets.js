/**
 * Media assets inventory over hardlink.db: per-category file/size stats and
 * duplicate md5 detection across image/file/video hardlink tables.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { cachedBySig, fileSigOf } from "./meta.js";
const MEDIA_TABLES = [
    ['image_hardlink_info_v4', '图片'],
    ['file_hardlink_info_v4', '文件'],
    ['video_hardlink_info_v4', '视频'],
];
function tableColumns(db, table) {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all();
    return new Set(rows.map(r => r.name));
}
/**
 * Compute the media assets snapshot.
 * @param decryptedDir - decrypted data root.
 * @returns the media assets snapshot.
 */
export function queryMediaAssets(decryptedDir) {
    return cachedBySig('media-assets:' + decryptedDir, fileSigOf(join(decryptedDir, 'hardlink', 'hardlink.db')), () => computeMediaAssets(decryptedDir), 30_000);
}
function computeMediaAssets(decryptedDir) {
    const p = join(decryptedDir, 'hardlink', 'hardlink.db');
    const categories = [];
    const duplicates = new Map();
    let totalFiles = 0;
    let totalBytes = 0;
    if (existsSync(p)) {
        try {
            const db = new DatabaseSync(p, { readOnly: true });
            for (const [table, label] of MEDIA_TABLES) {
                const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined;
                if (!has)
                    continue;
                const cols = tableColumns(db, table);
                const md5Col = cols.has('md5') ? 'md5' : cols.has('MD5') ? 'MD5' : '';
                const sizeCol = cols.has('file_size') ? 'file_size' : '0';
                const statRows = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(${sizeCol}), 0) AS s FROM ${table}`).all();
                const stat = statRows[0] ?? { n: 0, s: 0 };
                const count = stat.n;
                const size = stat.s;
                categories.push({ category: label, count, size });
                totalFiles += count;
                totalBytes += size;
                if (md5Col) {
                    try {
                        const dupRows = db.prepare(`SELECT ${md5Col} AS m, COUNT(*) AS n, COALESCE(SUM(CAST(${sizeCol} AS INTEGER)), 0) AS s FROM ${table} WHERE ${md5Col} IS NOT NULL AND ${md5Col} != '' GROUP BY ${md5Col} HAVING COUNT(*) > 1`).all();
                        for (const r of dupRows) {
                            const md5 = typeof r.m === 'string' ? r.m : '';
                            if (md5)
                                duplicates.set(md5, { count: r.n, size: r.s });
                        }
                    }
                    catch { /* duplicates optional */ }
                }
            }
            db.close();
        }
        catch { /* keep empty */ }
    }
    let duplicateFiles = 0;
    let duplicateBytes = 0;
    let reclaimBytes = 0;
    const dupList = Array.from(duplicates.entries())
        .map(([md5, d]) => ({
        md5,
        count: d.count,
        size: d.size,
        reclaimBytes: d.count > 1 ? Math.round((d.size * (d.count - 1)) / d.count) : 0,
    }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 50);
    for (const d of dupList) {
        duplicateFiles += d.count;
        duplicateBytes += d.size;
        reclaimBytes += d.reclaimBytes;
    }
    return {
        categories,
        duplicates: dupList,
        totalFiles,
        totalBytes,
        duplicateFiles,
        duplicateBytes,
        reclaimBytes,
        updatedAt: Math.floor(Date.now() / 1000),
    };
}
//# sourceMappingURL=media-assets.js.map