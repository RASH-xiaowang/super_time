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
      db.exec('CREATE TABLE SnsTimeLine (tid INTEGER, user_name TEXT, content TEXT, createTime INTEGER)')
      db.prepare('INSERT INTO SnsTimeLine VALUES (?, ?, ?, ?)').run(
        907,
        'wxid_a',
        '<TimelineObject><id>907</id><createTime>1700000000</createTime><contentDesc><![CDATA[wxid_a 的朋友圈]]></contentDesc>'
          + '<media><id>img-1</id><url md5="moment-md5" token="moment-token" key="moment-seed">https://cdn/img.jpg</url></media></TimelineObject>',
        1700000000,
      )
    })
    makeDb(join(root, 'favorite', 'favorite.db'), (db) => {
      db.exec('CREATE TABLE fav_db_item (local_id INTEGER, type INTEGER, update_time INTEGER, server_id INTEGER, source_id INTEGER, content TEXT)')
      db.prepare('INSERT INTO fav_db_item VALUES (?, ?, ?, ?, ?, ?)').run(
        41,
        8,
        1700000100,
        9007199254740993n,
        9007199254740994n,
        '<favitem><desc><![CDATA[wxid_a 收藏]]></desc><datalist>'
          + '<dataitem datatype="8" dataid="fav-full-md5"><datatitle>wxid_a 收藏.pdf</datatitle><datafmt>pdf</datafmt><fullsize>2048</fullsize></dataitem>'
          + '</datalist></favitem>',
      )
    })
    makeDb(join(root, 'hardlink', 'hardlink.db'), (db) => {
      db.exec('CREATE TABLE file_hardlink_info_v4 (file_name TEXT, md5 TEXT, file_size INTEGER, modify_time INTEGER)')
      db.prepare('INSERT INTO file_hardlink_info_v4 VALUES (?, ?, ?, ?)').run('wxid_a.pdf', 'md5-1', 100, 1700000200)
    })
    makeDb(join(root, 'general', 'general.db'), (db) => {
      db.exec('CREATE TABLE transferTable (session_name TEXT, begin_transfer_time INTEGER, message_server_id INTEGER, transfer_id TEXT)')
      db.prepare('INSERT INTO transferTable VALUES (?, ?, ?, ?)').run(
        'wxid_a', 1700000300, 9007199254740995n, 'transfer-1',
      )
    })

    const snap = searchUnified(root, 'wxid_a')
    expect(snap.contacts.some(c => c.username === 'wxid_a' && c.name === '张三')).toBe(true)
    expect(snap.contacts.some(c => c.username === 'wxid_a' && c.name === '张三')).toBe(true)
    expect(snap.moments).toHaveLength(1)
    expect(snap.moments[0]?.snippet).toContain('wxid_a')
    expect(snap.moments[0]).toMatchObject({
      tid: '907',
      mediaId: 'img-1',
      md5: 'moment-md5',
      token: 'moment-token',
      seed: 'moment-seed',
    })
    expect(snap.moments[0]?.time).toContain('2023-11-')
    expect(snap.favorites).toHaveLength(1)
    expect(snap.favorites[0]?.snippet).toContain('收藏')
    expect(snap.favorites[0]).toMatchObject({
      id: 41,
      resourceKind: 'file',
      fileName: 'wxid_a 收藏.pdf',
      size: 2048,
      md5: 'fav-full-md5',
      serverId: '9007199254740993',
      sourceId: '9007199254740994',
      typeLabel: '文件',
    })
    expect(snap.favorites[0]?.time).toContain('2023-11-')
    expect(snap.files).toHaveLength(1)
    expect(snap.files[0]?.fileName).toBe('wxid_a.pdf')
    expect(snap.files[0]).toMatchObject({ md5: 'md5-1', size: 100, category: 'file' })
    expect(snap.files[0]?.time).toContain('2023-11-')
    expect(snap.records).toHaveLength(1)
    expect(snap.records[0]?.kind).toBe('transfers')
    expect(snap.records[0]).toMatchObject({
      sourceId: 'transfer-1',
      transferId: 'transfer-1',
      messageServerId: '9007199254740995',
    })
    expect(snap.records[0]?.time).toContain('2023-11-')
  })

  it('日期范围与用户名会下推到各资源域，范围外不返回', () => {
    const root = tempRoot()
    makeDb(join(root, 'sns', 'db_sns', 'sns.db'), (db) => {
      db.exec('CREATE TABLE SnsTimeLine (tid INTEGER, user_name TEXT, content TEXT, createTime INTEGER)')
      const ins = db.prepare('INSERT INTO SnsTimeLine VALUES (?, ?, ?, ?)')
      ins.run(1, 'wxid_a', '<TimelineObject><contentDesc><![CDATA[项目周报]]></contentDesc></TimelineObject>', 1700000000)
      ins.run(2, 'wxid_b', '<TimelineObject><contentDesc><![CDATA[项目周报]]></contentDesc></TimelineObject>', 1700100000)
    })
    makeDb(join(root, 'favorite', 'favorite.db'), (db) => {
      db.exec('CREATE TABLE fav_db_item (local_id INTEGER, type INTEGER, update_time INTEGER, fromusr TEXT, realchatname TEXT, content TEXT)')
      db.prepare('INSERT INTO fav_db_item VALUES (?, ?, ?, ?, ?, ?)')
        .run(1, 1, 1700000000, 'wxid_a', '项目群', '<favitem><desc><![CDATA[项目周报]]></desc></favitem>')
    })
    // 让会话 username 能解析成记录表里的显示名，验证会话过滤不是只比原始 id。
    makeDb(join(root, 'contact', 'contact.db'), (db) => {
      db.exec('CREATE TABLE contact (username TEXT, remark TEXT, nick_name TEXT)')
      db.prepare('INSERT INTO contact VALUES (?, ?, ?)').run('wxid_a', '项目群', '')
    })
    makeDb(join(root, 'general', 'general.db'), (db) => {
      db.exec('CREATE TABLE transferTable (session_name TEXT, begin_transfer_time INTEGER, message_server_id INTEGER, transfer_id TEXT)')
      db.prepare('INSERT INTO transferTable VALUES (?, ?, ?, ?)').run('项目群', 1700000000, 1, 't-1')
    })

    const from = new Date(1700000000 * 1000)
    const day = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, '0')}-${String(from.getDate()).padStart(2, '0')}`
    const snap = searchUnified(root, '项目', 12, { from: day, to: day, username: 'wxid_a' })
    expect(snap.moments.map(m => m.tid)).toEqual(['1'])
    expect(snap.favorites.map(f => f.id)).toEqual([1])
    // 记录按显示名/username 命中后仍受日期约束。
    expect(snap.records.map(record => record.sourceId)).toEqual(['t-1'])
    // 联系人/文件没有可用的时间列；带日期时必须明确说「不支持」，不能返回未过滤数据。
    expect(snap.contacts).toEqual([])
    expect(snap.domainErrors?.contacts).toMatchObject({ code: 'unsupported_scope' })
  })

  it('不支持的日期过滤以结构化错误表示，不伪装成 0 命中', () => {
    const root = tempRoot()
    makeDb(join(root, 'sns', 'db_sns', 'sns.db'), (db) => {
      // 老库没有时间列。
      db.exec('CREATE TABLE SnsTimeLine (tid INTEGER, user_name TEXT, content TEXT)')
      db.prepare('INSERT INTO SnsTimeLine VALUES (?, ?, ?)').run(1, 'wxid_a', '项目周报')
    })
    const snap = searchUnified(root, '项目', 12, { from: '2024-01-01', to: '2024-01-31' })
    expect(snap.moments).toEqual([])
    expect(snap.domainErrors?.moments).toMatchObject({ code: 'unsupported_scope' })
    expect(snap.readError).toBeUndefined()
  })

  it('非法日期或 from > to 不执行任何域，并返回 unsupported_scope', () => {
    const root = tempRoot()
    for (const options of [
      { from: '2024-02-30', to: '2024-03-01' },
      { from: '2024-03-01', to: '2024-02-01' },
    ]) {
      const snap = searchUnified(root, '项目', 12, options)
      expect(snap.domainErrors?.moments?.code).toBe('unsupported_scope')
      expect(snap.moments).toEqual([])
    }
  })
})
