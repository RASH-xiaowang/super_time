/**
 * Session draft clearing, rewritten from st_control handlers/session.rs
 * clear_session_draft / clear_all_session_drafts. Writes to the decrypted
 * session.db copy only (the WeChat source is untouched).
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
/** Open the decrypted session.db read-write. */
function openSessionDb(decryptedDir) {
    const p = join(decryptedDir, 'session', 'session.db');
    if (!existsSync(p))
        return null;
    try {
        return new DatabaseSync(p);
    }
    catch {
        return null;
    }
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
/** Decode a draft cell (TEXT or BLOB). */
function draftText(v) {
    if (v === null || v === undefined)
        return '';
    if (typeof v === 'string')
        return v;
    if (v instanceof Uint8Array)
        return new TextDecoder('utf-8', { fatal: false }).decode(v);
    if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol')
        return String(v);
    return '';
}
/**
 * Clear one session draft (decrypted copy only).
 * @param decryptedDir - decrypted data root.
 * @param username - session username whose draft is cleared.
 * @returns ok + rows updated.
 */
export function clearSessionDraft(decryptedDir, username) {
    const db = openSessionDb(decryptedDir);
    if (!db)
        return { ok: false, updated: 0, error: '解密 session.db 不存在' };
    try {
        const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='SessionTable'").get() !== undefined;
        if (!has) {
            db.close();
            return { ok: false, updated: 0, error: 'SessionTable 不存在' };
        }
        const r = db.prepare('UPDATE SessionTable SET draft = ? WHERE username = ?').run('', username);
        return { ok: true, updated: Number(r.changes) };
    }
    catch (e) {
        return { ok: false, updated: 0, error: e.message };
    }
    finally {
        db.close();
    }
}
/**
 * Clear all session drafts, returning the cleared drafts list.
 * @param decryptedDir - decrypted data root.
 * @returns cleared drafts + count.
 */
export function clearAllSessionDrafts(decryptedDir) {
    const db = openSessionDb(decryptedDir);
    if (!db)
        return { ok: false, cleared: [], count: 0, error: '解密 session.db 不存在' };
    try {
        const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='SessionTable'").get() !== undefined;
        if (!has) {
            db.close();
            return { ok: false, cleared: [], count: 0, error: 'SessionTable 不存在' };
        }
        const rows = db.prepare('SELECT username, draft FROM SessionTable WHERE draft IS NOT NULL AND length(draft) > 0').all();
        const cleared = rows.map(r => ({ username: cellStr(r['username'] ?? ''), draft: draftText(r['draft']) }));
        db.prepare('UPDATE SessionTable SET draft = ? WHERE draft IS NOT NULL AND length(draft) > 0').run('');
        return { ok: true, cleared, count: cleared.length };
    }
    catch (e) {
        return { ok: false, cleared: [], count: 0, error: e.message };
    }
    finally {
        db.close();
    }
}
//# sourceMappingURL=drafts.js.map