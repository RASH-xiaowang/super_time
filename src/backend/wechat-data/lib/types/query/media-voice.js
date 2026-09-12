/**
 * WeChat voice message lookup, rewritten from st_control voice.rs.
 * Locates silk voice data in media_0.db VoiceInfo (Name2Id direct, then
 * svr_id fallback). Node cannot decode silk without ffmpeg/a WASM decoder,
 * so decodable=false and the frontend shows a duration + degrade hint.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
/** Msg_<md5(username)> table name for a talker. */
function msgTableName(username) {
    return 'Msg_' + createHash('md5').update(username, 'utf8').digest('hex');
}
/** Message shard DB files under <decrypted>/message. */
function messageShardFiles(decryptedDir) {
    const dir = join(decryptedDir, 'message');
    if (!existsSync(dir))
        return [];
    return readdirSync(dir)
        .filter(f => f.endsWith('.db') && !f.includes('_shm') && !f.includes('_wal') && !f.includes('media') && !f.includes('fts') && !f.includes('resource'))
        .sort()
        .map(f => join(dir, f));
}
/**
 * server_id for (username, local_id) from the message shards.
 * @returns the server id as text (bigints exceed the safe-integer range).
 */
function messageServerId(decryptedDir, username, localId) {
    const table = msgTableName(username);
    for (const shard of messageShardFiles(decryptedDir)) {
        let db = null;
        try {
            db = new DatabaseSync(shard, { readOnly: true });
        }
        catch {
            continue;
        }
        const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined;
        if (has) {
            try {
                const row = db.prepare('SELECT CAST(server_id AS TEXT) AS s FROM "' + table + '" WHERE local_id = ? LIMIT 1').get(localId);
                db.close();
                if (row && row.s)
                    return row.s;
                continue;
            }
            catch {
                db.close();
                continue;
            }
        }
        db.close();
    }
    return null;
}
/**
 * Look up one voice message.
 * @param decryptedDir - decrypted data root.
 * @param username - conversation username.
 * @param localId - message local id.
 * @returns voice info; svrId as text (bigints exceed the safe-integer range);
 * decodable=false when no Node silk decoder is available.
 */
export function resolveVoiceInfo(decryptedDir, username, localId) {
    const mediaDb = join(decryptedDir, 'message', 'media_0.db');
    if (!existsSync(mediaDb)) {
        return { available: false, decodable: false, error: '语音库不存在 (media_0.db)' };
    }
    try {
        const db = new DatabaseSync(mediaDb, { readOnly: true });
        const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='VoiceInfo'").get() !== undefined;
        if (!has) {
            db.close();
            return { available: false, decodable: false, error: 'VoiceInfo 表不存在' };
        }
        // 1. Name2Id direct (chat_name_id, local_id)
        let row;
        const chat = db.prepare('SELECT rowid FROM Name2Id WHERE user_name = ?').get(username);
        if (chat) {
            row = db.prepare('SELECT CAST(svr_id AS TEXT) AS svr_id, length(voice_data) AS len FROM VoiceInfo WHERE chat_name_id = ? AND local_id = ? LIMIT 1').get(chat.rowid, localId);
        }
        let svrId = row?.svr_id;
        // 2. svr_id fallback
        if (!row) {
            const sid = messageServerId(decryptedDir, username, localId);
            if (sid !== null) {
                row = db.prepare('SELECT CAST(svr_id AS TEXT) AS svr_id, length(voice_data) AS len FROM VoiceInfo WHERE svr_id = ? ORDER BY create_time DESC LIMIT 1').get(sid);
                svrId = sid;
            }
        }
        db.close();
        if (!row)
            return { available: false, decodable: false, error: '未找到语音数据' };
        return { available: true, svrId: row.svr_id ?? svrId ?? '0', length: row.len ?? 0, decodable: false, error: 'silk 解码需要 ffmpeg/WASM（当前不可用）' };
    }
    catch (e) {
        return { available: false, decodable: false, error: e.message };
    }
}
//# sourceMappingURL=media-voice.js.map