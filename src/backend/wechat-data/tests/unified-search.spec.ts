/**
 * Unified search over a minimal decrypted fixture: contacts, moments,
 * favorites, files, and records hit different domains for one query term.
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { searchUnified } from '../src/query/unified-search.ts'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
})

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wx-search-'))
  scratch.push(dir)
  return dir
}

function makeDb(path: string, create: (db: DatabaseSync) => void): void {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  try { create(db) } finally { db.close() }
}

describe('searchUnified', () => {
  it('returns typed hits per domain for a matching term', () => {
    const root = tempRoot()
    makeDb(join(root, 'contact', 'contact.db'), (db) => {
      db.exec('CREATE TABLE contact (id INTEGER PRIMARY KEY, username TEXT, remark TEXT, nick_name TEXT, alias TEXT, quan_pin TEXT)')
      db.prepare('INSERT INTO contact VALUES (?, ?, ?, ?, ?, ?)').run(1, 'wxid_a', '张三', 'zhangsan', '', 'zhangsan')
    })
    makeDb(join(root, 'sns', 'db_sns', 'sns.db'), (db) => {
      db.exec('CREATE TABLE SnsTimeLine (tid INTEGER, user_name TEXT, content TEXT)')
      db.prepare('INSERT INTO SnsTimeLine VALUES (?, ?, ?)').run(1, 'wxid_a', '<desc>wxid_a 的朋友圈</desc>')
    })
    makeDb(join(root, 'favorite', 'favorite.db'), (db) => {
      db.exec('CREATE TABLE fav_db_item (local_id INTEGER, content TEXT)')
      db.prepare('INSERT INTO fav_db_item VALUES (?, ?)').run(1, '<desc>wxid_a 收藏</desc>')
    })
    makeDb(join(root, 'hardlink', 'hardlink.db'), (db) => {
      db.exec('CREATE TABLE file_hardlink_info_v4 (file_name TEXT, md5 TEXT, file_size INTEGER)')
      db.prepare('INSERT INTO file_hardlink_info_v4 VALUES (?, ?, ?)').run('wxid_a.pdf', 'md5-1', 100)
    })
    makeDb(join(root, 'general', 'general.db'), (db) => {
      db.exec('CREATE TABLE transferTable (session_name TEXT)')
      db.prepare('INSERT INTO transferTable VALUES (?)').run('wxid_a')
    })

    const snap = searchUnified(root, 'wxid_a')
    expect(snap.contacts.some(c => c.username === 'wxid_a' && c.name === '张三')).toBe(true)
    expect(snap.contacts.some(c => c.username === 'wxid_a' && c.name === '张三')).toBe(true)
    expect(snap.moments).toHaveLength(1)
    expect(snap.moments[0]?.snippet).toContain('wxid_a')
    expect(snap.favorites).toHaveLength(1)
    expect(snap.favorites[0]?.snippet).toContain('收藏')
    expect(snap.files).toHaveLength(1)
    expect(snap.files[0]?.fileName).toBe('wxid_a.pdf')
    expect(snap.records).toHaveLength(1)
    expect(snap.records[0]?.kind).toBe('transfers')
  })
})
