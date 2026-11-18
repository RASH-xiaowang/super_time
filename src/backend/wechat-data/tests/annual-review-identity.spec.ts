/**
 * Regression guard: an old group found only in a message shard must stay a
 * group in annual review. Its 32-char table hash must never enter the private
 * contact ranking or become a navigation id.
 * @vitest-environment node
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { invalidateWechatMeta } from '../src/query/meta.ts'
import { queryAnnualReview } from '../src/query/annual-review-cache.ts'

const scratch: string[] = []

afterEach(() => {
  invalidateWechatMeta()
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
})

function makeDb(path: string, create: (db: DatabaseSync) => void): void {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  try { create(db) } finally { db.close() }
}

describe('annual review legacy group identity', () => {
  it('keeps a shard-only chatroom out of the private ranking', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wx-annual-identity-'))
    scratch.push(root)
    const room = '44626999237@chatroom'
    const hash = createHash('md5').update(room, 'utf8').digest('hex')
    const table = 'Msg_' + hash
    const ts = Math.floor(Date.UTC(2026, 5, 1, 12, 0, 0) / 1000)
    makeDb(join(root, 'message', 'message_0.db'), (db) => {
      db.exec('CREATE TABLE Name2Id (user_name TEXT)')
      db.prepare('INSERT INTO Name2Id VALUES (?)').run(room)
      db.prepare('INSERT INTO Name2Id VALUES (?)').run('wxid_member')
      db.exec(`CREATE TABLE "${table}" (
        local_id INTEGER PRIMARY KEY, create_time INTEGER, local_type INTEGER,
        message_content TEXT, real_sender_id INTEGER
      )`)
      db.prepare(`INSERT INTO "${table}" VALUES (?, ?, ?, ?, ?)`).run(
        1, ts, 1, 'wxid_member:\n群里的消息', 2,
      )
    })

    const review = await queryAnnualReview(root, 2026)
    expect(review.ranking).toEqual([])
    expect(review.groups.top[0]?.username).toBe(room)
    expect(review.groups.top[0]?.username).not.toBe(hash)
    expect(review.highlights.some(row => row.username === hash)).toBe(false)
  })
})
