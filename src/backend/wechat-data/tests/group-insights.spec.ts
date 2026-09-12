/**
 * Offline group insights over a minimal chatroom fixture: member ranks,
 * totals and announcement.
 * @vitest-environment node
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { queryGroupInsights } from '../src/query/group-insights.ts'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
})

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wx-group-'))
  scratch.push(dir)
  return dir
}

function makeDb(path: string, create: (db: DatabaseSync) => void): void {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  try { create(db) } finally { db.close() }
}

describe('queryGroupInsights', () => {
  it('counts messages and ranks members with the announcement', () => {
    const root = tempRoot()
    const room = '@chatroom_g'
    const msgTable = 'Msg_' + createHash('md5').update(room, 'utf8').digest('hex')
    const ts = Math.floor(new Date(2026, 8, 1, 10).getTime() / 1000)
    makeDb(join(root, 'contact', 'contact.db'), (db) => {
      db.exec('CREATE TABLE contact (id INTEGER PRIMARY KEY, username TEXT, remark TEXT, nick_name TEXT)')
      db.prepare('INSERT INTO contact VALUES (?, ?, ?, ?)').run(10, room, '项目群', '@chatroom_g')
      db.prepare('INSERT INTO contact VALUES (?, ?, ?, ?)').run(1, 'wxid_a', '张三', 'zhangsan')
      db.prepare('INSERT INTO contact VALUES (?, ?, ?, ?)').run(2, 'wxid_b', '李四', 'lisi')
      db.exec('CREATE TABLE chatroom_member (room_id INTEGER, member_id INTEGER)')
      db.prepare('INSERT INTO chatroom_member VALUES (?, ?)').run(10, 1)
      db.prepare('INSERT INTO chatroom_member VALUES (?, ?)').run(10, 2)
      db.exec('CREATE TABLE chat_room_info_detail (room_id_ INTEGER, announcement_ TEXT, announcement_publish_time_ INTEGER)')
      db.prepare('INSERT INTO chat_room_info_detail VALUES (?, ?, ?)').run(10, '明天用户评审', ts)
    })
    makeDb(join(root, 'message', 'message_1.db'), (db) => {
      db.exec(`CREATE TABLE "${msgTable}" (local_id INTEGER, create_time INTEGER, local_type INTEGER, message_content TEXT)`)
      db.prepare(`INSERT INTO "${msgTable}" VALUES (?, ?, ?, ?)`).run(1, ts, 1, 'wxid_a:\n你好')
      db.prepare(`INSERT INTO "${msgTable}" VALUES (?, ?, ?, ?)`).run(2, ts, 1, 'wxid_b:\n收到')
      db.prepare(`INSERT INTO "${msgTable}" VALUES (?, ?, ?, ?)`).run(3, ts, 1, 'wxid_a:\n明天提交')
    })

    const snap = queryGroupInsights(root, room)
    expect(snap.name).toBe('项目群')
    expect(snap.memberCount).toBe(2)
    expect(snap.total).toBe(3)
    expect(snap.announcement).toBe('明天用户评审')
    expect(snap.topMembers).toHaveLength(2)
    expect(snap.topMembers[0]?.name).toBe('张三')
    expect(snap.topMembers[0]?.count).toBe(2)
  })
})
