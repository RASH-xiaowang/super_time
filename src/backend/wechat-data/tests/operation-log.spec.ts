/**
 * Operation-log store: append-only metadata records + filtered reads + clear.
 * @vitest-environment node
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { clearOperationLog, listOperations, recordOperation } from '../src/query/operation-log.ts'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch { /* best-effort Windows cleanup */ }
  }
  scratch.length = 0
})

function root(): string {
  const base = mkdtempSync(join(tmpdir(), 'wx-oplog-'))
  scratch.push(base)
  const dir = join(base, 'decrypted')
  mkdirSync(dir)
  return dir
}

/** A decrypted path whose parent is a regular file: any store open must fail. */
function brokenRoot(): string {
  const base = mkdtempSync(join(tmpdir(), 'wx-oplog-'))
  scratch.push(base)
  const blocker = join(base, 'blocker')
  writeFileSync(blocker, '')
  return join(blocker, 'decrypted')
}

describe('operation log store', () => {
  it('records rows (auto + explicit ts) and reads them newest-first', () => {
    const dir = root()
    recordOperation(dir, { category: 'settings', action: 'save_wechat_config', target: '', status: 'ok', detail: 'config' })
    recordOperation(dir, { category: 'export', action: 'export_session_messages', target: '张三', status: 'ok', detail: '3 条', ts: 111 })
    recordOperation(dir, { category: 'error', action: 'decrypt_failed', target: '', status: 'fail', detail: 'bad key' })

    const snap = listOperations(dir)
    expect(snap.total).toBe(3)
    // newest first: error(3), export(2), settings(1)
    expect(snap.items[0]?.category).toBe('error')
    expect(snap.items[1]?.ts).toBe(111)
    expect(snap.items[1]?.target).toBe('张三')
  })

  it('filters by range, status and validated categories', () => {
    const dir = root()
    recordOperation(dir, { category: 'settings', action: 'save_wechat_config', target: '', status: 'ok', detail: 'a', ts: 100 })
    recordOperation(dir, { category: 'export', action: 'export_csv', target: '', status: 'ok', detail: 'b', ts: 200 })
    recordOperation(dir, { category: 'delete', action: 'delete_backup', target: 'b1', status: 'fail', detail: 'c', ts: 300 })

    expect(listOperations(dir, { from: 150, to: 250 }).items).toHaveLength(1)
    expect(listOperations(dir, { status: 'fail' }).items).toHaveLength(1)
    // invalid category 'bogus' is dropped; valid ones apply.
    const cats = listOperations(dir, { categories: ['export', 'bogus', 'delete'] })
    expect(cats.total).toBe(2)
    // empty category list -> no category filter.
    expect(listOperations(dir, { categories: [] }).total).toBe(3)
  })

  it('clamps the page limit between 1 and the max', () => {
    const dir = root()
    recordOperation(dir, { category: 'settings', action: 'a', target: '', status: 'ok', detail: '', ts: 1 })
    recordOperation(dir, { category: 'settings', action: 'b', target: '', status: 'ok', detail: '', ts: 2 })
    // negative -> 1
    expect(listOperations(dir, { limit: -5 }).items).toHaveLength(1)
    // zero -> 1
    expect(listOperations(dir, { limit: 0 }).items).toHaveLength(1)
    // huge -> clamped to max (still returns all 2 here)
    expect(listOperations(dir, { limit: 999999 }).items).toHaveLength(2)
  })

  it('coerces malformed DB rows to safe defaults', () => {
    const dir = root()
    // creates the schema first
    recordOperation(dir, { category: 'settings', action: 'seed', target: '', status: 'ok', detail: '', ts: 5 })
    const db = new DatabaseSync(join(dirname(dir), 'wechat_privacy.db'))
    db.exec("INSERT INTO operation_log(ts, category, action, target, status, detail) VALUES (1, 'bogus', NULL, NULL, 'bogus', NULL)")
    db.close()

    const snap = listOperations(dir)
    const row = snap.items[0]!
    expect(row.category).toBe('error')
    expect(row.status).toBe('fail')
    expect(row.action).toBe('')
    expect(row.target).toBe('')
  })

  it('clears the log and reports the removed count', () => {
    const dir = root()
    recordOperation(dir, { category: 'settings', action: 'a', target: '', status: 'ok', detail: '', ts: 1 })
    recordOperation(dir, { category: 'export', action: 'b', target: '', status: 'ok', detail: '', ts: 2 })
    const cleared = clearOperationLog(dir)
    expect(cleared.ok).toBe(true)
    expect(cleared.removed).toBe(2)
    expect(listOperations(dir).total).toBe(0)
  })

  it('stays best-effort when the store cannot be opened', () => {
    const bad = brokenRoot()
    expect(() =>{  recordOperation(bad, { category: 'settings', action: 'a', target: '', status: 'ok', detail: '' }) }).not.toThrow()
    expect(listOperations(bad)).toEqual({ items: [], total: 0 })
    expect(clearOperationLog(bad)).toEqual({ ok: false, removed: 0 })
  })
})
