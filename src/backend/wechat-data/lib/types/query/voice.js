/**
 * WeChat voice-message source helpers: media_0.db VoiceInfo rows (silk v3
 * voice_data), Name2Id username mapping, and the wx_silk decoder process
 * (pure-Rust SILK v3 → WAV, bundled under resources/win32/x64).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
function mediaDbPath(decryptedDir) {
    return join(decryptedDir, 'message', 'media_0.db');
}
/** Map a chat_name_id (Name2Id rowid) to its user_name. */
export function usernameByChatId(decryptedDir, chatId) {
    try {
        const db = new DatabaseSync(mediaDbPath(decryptedDir), { readOnly: true });
        const row = db.prepare('SELECT user_name FROM Name2Id WHERE rowid = CAST(? AS INTEGER) LIMIT 1').get(chatId);
        db.close();
        if (row && typeof row.user_name === 'string')
            return row.user_name;
    }
    catch { /* db unavailable */ }
    return '';
}
/** Most recent voice messages (newest first). */
export function recentVoiceMessages(decryptedDir, limit) {
    const dbPath = mediaDbPath(decryptedDir);
    if (!existsSync(dbPath))
        return [];
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
        const rows = db.prepare(`SELECT CAST(chat_name_id AS TEXT) AS c, CAST(local_id AS TEXT) AS l, CAST(svr_id AS TEXT) AS s
       FROM VoiceInfo ORDER BY create_time DESC LIMIT ?`).all(limit);
        return rows.map((r) => {
            const chatId = r.c ?? '';
            const svrId = r.s ?? '';
            const localId = r.l ?? '';
            return { chatId, localId, svrId, username: usernameByChatId(decryptedDir, chatId) };
        });
    }
    finally {
        db.close();
    }
}
/** The raw silk voice_data bytes for a svr_id. */
export function voiceDataBySvr(decryptedDir, svrId) {
    const dbPath = mediaDbPath(decryptedDir);
    if (!existsSync(dbPath))
        return null;
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
        const row = db.prepare('SELECT voice_data FROM VoiceInfo WHERE svr_id = CAST(? AS INTEGER) LIMIT 1').get(svrId);
        db.close();
        if (row?.voice_data instanceof Uint8Array)
            return Buffer.from(row.voice_data);
        return null;
    }
    catch {
        db.close();
        return null;
    }
}
/** VoiceInfo svr_id for (username, local_id) — direct Name2Id mapping. */
export function svrIdByChatLocal(decryptedDir, username, localId) {
    const dbPath = mediaDbPath(decryptedDir);
    if (!existsSync(dbPath))
        return '';
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
        const chat = db.prepare('SELECT rowid FROM Name2Id WHERE user_name = ? LIMIT 1').get(username);
        db.close();
        if (!chat || typeof chat.rowid !== 'number')
            return '';
        const db2 = new DatabaseSync(dbPath, { readOnly: true });
        try {
            const row = db2.prepare('SELECT CAST(svr_id AS TEXT) AS s FROM VoiceInfo WHERE chat_name_id = ? AND local_id = ? LIMIT 1').get(chat.rowid, localId);
            return row?.s ?? '';
        }
        finally {
            db2.close();
        }
    }
    catch {
        return '';
    }
}
/** Resolve the wx_silk decoder binary: env pin, bundled resources, '' when none. */
export function silkDecoderBin() {
    const pinned = process.env.DSH_WECHAT_SILK_BIN;
    if (pinned && pinned.trim().length > 0)
        return pinned.trim();
    try {
        // Walk up from the emitted module (lib or lib/types/query) to the package
        // root and look for resources/win32/x64/wx_silk.exe.
        let dir = fileURLToPath(new URL('.', import.meta.url));
        for (let i = 0; i < 5; i += 1) {
            const candidate = join(dir, 'resources', 'win32', 'x64', 'wx_silk.exe');
            if (existsSync(candidate))
                return candidate;
            const parent = existingParent(dir);
            if (parent === dir)
                break;
            dir = parent;
        }
    }
    catch { /* bundled lookup best-effort */ }
    return '';
}
/** Parent dir that exists (dirname loop guard). */
function existingParent(dir) {
    const parent = dirname(dir);
    return parent === dir ? dir : parent;
}
/**
 * Decode silk bytes to a WAV file via wx_silk (16 kHz mono, whisper-ready).
 * @param silk - raw voice_data bytes (leading 0x02 tolerated).
 * @param wavPath - output WAV path (parent dir created).
 * @returns ok, or an error description.
 */
export function silkToWav(silk, wavPath) {
    const bin = silkDecoderBin();
    if (!bin)
        return { ok: false, error: '未找到 wx_silk 解码器（DSH_WECHAT_SILK_BIN 或打包资源缺失）' };
    const tempDir = dirname(wavPath);
    const silkPath = join(tempDir, `.wx_silk_${process.pid}_${silk.length % 100000}.silk`);
    try {
        mkdirSync(tempDir, { recursive: true });
        writeFileSync(silkPath, silk);
        const res = spawnSync(bin, ['16000', silkPath, wavPath], { encoding: 'utf8', windowsHide: true });
        if (res.status === 0 && existsSync(wavPath))
            return { ok: true };
        return { ok: false, error: (res.stderr || `解码器退出码 ${String(res.status)}`).trim().slice(0, 200) };
    }
    catch (e) {
        return { ok: false, error: e.message };
    }
}
//# sourceMappingURL=voice.js.map