/**
 * 微信数据总览「战术分析」：基于解密数据库做交互画像/作息浓度/关系浓度/
 * 内容资产/数据健康五块统计，供总览页展示。
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { contactMeta, shardCatalogDirs, shardCatalogSig, fileSigOf, cachedBySig } from "./meta.js";
import { queryOverviewExtras } from "./overview-extras.js";
function cellStr(v) {
    if (typeof v === 'string')
        return v;
    if (v === null || v === undefined)
        return '';
    if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol')
        return String(v);
    if (v instanceof Uint8Array)
        return new TextDecoder('utf-8', { fatal: false }).decode(v);
    return '';
}
/** 枚举 decrypted 目录下所有 *.db（不含 -wal/-shm）。 */
function walkDbFiles(dir, out, depth) {
    if (depth > 4 || !existsSync(dir))
        return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
            walkDbFiles(p, out, depth + 1);
        }
        else if (e.name.endsWith('.db') && !e.name.includes('-wal') && !e.name.includes('-shm')) {
            try {
                out.push({ path: p, bytes: statSync(p).size });
            }
            catch { /* ignore */ }
        }
    }
}
/** 行内计数：按本地类型归一化后分类。 */
function typeBucket(t) {
    const m = t > 0x100000000 ? t % 0x100000000 : t;
    if (m === 1)
        return 'text';
    if (m === 3)
        return 'image';
    if (m === 34)
        return 'voice';
    if (m === 43)
        return 'video';
    if (m === 49)
        return 'rich';
    if (m === 10000)
        return 'system';
    if (m === 10002)
        return 'revoked';
    return 'other';
}
export function queryOverviewInsights(decryptedDir) {
    const dec = decryptedDir;
    const sns = existsSync(join(dec, 'sns', 'db_sns', 'sns.db')) ? join(dec, 'sns', 'db_sns', 'sns.db') : join(dec, 'sns', 'sns.db');
    const sig = [
        shardCatalogSig(dec, ['message', 'bizchat']),
        fileSigOf(join(dec, 'contact', 'contact.db')),
        fileSigOf(join(dec, 'session', 'session.db')),
        fileSigOf(sns),
        fileSigOf(join(dec, 'favorite', 'favorite.db')),
        fileSigOf(join(dec, 'emoticon', 'emoticon.db')),
        fileSigOf(join(dec, 'hardlink', 'hardlink.db')),
        fileSigOf(join(dec, 'message', 'message_resource.db')),
    ].join('|');
    return cachedBySig('overview-insights:' + dec, sig, () => computeOverviewInsights(decryptedDir));
}
function computeOverviewInsights(decryptedDir) {
    const dec = decryptedDir;
    const names = contactMeta(dec).names;
    // 反向映射 md5(table suffix) -> 联系人。真实账号来自 contactMeta 与
    // SessionTable（下方合并），不再注入硬编码示例账号。
    const md5ToUser = new Map();
    for (const u of names.keys())
        md5ToUser.set(createHash('md5').update(u, 'utf8').digest('hex'), u);
    try {
        const sp = join(dec, 'session', 'session.db');
        if (existsSync(sp)) {
            const db = new DatabaseSync(sp, { readOnly: true });
            const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='SessionTable'").get() !== undefined;
            if (has) {
                const rows = db.prepare('SELECT username FROM SessionTable').all();
                for (const r of rows) {
                    const u = cellStr(r['username']);
                    if (u)
                        md5ToUser.set(createHash('md5').update(u, 'utf8').digest('hex'), u);
                }
            }
            db.close();
        }
    }
    catch { /* ignore */ }
    const total = { n: 0, sent: 0 };
    const buckets = { text: 0, image: 0, voice: 0, video: 0, rich: 0, system: 0, revoked: 0, other: 0 };
    const hourDist = new Array(24).fill(0);
    const dayCounts = new Map();
    const talkerCount = new Map();
    let minDay = -1;
    let maxDay = -1;
    let lastActive = 0;
    for (const sh of shardCatalogDirs(dec, ['message', 'bizchat'])) {
        try {
            const db = new DatabaseSync(sh.file, { readOnly: true });
            try {
                for (const [table, meta] of sh.tables) {
                    if (!meta.cols.has('create_time') || !meta.cols.has('local_type'))
                        continue;
                    const senderCol = meta.cols.has('is_sender') ? 'is_sender' : '0';
                    const grouped = db.prepare('SELECT (local_type & 4294967295) AS t, (create_time / 3600) % 24 AS h, create_time / 86400 AS d, COUNT(*) AS n, COALESCE(SUM(' + senderCol + '), 0) AS s, MAX(create_time) AS m FROM ' + table + ' GROUP BY t, h, d').all();
                    let tn = 0;
                    for (const g of grouped) {
                        const b = typeBucket(g.t);
                        buckets[b] = (buckets[b] ?? 0) + g.n;
                        total.sent += g.s;
                        tn += g.n;
                        hourDist[((g.h % 24) + 24) % 24] = (hourDist[((g.h % 24) + 24) % 24] ?? 0) + g.n;
                        const d = g.d;
                        dayCounts.set(d, (dayCounts.get(d) ?? 0) + g.n);
                        if (minDay < 0 || d < minDay)
                            minDay = d;
                        if (d > maxDay)
                            maxDay = d;
                        if (g.m)
                            lastActive = Math.max(lastActive, g.m);
                    }
                    total.n += tn;
                    const talker = md5ToUser.get(table.slice(4)) ?? table.slice(4);
                    talkerCount.set(talker, (talkerCount.get(talker) ?? 0) + tn);
                }
            }
            finally {
                db.close();
            }
        }
        catch { /* skip shard */ }
    }
    let busyHour = 0;
    let busyCount = 0;
    let deepNight = 0;
    let weekend = 0;
    for (let i = 0; i < 24; i++) {
        const n = hourDist[i] ?? 0;
        if (n > busyCount) {
            busyCount = n;
            busyHour = i;
        }
        if (i >= 23 || i <= 5)
            deepNight += n;
    }
    for (const [d, n] of dayCounts) {
        const dow = (d + 4) % 7;
        if (dow === 0 || dow === 6)
            weekend += n;
    }
    const totalSafe = Math.max(1, total.n);
    // 关系浓度
    const contactRows = [];
    const cp = join(dec, 'contact', 'contact.db');
    if (existsSync(cp)) {
        try {
            const db = new DatabaseSync(cp, { readOnly: true });
            const cols = new Set(db.prepare('PRAGMA table_info(contact)').all().map(r => r.name));
            if (cols.has('username')) {
                const lt = cols.has('local_type') ? 'local_type' : '0';
                const df = cols.has('delete_flag') ? 'delete_flag' : '0';
                const rows = db.prepare(`SELECT username, ${lt} AS lt, ${df} AS df FROM contact WHERE (${df} = 0 OR ${df} IS NULL)`).all();
                for (const r of rows) {
                    const u = cellStr(r['username']);
                    if (!u)
                        continue;
                    if (u.startsWith('@'))
                        continue;
                    contactRows.push({ username: u, isGroup: u.includes('@chatroom'), isGh: u.startsWith('gh_') });
                }
            }
            db.close();
        }
        catch { /* ignore */ }
    }
    const friendRows = contactRows.filter(r => !r.isGroup && !r.isGh);
    const activeFriends = friendRows.filter(r => talkerCount.has(r.username)).length;
    const silentFriends = friendRows.length - activeFriends;
    const groupsWithMsg = contactRows.filter(r => r.isGroup && talkerCount.has(r.username)).length;
    const top = Array.from(talkerCount.entries())
        .filter(([u]) => !u.includes('@chatroom'))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([u, count]) => ({ username: u, name: names.get(u) ?? u, count }));
    // 朋友圈
    const moments = { total: 0, images: 0, videos: 0, likes: 0, comments: 0 };
    const sp2 = existsSync(join(dec, 'sns', 'db_sns', 'sns.db')) ? join(dec, 'sns', 'db_sns', 'sns.db') : join(dec, 'sns', 'sns.db');
    if (existsSync(sp2)) {
        try {
            const db = new DatabaseSync(sp2, { readOnly: true });
            const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='SnsTimeLine'").get() !== undefined;
            if (has) {
                const rows = db.prepare('SELECT content AS c FROM SnsTimeLine').all();
                for (const r of rows) {
                    const xml = cellStr(r.c);
                    moments.total += 1;
                    moments.images += xml.split('<media>').length - 1 + xml.split('<media ').length - 1;
                    if (xml.includes('<type>6</type>') || xml.includes('<type>4</type>') || xml.includes('<type>15</type>'))
                        moments.videos += 1;
                    const le = xml.indexOf('<LocalExtraInfo>');
                    if (le >= 0) {
                        const block = xml.slice(le, xml.indexOf('</LocalExtraInfo>', le) || xml.length);
                        const parts = block.split('<user_comment>').length - 1;
                        const likes = (block.match(/<type>1<\/type>/g) ?? []).length;
                        moments.likes += likes;
                        moments.comments += Math.max(0, parts - likes);
                    }
                }
            }
            db.close();
        }
        catch { /* ignore */ }
    }
    // 资产
    const assets = { favorites: 0, emoticons: 0, files: 0, fileBytes: 0, mediaItems: 0, mediaBytes: 0 };
    assets.favorites = countRows(join(dec, 'favorite', 'favorite.db'), 'fav_db_item');
    assets.emoticons = countRows(join(dec, 'emoticon', 'emoticon.db'), 'kNonStoreEmoticonTable');
    for (const table of ['image_hardlink_info_v4', 'file_hardlink_info_v4', 'video_hardlink_info_v4']) {
        const hp = join(dec, 'hardlink', 'hardlink.db');
        if (!existsSync(hp))
            break;
        try {
            const db = new DatabaseSync(hp, { readOnly: true });
            const has = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='${table}'`).get() !== undefined;
            if (has) {
                const c = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(file_size), 0) AS s FROM ${table}`).get();
                assets.files += c.n;
                assets.fileBytes += c.s;
            }
            db.close();
        }
        catch { /* ignore */ }
    }
    const rp = join(dec, 'message', 'message_resource.db');
    if (existsSync(rp)) {
        try {
            const db = new DatabaseSync(rp, { readOnly: true });
            if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='MessageResourceDetail'").get() !== undefined) {
                const c = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS s FROM MessageResourceDetail').get();
                assets.mediaItems = c.n;
                assets.mediaBytes = c.s;
            }
            db.close();
        }
        catch { /* ignore */ }
    }
    // 数据健康
    const dbs = [];
    walkDbFiles(dec, dbs, 0);
    const dbBytes = dbs.reduce((a, r) => a + r.bytes, 0);
    return {
        messages: {
            total: total.n,
            sent: total.sent,
            received: Math.max(0, total.n - total.sent),
            text: buckets.text ?? 0,
            image: buckets.image ?? 0,
            voice: buckets.voice ?? 0,
            video: buckets.video ?? 0,
            rich: buckets.rich ?? 0,
            system: buckets.system ?? 0,
            revoked: buckets.revoked ?? 0,
        },
        time: {
            activeDays: dayCounts.size,
            spanDays: maxDay >= 0 && minDay >= 0 ? maxDay - minDay + 1 : 0,
            busyHour,
            busyCount,
            hourDist,
            deepNightPct: Math.round((deepNight / totalSafe) * 1000) / 10,
            weekendPct: Math.round((weekend / totalSafe) * 1000) / 10,
            lastActive: lastActive ? new Date(lastActive * 1000).toLocaleString('zh-CN') : '',
        },
        relations: {
            total: friendRows.length,
            active: activeFriends,
            silent: silentFriends,
            groupsWithMsg,
            top,
        },
        moments,
        assets,
        health: { dbFiles: dbs.length, dbBytes, ok: total.n > 0 || contactRows.length > 0 },
        extras: queryOverviewExtras(decryptedDir),
    };
}
function countRows(path, table) {
    if (!existsSync(path))
        return 0;
    try {
        const db = new DatabaseSync(path, { readOnly: true });
        const has = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='${table}'`).get() !== undefined;
        if (!has) {
            db.close();
            return 0;
        }
        const r = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
        db.close();
        return r.n;
    }
    catch {
        return 0;
    }
}
//# sourceMappingURL=overview-insights.js.map