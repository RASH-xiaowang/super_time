/**
 * Native WeChat reminder access: list + import into the plugin task store with
 * title dedupe.
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { importHandoffTasks, listHandoffReminds } from '../src/query/handoff.ts'
import { listTasks } from '../src/query/wechat-tasks.ts'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
})

function tempRoot(): string {
  const base = mkdtempSync(join(tmpdir(), 'wx-handoff-'))
  scratch.push(base)
  const dir = join(base, 'decrypted')
  mkdirSync(dir)
  return dir
}

function makeDb(path: string, create: (db: DatabaseSync) => void): void {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  try { create(db) } finally { db.close() }
}

describe('handoff reminders', () => {
  it('lists native reminders and imports them deduped', () => {
    const root = tempRoot()
    const ts = Math.floor(new Date(2026, 8, 1).getTime() / 1000)
    makeDb(join(root, 'general', 'general.db'), (db) => {
      db.exec('CREATE TABLE handoff_remind_v0 (local_id INTEGER, content TEXT, time INTEGER)')
      db.prepare('INSERT INTO handoff_remind_v0 VALUES (?, ?, ?)').run(1, '周五交报告', ts)
      db.prepare('INSERT INTO handoff_remind_v0 VALUES (?, ?, ?)').run(2, '明天十点开会', ts + 1)
    })

    const snap = listHandoffReminds(root)
    expect(snap.total).toBe(2)
    expect(snap.items[0]?.title).toBe('周五交报告')

    const first = importHandoffTasks(root)
    expect(first.added).toBe(2)
    const second = importHandoffTasks(root)
    expect(second.added).toBe(0)
    expect(listTasks(root).total).toBe(2)
  })
})
