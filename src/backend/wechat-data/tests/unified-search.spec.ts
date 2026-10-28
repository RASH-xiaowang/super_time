/**
 * Unified search over a minimal decrypted fixture: contacts, moments,
 * favorites, files, and records hit different domains for one query term.
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { searchUnified } from '../src/query/unified-search.ts'
import { hitFromRow } from '../src/query/search-query.ts'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
  vi.unstubAllEnvs()
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

/** Build `contact.extra_buffer` with protobuf field 2 = enterprise wording id. */
function enterpriseBuffer(wordingId: string): Buffer {
  const value = Buffer.from(wordingId, 'utf8')
  return Buffer.concat([Buffer.from([0x12, value.length]), value])
}

describe('searchUnified', () => {
  it('returns typed hits per domain for a matching term', () => {
    const root = tempRoot()
    makeDb(join(root, 'contact', 'contact.db'), (db) => {
      db.exec('CREATE TABLE contact (id INTEGER PRIMARY KEY, username TEXT, remark TEXT, nick_name TEXT, alias TEXT, quan_pin TEXT)')
      const ins = db.prepare('INSERT INTO contact VALUES (?, ?, ?, ?, ?, ?)')
      ins.run(1, 'wxid_a', '张三', 'zhangsan', 'zhangsan_wechat', 'zhangsan')
      ins.run(2, '123@chatroom', 'wxid_a 项目群', '项目群昵称', '', 'xiangmuqun')
      db.exec('CREATE TABLE chat_room (id INTEGER PRIMARY KEY, username TEXT, owner TEXT)')
      db.prepare('INSERT INTO chat_room VALUES (?, ?, ?)').run(11, '123@chatroom', 'wxid_a')
      db.exec('CREATE TABLE chatroom_member (room_id INTEGER, member_id INTEGER)')
      const member = db.prepare('INSERT INTO chatroom_member VALUES (?, ?)')
      member.run(11, 101)
      member.run(11, 102)
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
    expect(snap.contacts.find(c => c.username === 'wxid_a')).toMatchObject({
      remark: '张三',
      nickname: 'zhangsan',
      alias: 'zhangsan_wechat',
    })
    expect(snap.contacts.find(c => c.username === '123@chatroom')).toMatchObject({
      name: 'wxid_a 项目群',
      category: 'group',
      memberCount: 2,
    })
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
      name: '张三',
      session: 'wxid_a',
      sourceId: 'transfer-1',
      transferId: 'transfer-1',
      messageServerId: '9007199254740995',
    })
    expect(snap.records[0]?.time).toContain('2023-11-')
  })

  it('记录标题按联系人、会话标题回退，无法解析时不把 wxid 当标题', () => {
    const root = tempRoot()
    makeDb(join(root, 'contact', 'contact.db'), (db) => {
      db.exec('CREATE TABLE contact (username TEXT, remark TEXT, nick_name TEXT)')
      db.prepare('INSERT INTO contact VALUES (?, ?, ?)').run('wxid_contact', '王五', '')
    })
    makeDb(join(root, 'session', 'session.db'), (db) => {
      db.exec('CREATE TABLE SessionNoContactInfoTable (username TEXT, session_title TEXT)')
      db.prepare('INSERT INTO SessionNoContactInfoTable VALUES (?, ?)').run('wxid_session', '项目协作群')
    })
    makeDb(join(root, 'general', 'general.db'), (db) => {
      db.exec('CREATE TABLE transferTable (session_name TEXT, begin_transfer_time INTEGER, message_server_id INTEGER, transfer_id TEXT, pay_payer TEXT, pay_receiver TEXT)')
      const ins = db.prepare('INSERT INTO transferTable VALUES (?, ?, ?, ?, ?, ?)')
      ins.run('wxid_contact', 1700000300, 1, 'transfer-contact', 'wxid_contact', 'wxid_self')
      ins.run('wxid_session', 1700000301, 2, 'transfer-session', 'wxid_self', 'wxid_session')
      ins.run('wxid_missing', 1700000302, 3, 'transfer-missing', 'wxid_missing', 'wxid_self')
    })

    const snap = searchUnified(root, 'transfer-', 12)
    const byId = new Map(snap.records.map(record => [record.transferId, record]))
    expect(byId.get('transfer-contact')).toMatchObject({ name: '王五', session: 'wxid_contact' })
    expect(byId.get('transfer-session')).toMatchObject({ name: '项目协作群', session: 'wxid_session' })
    expect(byId.get('transfer-missing')).toMatchObject({ name: '未知联系人', session: 'wxid_missing' })
  })

  it('私聊会话标识无法解析时可安全使用非本人的参与方名称', () => {
    vi.stubEnv('DSH_WECHAT_SELF_WXID', 'wxid_self')
    const root = tempRoot()
    makeDb(join(root, 'contact', 'contact.db'), (db) => {
      db.exec('CREATE TABLE contact (username TEXT, remark TEXT, nick_name TEXT)')
      db.prepare('INSERT INTO contact VALUES (?, ?, ?)').run('wxid_peer', '赵六', '')
    })
    makeDb(join(root, 'general', 'general.db'), (db) => {
      db.exec('CREATE TABLE transferTable (session_name TEXT, begin_transfer_time INTEGER, message_server_id INTEGER, transfer_id TEXT, pay_payer TEXT, pay_receiver TEXT)')
      db.prepare('INSERT INTO transferTable VALUES (?, ?, ?, ?, ?, ?)').run(
        'wxid_peer_variant', 1700000300, 1, 'transfer-peer', 'wxid_peer', 'wxid_self',
      )
    })

    const snap = searchUnified(root, 'transfer-peer', 12)
    expect(snap.records[0]).toMatchObject({
      name: '赵六',
      session: 'wxid_peer_variant',
      transferId: 'transfer-peer',
    })
  })

  it('红包记录同样解析会话显示名', () => {
    const root = tempRoot()
    makeDb(join(root, 'contact', 'contact.db'), (db) => {
      db.exec('CREATE TABLE contact (username TEXT, remark TEXT, nick_name TEXT)')
      db.prepare('INSERT INTO contact VALUES (?, ?, ?)').run('wxid_red', '', '红包好友')
    })
    makeDb(join(root, 'general', 'general.db'), (db) => {
      db.exec('CREATE TABLE redEnvelopeTable (message_server_id INTEGER, session_name TEXT, sender_user_name TEXT)')
      db.prepare('INSERT INTO redEnvelopeTable VALUES (?, ?, ?)').run(1, 'wxid_red', 'wxid_red')
    })

    const snap = searchUnified(root, 'wxid_red', 12)
    expect(snap.records[0]).toMatchObject({
      kind: 'redpackets',
      name: '红包好友',
      session: 'wxid_red',
    })
  })

  it('群消息命中同时保留发送者显示名与原始 username', () => {
    const hit = hitFromRow(
      { local_id: 7, create_time: 1700000000, message_content: 'wxid_sender:\n项目进度更新' },
      '123@chatroom',
      '项目',
      new Map([['wxid_sender', '李四']]),
    )
    expect(hit).toMatchObject({
      sender: '李四',
      sender_username: 'wxid_sender',
      snippet: '项目进度更新',
    })
  })

  it('联系人检索可按企业名称命中，并返回 enterprise category 与企业名', () => {
    const root = tempRoot()
    makeDb(join(root, 'contact', 'contact.db'), (db) => {
      db.exec('CREATE TABLE contact (id INTEGER PRIMARY KEY, username TEXT, remark TEXT, nick_name TEXT, alias TEXT, quan_pin TEXT, extra_buffer BLOB)')
      db.exec('CREATE TABLE openim_wording (wording_id TEXT, wording TEXT)')
      db.prepare('INSERT INTO openim_wording VALUES (?, ?)').run('wording-a', '深度求索')
      db.prepare('INSERT INTO contact VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        1, 'wxid_peer@openim', '小深', '顾问', '', 'xiaoshen', enterpriseBuffer('wording-a'),
      )
    })

    const snap = searchUnified(root, '深度求索', 12)
    expect(snap.contacts).toEqual([
      expect.objectContaining({
        username: 'wxid_peer@openim',
        name: '小深',
        category: 'enterprise',
        enterpriseName: '深度求索',
      }),
    ])
  })

  it('朋友圈、收藏、转账和红包命中企微用户时都返回企业名称', () => {
    const root = tempRoot()
    const username = 'wxid_ent@openim'
    makeDb(join(root, 'contact', 'contact.db'), (db) => {
      db.exec('CREATE TABLE contact (id INTEGER PRIMARY KEY, username TEXT, remark TEXT, nick_name TEXT, alias TEXT, quan_pin TEXT, extra_buffer BLOB)')
      db.exec('CREATE TABLE openim_wording (wording_id TEXT, wording TEXT)')
      db.prepare('INSERT INTO openim_wording VALUES (?, ?)').run('wording-ent', '示例企业')
      db.prepare('INSERT INTO contact VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        1, username, '小企', '企微伙伴', '', '', enterpriseBuffer('wording-ent'),
      )
    })
    makeDb(join(root, 'sns', 'db_sns', 'sns.db'), (db) => {
      db.exec('CREATE TABLE SnsTimeLine (tid INTEGER, user_name TEXT, content TEXT, createTime INTEGER)')
      db.prepare('INSERT INTO SnsTimeLine VALUES (?, ?, ?, ?)').run(
        1,
        username,
        '<TimelineObject><contentDesc><![CDATA[企微伙伴动态]]></contentDesc></TimelineObject>',
        1700000000,
      )
    })
    makeDb(join(root, 'favorite', 'favorite.db'), (db) => {
      db.exec('CREATE TABLE fav_db_item (local_id INTEGER, type INTEGER, update_time INTEGER, fromusr TEXT, realchatname TEXT, content TEXT)')
      db.prepare('INSERT INTO fav_db_item VALUES (?, ?, ?, ?, ?, ?)').run(
        1,
        1,
        1700000100,
        username,
        '',
        '<favitem><desc><![CDATA[企微伙伴收藏]]></desc></favitem>',
      )
    })
    makeDb(join(root, 'general', 'general.db'), (db) => {
      db.exec('CREATE TABLE transferTable (session_name TEXT, begin_transfer_time INTEGER, message_server_id INTEGER, transfer_id TEXT, pay_payer TEXT, pay_receiver TEXT)')
      db.prepare('INSERT INTO transferTable VALUES (?, ?, ?, ?, ?, ?)').run(
        username, 1700000200, 2, 'transfer-ent', username, 'wxid_self',
      )
      db.exec('CREATE TABLE redEnvelopeTable (session_name TEXT, last_update_time INTEGER, message_server_id INTEGER, sender_user_name TEXT)')
      db.prepare('INSERT INTO redEnvelopeTable VALUES (?, ?, ?, ?)').run(
        username, 1700000300, 3, username,
      )
    })

    const snap = searchUnified(root, username, 12)
    expect(snap.contacts[0]).toMatchObject({
      username,
      name: '小企',
      category: 'enterprise',
      enterpriseName: '示例企业',
    })
    expect(snap.moments[0]).toMatchObject({
      username,
      name: '小企',
      enterpriseName: '示例企业',
    })
    expect(snap.favorites[0]).toMatchObject({
      source: '小企',
      sourceEnterpriseName: '示例企业',
    })
    const records = new Map(snap.records.map(record => [record.kind, record]))
    expect(records.get('transfers')).toMatchObject({
      name: '小企',
      enterpriseName: '示例企业',
      session: username,
    })
    expect(records.get('redpackets')).toMatchObject({
      name: '小企',
      enterpriseName: '示例企业',
      session: username,
    })
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
