/**
 * Annual report: local-only yearly WeChat chat story, rewritten from
 * st_control AnnualSummary + utils/annual.ts. Scans all message shards for
 * one year and computes hero stats, heatmap, monthly, types, phrases, emoji,
 * top contacts/groups, and first/last sentences.
 */
import { DatabaseSync } from 'node:sqlite';
import { decompress } from 'fzstd';
import { existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { contactMeta } from "./meta.js";
/** Msg_<md5(username)> table name. */
function msgTableName(username) {
    return 'Msg_' + createHash('md5').update(username, 'utf8').digest('hex');
}
/** Coerce a DB cell to a string (null -> '', else String()). */
function cellStr(v) {
    if (typeof v === 'string')
        return v;
    if (v === null || v === undefined)
        return '';
    if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol')
        return String(v);
    return '';
}
/** zstd magic bytes (WCDB compressed blobs). */
const ZSTD_MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD]);
/** Decode raw column bytes: zstd-decompress when the magic matches. */
function tryDecompress(data) {
    if (data.length >= 4 && data.subarray(0, 4).equals(ZSTD_MAGIC)) {
        try {
            return Buffer.from(decompress(data));
        }
        catch {
            return null;
        }
    }
    return null;
}
/** Decode bytes as UTF-8, falling back to GBK when UTF-8 leaves replacement chars. */
function decodeUtfOrGbk(bytes) {
    const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    if (!utf8.includes('\uFFFD'))
        return utf8;
    try {
        const gbk = new TextDecoder('gbk', { fatal: false }).decode(bytes);
        const utf8Bad = (utf8.match(/\uFFFD/g) ?? []).length;
        const gbkBad = (gbk.match(/\uFFFD/g) ?? []).length;
        return gbkBad < utf8Bad ? gbk : utf8;
    }
    catch {
        return utf8;
    }
}
/** Decode a message cell (TEXT or BLOB): zstd-decompress, then UTF-8/GBK. */
function decodeCell(v) {
    if (v === null || v === undefined)
        return '';
    if (typeof v === 'string')
        return v;
    if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol')
        return String(v);
    const raw = Buffer.from(v instanceof Uint8Array ? v : []);
    const decompressed = tryDecompress(raw);
    return decodeUtfOrGbk(decompressed ?? raw);
}
/** Strip XML tags for text. */
function stripXml(x) {
    return x.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}
/** Extract group sender from content prefix (wxid:\n). */
function senderFromContent(content) {
    const m = content.match(/([A-Za-z0-9_@.\-]{3,64}):\n/);
    return m ? (m[1] ?? null) : null;
}
/** Clean a message preview: strip binary header + group sender prefix + XML. */
function cleanMessage(text) {
    let t = text;
    // group-chat content is '<binary>wxid_xxx: <body>' (colon may be followed by
    // space or newline); keep only the body after the first username-like prefix
    const m = t.match(/(?:[A-Za-z0-9_@.\-]{3,64}:\s*)([\s\S]*)/);
    if (m && m[1] && !m[1].startsWith('<'))
        t = m[1];
    // strip leading binary/control bytes and XML tags
    t = t.replace(/^[\x00-\x1f\x7f-\x9f]*/, '');
    t = t.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    return t.slice(0, 120);
}
/** Compute persona tags from shares. */
function personaTags(s) {
    const tags = [];
    if (s.nightShare >= 0.2)
        tags.push('夜猫子');
    if (s.morningShare >= 0.15)
        tags.push('早起鸟');
    if (s.weekendShare >= 0.25)
        tags.push('周末达人');
    if (s.groupShare >= 0.6)
        tags.push('群聊之王');
    if (s.dailyAvg >= 50)
        tags.push('话痨');
    if (tags.length === 0)
        tags.push('稳健沟通者');
    return tags;
}
/**
 * Compute the annual report for one year.
 * @param decryptedDir - decrypted data root.
 * @param year - calendar year.
 * @returns the annual report.
 */
export function queryAnnualReport(decryptedDir, year) {
    const msgDir = join(decryptedDir, 'message');
    if (!existsSync(msgDir))
        return { year, total: 0 };
    const start = Math.floor(new Date(year, 0, 1, 0, 0, 0, 0).getTime() / 1000);
    const end = Math.floor(new Date(year + 1, 0, 1, 0, 0, 0, 0).getTime() / 1000);
    // gather sessions
    const usernames = loadUsernames(decryptedDir);
    const perSender = new Map();
    const perChat = new Map();
    const heat = new Array(7 * 24).fill(0);
    const monthly = new Array(12).fill(0);
    const kindCounts = new Map();
    const emojiCount = new Map();
    const phraseCount = new Map();
    const activeDays = new Set();
    let total = 0;
    let textCount = 0;
    let textChars = 0;
    let nightCount = 0;
    let morningCount = 0;
    let weekendCount = 0;
    let groupCount = 0;
    let firstMsg = null;
    let lastMsg = null;
    let firstTs = Number.POSITIVE_INFINITY;
    let lastTs = 0;
    const files = readdirSync(msgDir).filter(f => f.endsWith('.db') && !f.includes('_shm') && !f.includes('_wal') && !f.includes('monitor_cache')
        && !f.includes('media') && !f.includes('resource') && !f.includes('fts'));
    // File-first indexing: open each shard once and map its Msg_* tables to
    // session usernames, so the per-session loop never reopens a file.
    const tableToUser = new Map();
    for (const username of usernames)
        tableToUser.set(msgTableName(username), username);
    const fileInfos = [];
    for (const file of files) {
        let probe = null;
        try {
            probe = new DatabaseSync(join(msgDir, file), { readOnly: true });
        }
        catch {
            continue;
        }
        try {
            const names = probe.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'").all().map(r => r.name);
            const tables = [];
            for (const n of names) {
                const u = tableToUser.get(n);
                if (u)
                    tables.push([n, u]);
            }
            if (tables.length > 0)
                fileInfos.push({ path: join(msgDir, file), tables });
        }
        catch { /* skip */ }
        finally {
            probe.close();
        }
    }
    // Stats pass: one open per shard, one year-scoped query per session table.
    for (const fi of fileInfos) {
        let db = null;
        try {
            db = new DatabaseSync(fi.path, { readOnly: true });
        }
        catch {
            continue;
        }
        try {
            for (const [table, username] of fi.tables) {
                try {
                    const cols = db.prepare('PRAGMA table_info("' + table + '")').all().map(r => r.name);
                    const senderCol = cols.includes('is_sender') ? 'is_sender' : cols.includes('IsSender') ? 'IsSender' : '0';
                    const rows = db.prepare('SELECT create_time, local_type, ' + senderCol + ' AS is_sender, message_content FROM "' + table + '" WHERE create_time >= ? AND create_time < ?').all(start, end);
                    for (const r of rows) {
                        const ts = Number(r['create_time'] ?? 0);
                        const lt = Number(r['local_type'] ?? 0);
                        const content = decodeCell(r['message_content']);
                        const text = stripXml(content);
                        // skip binary comma-lists
                        if (text && /^[0-9,]+$/.test(text.slice(0, 80)))
                            continue;
                        total += 1;
                        if (username.endsWith('@chatroom')) {
                            // group chat: attribute to the sender when the content carries a
                            // wxid prefix; the chatroom itself never ranks as a person
                            const sender = senderFromContent(content);
                            if (sender && !sender.endsWith('@chatroom'))
                                perSender.set(sender, (perSender.get(sender) ?? 0) + 1);
                        }
                        else {
                            perSender.set(username, (perSender.get(username) ?? 0) + 1);
                        }
                        perChat.set(username, (perChat.get(username) ?? 0) + 1);
                        if (username.endsWith('@chatroom'))
                            groupCount += 1;
                        const d = new Date(ts * 1000);
                        const h = d.getHours();
                        const dow = d.getDay();
                        heat[dow * 24 + h] = (heat[dow * 24 + h] ?? 0) + 1;
                        monthly[d.getMonth()] = (monthly[d.getMonth()] ?? 0) + 1;
                        const dayKey = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
                        activeDays.add(dayKey);
                        if (h >= 23 || h <= 4)
                            nightCount += 1;
                        if (h >= 5 && h <= 9)
                            morningCount += 1;
                        if (dow === 0 || dow === 6)
                            weekendCount += 1;
                        const normType = lt > 4294967296 ? lt % 4294967296 : lt;
                        if (normType === 1 && text) {
                            textCount += 1;
                            textChars += text.length;
                            // phrases: CJK bigrams
                            for (let i = 0; i + 2 <= text.length; i += 1) {
                                const bi = text.slice(i, i + 2);
                                if (/[\u4e00-\u9fff]{2}/.test(bi))
                                    phraseCount.set(bi, (phraseCount.get(bi) ?? 0) + 1);
                            }
                            // emoji: simple extraction of common emoji ranges
                            const emo = text.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) ?? [];
                            for (const e of emo)
                                emojiCount.set(e, (emojiCount.get(e) ?? 0) + 1);
                        }
                        kindCounts.set(typeLabel(normType), (kindCounts.get(typeLabel(normType)) ?? 0) + 1);
                        if (ts > lastTs && text) {
                            lastTs = ts;
                            lastMsg = text.slice(0, 80);
                        }
                        if (ts < firstTs && text) {
                            firstTs = ts;
                            firstMsg = text.slice(0, 80);
                        }
                    }
                }
                catch { /* skip */ }
            }
        }
        finally {
            db.close();
        }
    }
    const activeDaysCount = activeDays.size;
    const dailyAvg = activeDaysCount > 0 ? Math.round(total / activeDaysCount) : 0;
    const textShare = total > 0 ? textCount / total : 0;
    const nightShare = total > 0 ? nightCount / total : 0;
    const morningShare = total > 0 ? morningCount / total : 0;
    const weekendShare = total > 0 ? weekendCount / total : 0;
    const groupShare = total > 0 ? groupCount / total : 0;
    const nameMap = contactMeta(decryptedDir).names;
    const topContacts = Array.from(perSender.entries()).filter(([u]) => !u.endsWith('@chatroom') && !u.startsWith('gh_')).map(([username, count]) => ({ username, name: nameMap.get(username) || username, count, share: total > 0 ? count / total : 0 })).sort((a, b) => b.count - a.count).slice(0, 10);
    const topGroups = Array.from(perChat.entries()).filter(([u]) => u.endsWith('@chatroom')).map(([username, count]) => ({ username, name: nameMap.get(username) || username, count, share: total > 0 ? count / total : 0 })).sort((a, b) => b.count - a.count).slice(0, 10);
    const topEmoji = Array.from(emojiCount.entries()).map(([e, n]) => ({ emoji: e, count: n })).sort((a, b) => b.count - a.count).slice(0, 8);
    const topPhrases = Array.from(phraseCount.entries())
        .map(([p, n]) => ({ phrase: p, count: n }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 20);
    const out = {
        year,
        total,
        active_days: activeDaysCount,
        text_chars: textChars,
        daily_avg: dailyAvg,
        text_share: Number(textShare.toFixed(4)),
        night_share: Number(nightShare.toFixed(4)),
        morning_share: Number(morningShare.toFixed(4)),
        weekend_share: Number(weekendShare.toFixed(4)),
        group_share: Number(groupShare.toFixed(4)),
        heat,
        monthly,
        kind_counts: Object.fromEntries(kindCounts),
        top_phrases: topPhrases,
        top_emoji: topEmoji,
        top_contacts: topContacts,
        top_groups: topGroups,
        persona_tags: personaTags({ nightShare, morningShare, weekendShare, groupShare, dailyAvg }),
    };
    if (firstMsg)
        out.first_message = cleanMessage(firstMsg);
    if (lastMsg)
        out.last_message = cleanMessage(lastMsg);
    return out;
}
/** Load session usernames. */
function loadUsernames(decryptedDir) {
    const p = join(decryptedDir, 'session', 'session.db');
    if (!existsSync(p))
        return [];
    const out = [];
    try {
        const db = new DatabaseSync(p, { readOnly: true });
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
        const table = tables.includes('SessionTable') ? 'SessionTable' : tables.includes('Session') ? 'Session' : '';
        if (table) {
            const rows = db.prepare('SELECT username FROM "' + table + '"').all();
            for (const r of rows) {
                const u = cellStr(r['username'] ?? '').trim();
                if (u)
                    out.push(u);
            }
        }
        db.close();
    }
    catch { /* skip */ }
    return out;
}
/** Human label for a message type. */
function typeLabel(t) {
    if (t === 1)
        return '文本';
    if (t === 3)
        return '图片';
    if (t === 34)
        return '语音';
    if (t === 42)
        return '名片';
    if (t === 43)
        return '视频';
    if (t === 47)
        return '表情';
    if (t === 48)
        return '位置';
    if (t === 49)
        return '链接';
    if (t === 10000)
        return '系统消息';
    return '其他';
}
//# sourceMappingURL=annual-report.js.map