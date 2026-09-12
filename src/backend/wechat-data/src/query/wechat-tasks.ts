/**
 * WeChat task store: persists extracted todo/reminder items in
 * <data-root>/wechat_tasks.db.
 *
 * ⚠️ 提取是**纯本地**的：gateway 的 `extractTasks` 用正则
 * （`记得|待办|要做|提醒|别忘了|稍后|待处理|deadline`）逐行匹配，全程不调用模型、不出网。
 * 这里原写作「Extraction (LLM) lives in the gateway」，是与实现不符的注释 ——
 * 第 59 轮做隐私名单时按它把「待办提取」列进了出网功能，实际并不会出网（已改正）。
 * 本模块只负责持久 CRUD。
 */
import { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'
import type { TasksSnapshot, TaskMutationResult, WechatTask } from '../types.ts'

function dbPath(decryptedDir: string): string {
  return join(dirname(decryptedDir), 'wechat_tasks.db')
}

function openStore(decryptedDir: string): DatabaseSync {
  const db = new DatabaseSync(dbPath(decryptedDir))
  db.exec('CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT \'open\', due_at INTEGER, source_username TEXT NOT NULL DEFAULT \'\', source_local_id INTEGER, message_time INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)')
  return db
}

function cellStr(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === null || v === undefined) return ''
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol') return String(v)
  return ''
}

function rowToTask(r: Record<string, unknown>): WechatTask {
  const status = cellStr(r['status'] ?? 'open') === 'done' ? 'done' : 'open'
  const task: WechatTask = {
    id: Number(r['id'] ?? 0),
    title: cellStr(r['title'] ?? ''),
    status,
    createdAt: Number(r['created_at'] ?? 0),
    updatedAt: Number(r['updated_at'] ?? 0),
  }
  if (r['due_at'] != null) task.dueAt = Number(r['due_at'])
  if (r['source_username']) task.sourceUsername = cellStr(r['source_username'])
  if (r['source_local_id'] != null) task.sourceLocalId = Number(r['source_local_id'])
  if (r['message_time'] != null) task.messageTime = Number(r['message_time'])
  return task
}

/** List tasks (newest first). */
export function listTasks(decryptedDir: string): TasksSnapshot {
  try {
    const db = openStore(decryptedDir)
    const rows = db.prepare('SELECT * FROM tasks ORDER BY id DESC').all() as Array<Record<string, unknown>>
    db.close()
    const items = rows.map(rowToTask)
    return { items, total: items.length }
  } catch {
    return { items: [], total: 0 }
  }
}

/** Insert one task (extracted or manual). Skips open duplicates by title. */
export function insertTask(
  decryptedDir: string,
  task: { title: string; dueAt?: number; sourceUsername?: string; sourceLocalId?: number; messageTime?: number },
): TaskMutationResult {
  try {
    const db = openStore(decryptedDir)
    const exists = db.prepare("SELECT id FROM tasks WHERE title = ? AND status = 'open' LIMIT 1").get(task.title)
    if (exists) {
      db.close()
      return { ok: false, error: '已存在同名待办' }
    }
    const ts = Date.now()
    const r = db.prepare('INSERT INTO tasks(title, status, due_at, source_username, source_local_id, message_time, created_at, updated_at) VALUES (?, \'open\', ?, ?, ?, ?, ?, ?)').run(
      task.title, task.dueAt ?? null, task.sourceUsername ?? '', task.sourceLocalId ?? null, task.messageTime ?? null, ts, ts,
    )
    const id = Number(r.lastInsertRowid)
    db.close()
    return { ok: true, id }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** Set task status ('open' | 'done'). */
export function setTaskStatus(decryptedDir: string, id: number, status: 'open' | 'done'): TaskMutationResult {
  try {
    const db = openStore(decryptedDir)
    const r = db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), id)
    db.close()
    return { ok: r.changes > 0, id }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** Delete a task. */
export function deleteTask(decryptedDir: string, id: number): TaskMutationResult {
  try {
    const db = openStore(decryptedDir)
    const r = db.prepare('DELETE FROM tasks WHERE id = ?').run(id)
    db.close()
    return { ok: r.changes > 0, id }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}
