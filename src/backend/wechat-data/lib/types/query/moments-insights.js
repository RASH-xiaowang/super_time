/**
 * Moments insights for one author (usually self): post/like/comment totals,
 * top likers and commenters, monthly distribution, and "on this day" items.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseSnsLikesComments, parseSnsXml } from "./moments.js";
import { cachedBySig, fileSigOf } from "./meta.js";
function cellString(v) {
    if (typeof v === 'string')
        return v;
    if (v === null || v === undefined)
        return '';
    if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol')
        return String(v);
    return '';
}
function snsDb(decryptedDir) {
    for (const p of [join(decryptedDir, 'sns', 'db_sns', 'sns.db'), join(decryptedDir, 'sns', 'sns.db')]) {
        if (existsSync(p))
            return p;
    }
    return null;
}
function addInteractor(map, username, nickname) {
    const key = username || nickname || '?';
    const cur = map.get(key);
    if (cur) {
        cur.count += 1;
    }
    else {
        map.set(key, { username, nickname, count: 1 });
    }
}
function sortedTop(map, cap) {
    return Array.from(map.values()).sort((a, b) => b.count - a.count).slice(0, cap);
}
/**
 * Compute moments insights for an author.
 * @param decryptedDir - decrypted data root.
 * @param author - author username (default: all).
 * @returns the insights snapshot.
 */
export function queryMomentsInsights(decryptedDir, author) {
    const dbPath = snsDb(decryptedDir);
    // Cache keyed on the sns.db signature; recomputed when the realtime sync
    // rewrites it, otherwise served from the 5s bounded cache.
    const sig = dbPath === null ? '' : fileSigOf(dbPath);
    return cachedBySig('moments-insights:' + decryptedDir + ':' + (author ?? ''), sig, () => computeMomentsInsights(decryptedDir, author));
}
function computeMomentsInsights(decryptedDir, author) {
    const dbPath = snsDb(decryptedDir);
    if (dbPath === null)
        return { author: author ?? '', posts: 0, likes: 0, comments: 0, likedBy: [], commenters: [], monthly: [], today: [], updatedAt: Math.floor(Date.now() / 1000) };
    let posts = 0;
    let likes = 0;
    let comments = 0;
    const likers = new Map();
    const commenters = new Map();
    const monthly = new Map();
    const now = new Date();
    const today = [];
    try {
        const db = new DatabaseSync(dbPath, { readOnly: true });
        const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='SnsTimeLine'").get() !== undefined;
        if (!has) {
            db.close();
            return { author: author ?? '', posts: 0, likes: 0, comments: 0, likedBy: [], commenters: [], monthly: [], today: [], updatedAt: Math.floor(Date.now() / 1000) };
        }
        const cols = new Set(db.prepare('PRAGMA table_info(SnsTimeLine)').all().map(r => r.name));
        const tidCol = cols.has('tid') ? 'tid' : cols.has('Id') ? 'Id' : '';
        const userCol = cols.has('user_name') ? 'user_name' : cols.has('userName') ? 'userName' : '';
        const contentCol = cols.has('content') ? 'content' : cols.has('Content') ? 'Content' : '';
        if (!tidCol || !userCol || !contentCol) {
            db.close();
            return { author: author ?? '', posts: 0, likes: 0, comments: 0, likedBy: [], commenters: [], monthly: [], today: [], updatedAt: Math.floor(Date.now() / 1000) };
        }
        const where = author ? ` WHERE ${userCol} = ?` : '';
        const rows = db.prepare(`SELECT ${tidCol} AS t, ${userCol} AS u, ${contentCol} AS c FROM SnsTimeLine${where}`).all(...(author ? [author] : []));
        db.close();
        for (const r of rows) {
            posts += 1;
            const xml = cellString(r.c);
            const parsed = parseSnsXml(xml);
            const social = parseSnsLikesComments(xml);
            likes += social.likes.length;
            comments += social.comments.length;
            for (const like of social.likes)
                addInteractor(likers, like.username, like.nickname);
            for (const cm of social.comments)
                addInteractor(commenters, cm.username, cm.nickname);
            if (parsed.createTime > 0) {
                const d = new Date(parsed.createTime * 1000);
                const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
                monthly.set(key, (monthly.get(key) ?? 0) + 1);
                if (d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) {
                    today.push({ tid: cellString(r.t), text: parsed.text, ts: parsed.createTime, author: cellString(r.u) });
                }
            }
        }
    }
    catch { /* keep zeros */ }
    const monthlyArr = Array.from(monthly.entries())
        .map(([month, count]) => ({ month, count }))
        .sort((a, b) => a.month.localeCompare(b.month));
    return {
        author: author ?? '',
        posts,
        likes,
        comments,
        likedBy: sortedTop(likers, 10),
        commenters: sortedTop(commenters, 10),
        monthly: monthlyArr,
        today: today.slice(0, 20).sort((a, b) => b.ts - a.ts),
        updatedAt: Math.floor(Date.now() / 1000),
    };
}
//# sourceMappingURL=moments-insights.js.map