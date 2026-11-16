/**
 * P2：会话未读的 N+1 查询。
 *
 * 旧实现对最多 80 个未读会话逐个 `CAST(server_id AS TEXT) = ?`，每次都要把含该
 * Msg_ 表的分片重新 open/close；本用例把「批量解析」的行为钉住：
 *   · 多个会话（跨分片、server_id 为 INTEGER 与 TEXT 两种形态）都能解析；
 *   · 同一张表在第一个分片只有 create_time=0 时，继续到后面的分片找（保留旧优先级）；
 *   · 解析不到的会话不写 `unreadSince`，unread=0 的会话不做无效查询；
 *   · `querySessions` 的排序 / 未读计数不受影响。
 * @vitest-environment node
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { msgCreateTimesByServerIds } from '../src/query/messages.ts'
import { querySessions } from '../src/query/sessions.ts'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0, scratch.length)) rmSync(dir, { recursive: true, force: true })
})

function makeDb(path: string, create: (db: DatabaseSync) => void): void {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  try { create(db) } finally { db.close() }
}

function tableFor(talker: string): string {
  return 'Msg_' + createHash('md5').update(talker, 'utf8').digest('hex')
}

/** 在指定分片里建 `Msg_<md5>` 表并插入 `(localId, serverId, createTime)`。 */
function addMessages(
  shardPath: string,
  talker: string,
  rows: Array<{ localId: number; serverId: string; createTime: number }>,
  serverIdType: 'TEXT' | 'INTEGER' = 'TEXT',
): void {
  makeDb(shardPath, (db) => {
    const table = tableFor(talker)
    db.exec(`CREATE TABLE "${table}" (local_id INTEGER, sort_seq INTEGER, local_type INTEGER, is_sender INTEGER, create_time INTEGER, real_sender_id INTEGER, message_content TEXT, server_id ${serverIdType})`)
    const ins = db.prepare(`INSERT INTO "${table}" VALUES (?,?,?,?,?,?,?,?)`)
    for (const row of rows) {
      // server_id 列在真实库里既可能是 INTEGER 也可能是 TEXT；两种都造一份。
      const value = serverIdType === 'INTEGER' ? Number(row.serverId) : row.serverId
      ins.run(row.localId, row.localId, 1, 0, row.createTime, 1, 'msg', value)
    }
  })
}

/**
 * 造 5 个会话：
 *   s1/s2 —— server_id 分别是 TEXT / INTEGER 形态，各在一个分片；
 *   s3    —— 表同时出现在两个分片：第一个分片 create_time=0，第二个才是真实时间；
 *   s4    —— unread>0 但消息表里没有该 server_id（不写 unreadSince）；
 *   s5    —— unread=0（不该进入未读回查）。
 */
function makeSessionsFixture(): {
  decrypted: string
  sessions: Array<{ username: string; unread: number; srv: string; expected?: number }>
} {
  const base = mkdtempSync(join(tmpdir(), 'wx-p2-sessions-'))
  scratch.push(base)
  const decrypted = join(base, 'decrypted')
  mkdirSync(join(decrypted, 'message'), { recursive: true })
  mkdirSync(join(decrypted, 'session'), { recursive: true })

  const sessions = [
    { username: 'wxid_s1', unread: 3, srv: '111', expected: 1700000100 },
    { username: 'wxid_s2', unread: 2, srv: '222', expected: 1700000200 },
    { username: 'wxid_s3', unread: 1, srv: '333', expected: 1700000300 },
    { username: 'wxid_s4', unread: 4, srv: '444' },
    { username: 'wxid_s5', unread: 0, srv: '555' },
  ]

  makeDb(join(decrypted, 'session', 'session.db'), (db) => {
    db.exec(`CREATE TABLE SessionTable (
      username TEXT, unread_count INTEGER, unread_first_msg_srv_id TEXT,
      last_timestamp INTEGER, sort_timestamp INTEGER, summary TEXT, draft TEXT,
      is_hidden INTEGER, last_msg_type INTEGER, last_msg_sub_type INTEGER,
      last_msg_sender TEXT, last_sender_display_name TEXT
    )`)
    const ins = db.prepare(`INSERT INTO SessionTable
      (username, unread_count, unread_first_msg_srv_id, last_timestamp, sort_timestamp,
       summary, draft, is_hidden, last_msg_type, last_msg_sub_type, last_msg_sender, last_sender_display_name)
      VALUES (?, ?, ?, ?, ?, '', NULL, 0, 1, 0, '', '')`)
    for (let i = 0; i < sessions.length; i += 1) {
      const s = sessions[i]!
      // 倒序写入时间，确认排序仍按 sort_timestamp DESC。
      ins.run(s.username, s.unread, s.srv, 1700000000 + i, 1700000000 + i)
    }
  })

  // 分片 0：s1(TEXT) + s3 的 create_time=0 行 + s4 的“无关”行
  addMessages(join(decrypted, 'message', 'message_0.db'), 'wxid_s1', [
    { localId: 1, serverId: '111', createTime: 1700000100 },
  ])
  addMessages(join(decrypted, 'message', 'message_0.db'), 'wxid_s3', [
    { localId: 1, serverId: '333', createTime: 0 },
  ])
  addMessages(join(decrypted, 'message', 'message_0.db'), 'wxid_s4', [
    { localId: 1, serverId: '999', createTime: 1700000400 },
  ])
  // 分片 1：s2(INTEGER) + s3 的真实行 + s5（unread=0，不应被读）
  addMessages(join(decrypted, 'message', 'message_1.db'), 'wxid_s2', [
    { localId: 1, serverId: '222', createTime: 1700000200 },
  ], 'INTEGER')
  addMessages(join(decrypted, 'message', 'message_1.db'), 'wxid_s3', [
    { localId: 2, serverId: '333', createTime: 1700000300 },
  ])
  addMessages(join(decrypted, 'message', 'message_1.db'), 'wxid_s5', [
    { localId: 1, serverId: '555', createTime: 1700000500 },
  ])

  return { decrypted, sessions }
}

describe('msgCreateTimesByServerIds：批量未读起点', () => {
  it('跨分片、TEXT/INTEGER 两种 server_id 都能解析，且按入参顺序返回', () => {
    const { decrypted } = makeSessionsFixture()
    const times = msgCreateTimesByServerIds(decrypted, [
      { talker: 'wxid_s1', serverId: '111' },
      { talker: 'wxid_s2', serverId: '222' },
      // s3 在第一个分片只有 create_time=0，必须继续到第二个分片。
      { talker: 'wxid_s3', serverId: '333' },
      // 表里没有这个 server_id。
      { talker: 'wxid_s4', serverId: '444' },
      // 无效输入不应触发查询。
      { talker: 'wxid_s5', serverId: '0' },
      { talker: '', serverId: '111' },
    ])
    expect(times).toEqual([1700000100, 1700000200, 1700000300, null, null, null])
  })

  it('空入参返回空数组（不会开库）', () => {
    const { decrypted } = makeSessionsFixture()
    expect(msgCreateTimesByServerIds(decrypted, [])).toEqual([])
  })
})

describe('querySessions：未读起点批量填充', () => {
  it('一页多会话的 unreadSince 全部正确，排序与未读计数不变', async () => {
    const { decrypted, sessions } = makeSessionsFixture()
    const snap = await querySessions(decrypted, undefined, 80)
    const byName = new Map(snap.sessions.map((s) => [s.username, s]))

    expect(snap.total).toBe(sessions.length)
    for (const s of sessions) {
      const actual = byName.get(s.username)
      expect(actual, `${s.username} 未返回`).toBeDefined()
      expect(actual?.unreadCount).toBe(s.unread)
      if (s.expected === undefined) expect(actual?.unreadSince).toBeUndefined()
      else expect(actual?.unreadSince).toBe(s.expected)
    }
    // 排序仍是 last_timestamp DESC（夹具里 s5 最新）。
    expect(snap.sessions.map((s) => s.username)).toEqual([
      'wxid_s5', 'wxid_s4', 'wxid_s3', 'wxid_s2', 'wxid_s1',
    ])
  })

  it('分页只解析当前页里的未读会话（不去碰页外会话）', async () => {
    const { decrypted } = makeSessionsFixture()
    const snap = await querySessions(decrypted, undefined, 1)
    expect(snap.sessions.length).toBe(1)
    expect(snap.sessions[0]?.username).toBe('wxid_s5')
    // s5 的 unread=0，不应有 unreadSince（即便消息分片里能查到该 srv）。
    expect(snap.sessions[0]?.unreadSince).toBeUndefined()
  })
})
