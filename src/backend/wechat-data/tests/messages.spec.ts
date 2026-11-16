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

/** Build `contact.extra_buffer` with protobuf field 2 = enterprise wording id. */
function enterpriseBuffer(wordingId: string): Buffer {
  const value = Buffer.from(wordingId, 'utf8')
  return Buffer.concat([Buffer.from([0x12, value.length]), value])
}

describe('queryMessages / queryNewMessages', () => {
  it('pages newest-first across shards and increments by watermark', async () => {
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

    const anchored = queryMessages(root, talker, 3, undefined, undefined, undefined, 104)
    expect(anchored.messages.map((m) => m.localId)).toEqual([102, 103, 104])
    expect(anchored.hasMore).toBe(true)
    expect(anchored.cursor).toBe(102)
    expect(anchored.cursorLocalId).toBe(102)

    const scoped = await queryMessageByServerId(root, '1104', talker)
    expect(scoped.found).toBe(true)
    expect(scoped.message?.localId).toBe(104)
    expect(scoped.message?.displayText).toBe('msg 104')
    expect((await queryMessageByServerId(root, '1104')).found).toBe(false)

    const delta = queryNewMessages(root, talker, 2, 10)
    // sort_seq > 2: 3,4,5,101..105 = 8 rows; cap 10 returns all.
    expect(delta.messages.length).toBe(8)
    expect(delta.messages[0]?.localId).toBe(3)
    expect(delta.messages[7]?.localId).toBe(105)
  })

  it('单聊接收方向的消息带上 sender（缓存归属可校验），自己发的消息不被标成对方', () => {
    const root = tempRoot()
    const talker = 'wxid_peer'
    const table = 'Msg_' + createHash('md5').update(talker, 'utf8').digest('hex')
    makeDb(join(root, 'message', 'message_0.db'), (db) => {
      db.exec(`CREATE TABLE "${table}" (local_id INTEGER PRIMARY KEY, sort_seq INTEGER, local_type INTEGER, is_sender INTEGER, create_time INTEGER, real_sender_id INTEGER, message_content TEXT, server_id TEXT)`)
      db.exec('CREATE TABLE Name2Id (user_name TEXT)')
      db.exec("INSERT INTO Name2Id (rowid, user_name) VALUES (1, 'wxid_me'), (2, '')")
      const ins = db.prepare(`INSERT INTO "${table}" VALUES (?,?,?,?,?,?,?,?)`)
      ins.run(1, 1, 1, 0, 1700000001, 0, '对方发来的', '1001')
      ins.run(2, 2, 1, 0, 1700000002, 1, '我自己发的', '1002')
    })

    const snap = queryMessages(root, talker, 10, undefined, 'wxid_me')
    const [incoming, mine] = snap.messages
    expect(incoming?.isSender).toBe(0)
    // 前端读渲染缓存时靠这一行判定「这份列表是不是这个会话的」（msg-scope.ts）。
    expect(incoming?.sender, '单聊接收方向不带 sender ⇒ 前端缓存归属校验形同虚设').toBe(talker)
    // 联系人表里查不到这个人：显示名退回「对方」，不能把 wxid 或「未知联系人」写进去。
    expect(incoming?.senderName).toBe('对方')
    expect(mine?.isSender).toBe(1)
    expect(mine?.sender, '自己发的行不该被安上对端身份').toBeUndefined()
  })

  /**
   * 归属判据（2026-11 报障）：真机上分片 Name2Id 里登录账号**有独立命名行**，
   * 空 user_name 行是**另一个群成员** —— 那些行的撤回通知写着别人的名字。
   * 把空名行认成「我」，这个成员的消息会整批画到右侧。
   */
  it('分片有显式账号行时，空名 Name2Id 行的消息不算「我发的」', () => {
    const root = tempRoot()
    const talker = '123@chatroom'
    const table = 'Msg_' + createHash('md5').update(talker, 'utf8').digest('hex')
    makeDb(join(root, 'message', 'message_0.db'), (db) => {
      db.exec(`CREATE TABLE "${table}" (local_id INTEGER PRIMARY KEY, sort_seq INTEGER, local_type INTEGER, is_sender INTEGER, create_time INTEGER, real_sender_id INTEGER, message_content TEXT, server_id TEXT)`)
      db.exec('CREATE TABLE Name2Id (user_name TEXT)')
      db.exec("INSERT INTO Name2Id (rowid, user_name) VALUES (2, 'wxid_me'), (19, '')")
      const ins = db.prepare(`INSERT INTO "${table}" VALUES (?,?,?,?,?,?,?,?)`)
      ins.run(1, 1, 1, 0, 1700000001, 2, '我发的', '1001')
      ins.run(2, 2, 1, 0, 1700000002, 19, '别人发的', '1002')
      ins.run(3, 3, 10000, 0, 1700000003, 19, '"旭动" 撤回了一条消息', '1003')
    })

    const [mine, other, notice] = queryMessages(root, talker, 10, undefined, 'wxid_me').messages
    expect(mine?.isSender).toBe(1)
    expect(other?.isSender, '空名行是另一个成员，却被画成了「我发的」').toBe(0)
    expect(other?.sender, '那个成员没有可解析的 wxid，不能编一个').toBeUndefined()
    expect(notice?.isSender, '别人的撤回通知同样不能算我发的').toBe(0)
  })

  it('分片没有显式账号行时，沿旧约定把空名行当作「我」（老分片兼容）', () => {
    const root = tempRoot()
    const talker = '456@chatroom'
    const table = 'Msg_' + createHash('md5').update(talker, 'utf8').digest('hex')
    makeDb(join(root, 'message', 'message_0.db'), (db) => {
      db.exec(`CREATE TABLE "${table}" (local_id INTEGER PRIMARY KEY, sort_seq INTEGER, local_type INTEGER, is_sender INTEGER, create_time INTEGER, real_sender_id INTEGER, message_content TEXT, server_id TEXT)`)
      db.exec('CREATE TABLE Name2Id (user_name TEXT)')
      db.exec("INSERT INTO Name2Id (rowid, user_name) VALUES (8, ''), (9, 'wxid_member')")
      const ins = db.prepare(`INSERT INTO "${table}" VALUES (?,?,?,?,?,?,?,?)`)
      ins.run(1, 1, 1, 0, 1700000001, 8, '老分片里我发的', '1001')
      ins.run(2, 2, 1, 0, 1700000002, 9, '成员发的', '1002')
    })

    const [mine, member] = queryMessages(root, talker, 10, undefined, 'wxid_me').messages
    expect(mine?.isSender, '没有显式账号行时，空名行是唯一的「我」的线索').toBe(1)
    expect(member?.isSender).toBe(0)
  })

  it('「和自己对话」的会话（talker 就是登录账号）里，消息仍然算我发的', () => {
    const root = tempRoot()
    const self = 'wxid_me'
    const table = 'Msg_' + createHash('md5').update(self, 'utf8').digest('hex')
    makeDb(join(root, 'message', 'message_0.db'), (db) => {
      db.exec(`CREATE TABLE "${table}" (local_id INTEGER PRIMARY KEY, sort_seq INTEGER, local_type INTEGER, is_sender INTEGER, create_time INTEGER, real_sender_id INTEGER, message_content TEXT, server_id TEXT)`)
      db.exec('CREATE TABLE Name2Id (user_name TEXT)')
      db.exec("INSERT INTO Name2Id (rowid, user_name) VALUES (2, 'wxid_me')")
      db.prepare(`INSERT INTO "${table}" VALUES (?,?,?,?,?,?,?,?)`)
        .run(1, 1, 1, 0, 1700000001, 2, '发给自己的一条', '1001')
    })

    const [only] = queryMessages(root, self, 10, undefined, self).messages
    expect(only?.isSender, '自聊会话里我发的消息被当成了对方（画到左边）').toBe(1)
  })

  /**
   * 正文前缀的判据（2026-11 实测）：
   *  · 私聊没有发送者前缀 —— 以 `try:\n` 开头的代码会被旧的「全串搜索 `xxx:\n`」
   *    误认成发送者，于是自己发的消息被画到左边；
   *  · 群聊的前缀必须锚定开头，且 token 必须是本分片 Name2Id 里存在的账号
   *    （真机抽样 96,863/96,863 命中；非锚定命中的唯一一条是正文里的 `android:`）。
   */
  it('正文里的 `xxx:\\n` 不能被当成发送者前缀（私聊/群聊同一判据）', () => {
    const root = tempRoot()
    const peer = 'wxid_peer'
    const peerTable = 'Msg_' + createHash('md5').update(peer, 'utf8').digest('hex')
    const room = '789@chatroom'
    const roomTable = 'Msg_' + createHash('md5').update(room, 'utf8').digest('hex')
    makeDb(join(root, 'message', 'message_0.db'), (db) => {
      db.exec(`CREATE TABLE "${peerTable}" (local_id INTEGER PRIMARY KEY, sort_seq INTEGER, local_type INTEGER, is_sender INTEGER, create_time INTEGER, real_sender_id INTEGER, message_content TEXT, server_id TEXT)`)
      db.exec(`CREATE TABLE "${roomTable}" (local_id INTEGER PRIMARY KEY, sort_seq INTEGER, local_type INTEGER, is_sender INTEGER, create_time INTEGER, real_sender_id INTEGER, message_content TEXT, server_id TEXT)`)
      db.exec('CREATE TABLE Name2Id (user_name TEXT)')
      db.exec("INSERT INTO Name2Id (rowid, user_name) VALUES (1, 'wxid_me'), (2, 'wxid_peer'), (5, 'wxid_other')")
      db.prepare(`INSERT INTO "${peerTable}" VALUES (?,?,?,?,?,?,?,?)`)
        .run(1, 1, 1, 0, 1700000001, 1, 'try:\n   x = 1', '1001')
      const ins = db.prepare(`INSERT INTO "${roomTable}" VALUES (?,?,?,?,?,?,?,?)`)
      ins.run(1, 2, 1, 0, 1700000002, 1, 'try:\n   x = 1', '1002')
      ins.run(2, 3, 1, 0, 1700000003, 5, 'iOS&android:\n下载链接', '1003')
      ins.run(3, 4, 1, 0, 1700000004, 5, 'wxid_other:\n真实前缀', '1004')
    })

    const [mine] = queryMessages(root, peer, 10, undefined, 'wxid_me').messages
    expect(mine?.isSender, '私聊正文里的 `try:` 不是发送者：自己的消息必须还在右边').toBe(1)

    const [roomMine, noise, prefixed] = queryMessages(root, room, 10, undefined, 'wxid_me').messages
    expect(roomMine?.isSender, '群里自己发的代码片段不能被前缀规则翻成对方').toBe(1)
    expect(noise?.isSender).toBe(0)
    expect(noise?.sender, '正文里的 `android:` 不是账号，必须回退到 Name2Id 的发送者').toBe('wxid_other')
    expect(prefixed?.sender, '真实前缀（Name2Id 里存在）仍然优先').toBe('wxid_other')
  })

  it('incremental pages advance through duplicate sort_seq with hasMore and a composite cursor', () => {
    const root = tempRoot()
    const talker = 'wxid_talker'
    const table = 'Msg_' + createHash('md5').update(talker, 'utf8').digest('hex')
    const mkShard = (path: string, rows: Array<[number, number]>): void => {
      makeDb(path, (db) => {
        db.exec(`CREATE TABLE "${table}" (local_id INTEGER PRIMARY KEY, sort_seq INTEGER, local_type INTEGER, is_sender INTEGER, create_time INTEGER, real_sender_id INTEGER, message_content TEXT, server_id TEXT)`)
        db.exec('CREATE TABLE Name2Id (user_name TEXT)')
        const ins = db.prepare(`INSERT INTO "${table}" VALUES (?,?,?,?,?,?,?,?)`)
        for (const [localId, sortSeq] of rows) {
          ins.run(localId, sortSeq, 1, 0, 1700000000 + sortSeq, 1, `msg ${String(localId)}`, String(1000 + localId))
        }
        db.prepare('INSERT INTO Name2Id VALUES (?)').run('wxid_sender')
      })
    }
    mkShard(join(root, 'message', 'message_0.db'), [[1, 5], [2, 5], [3, 5]])
    mkShard(join(root, 'message', 'message_1.db'), [[101, 6], [102, 6]])

    expect(queryNewMessages(root, talker, 5, 10).messages.map((m) => m.localId))
      .toEqual([101, 102])

    const first = queryNewMessages(root, talker, 4, 2)
    expect(first.messages.map((m) => m.localId)).toEqual([1, 2])
    expect(first.hasMore).toBe(true)
    expect([first.cursor, first.cursorLocalId]).toEqual([5, 2])

    const second = queryNewMessages(root, talker, first.cursor ?? -1, 2, undefined, first.cursorLocalId)
    expect(second.messages.map((m) => m.localId)).toEqual([3, 101])
    expect(second.hasMore).toBe(true)
    expect([second.cursor, second.cursorLocalId]).toEqual([6, 101])

    const third = queryNewMessages(root, talker, second.cursor ?? -1, 2, undefined, second.cursorLocalId)
    expect(third.messages.map((m) => m.localId)).toEqual([102])
    expect(third.hasMore).toBe(false)
    expect([third.cursor, third.cursorLocalId]).toEqual([6, 102])
  })

  it('locates a payment message by 64-bit and text server ids', async () => {
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
    const big = await queryMessageByServerId(root, '9007199254740993')
    expect(big.found).toBe(true)
    expect(big.message?.localId).toBe(1)
    expect(big.message?.rich?.type).toBe('transfer')
    const text = await queryMessageByServerId(root, 'pay-1002')
    expect(text.found).toBe(true)
    expect(text.message?.localId).toBe(2)
    expect((await queryMessageByServerId(root, '99999')).found).toBe(false)
  })

  it('resolves the enterprise name for a WeCom contact-card message', () => {
    const root = tempRoot()
    const talker = 'wxid_talker'
    const table = 'Msg_' + createHash('md5').update(talker, 'utf8').digest('hex')
    makeDb(join(root, 'contact', 'contact.db'), (db) => {
      db.exec('CREATE TABLE contact (username TEXT, remark TEXT, nick_name TEXT, extra_buffer BLOB)')
      db.exec('CREATE TABLE openim_wording (wording_id TEXT, wording TEXT)')
      db.prepare('INSERT INTO openim_wording VALUES (?, ?)').run('wording-a', '深度求索')
      db.prepare('INSERT INTO contact VALUES (?, ?, ?, ?)').run(
        'wxid_peer@openim',
        '小深',
        '顾问',
        enterpriseBuffer('wording-a'),
      )
    })
    makeDb(join(root, 'message', 'message_0.db'), (db) => {
      db.exec(`CREATE TABLE "${table}" (
        local_id INTEGER, sort_seq INTEGER, local_type INTEGER, create_time INTEGER,
        real_sender_id INTEGER, message_content TEXT
      )`)
      db.prepare(`INSERT INTO "${table}" VALUES (?, ?, ?, ?, ?, ?)`).run(
        1,
        1,
        42,
        1700000001,
        1,
        '<msg><contact username="wxid_peer@openim" nickname="小深" /></msg>',
      )
    })

    const snap = queryMessages(root, talker, 20)
    expect(snap.messages[0]?.rich).toMatchObject({
      type: 'contact',
      username: 'wxid_peer@openim',
      nickname: '小深',
      enterpriseName: '深度求索',
    })
  })

  it('adds enterprise names to WeCom mentions and merged chat-log senders', () => {
    const root = tempRoot()
    const talker = '123@chatroom'
    const table = 'Msg_' + createHash('md5').update(talker, 'utf8').digest('hex')
    makeDb(join(root, 'contact', 'contact.db'), (db) => {
      db.exec('CREATE TABLE contact (username TEXT, remark TEXT, nick_name TEXT, extra_buffer BLOB)')
      db.exec('CREATE TABLE openim_wording (wording_id TEXT, wording TEXT)')
      db.prepare('INSERT INTO openim_wording VALUES (?, ?)').run('wording-a', '深度求索')
      db.prepare('INSERT INTO contact VALUES (?, ?, ?, ?)').run(
        'wxid_peer@openim',
        '小深',
        '顾问',
        enterpriseBuffer('wording-a'),
      )
    })
    makeDb(join(root, 'message', 'message_0.db'), (db) => {
      db.exec(`CREATE TABLE "${table}" (
        local_id INTEGER, sort_seq INTEGER, local_type INTEGER, create_time INTEGER,
        real_sender_id INTEGER, message_content TEXT, source TEXT
      )`)
      const insert = db.prepare(`INSERT INTO "${table}" VALUES (?, ?, ?, ?, ?, ?, ?)`)
      insert.run(
        1,
        1,
        1,
        1700000001,
        0,
        '@小深 看下',
        '<msgsource><atuserlist><![CDATA[wxid_peer@openim]]></atuserlist></msgsource>',
      )
      insert.run(
        2,
        2,
        49,
        1700000002,
        0,
        '<msg><appmsg><title>聊天记录</title><type>19</type><recorditem><![CDATA['
          + '<recordinfo><datalist><dataitem datatype="1" datasourceid="wxid_peer@openim">'
          + '<sourcename>小深</sourcename><datadesc>合并记录正文</datadesc>'
          + '</dataitem></datalist></recordinfo>]]></recorditem></appmsg></msg>',
        '',
      )
    })

    const snap = queryMessages(root, talker, 20)
    expect(snap.messages[0]?.atUsers?.[0]).toMatchObject({
      username: 'wxid_peer@openim',
      displayName: '小深',
      enterpriseName: '深度求索',
    })
    expect(snap.messages[1]?.rich?.records?.[0]).toMatchObject({
      name: '小深',
      sourceUsername: 'wxid_peer@openim',
      enterpriseName: '深度求索',
    })
  })
})

describe('M11：按 server_id 查询带签名缓存', () => {
  it('同一 id 重复查询命中缓存（返回同一个对象），分片一变就失效', async () => {
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

    // 2026-09-28：`queryMessageByServerId` 改 async（逐分片扫描要让出，实测独占 84ms）。
    // ⚠️ `toBe` 必须比**解析出来的对象**：每次调用返回的都是新 Promise，
    // 直接比 Promise 会恒不相等 ⇒ 这条"命中缓存返回同一对象"的判据会退化成恒假。
    const a = await queryMessageByServerId(root, 'cache-1')
    expect(a.found).toBe(true)
    const b = await queryMessageByServerId(root, 'cache-1')
    expect(b).toBe(a) // 命中缓存：同一个对象（`cachedBySigAsync` 的行为）

    // 负结果同样被缓存
    const miss1 = await queryMessageByServerId(root, 'nope-1')
    expect(miss1.found).toBe(false)
    expect(await queryMessageByServerId(root, 'nope-1')).toBe(miss1)

    // 分片被替换（同步的原子替换只改 mtime/size）⇒ 签名变化 ⇒ 缓存失效
    const t = new Date(Date.now() + 5000)
    utimesSync(shard, t, t)
    expect(await queryMessageByServerId(root, 'cache-1')).not.toBe(a)
    expect(await queryMessageByServerId(root, 'nope-1')).not.toBe(miss1)
  })

  it('缓存不会跨数据根串味（key 里带 decryptedDir）', async () => {
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
    expect((await queryMessageByServerId(r1, 'dup-1')).found).toBe(true)
    expect((await queryMessageByServerId(r2, 'dup-1')).found).toBe(false)
  })
})
