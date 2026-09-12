/**
 * Contact 360° profile over a minimal decrypted fixture: message stats,
 * moments count, fund rows, and shared groups.
 * @vitest-environment node
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { queryContact360 } from '../src/query/contact360.ts'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
})

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wx-c360-'))
  scratch.push(dir)
  return dir
}

function makeDb(path: string, create: (db: DatabaseSync) => void): void {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  try { create(db) } finally { db.close() }
}

describe('queryContact360', () => {
  it('aggregates messages, moments, funds, and shared groups', () => {
    const root = tempRoot()
    const msgTable = 'Msg_' + createHash('md5').update('wxid_a', 'utf8').digest('hex')
    makeDb(join(root, 'contact', 'contact.db'), (db) => {
      db.exec('CREATE TABLE contact (id INTEGER PRIMARY KEY, username TEXT, remark TEXT, nick_name TEXT)')
      db.prepare('INSERT INTO contact VALUES (?, ?, ?, ?)').run(1, 'wxid_a', '张三', 'zhangsan')
      db.exec('CREATE TABLE chat_room (id INTEGER PRIMARY KEY, username TEXT, owner TEXT)')
      db.prepare('INSERT INTO chat_room VALUES (?, ?, ?)').run(10, '@chatroom_group', '')
      db.exec('CREATE TABLE chatroom_member (room_id INTEGER, member_id INTEGER)')
      db.prepare('INSERT INTO chatroom_member VALUES (?, ?)').run(10, 1)
    })
    makeDb(join(root, 'general', 'general.db'), (db) => {
      db.exec('CREATE TABLE transferTable (session_name TEXT)')
      db.prepare('INSERT INTO transferTable VALUES (?)').run('wxid_a')
      db.exec('CREATE TABLE redEnvelopeTable (session_name TEXT)')
      db.prepare('INSERT INTO redEnvelopeTable VALUES (?)').run('wxid_a')
    })
    makeDb(join(root, 'sns', 'db_sns', 'sns.db'), (db) => {
      db.exec('CREATE TABLE SnsTimeLine (tid INTEGER, user_name TEXT, content TEXT)')
      db.prepare('INSERT INTO SnsTimeLine VALUES (?, ?, ?)').run(1, 'wxid_a', '<desc>a</desc>')
      db.prepare('INSERT INTO SnsTimeLine VALUES (?, ?, ?)').run(2, 'wxid_a', '<desc>b</desc>')
    })
    makeDb(join(root, 'message', 'message_1.db'), (db) => {
      db.exec(`CREATE TABLE "${msgTable}" (local_id INTEGER, create_time INTEGER, local_type INTEGER)`)
      db.prepare(`INSERT INTO "${msgTable}" VALUES (?, ?, ?)`).run(1, 100, 1)
      db.prepare(`INSERT INTO "${msgTable}" VALUES (?, ?, ?)`).run(2, 200, 1)
      db.prepare(`INSERT INTO "${msgTable}" VALUES (?, ?, ?)`).run(3, 300, 1)
    })

    const snap = queryContact360(root, 'wxid_a')
    expect(snap.displayName).toBe('张三')
    expect(snap.messages.count).toBe(3)
    expect(snap.messages.firstTime).toBe(100)
    expect(snap.messages.lastTime).toBe(300)
    expect(snap.moments.count).toBe(2)
    expect(snap.funds.transfers).toBe(1)
    expect(snap.funds.redpackets).toBe(1)
    expect(snap.commonGroups).toHaveLength(1)
    expect(snap.commonGroups[0]?.username).toBe('@chatroom_group')
    expect(snap.commonGroups[0]?.memberCount).toBe(1)
  })
})
