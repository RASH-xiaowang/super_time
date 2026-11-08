/**
 * Legacy WeChat 4.x message-table identities.
 *
 * `Msg_<md5(username)>` is a physical table name, not a conversation id. Old
 * groups can disappear from session/contact metadata while remaining in a
 * shard's Name2Id table, so every read path must resolve before table lookup.
 * @vitest-environment node
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  isInternalWechatId,
  messageIdentityIndex,
  readableIdentityLabel,
  replaceWechatIds,
  resolveChatIdentity,
  resolveTalkerUsername,
  sessionDisplayNames,
} from '../src/query/message-identity.ts'
import { invalidateWechatMeta } from '../src/query/meta.ts'
import { queryMessages } from '../src/query/messages.ts'
import { querySessions } from '../src/query/sessions.ts'
import { getDailyCounts } from '../src/query/calendar.ts'
import { queryContact360 } from '../src/query/contact360.ts'
import { resolveImageResourceHint } from '../src/query/media-image.ts'
import { listMessagesInRange } from '../src/query/search-build.ts'
import { searchWechatFts } from '../src/query/search-query.ts'
import {
  bigramTokens,
  INDEX_SCHEMA_VERSION,
  loadDisplayNames,
  searchIndexBatch,
} from '../src/query/search-scaffold.ts'
import { runAggregate } from '../src/query/retrieval/aggregate.ts'
import {
  getMessageContextTool,
  getSessionMessagesTool,
  listSessionsTool,
} from '../src/query/tools/message-tools.ts'
import { DEFAULT_KB_ID, listNotes, saveNote } from '../src/query/notes.ts'
import { insertTask, listTasks } from '../src/query/wechat-tasks.ts'
import { listSummaryRecords, listSummaryTasks, saveSummaryTask } from '../src/query/summary-tasks.ts'
import { listEditedMessages } from '../src/query/edit.ts'
import { clearSessionDraft } from '../src/query/drafts.ts'
import { queryGraph } from '../src/query/graph.ts'

const scratch: string[] = []

describe('internal identity redaction', () => {
  it('distinguishes raw WeChat IDs from readable contact labels', () => {
    expect(isInternalWechatId('wxid_alice')).toBe(true)
    expect(isInternalWechatId('gh_service_account')).toBe(true)
    expect(isInternalWechatId('123456@chatroom')).toBe(true)
    expect(isInternalWechatId('张三')).toBe(false)
    expect(readableIdentityLabel('房东老陈', 'wxid_alice')).toBe('房东老陈')
    expect(readableIdentityLabel('wxid_alice', 'wxid_alice')).toBe('')
    expect(readableIdentityLabel('群聊 123', '123@chatroom')).toBe('')
  })

  it('replaces known IDs with names and unknown IDs with safe labels', () => {
    const labels = new Map([
      ['wxid_alice', '房东老陈'],
      ['123456@chatroom', '项目交付群'],
    ])
    const text = 'wxid_alice 在 123456@chatroom 说，wxid_unknown 也在场'
    expect(replaceWechatIds(
      text,
      raw => labels.get(raw),
      raw => raw.endsWith('@chatroom') ? '该群聊' : '某位联系人',
    )).toBe('房东老陈 在 项目交付群 说，某位联系人 也在场')
  })
})

afterEach(() => {
  invalidateWechatMeta()
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'wx-identity-'))
  scratch.push(root)
  return root
}

function makeDb(path: string, create: (db: DatabaseSync) => void): void {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  try { create(db) } finally { db.close() }
}

function tableOf(username: string): string {
  return 'Msg_' + createHash('md5').update(username, 'utf8').digest('hex')
}

function searchIndexFixture(decryptedDir: string, room: string, hash: string): void {
  makeDb(join(dirname(decryptedDir), 'wechat_search.db'), (db) => {
    db.exec(`
      CREATE TABLE message_meta (
        text TEXT NOT NULL,
        username TEXT NOT NULL,
        create_time INTEGER NOT NULL DEFAULT 0,
        sort_seq INTEGER NOT NULL DEFAULT 0,
        local_id INTEGER NOT NULL DEFAULT 0,
        sender TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE VIRTUAL TABLE message_fts USING fts5(tokens, who, content='');
    `)
    db.prepare('INSERT INTO meta(key, value) VALUES(?, ?)').run('schema_version', INDEX_SCHEMA_VERSION)
    const insertMeta = db.prepare('INSERT INTO message_meta VALUES(?, ?, ?, ?, ?, ?)')
    const insertFts = db.prepare('INSERT INTO message_fts(rowid, tokens, who) VALUES(?, ?, ?)')
    const rows: Array<[string, string, number, number]> = [
      ['你好一', room, 100, 1],
      ['你好二', hash, 200, 2],
    ]
    for (const [text, username, createTime, localId] of rows) {
      const result = insertMeta.run(text, username, createTime, createTime, localId, '')
      insertFts.run(Number(result.lastInsertRowid), bigramTokens(text), bigramTokens('旧群'))
    }
  })
}

describe('message identity resolution', () => {
  it('resolves every old group that exists only in message-shard Name2Id', () => {
    const root = tempRoot()
    const roomA = '44626999237@chatroom'
    const roomB = '25043774179@chatroom'
    makeDb(join(root, 'message', 'message_0.db'), (db) => {
      db.exec('CREATE TABLE Name2Id (user_name TEXT)')
      const addName = db.prepare('INSERT INTO Name2Id VALUES (?)')
      addName.run(roomA)
      addName.run(roomB)
      db.exec(`CREATE TABLE "${tableOf(roomA)}" (local_id INTEGER)`)
      db.exec(`CREATE TABLE "${tableOf(roomB)}" (local_id INTEGER)`)
    })

    const index = messageIdentityIndex(root)
    for (const room of [roomA, roomB]) {
      const hash = createHash('md5').update(room, 'utf8').digest('hex')
      expect(index.tableToUsername.get(tableOf(room))).toBe(room)
      expect(resolveTalkerUsername(root, hash)).toBe(room)
      expect(resolveTalkerUsername(root, tableOf(room))).toBe(room)
      expect(resolveChatIdentity(root, hash)).toMatchObject({
        username: room,
        type: 'group',
        legacyHash: true,
        resolved: true,
      })
    }
  })

  it('opens a hash link as the real group and returns a non-hash display name', () => {
    const root = tempRoot()
    const room = '44626999237@chatroom'
    const hash = createHash('md5').update(room, 'utf8').digest('hex')
    const table = tableOf(room)
    makeDb(join(root, 'message', 'message_0.db'), (db) => {
      db.exec('CREATE TABLE Name2Id (user_name TEXT)')
      db.prepare('INSERT INTO Name2Id VALUES (?)').run(room)
      db.prepare('INSERT INTO Name2Id VALUES (?)').run('wxid_member')
      db.exec(`CREATE TABLE "${table}" (
        local_id INTEGER PRIMARY KEY, sort_seq INTEGER, local_type INTEGER,
        create_time INTEGER, real_sender_id INTEGER, message_content TEXT
      )`)
      db.prepare(`INSERT INTO "${table}" VALUES (?, ?, ?, ?, ?, ?)`).run(
        1, 1700000000000, 1, 1780000000, 2, 'wxid_member:\n大家好',
      )
    })

    const snapshot = queryMessages(root, hash, 20)
    expect(snapshot.canonicalUsername).toBe(room)
    expect(snapshot.chatType).toBe('group')
    expect(snapshot.chatDisplayName).toBe('群聊 44626999237')
    expect(snapshot.messages).toHaveLength(1)
    expect(snapshot.messages[0]?.displayText).toBe('大家好')
  })

  it('reads stranger-only contacts and never echoes an unresolved hash', () => {
    const root = tempRoot()
    const person = 'wxid_stranger_only'
    makeDb(join(root, 'contact', 'contact.db'), (db) => {
      db.exec('CREATE TABLE stranger (username TEXT, remark TEXT, nick_name TEXT)')
      db.prepare('INSERT INTO stranger VALUES (?, ?, ?)').run(person, '陌生人备注', '昵称')
    })
    makeDb(join(root, 'message', 'message_0.db'), (db) => {
      db.exec('CREATE TABLE Name2Id (user_name TEXT)')
      db.prepare('INSERT INTO Name2Id VALUES (?)').run(person)
      db.exec(`CREATE TABLE "${tableOf(person)}" (local_id INTEGER)`)
    })
    expect(resolveChatIdentity(root, tableOf(person))).toMatchObject({
      username: person,
      displayName: '陌生人备注',
      type: 'private',
    })

    const missing = 'ffffffffffffffffffffffffffffffff'
    const identity = resolveChatIdentity(root, missing)
    expect(identity).toMatchObject({
      username: '',
      displayName: '未命名会话',
      resolved: false,
      legacyHash: true,
    })
    const snapshot = queryMessages(root, missing, 20)
    expect(snapshot).toMatchObject({
      messages: [],
      total: 0,
      canonicalUsername: '',
      chatDisplayName: '未命名会话',
    })
    expect(JSON.stringify(snapshot)).not.toContain(missing)
  })

  it('keeps legacy hashes usable across media, calendar and contact-360 routes', () => {
    const root = tempRoot()
    const room = '44626999237@chatroom'
    const hash = createHash('md5').update(room, 'utf8').digest('hex')
    const imageMd5 = 'a'.repeat(32)
    const createdAt = Math.floor(new Date(2026, 9, 29, 12, 0, 0).getTime() / 1000)
    makeDb(join(root, 'message', 'message_0.db'), (db) => {
      db.exec('CREATE TABLE Name2Id (user_name TEXT)')
      db.prepare('INSERT INTO Name2Id VALUES (?)').run(room)
      db.exec(`CREATE TABLE "${tableOf(room)}" (
        local_id INTEGER PRIMARY KEY,
        local_type INTEGER,
        create_time INTEGER,
        packed_info_data BLOB,
        message_content TEXT
      )`)
      const packed = Buffer.concat([
        Buffer.from([0x12, 0x22, 0x0a, 0x20]),
        Buffer.from(imageMd5, 'ascii'),
      ])
      db.prepare(`INSERT INTO "${tableOf(room)}" VALUES (?, ?, ?, ?, ?)`).run(
        7, 3, createdAt, packed, '<msg><img /></msg>',
      )
    })

    expect(resolveImageResourceHint(root, hash, 7).md5).toBe(imageMd5)
    expect(getDailyCounts(root, hash, 2026, 10).counts['29']).toBe(1)
    expect(queryContact360(root, hash)).toMatchObject({
      username: room,
      displayName: '群聊 44626999237',
      messages: { count: 1, firstTime: createdAt, lastTime: createdAt },
    })
  })

  it('canonicalizes a legacy hash when it is stored in SessionTable', async () => {
    const root = tempRoot()
    const room = '173568a966881cbabd260b08d2353d0f@chatroom'
    const hash = createHash('md5').update(room, 'utf8').digest('hex')
    makeDb(join(root, 'message', 'message_0.db'), (db) => {
      db.exec('CREATE TABLE Name2Id (user_name TEXT)')
      db.prepare('INSERT INTO Name2Id VALUES (?)').run(room)
      db.exec(`CREATE TABLE "${tableOf(room)}" (local_id INTEGER)`)
    })
    makeDb(join(root, 'session', 'session.db'), (db) => {
      db.exec(`CREATE TABLE SessionTable (
        username TEXT, last_timestamp INTEGER, sort_timestamp INTEGER, summary TEXT,
        unread_count INTEGER, draft BLOB, is_hidden INTEGER, last_msg_type INTEGER,
        last_msg_sub_type INTEGER, last_msg_sender TEXT, last_sender_display_name TEXT
      )`)
      db.prepare('INSERT INTO SessionTable VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(hash, 200, 200, '旧群消息', 0, null, 0, 1, 0, '', '')
    })

    const snapshot = await querySessions(root)
    expect(snapshot.sessions).toHaveLength(1)
    expect(snapshot.sessions[0]).toMatchObject({
      username: room,
      displayName: '群聊 173568a966881cbabd260b08d2353d0f',
      type: 'group',
    })
    expect(JSON.stringify(snapshot)).not.toContain(hash)
  })

  it('loads relation-graph groups through the canonical username', async () => {
    const root = tempRoot()
    const room = '44626999237@chatroom'
    const hash = createHash('md5').update(room, 'utf8').digest('hex')
    makeDb(join(root, 'message', 'message_0.db'), (db) => {
      db.exec('CREATE TABLE Name2Id (user_name TEXT)')
      db.prepare('INSERT INTO Name2Id VALUES (?)').run(room)
      db.exec(`CREATE TABLE "${tableOf(room)}" (local_id INTEGER)`)
      db.prepare(`INSERT INTO "${tableOf(room)}" VALUES (1)`).run()
    })
    makeDb(join(root, 'session', 'session.db'), (db) => {
      db.exec('CREATE TABLE SessionTable (username TEXT)')
      db.prepare('INSERT INTO SessionTable VALUES (?)').run(hash)
      db.exec('CREATE TABLE SessionNoContactInfoTable (username TEXT, session_title TEXT)')
      db.prepare('INSERT INTO SessionNoContactInfoTable VALUES (?, ?)').run(hash, '图谱旧群')
    })

    const graph = await queryGraph(root)
    expect(graph.nodes.find(node => node.id === room)).toMatchObject({
      id: room,
      label: '图谱旧群',
      kind: 'group',
      msg_count: 1,
    })
    expect(JSON.stringify(graph)).not.toContain(hash)
  })

  it('merges duplicate hash/real SessionTable rows and keeps title/order/draft metadata', async () => {
    const root = tempRoot()
    const room = '44626999237@chatroom'
    const hash = createHash('md5').update(room, 'utf8').digest('hex')
    makeDb(join(root, 'message', 'message_0.db'), (db) => {
      db.exec('CREATE TABLE Name2Id (user_name TEXT)')
      db.prepare('INSERT INTO Name2Id VALUES (?)').run(room)
      db.exec(`CREATE TABLE "${tableOf(room)}" (local_id INTEGER)`)
    })
    makeDb(join(root, 'session', 'session.db'), (db) => {
      db.exec(`CREATE TABLE SessionTable (
        username TEXT, last_timestamp INTEGER, sort_timestamp INTEGER, summary TEXT,
        unread_count INTEGER, draft BLOB, is_hidden INTEGER, last_msg_type INTEGER,
        last_msg_sub_type INTEGER, last_msg_sender TEXT, last_sender_display_name TEXT
      )`)
      const insert = db.prepare('INSERT INTO SessionTable VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      insert.run(hash, 100, 100, '旧摘要', 3, Buffer.from('未发送草稿'), 0, 49, 6, 'wxid_member', '')
      insert.run(room, 200, 200, '新摘要', 0, null, 0, 1, 0, 'wxid_member', '张三')
      db.exec('CREATE TABLE SessionNoContactInfoTable (username TEXT, session_title TEXT)')
      db.prepare('INSERT INTO SessionNoContactInfoTable VALUES (?, ?)').run(hash, '旧群正式名称')
    })

    const snapshot = await querySessions(root)
    expect(snapshot.sessions).toHaveLength(1)
    expect(snapshot.sessions[0]).toMatchObject({
      username: room,
      displayName: '旧群正式名称',
      type: 'group',
      lastTimestamp: 200,
      summary: '新摘要',
      draft: '未发送草稿',
      unreadCount: 3,
      lastMsgSenderName: '张三',
    })
    expect(sessionDisplayNames(root).get(room)).toBe('旧群正式名称')
    expect(JSON.stringify(snapshot)).not.toContain(hash)
  })

  it('merges legacy hash rows in search, aggregation and AI message tools', async () => {
    const dataRoot = tempRoot()
    const decryptedDir = join(dataRoot, 'wechat', 'decrypted')
    const room = '44626999237@chatroom'
    const hash = createHash('md5').update(room, 'utf8').digest('hex')
    const expectedName = '群聊 44626999237'
    mkdirSync(join(decryptedDir, 'message'), { recursive: true })
    makeDb(join(decryptedDir, 'message', 'message_0.db'), (db) => {
      db.exec('CREATE TABLE Name2Id (user_name TEXT)')
      db.prepare('INSERT INTO Name2Id VALUES (?)').run(room)
      db.exec(`CREATE TABLE "${tableOf(room)}" (local_id INTEGER)`)
    })
    searchIndexFixture(decryptedDir, room, hash)

    const range = listMessagesInRange(decryptedDir, 1, 300, 20, hash)
    expect(range.hits).toHaveLength(2)
    expect(range.hits.every(hit => hit.username === room)).toBe(true)
    expect(range.hits.every(hit => hit.name === expectedName)).toBe(true)

    const search = searchIndexBatch(decryptedDir, ['你好'], 20, { username: hash })
    expect(search.hits).toHaveLength(2)
    expect(search.hits.every(hit => hit.username === room)).toBe(true)

    const aggregate = runAggregate({
      decryptedDir,
      question: '哪个会话消息最多',
      scope: { username: hash },
    })
    expect(aggregate).toHaveLength(1)
    expect(aggregate[0]?.body).toContain(`${expectedName}：2 条`)
    expect(aggregate[0]?.body).not.toContain(hash)

    const ctx = { decryptedDir, scope: { username: hash } }
    const sessionMessages = await getSessionMessagesTool.run({ username: hash, limit: 20 }, ctx)
    expect(sessionMessages.ok).toBe(true)
    expect(sessionMessages.hits).toHaveLength(2)
    expect(sessionMessages.hits.every(hit => hit.key.startsWith(room + ':'))).toBe(true)

    const sessions = await listSessionsTool.run({ orderBy: 'count', limit: 20 }, ctx)
    expect(sessions.ok).toBe(true)
    expect(sessions.hits).toHaveLength(1)
    expect(sessions.hits[0]).toMatchObject({ key: room, name: expectedName })
    expect(JSON.stringify(sessions)).not.toContain(hash)
  })

  it('resolves raw senders and IDs inside message-window snippets', async () => {
    const dataRoot = tempRoot()
    const decryptedDir = join(dataRoot, 'wechat', 'decrypted')
    const room = '123456@chatroom'
    const member = 'wxid_member'
    const table = tableOf(room)
    mkdirSync(join(decryptedDir, 'message'), { recursive: true })
    makeDb(join(decryptedDir, 'contact', 'contact.db'), (db) => {
      db.exec('CREATE TABLE contact (username TEXT, remark TEXT, nick_name TEXT)')
      const insert = db.prepare('INSERT INTO contact VALUES (?, ?, ?)')
      insert.run(room, '项目交付群', '')
      insert.run(member, '张三', '')
    })
    makeDb(join(decryptedDir, 'message', 'message_0.db'), (db) => {
      db.exec('CREATE TABLE Name2Id (user_name TEXT)')
      db.prepare('INSERT INTO Name2Id VALUES (?)').run(room)
      db.prepare('INSERT INTO Name2Id VALUES (?)').run(member)
      db.exec(`CREATE TABLE "${table}" (
        local_id INTEGER, sort_seq INTEGER, local_type INTEGER,
        create_time INTEGER, message_content TEXT
      )`)
      db.prepare(`INSERT INTO "${table}" VALUES (?, ?, ?, ?, ?)`).run(
        7,
        1700000000000,
        1,
        1700000000,
        `${member}:\n${member} 说资料已经发到群里`,
      )
    })
    makeDb(join(dirname(decryptedDir), 'wechat_search.db'), (db) => {
      db.exec('CREATE TABLE message_meta (username TEXT, local_id INTEGER, create_time INTEGER)')
      db.prepare('INSERT INTO message_meta VALUES (?, ?, ?)').run(room, 7, 1700000000)
    })

    const result = await getMessageContextTool.run(
      { key: `${room}:7` },
      { decryptedDir },
    )
    expect(result.ok).toBe(true)
    expect(result.hits[0]?.sender).toBe('张三')
    expect(result.hits[0]?.snippet).toBe('张三 说资料已经发到群里')
    expect(JSON.stringify(result)).not.toContain(member)
  })

  it('canonicalizes legacy hash ids in the WeChat full-text index', () => {
    const root = tempRoot()
    const room = '44626999237@chatroom'
    const hash = createHash('md5').update(room, 'utf8').digest('hex')
    makeDb(join(root, 'message', 'message_0.db'), (db) => {
      db.exec('CREATE TABLE Name2Id (user_name TEXT)')
      db.prepare('INSERT INTO Name2Id VALUES (?)').run(room)
      db.exec(`CREATE TABLE "${tableOf(room)}" (local_id INTEGER)`)
    })
    makeDb(join(root, 'message', 'message_fts.db'), (db) => {
      db.exec(`
        CREATE TABLE name2id (rowid INTEGER PRIMARY KEY, username TEXT NOT NULL);
        CREATE TABLE message_fts_v4_0_content (id INTEGER PRIMARY KEY, c0 TEXT NOT NULL);
        CREATE TABLE message_fts_v4_aux_0 (
          rowid INTEGER PRIMARY KEY,
          message_local_id INTEGER NOT NULL,
          sort_seq INTEGER NOT NULL,
          session_id INTEGER NOT NULL
        );
      `)
      db.prepare('INSERT INTO name2id(rowid, username) VALUES(1, ?)').run(hash)
      db.prepare('INSERT INTO message_fts_v4_0_content(id, c0) VALUES(1, ?)')
        .run('旧群约定明天交付')
      db.prepare('INSERT INTO message_fts_v4_aux_0(rowid, message_local_id, sort_seq, session_id) VALUES(1, 9, 1780000000000, 1)')
        .run()
    })
    makeDb(join(root, 'session', 'session.db'), (db) => {
      db.exec('CREATE TABLE SessionNoContactInfoTable (username TEXT, session_title TEXT)')
      db.prepare('INSERT INTO SessionNoContactInfoTable VALUES(?, ?)').run(hash, '项目旧群')
    })

    const result = searchWechatFts(root, '交付', 20, new Map([[room, '项目旧群']]), hash)
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0]).toMatchObject({
      username: room,
      name: '项目旧群',
    })
    expect(JSON.stringify(result)).not.toContain(hash)
    expect(loadDisplayNames(root).get(room)).toBe('项目旧群')
  })

  it('canonicalizes persisted note/task/summary/edit/draft source identities', () => {
    const dataRoot = tempRoot()
    const root = join(dataRoot, 'wechat', 'decrypted')
    mkdirSync(root, { recursive: true })
    const room = '25043774179@chatroom'
    const hash = createHash('md5').update(room, 'utf8').digest('hex')
    makeDb(join(root, 'message', 'message_0.db'), (db) => {
      db.exec('CREATE TABLE Name2Id (user_name TEXT)')
      db.prepare('INSERT INTO Name2Id VALUES (?)').run(room)
      db.exec(`CREATE TABLE "${tableOf(room)}" (local_id INTEGER)`)
    })

    const note = saveNote(root, DEFAULT_KB_ID, {
      title: '旧会话沉淀',
      sourceKind: 'ask',
      sourceUsername: hash,
    })
    expect(note.ok, note.error).toBe(true)
    makeDb(join(dirname(root), 'wechat_notes.db'), (db) => {
      db.prepare('UPDATE notes SET source_username = ?').run(hash)
    })
    expect(listNotes(root, DEFAULT_KB_ID).items[0]?.sourceUsername).toBe(room)

    const task = insertTask(root, { title: '回到旧群', sourceUsername: hash })
    expect(task.ok).toBe(true)
    makeDb(join(dirname(root), 'wechat_tasks.db'), (db) => {
      db.prepare('UPDATE tasks SET source_username = ?').run(hash)
    })
    expect(listTasks(root).items[0]?.sourceUsername).toBe(room)

    const summary = saveSummaryTask(root, {
      groupUsername: hash,
      groupName: hash,
      targetUsers: [],
      format: 'brief',
      customPrompt: '',
      scheduleTime: '08:00',
      enabled: true,
    })
    expect(summary.ok).toBe(true)
    makeDb(join(dirname(root), 'daily_summary.db'), (db) => {
      db.prepare('UPDATE summary_tasks SET group_username = ?, group_name = ?').run(hash, hash)
      db.prepare(`INSERT INTO summary_records
        (task_id, group_username, group_name, summary_date, summary, message_count, status, error, created_at)
        VALUES (?, ?, ?, '2026-11-01', '旧总结', 1, 'done', '', 1)`).run(summary.id ?? 0, hash, hash)
    })
    expect(listSummaryTasks(root).items[0]).toMatchObject({
      groupUsername: room,
      groupName: '群聊 25043774179',
    })
    expect(listSummaryRecords(root).items[0]).toMatchObject({
      groupUsername: room,
      groupName: '群聊 25043774179',
    })

    makeDb(join(dirname(root), 'message_edits.db'), (db) => {
      db.exec(`CREATE TABLE message_edits (
        account TEXT NOT NULL, session_id TEXT NOT NULL, db TEXT NOT NULL,
        table_name TEXT NOT NULL, local_id INTEGER NOT NULL,
        first_edited_at INTEGER NOT NULL, last_edited_at INTEGER NOT NULL,
        edit_count INTEGER NOT NULL, original_msg_json TEXT NOT NULL,
        edited_cols_json TEXT, PRIMARY KEY (account, session_id, db, table_name, local_id)
      )`)
      db.prepare(`INSERT INTO message_edits VALUES
        ('account', ?, 'message', ?, 1, 1, 1, 1, '{}', '[]')`).run(hash, tableOf(room))
    })
    expect(listEditedMessages(root).items[0]?.sessionId).toBe(room)

    makeDb(join(root, 'session', 'session.db'), (db) => {
      db.exec('CREATE TABLE SessionTable (username TEXT, draft TEXT)')
      db.prepare('INSERT INTO SessionTable VALUES (?, ?)').run(hash, '旧草稿')
    })
    expect(clearSessionDraft(root, room)).toEqual({ ok: true, updated: 1 })
    const sessionDb = new DatabaseSync(join(root, 'session', 'session.db'), { readOnly: true })
    try {
      expect((sessionDb.prepare('SELECT draft FROM SessionTable').get() as { draft?: string }).draft).toBe('')
    } finally {
      sessionDb.close()
    }

    expect(JSON.stringify({
      note: listNotes(root, DEFAULT_KB_ID),
      tasks: listTasks(root),
      summaries: listSummaryTasks(root),
      records: listSummaryRecords(root),
      edits: listEditedMessages(root).items.map(({ sessionId, localId }) => ({ sessionId, localId })),
    })).not.toContain(hash)
  })
})
