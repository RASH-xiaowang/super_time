/**
 * Period summary collection over a minimal message fixture: shared range
 * collection backs both day and period APIs.
 * @vitest-environment node
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { collectDayMessages, collectPeriodLinesWithSources, collectPeriodMessages } from '../src/query/daily-summary.ts'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
})

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wx-period-'))
  scratch.push(dir)
  return dir
}

function makeDb(path: string, create: (db: DatabaseSync) => void): void {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  try { create(db) } finally { db.close() }
}

describe('collectPeriodMessages', () => {
  it('collects an inclusive range and reuses the same stats as the daily path', () => {
    const root = tempRoot()
    const msgTable = 'Msg_' + createHash('md5').update('wxid_a', 'utf8').digest('hex')
    const t1 = Math.floor(new Date(2026, 8, 1, 10).getTime() / 1000)
    const t2 = Math.floor(new Date(2026, 8, 2, 11).getTime() / 1000)
    makeDb(join(root, 'session', 'session.db'), (db) => {
      db.exec('CREATE TABLE SessionTable (username TEXT)')
      db.prepare('INSERT INTO SessionTable VALUES (?)').run('wxid_a')
    })
    makeDb(join(root, 'message', 'message_1.db'), (db) => {
      db.exec(`CREATE TABLE "${msgTable}" (local_id INTEGER, create_time INTEGER, local_type INTEGER, message_content TEXT)`)
      db.prepare(`INSERT INTO "${msgTable}" VALUES (?, ?, ?, ?)`).run(1, t1, 1, '你好，这是第一天')
      db.prepare(`INSERT INTO "${msgTable}" VALUES (?, ?, ?, ?)`).run(2, t2, 1, '第二天继续聊')
    })

    const period = collectPeriodMessages(root, '2026-09-01', '2026-09-02')
    expect(period.total).toBe(2)
    expect(period.sessions).toBe(1)
    expect(period.lines.some(l => l.includes('你好'))).toBe(true)
    expect(period.lines.some(l => l.includes('第二天'))).toBe(true)

    const day = collectDayMessages(root, '2026-09-01')
    expect(day.total).toBe(1)
  })

  it('returns per-message sources for task provenance', () => {
    const root = tempRoot()
    const msgTable = 'Msg_' + createHash('md5').update('wxid_a', 'utf8').digest('hex')
    const ts = Math.floor(new Date(2026, 8, 1, 10).getTime() / 1000)
    makeDb(join(root, 'session', 'session.db'), (db) => {
      db.exec('CREATE TABLE SessionTable (username TEXT)')
      db.prepare('INSERT INTO SessionTable VALUES (?)').run('wxid_a')
    })
    makeDb(join(root, 'message', 'message_1.db'), (db) => {
      db.exec(`CREATE TABLE "${msgTable}" (local_id INTEGER, create_time INTEGER, local_type INTEGER, message_content TEXT)`)
      db.prepare(`INSERT INTO "${msgTable}" VALUES (?, ?, ?, ?)`).run(7, ts, 1, '记得周五交报告')
    })

    const r = collectPeriodLinesWithSources(root, '2026-09-01', '2026-09-02')
    expect(r.sources).toHaveLength(1)
    expect(r.sources[0]?.username).toBe('wxid_a')
    expect(r.sources[0]?.localId).toBe(7)
    expect(r.sources[0]?.text).toContain('周五')
  })
})
