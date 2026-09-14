/**
 * Message keyset pagination and incremental fetch over multi-shard fixtures.
 * @vitest-environment node
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { queryMessages, queryMessageByServerId, queryNewMessages } from '../src/query/messages.ts'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
})

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wx-msg-'))
  scratch.push(dir)
  return dir
}

function makeDb(path: string, create: (db: DatabaseSync) => void): void {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  try { create(db) } finally { db.close() }
}

describe('queryMessages / queryNewMessages', () => {
  it('pages newest-first across shards and increments by watermark', () => {
    const root = tempRoot()
    const talker = 'wxid_talker'
    const table = 'Msg_' + createHash('md5').update(talker, 'utf8').digest('hex')
    const mkShard = (path: string, seqBase: number): void => {
      makeDb(path, (db) => {
        db.exec(`CREATE TABLE "${table}" (local_id INTEGER PRIMARY KEY, sort_seq INTEGER, local_type INTEGER, is_sender INTEGER, create_time INTEGER, real_sender_id INTEGER, message_content TEXT, server_id TEXT)`)
        db.exec('CREATE TABLE Name2Id (user_name TEXT)')
        const ins = db.prepare(`INSERT INTO "${table}" VALUES (?,?,?,?,?,?,?,?)`)
        for (let i = 0; i < 5; i += 1) {
          const seq = seqBase + i
          ins.run(seq, seq, 1, 0, 1700000000 + seq, 1, `msg ${seq}`, String(1000 + seq))
        }
        db.prepare('INSERT INTO Name2Id VALUES (?)').run('wxid_sender')
      })
    }
    mkShard(join(root, 'message', 'message_0.db'), 1)
    mkShard(join(root, 'message', 'message_1.db'), 101)

    const first = queryMessages(root, talker, 5)
    expect(first.total).toBe(10)
    expect(first.messages.length).toBe(5)
    expect(first.messages[0]?.localId).toBe(101)
    expect(first.messages[4]?.localId).toBe(105)
    expect(first.typeStats?.[0]?.count).toBe(10)
    expect(first.cursor).toBe(101)

    const second = queryMessages(root, talker, 5, first.cursor)
    expect(second.messages.length).toBe(5)
    expect(second.messages[0]?.localId).toBe(1)
    expect(second.messages[4]?.localId).toBe(5)
    expect(second.hasMore).toBe(false)

    const delta = queryNewMessages(root, talker, 2, 10)
    // sort_seq > 2: 3,4,5,101..105 = 8 rows; cap 10 returns all.
    expect(delta.messages.length).toBe(8)
    expect(delta.messages[0]?.localId).toBe(3)
    expect(delta.messages[7]?.localId).toBe(105)
  })

  it('locates a payment message by 64-bit and text server ids', () => {
    const root = tempRoot()
    const talker = 'wxid_pay'
    const table = 'Msg_' + createHash('md5').update(talker, 'utf8').digest('hex')
    // 真实微信把子类型写成 <appmsg> 的**子元素** <type>，不是属性 ——
    // parse.ts 的 parseAppmsgType 只读子元素，属性写法解析出 0、会落到 default 分支。
    const XML = '<msg><appmsg><type>2000</type><wcpayinfo><feedesc>￥10.00</feedesc></wcpayinfo></appmsg></msg>'
    makeDb(join(root, 'message', 'message_1.db'), (db) => {
      db.exec(`CREATE TABLE "${table}" (local_id INTEGER, sort_seq INTEGER, local_type INTEGER, is_sender INTEGER, create_time INTEGER, real_sender_id INTEGER, message_content TEXT, server_id INTEGER)`)
      // >2^53 的 server_id 按 INTEGER 存储：整型等值路径必须原样命中。
      db.prepare(`INSERT INTO "${table}" VALUES (?,?,?,?,?,?,?,?)`).run(1, 1, 49, 0, 1700000001, 1, XML, 9007199254740993n)
      db.prepare(`INSERT INTO "${table}" VALUES (?,?,?,?,?,?,?,?)`).run(2, 2, 49, 0, 1700000002, 1, XML, 'pay-1002')
    })
    const big = queryMessageByServerId(root, '9007199254740993')
    expect(big.found).toBe(true)
    expect(big.message?.localId).toBe(1)
    expect(big.message?.rich?.type).toBe('transfer')
    const text = queryMessageByServerId(root, 'pay-1002')
    expect(text.found).toBe(true)
    expect(text.message?.localId).toBe(2)
    expect(queryMessageByServerId(root, '99999').found).toBe(false)
  })
})

describe('M11：按 server_id 查询带签名缓存', () => {
  it('同一 id 重复查询命中缓存（返回同一个对象），分片一变就失效', () => {
    // 为什么值得缓存：本机实测「命中」1.8ms，而**未命中** 80ms（两轮扫描 × 304 张 Msg 表）。
    // 调用方是用户点开合并聊天记录这种**用户触发**动作，负结果缓存直接消掉
    // 「点了没找到 → 同步完再点」的重复代价。
    const root = tempRoot()
    const talker = 'wxid_cache'
    const table = 'Msg_' + createHash('md5').update(talker, 'utf8').digest('hex')
    const XML = '<msg><appmsg><type>2000</type><wcpayinfo><feedesc>￥1.00</feedesc></wcpayinfo></appmsg></msg>'
    const shard = join(root, 'message', 'message_3.db')
    makeDb(shard, (db) => {
      db.exec(`CREATE TABLE "${table}" (local_id INTEGER, sort_seq INTEGER, local_type INTEGER, create_time INTEGER, real_sender_id INTEGER, message_content TEXT, server_id TEXT)`)
      db.prepare(`INSERT INTO "${table}" VALUES (?,?,?,?,?,?,?)`).run(1, 1, 49, 1700000001, 1, XML, 'cache-1')
    })

    const a = queryMessageByServerId(root, 'cache-1')
    expect(a.found).toBe(true)
    const b = queryMessageByServerId(root, 'cache-1')
    expect(b).toBe(a) // 命中缓存：同一个对象（`cachedBySig` 的行为）

    // 负结果同样被缓存
    const miss1 = queryMessageByServerId(root, 'nope-1')
    expect(miss1.found).toBe(false)
    expect(queryMessageByServerId(root, 'nope-1')).toBe(miss1)

    // 分片被替换（同步的原子替换只改 mtime/size）⇒ 签名变化 ⇒ 缓存失效
    const t = new Date(Date.now() + 5000)
    utimesSync(shard, t, t)
    expect(queryMessageByServerId(root, 'cache-1')).not.toBe(a)
    expect(queryMessageByServerId(root, 'nope-1')).not.toBe(miss1)
  })

  it('缓存不会跨数据根串味（key 里带 decryptedDir）', () => {
    const r1 = tempRoot()
    const r2 = tempRoot()
    const talker = 'wxid_two'
    const table = 'Msg_' + createHash('md5').update(talker, 'utf8').digest('hex')
    const XML = '<msg><appmsg><type>2000</type><wcpayinfo><feedesc>￥2.00</feedesc></wcpayinfo></appmsg></msg>'
    makeDb(join(r1, 'message', 'message_0.db'), (db) => {
      db.exec(`CREATE TABLE "${table}" (local_id INTEGER, sort_seq INTEGER, local_type INTEGER, create_time INTEGER, real_sender_id INTEGER, message_content TEXT, server_id TEXT)`)
      db.prepare(`INSERT INTO "${table}" VALUES (?,?,?,?,?,?,?)`).run(1, 1, 49, 1700000001, 1, XML, 'dup-1')
    })
    // r2 里没有这条消息
    makeDb(join(r2, 'message', 'message_0.db'), (db) => {
      db.exec(`CREATE TABLE "${table}" (local_id INTEGER, sort_seq INTEGER, local_type INTEGER, create_time INTEGER, real_sender_id INTEGER, message_content TEXT, server_id TEXT)`)
    })
    expect(queryMessageByServerId(r1, 'dup-1').found).toBe(true)
    expect(queryMessageByServerId(r2, 'dup-1').found).toBe(false)
  })
})
