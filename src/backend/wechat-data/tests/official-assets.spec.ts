/**
 * Official account assets over a minimal fixture: gh_* session counts and
 * article-type detection.
 * @vitest-environment node
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { queryOfficialAssets } from '../src/query/official-assets.ts'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
})

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wx-official-'))
  scratch.push(dir)
  return dir
}

function makeDb(path: string, create: (db: DatabaseSync) => void): void {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  try { create(db) } finally { db.close() }
}

describe('queryOfficialAssets', () => {
  it('counts gh_* messages and articles', () => {
    const root = tempRoot()
    const gh = 'gh_abc'
    const ghTable = 'Msg_' + createHash('md5').update(gh, 'utf8').digest('hex')
    const wxidTable = 'Msg_' + createHash('md5').update('wxid_x', 'utf8').digest('hex')
    const ts = Math.floor(new Date(2026, 8, 1).getTime() / 1000)
    makeDb(join(root, 'session', 'session.db'), (db) => {
      db.exec('CREATE TABLE SessionTable (username TEXT)')
      db.prepare('INSERT INTO SessionTable VALUES (?)').run(gh)
      db.prepare('INSERT INTO SessionTable VALUES (?)').run('wxid_x')
    })
    makeDb(join(root, 'message', 'message_1.db'), (db) => {
      db.exec(`CREATE TABLE "${ghTable}" (local_id INTEGER, create_time INTEGER, local_type INTEGER)`)
      db.prepare(`INSERT INTO "${ghTable}" VALUES (?, ?, ?)`).run(1, ts, 49)
      db.prepare(`INSERT INTO "${ghTable}" VALUES (?, ?, ?)`).run(2, ts, 1)
      db.exec(`CREATE TABLE "${wxidTable}" (local_id INTEGER, create_time INTEGER, local_type INTEGER)`)
      db.prepare(`INSERT INTO "${wxidTable}" VALUES (?, ?, ?)`).run(1, ts, 1)
    })

    const snap = queryOfficialAssets(root)
    expect(snap.rows).toHaveLength(1)
    expect(snap.rows[0]?.username).toBe(gh)
    expect(snap.rows[0]?.messages).toBe(2)
    expect(snap.rows[0]?.articles).toBe(1)
    expect(snap.rows[0]?.lastArticleTime).toBe(ts)
  })
})
