/**
 * WeChat task store: persists extracted todo/reminder items in
 * <data-root>/wechat_tasks.db. Extraction (LLM) lives in the gateway; this
 * module owns the durable CRUD.
 */
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
function dbPath(decryptedDir) {
    return join(dirname(decryptedDir), 'wechat_tasks.db');
}
function openStore(decryptedDir) {
    const db = new DatabaseSync(dbPath(decryptedDir));
    db.exec('CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT \'open\', due_at INTEGER, source_username TEXT NOT NULL DEFAULT \'\', source_local_id INTEGER, message_time INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)');
    return db;
}
function cellStr(v) {
    if (typeof v === 'string')
        return v;
    if (v === null || v === undefined)
        return '';
    if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol')
        return String(v);
    return '';
}
function rowToTask(r) {
    const status = cellStr(r['status'] ?? 'open') === 'done' ? 'done' : 'open';
    const task = {
        id: Number(r['id'] ?? 0),
        title: cellStr(r['title'] ?? ''),
        status,
        createdAt: Number(r['created_at'] ?? 0),
        updatedAt: Number(r['updated_at'] ?? 0),
    };
    if (r['due_at'] != null)
        task.dueAt = Number(r['due_at']);
    if (r['source_username'])
        task.sourceUsername = cellStr(r['source_username']);
    if (r['source_local_id'] != null)
        task.sourceLocalId = Number(r['source_local_id']);
    if (r['message_time'] != null)
        task.messageTime = Number(r['message_time']);
    return task;
}
/** List tasks (newest first). */
export function listTasks(decryptedDir) {
    try {
        const db = openStore(decryptedDir);
        const rows = db.prepare('SELECT * FROM tasks ORDER BY id DESC').all();
        db.close();
        const items = rows.map(rowToTask);
        return { items, total: items.length };
    }
    catch {
        return { items: [], total: 0 };
    }
}
/** Insert one task (extracted or manual). Skips open duplicates by title. */
export function insertTask(decryptedDir, task) {
    try {
        const db = openStore(decryptedDir);
        const exists = db.prepare("SELECT id FROM tasks WHERE title = ? AND status = 'open' LIMIT 1").get(task.title);
        if (exists) {
            db.close();
            return { ok: false, error: '已存在同名待办' };
        }
        const ts = Date.now();
        const r = db.prepare('INSERT INTO tasks(title, status, due_at, source_username, source_local_id, message_time, created_at, updated_at) VALUES (?, \'open\', ?, ?, ?, ?, ?, ?)').run(task.title, task.dueAt ?? null, task.sourceUsername ?? '', task.sourceLocalId ?? null, task.messageTime ?? null, ts, ts);
        const id = Number(r.lastInsertRowid);
        db.close();
        return { ok: true, id };
    }
    catch (e) {
        return { ok: false, error: e.message };
    }
}
/** Set task status ('open' | 'done'). */
export function setTaskStatus(decryptedDir, id, status) {
    try {
        const db = openStore(decryptedDir);
        const r = db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), id);
        db.close();
        return { ok: r.changes > 0, id };
    }
    catch (e) {
        return { ok: false, error: e.message };
    }
}
/** Delete a task. */
export function deleteTask(decryptedDir, id) {
    try {
        const db = openStore(decryptedDir);
        const r = db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
        db.close();
        return { ok: r.changes > 0, id };
    }
    catch (e) {
        return { ok: false, error: e.message };
    }
}
//# sourceMappingURL=wechat-tasks.js.map