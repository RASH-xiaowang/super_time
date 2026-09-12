/**
 * queryContacts pagination + cache: synthetic contact.db (no group tables).
 * @vitest-environment node
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { queryContacts } from '../src/query/contacts.ts'

const scratch: string[] = []
afterEach(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
  scratch.length = 0
})

/** Contact db at <root>/contact/contact.db; no chat_room/biz_info (skipped). */
function makeContactDb(): string {
  const root = mkdtempSync(join(tmpdir(), 'wx-contacts-'))
  scratch.push(root)
  const dir = join(root, 'contact')
  mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(join(dir, 'contact.db'))
  db.exec(`CREATE TABLE contact (
    id INTEGER, username TEXT, local_type INTEGER, alias TEXT, delete_flag INTEGER,
    remark TEXT, remark_pin_yin_initial TEXT, nick_name TEXT, pin_yin_initial TEXT, quan_pin TEXT,
    big_head_url TEXT, small_head_url TEXT, description TEXT, is_in_chat_room INTEGER
  )`)
  const ins = db.prepare('INSERT INTO contact (id, username, local_type, remark, quan_pin) VALUES (?, ?, ?, ?, ?)')
  ins.run(1, 'u_alice', 1, 'Alice', 'alice')
  ins.run(2, 'u_bob', 1, 'Bob', 'bob')
  ins.run(3, 'g@chatroom', 0, '小组', 'group')
  db.close()
  return root
}

describe('queryContacts', () => {
  it('returns all contacts with total and per-category stats when unpaged', () => {
    const root = makeContactDb()
    const env = queryContacts(root)
    expect(env.total).toBe(3)
    expect(env.contacts.length).toBe(3)
    expect(env.stats.friend).toBe(2)
    expect(env.stats.group).toBe(1)
  })

  it('slices a bounded page while keeping the full total', () => {
    const root = makeContactDb()
    const env = queryContacts(root, { limit: 2, offset: 0 })
    expect(env.total).toBe(3)
    expect(env.contacts.length).toBe(2)
    expect(env.contacts.every(c => c.username !== undefined)).toBe(true)
  })

  it('honours offset for the next page', () => {
    const root = makeContactDb()
    const env = queryContacts(root, { limit: 2, offset: 2 })
    expect(env.total).toBe(3)
    expect(env.contacts.length).toBe(1)
  })
})
