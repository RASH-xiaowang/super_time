/**
 * Operation log for the WeChat data panel: append-only records of the work
 * this app performs (settings, keys, sync, exports, deletes, backups, edits,
 * tasks) plus the failures it observes. Entries carry metadata only — never
 * message bodies, image or file contents — so an export is safe to share.
 * Persisted in the same <data-root>/wechat_privacy.db as the privacy audit
 * log.
 */
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
/** Categories accepted from the client; anything else is dropped by the filter. */
const CATEGORIES = ['settings', 'keys', 'sync', 'export', 'delete', 'backup', 'edit', 'task', 'error'];
const ALLOWED_CATEGORIES = new Set(CATEGORIES);
/** Valid result statuses. */
const STATUSES = ['ok', 'fail', 'skip'];
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5000;
function dbPath(decryptedDir) {
    return join(dirname(decryptedDir), 'wechat_privacy.db');
}
function openStore(decryptedDir) {
    const db = new DatabaseSync(dbPath(decryptedDir));
    db.exec('CREATE TABLE IF NOT EXISTS operation_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, category TEXT NOT NULL, action TEXT, target TEXT, status TEXT NOT NULL, detail TEXT)');
    db.exec('CREATE INDEX IF NOT EXISTS operation_log_ts ON operation_log(ts)');
    return db;
}
/** Append one operation row. Best-effort: a logging failure never breaks the operation it records. */
export function recordOperation(decryptedDir, entry) {
    try {
        const db = openStore(decryptedDir);
        db.prepare('INSERT INTO operation_log(ts, category, action, target, status, detail) VALUES (?, ?, ?, ?, ?, ?)')
            .run(entry.ts ?? Date.now(), entry.category, entry.action, entry.target, entry.status, entry.detail);
        db.close();
    }
    catch { /* operation log is best-effort */ }
}
/** Build the WHERE clause + bound params for one query, from its optional filters. */
function whereClause(query) {
    const clauses = [];
    const params = [];
    if (query.from !== undefined) {
        clauses.push('ts >= ?');
        params.push(query.from);
    }
    if (query.to !== undefined) {
        clauses.push('ts <= ?');
        params.push(query.to);
    }
    if (query.status !== undefined) {
        clauses.push('status = ?');
        params.push(query.status);
    }
    const categories = (query.categories ?? []).filter(c => ALLOWED_CATEGORIES.has(c));
    if (categories.length > 0) {
        clauses.push('category IN (' + categories.map(() => '?').join(', ') + ')');
        params.push(...categories);
    }
    return { sql: clauses.length > 0 ? ' WHERE ' + clauses.join(' AND ') : '', params };
}
function str(v) {
    return typeof v === 'string' ? v : '';
}
function asCategory(v) {
    return CATEGORIES.find(c => c === v) ?? 'error';
}
function asStatus(v) {
    return STATUSES.find(s => s === v) ?? 'fail';
}
function toEntry(r) {
    /* v8 ignore next -- id is the AUTOINCREMENT primary key; a stored row always has it. */
    const id = Number(r['id'] ?? 0);
    /* v8 ignore next -- ts is a NOT NULL column; a stored row always has it. */
    const ts = Number(r['ts'] ?? 0);
    return {
        id,
        ts,
        category: asCategory(r['category']),
        action: str(r['action']),
        target: str(r['target']),
        status: asStatus(r['status']),
        detail: str(r['detail']),
    };
}
/**
 * Read matching operation rows, newest first. `total` counts every match,
 * ignoring `limit`.
 * @param decryptedDir - decrypted WeChat data root.
 * @param query - optional time-range / category / status / limit filters.
 * @returns OperationLogSnapshot: matching items + full match count.
 */
export function listOperations(decryptedDir, query = {}) {
    const { sql, params } = whereClause(query);
    const limit = Math.min(Math.max(Math.floor(query.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
    const offset = Math.max(Math.floor(query.offset ?? 0), 0);
    try {
        const db = openStore(decryptedDir);
        const countRow = db.prepare('SELECT COUNT(*) AS n FROM operation_log' + sql).get(...params);
        const rows = db.prepare('SELECT id, ts, category, action, target, status, detail FROM operation_log' + sql + ' ORDER BY id DESC LIMIT ? OFFSET ?')
            .all(...params, limit, offset);
        db.close();
        /* v8 ignore next -- COUNT(*) always returns exactly one row, so countRow and its n are defined. */
        return { items: rows.map(toEntry), total: countRow?.n ?? 0 };
    }
    catch {
        return { items: [], total: 0 };
    }
}
/**
 * Delete all operation-log rows.
 * @param decryptedDir - decrypted WeChat data root.
 * @returns OperationLogClearResult: ok + removed row count.
 */
export function clearOperationLog(decryptedDir) {
    try {
        const db = openStore(decryptedDir);
        const r = db.prepare('DELETE FROM operation_log').run();
        db.close();
        return { ok: true, removed: Number(r.changes) };
    }
    catch {
        return { ok: false, removed: 0 };
    }
}
//# sourceMappingURL=operation-log.js.map