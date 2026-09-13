/**
 * Funds ledger aggregation over a minimal decrypted fixture: transfer and
 * red-packet rows in general.db plus payment messages in a shard DB.
 * @vitest-environment node
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { queryLedger } from '../src/query/ledger.ts'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
})

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wx-ledger-'))
  scratch.push(dir)
  return dir
}

function makeDb(path: string, create: (db: DatabaseSync) => void): void {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  try { create(db) } finally { db.close() }
}

// 子类型是 <appmsg> 的**子元素** <type>（真实格式），不是属性：
// parse.ts 的 parseAppmsgType 只读子元素，属性写法会解析成 0 并落到 default 分支。
const TRANSFER_XML = '<msg><appmsg><type>2000</type><wcpayinfo><paysubtype>3</paysubtype><feedesc>￥10.00</feedesc></wcpayinfo></appmsg></msg>'
const REDPACKET_XML = '<msg><appmsg><type>2001</type><wcpayinfo><feedesc>￥8.88</feedesc></wcpayinfo></appmsg></msg>'

describe('queryLedger', () => {
  it('aggregates transfer and red-packet amounts with direction and contact names', () => {
    const root = tempRoot()
    const ts = Math.floor(new Date(2026, 8, 1, 12).getTime() / 1000)
    const msgTable = 'Msg_' + createHash('md5').update('wxid_a', 'utf8').digest('hex')
    makeDb(join(root, 'contact', 'contact.db'), (db) => {
      db.exec('CREATE TABLE contact (id INTEGER PRIMARY KEY, username TEXT, remark TEXT, nick_name TEXT)')
      db.prepare('INSERT INTO contact (id, username, remark, nick_name) VALUES (1, ?, ?, ?)').run('wxid_a', '张三', 'zhangsan')
    })
    makeDb(join(root, 'general', 'general.db'), (db) => {
      db.exec('CREATE TABLE transferTable (session_name TEXT, message_server_id INTEGER, second_message_server_id INTEGER, pay_receiver TEXT, pay_payer TEXT, begin_transfer_time INTEGER, invalid_time INTEGER)')
      db.exec('CREATE TABLE redEnvelopeTable (session_name TEXT, message_server_id INTEGER, sender_user_name TEXT, hb_status INTEGER)')
      db.prepare('INSERT INTO transferTable VALUES (?, ?, ?, ?, ?, ?, ?)').run('wxid_a', 1001, 0, 'wxid_a', 'wxid_b', ts, 0)
      db.prepare('INSERT INTO redEnvelopeTable VALUES (?, ?, ?, ?)').run('wxid_a', 1002, 'wxid_a', 1)
    })
    makeDb(join(root, 'message', 'message_1.db'), (db) => {
      db.exec(`CREATE TABLE "${msgTable}" (local_id INTEGER, create_time INTEGER, local_type INTEGER, message_content TEXT, server_id INTEGER)`)
      db.prepare(`INSERT INTO "${msgTable}" VALUES (?, ?, ?, ?, ?)`).run(1, ts, 49, TRANSFER_XML, 1001)
      db.prepare(`INSERT INTO "${msgTable}" VALUES (?, ?, ?, ?, ?)`).run(2, ts, 49, REDPACKET_XML, 1002)
    })

    const snap = queryLedger(root, '2026-09', 'wxid_b')
    expect(snap.summary.transfers).toBe(1)
    expect(snap.summary.transferOut).toBe(1)
    expect(snap.summary.transferAmountOut).toBe(10)
    expect(snap.summary.redpacketsReceived).toBe(1)
    expect(snap.summary.redpacketAmountReceived).toBeCloseTo(8.88)
    expect(snap.byContact.some(r => r.name === '张三' && r.direction === 'out' && r.amount === 10)).toBe(true)
    expect(snap.byContact.some(r => r.name === '张三' && r.direction === 'in' && r.amount === 8.88)).toBe(true)
    expect(snap.redpacket.receivedAmount).toBeCloseTo(8.88)
  })

  it('resolves text/64-bit/non-numeric server ids via indexed pass and CAST fallback', () => {
    const root = tempRoot()
    const ts = Math.floor(new Date(2026, 8, 1, 12).getTime() / 1000)
    const msgTable = 'Msg_' + createHash('md5').update('wxid_a', 'utf8').digest('hex')
    makeDb(join(root, 'contact', 'contact.db'), (db) => {
      db.exec('CREATE TABLE contact (id INTEGER PRIMARY KEY, username TEXT, remark TEXT, nick_name TEXT)')
      db.prepare('INSERT INTO contact (id, username, remark, nick_name) VALUES (1, ?, ?, ?)').run('wxid_a', '张三', 'zhangsan')
      db.prepare('INSERT INTO contact (id, username, remark, nick_name) VALUES (2, ?, ?, ?)').run('wxid_b', '李四', 'lisi')
    })
    makeDb(join(root, 'general', 'general.db'), (db) => {
      db.exec('CREATE TABLE transferTable (session_name TEXT, message_server_id INTEGER, second_message_server_id INTEGER, pay_receiver TEXT, pay_payer TEXT, begin_transfer_time INTEGER, invalid_time INTEGER)')
      db.prepare('INSERT INTO transferTable VALUES (?, ?, ?, ?, ?, ?, ?)').run('wxid_a', '01001', 0, 'wxid_a', 'me', ts, 0)
      // >2^53 的 64 位 server_id：以 BigInt 绑定走整型等值（不用 CAST 全表扫）。
      db.prepare('INSERT INTO transferTable VALUES (?, ?, ?, ?, ?, ?, ?)').run('wxid_a', 9007199254740993n, 0, 'me', 'wxid_b', ts, 0)
      // 非纯数字 id：整型等值不适用，走 CAST(server_id AS TEXT) 兜底。
      db.prepare('INSERT INTO transferTable VALUES (?, ?, ?, ?, ?, ?, ?)').run('wxid_a', 'ts-1003', 0, 'wxid_a', 'me', ts, 0)
    })
    makeDb(join(root, 'message', 'message_1.db'), (db) => {
      db.exec(`CREATE TABLE "${msgTable}" (local_id INTEGER, create_time INTEGER, local_type INTEGER, message_content TEXT, server_id INTEGER)`)
      // 前导零 id 按 TEXT 存储：SQLite 数值亲和使整型等值(1001)依然命中。
      db.prepare(`INSERT INTO "${msgTable}" VALUES (?, ?, ?, ?, ?)`).run(1, ts, 49, TRANSFER_XML, '01001')
      db.prepare(`INSERT INTO "${msgTable}" VALUES (?, ?, ?, ?, ?)`).run(2, ts, 49, REDPACKET_XML, 9007199254740993n)
      db.prepare(`INSERT INTO "${msgTable}" VALUES (?, ?, ?, ?, ?)`).run(3, ts, 49, TRANSFER_XML, 'ts-1003')
    })

    const snap = queryLedger(root, '2026-09', 'me')
    expect(snap.summary.transfers).toBe(3)
    expect(snap.summary.transferOut).toBe(2)
    expect(snap.summary.transferIn).toBe(1)
    expect(snap.summary.transferAmountOut).toBe(20)
    expect(snap.summary.transferAmountIn).toBeCloseTo(8.88)
  })
})
