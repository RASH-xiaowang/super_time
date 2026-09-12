/**
 * queryOverview aggregate over a minimal decrypted fixture: revoked-message
 * counts must be summed across every message shard (the cache table can live
 * in any shard), and the aggregate must recompute when a shard is rewritten.
 * @vitest-environment node
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { queryOverview } from '../src/query/overview.ts'
import { invalidateWechatMeta } from '../src/query/meta.ts'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
})

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wx-overview-'))
  scratch.push(dir)
  return dir
}

function makeDb(path: string, create: (db: DatabaseSync) => void): void {
  mkdirSync(join(path, '..'), { recursive: true })
  const db = new DatabaseSync(path)
  try { create(db) } finally { db.close() }
}

function seedRoot(root: string, revoked: number): void {
  makeDb(join(root, 'contact', 'contact.db'), (db) => {
    db.exec('CREATE TABLE contact (id INTEGER, username TEXT, local_type INTEGER, remark TEXT, nick_name TEXT, quan_pin TEXT)')
    const ins = db.prepare('INSERT INTO contact (id, username, local_type, remark, quan_pin) VALUES (?, ?, ?, ?, ?)')
    ins.run(1, 'u_alice', 1, 'Alice', 'alice')
    ins.run(2, 'u_bob', 1, 'Bob', 'bob')
  })
  makeDb(join(root, 'session', 'session.db'), (db) => {
    db.exec('CREATE TABLE SessionTable (id INTEGER PRIMARY KEY, username TEXT)')
    db.prepare('INSERT INTO SessionTable (username) VALUES (?)').run('u_alice')
    db.prepare('INSERT INTO SessionTable (username) VALUES (?)').run('u_bob')
  })
  makeDb(join(root, 'sns', 'sns.db'), (db) => {
    db.exec('CREATE TABLE SnsTimeLine (id INTEGER PRIMARY KEY, user_name TEXT, content TEXT)')
    db.prepare('INSERT INTO SnsTimeLine (user_name, content) VALUES (?, ?)').run('u_alice', '<TimelineObject><nickname>Alice</nickname></TimelineObject>')
  })
  // 撤回缓存表落在 message_1.db（非 message_0.db），验证跨分片求和。
  makeDb(join(root, 'message', 'message_1.db'), (db) => {
    db.exec('CREATE TABLE _weflow_anti_revoke_deleted_cache (id INTEGER PRIMARY KEY, data TEXT)')
    const ins = db.prepare('INSERT INTO _weflow_anti_revoke_deleted_cache (data) VALUES (?)')
    for (let i = 0; i < revoked; i += 1) ins.run('x' + String(i))
  })
  makeDb(join(root, 'message', 'message_2.db'), (db) => {
    db.exec('CREATE TABLE Msg_00000000000000000000000000000000 (local_id INTEGER)')
  })
}

describe('queryOverview', () => {
  it('sums revoked counts across all message shards', () => {
    const root = tempRoot()
    seedRoot(root, 3)
    const snap = queryOverview(root)
    expect(snap.revoked).toBe(3)
    expect(snap.sessions).toBe(2)
    expect(snap.contacts).toBe(2)
    expect(snap.moments).toBe(1)
  })

  it('recomputes the aggregate after a shard is rewritten', () => {
    const root = tempRoot()
    seedRoot(root, 3)
    expect(queryOverview(root).revoked).toBe(3)
    // 重写 message_1.db：指纹变化，下一次查询必须重新聚合而不是吃旧缓存。
    rmSync(join(root, 'message', 'message_1.db'))
    makeDb(join(root, 'message', 'message_1.db'), (db) => {
      db.exec('CREATE TABLE _weflow_anti_revoke_deleted_cache (id INTEGER PRIMARY KEY, data TEXT)')
      const ins = db.prepare('INSERT INTO _weflow_anti_revoke_deleted_cache (data) VALUES (?)')
      for (let i = 0; i < 5; i += 1) ins.run('y' + String(i))
    })
    expect(queryOverview(root).revoked).toBe(5)
  })

  it('invalidateWechatMeta drops the aggregate cache', () => {
    const root = tempRoot()
    seedRoot(root, 2)
    expect(queryOverview(root).revoked).toBe(2)
    invalidateWechatMeta()
    expect(queryOverview(root).revoked).toBe(2)
  })
})
