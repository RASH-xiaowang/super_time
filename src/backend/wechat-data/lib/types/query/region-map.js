/**
 * Friend-region map (世界板块地图) query.
 *
 * Reads decrypted contact.db, parses each contact's extra_buffer region
 * (country / province / city) and builds a hierarchy
 * 世界 → 国家 → 省 → 市 → 好友. Only friends (category 'friend') with a
 * resolvable country are counted; contacts missing a province / city are
 * nested into synthetic 「省份未填」 / 「城市未填」 buckets so the world treemap
 * always drills to a friends list at the city level.
 */
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { parseContactExtra, regionLabel } from "./region.js";
/** One region node with a running count; children/friends are populated after. */
function makeNode(name, count) {
    return { key: name, name, count, children: [], friends: [] };
}
/**
 * Query the friend-region map.
 * @param decryptedDir - decrypted data root.
 * @returns the region map snapshot (world → countries → provinces → cities).
 */
export function queryRegionMap(decryptedDir) {
    const dbPath = join(decryptedDir, 'contact', 'contact.db');
    const rows = [];
    let unknown = 0;
    try {
        const db = new DatabaseSync(dbPath, { readOnly: true });
        try {
            const cols = db.prepare('PRAGMA table_info(contact)').all().map(r => r.name);
            const has = (c) => (cols.includes(c) ? c : 'NULL');
            const sql = 'SELECT ' +
                [has('username'), has('local_type'), has('alias'), has('delete_flag'), has('remark'),
                    has('nick_name'), has('big_head_url'), has('small_head_url'), has('extra_buffer')].join(', ') +
                ' FROM contact';
            const raw = db.prepare(sql).all();
            for (const r of raw) {
                const username = str(r[has('username')]);
                if (!username)
                    continue;
                const localType = Number(r[has('local_type')] ?? 0);
                const deleteFlag = Number(r[has('delete_flag')] ?? 0);
                // 只统计「联系人」：非官方 / 非群 / 非系统 / 非企业，local_type=1。
                if (deleteFlag !== 0 || localType !== 1)
                    continue;
                // 排除群聊 / 公众号 / 企业微信 / 客服 / 系统账号，只保留个人好友。
                if (username.endsWith('@chatroom') || username.includes('gh_') || username.includes('@kefu.openim') || username.endsWith('@openim') || /^(weixin|notifymessage|fmessage|newsapp)/.test(username))
                    continue;
                const extraBuf = toBuffer(r[has('extra_buffer')]);
                const extra = extraBuf.length > 0 ? parseContactExtra(extraBuf) : null;
                const country = regionLabel('country', extra?.country ?? '');
                const province = extra?.province ? regionLabel('province', extra.province) : '';
                const city = extra?.city ? regionLabel('city', extra.city) : '';
                if (!country) {
                    unknown += 1;
                    continue;
                }
                const remark = str(r[has('remark')]).trim();
                const nick = str(r[has('nick_name')]).trim();
                const displayName = remark || nick || username;
                const row = {
                    username,
                    displayName,
                    remark,
                    nickName: nick,
                    country,
                    province,
                    city,
                };
                const head = str(r[has('small_head_url')]).trim() || str(r[has('big_head_url')]).trim();
                if (head)
                    row.avatarUrl = head;
                rows.push(row);
            }
        }
        finally {
            db.close();
        }
    }
    catch { /* contact.db unavailable -> empty map */ }
    // Build the tree.
    const countries = new Map();
    for (const row of rows) {
        let country = countries.get(row.country);
        if (!country) {
            country = makeNode(row.country, 0);
            countries.set(row.country, country);
        }
        country.count += 1;
        // province level: use the province name, or "省份未填" when absent.
        const pName = row.province || '省份未填';
        let province = country.children.find(n => n.key === pName);
        if (!province) {
            province = makeNode(pName, 0);
            country.children.push(province);
        }
        province.count += 1;
        // city level: use city name, or "城市未填" when absent.
        const cName = row.city || '城市未填';
        let city = province.children.find(n => n.key === cName);
        if (!city) {
            city = makeNode(cName, 0);
            province.children.push(city);
        }
        city.count += 1;
        city.friends.push({
            username: row.username,
            displayName: row.displayName,
            remark: row.remark,
            nickName: row.nickName,
            ...(row.avatarUrl ? { avatarUrl: row.avatarUrl } : {}),
        });
    }
    // Sort each level by count desc for a stable, readable treemap.
    const sortNode = (n) => {
        n.children.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
        for (const c of n.children)
            sortNode(c);
    };
    const worldChildren = Array.from(countries.values());
    const world = { key: '世界', name: '世界', count: rows.length, children: worldChildren, friends: [] };
    sortNode(world);
    return { total: rows.length, unknown, world };
}
/** Coerce a DB cell to string. */
function str(v) {
    if (v === null || v === undefined)
        return '';
    if (typeof v === 'string')
        return v;
    if (v instanceof Uint8Array)
        return new TextDecoder('utf-8', { fatal: false }).decode(v);
    return '';
}
/** Coerce a BLOB cell to a Buffer (empty when null/other). */
function toBuffer(v) {
    if (v instanceof Uint8Array)
        return Buffer.from(v);
    if (typeof v === 'string' && v.length > 0)
        return Buffer.from(v, 'utf8');
    return Buffer.alloc(0);
}
//# sourceMappingURL=region-map.js.map