/**
 * Native WeChat reminders (handoff_remind_v0) access: defensive column probe
 * plus import into the plugin task store with title dedupe.
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { HandoffRemindsSnapshot, TaskMutationResult } from '../types.ts'
import { insertTask } from './wechat-tasks.ts'

function tableColumns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return new Set(rows.map(r => r.name))
}

function cellStr(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === null || v === undefined) return ''
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol') return String(v)
  return ''
}

/** Resolve column names for a DB. */
function resolveColumns(cols: Set<string>): { id: string; title: string; time: string } {
  const id = ['local_id', 'id', 'item_id', 'record_id', 'rowid'].find(c => cols.has(c)) ?? ''
  const title = ['content', 'item_content', 'text', 'title', 'msg_content', 'des'].find(c => cols.has(c)) ?? ''
  const time = ['time', 'create_time', 'alert_time', 'ts', 'remind_time'].find(c => cols.has(c)) ?? ''
  return { id, title, time }
}

/**
 * List native WeChat reminders.
 * @param decryptedDir - decrypted data root.
 * @returns the native reminder snapshot.
 */
export function listHandoffReminds(decryptedDir: string): HandoffRemindsSnapshot {
  const p = join(decryptedDir, 'general', 'general.db')
  if (!existsSync(p)) return { items: [], total: 0 }
  try {
    const db = new DatabaseSync(p, { readOnly: true })
    const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='handoff_remind_v0'").get() !== undefined
    if (!has) { db.close(); return { items: [], total: 0 } }
    const cols = tableColumns(db, 'handoff_remind_v0')
    const { id, title, time } = resolveColumns(cols)
    if (!id || !title) { db.close(); return { items: [], total: 0 } }
    const rows = db.prepare(`SELECT ${id} AS i, ${title} AS t, ${time || '0'} AS tm FROM handoff_remind_v0 LIMIT 500`).all() as Array<{ i: unknown; t: unknown; tm?: unknown }>
    db.close()
    const items = rows
      .map(r => ({ id: Number(r.i ?? 0), title: cellStr(r.t).trim(), time: Number(r.tm ?? 0) || null }))
      .filter(r => r.title)
    return { items, total: items.length }
  } catch {
    return { items: [], total: 0 }
  }
}

/**
 * Import native reminders into the plugin task store (deduped by title).
 * @param decryptedDir - decrypted data root.
 * @returns mutation result with added count.
 */
export function importHandoffTasks(decryptedDir: string): TaskMutationResult {
  const snap = listHandoffReminds(decryptedDir)
  let added = 0
  for (const item of snap.items) {
    const r = insertTask(decryptedDir, {
      title: item.title,
      ...(item.time !== null ? { dueAt: item.time * 1000 } : {}),
      ...(item.time !== null ? { messageTime: item.time } : {}),
    })
    if (r.ok) added += 1
  }
  return { ok: true, added }
}
