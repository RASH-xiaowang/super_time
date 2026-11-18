/**
 * 结构化上下文条目（`collectReplyContextEntries`）。
 *
 * 两条最要紧的性质：
 *   ① entries 保留**完整**正文与身份字段；300 字头部截断只发生在 `collectReplyContext` 的行上；
 *   ② 同一次夹具下，旧接口的行 / latestPeer / targetLine / imageCandidates 与条目映射逐字一致。
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  collectReplyContext,
  collectReplyContextEntries,
} from '../src/query/reply-suggest.ts'

const scratch: string[] = []
afterEach(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
  scratch.length = 0
})

interface Row {
  talker: string
  localId: number
  text: string
  fromSelf: boolean
  /** 群成员 wxid；单聊夹具可省略。 */
  sender?: string
  /** local_type；缺省为文本消息。 */
  type?: number
}

/** 造一个最小可用的解密目录：会话表 + 每个 talker 一张 Msg_ 表。 */
function makeFixture(rows: Row[]): string {
  const root = mkdtempSync(join(tmpdir(), 'wx-rce-'))
  scratch.push(root)
  const decrypted = join(root, 'decrypted')
  mkdirSync(join(decrypted, 'session'), { recursive: true })
  mkdirSync(join(decrypted, 'message'), { recursive: true })

  const sdb = new DatabaseSync(join(decrypted, 'session', 'session.db'))
  sdb.exec('CREATE TABLE SessionTable (username TEXT, type TEXT, last_timestamp INTEGER, sort_timestamp INTEGER, unread_count INTEGER, last_msg_type INTEGER, last_msg_sender TEXT)')
  const insS = sdb.prepare('INSERT INTO SessionTable (username, type, last_timestamp, sort_timestamp, unread_count, last_msg_type, last_msg_sender) VALUES (?, ?, 1700000000, 1700000000, 0, 1, \'\')')
  for (const talker of new Set(rows.map(r => r.talker))) insS.run(talker, 'private')
  sdb.close()

  const mdb = new DatabaseSync(join(decrypted, 'message', 'message_0.db'))
  // 发送者身份靠分片的 Name2Id 解析（WeChat 4.x 的 Msg 表没有 is_sender 列），
  // 所以夹具必须建这张表，否则连「我发的」都推不出来。
  mdb.exec('CREATE TABLE Name2Id (user_name TEXT)')
  const insN = mdb.prepare('INSERT INTO Name2Id (user_name) VALUES (?)')
  insN.run(SELF)
  insN.run(SELF)
  insN.run(SELF)
  const senderIds = new Map<string, number>()
  for (const sender of new Set(rows.map(r => r.sender).filter((x): x is string => Boolean(x)))) {
    const result = insN.run(sender)
    senderIds.set(sender, Number(result.lastInsertRowid))
  }
  for (const talker of new Set(rows.map(r => r.talker))) {
    const t = 'Msg_' + createHash('md5').update(talker, 'utf8').digest('hex')
    mdb.exec(`CREATE TABLE "${t}" (local_id INTEGER, sort_seq INTEGER, local_type INTEGER, is_sender INTEGER, create_time INTEGER, real_sender_id INTEGER, message_content TEXT, server_id INTEGER, compress_content TEXT)`)
    const ins = mdb.prepare(`INSERT INTO "${t}" VALUES (?,?,?,?,?,?,?,?,?)`)
    mdb.exec('BEGIN')
    for (const r of rows.filter(x => x.talker === talker)) {
      // Name2Id 是分片级 rowid -> wxid 映射；自定义 sender 必须先在表里占一行。
      const senderId = r.fromSelf ? 3 : (r.sender === undefined ? 9 : (senderIds.get(r.sender) ?? 9))
      ins.run(r.localId, r.localId, r.type ?? 1, r.fromSelf ? 1 : 0, 1700000000 + r.localId, senderId, r.text, r.localId, '')
    }
    mdb.exec('COMMIT')
  }
  mdb.close()
  return decrypted
}

const PEER = 'wxid_peer'
const SELF = 'wxid_me'

/** 与 `collectReplyContext` 的行口径一致：只保留头部 300 字。 */
function truncateHead(text: string): string {
  return text.length > 300 ? text.slice(0, 300) + '…' : text
}

describe('collectReplyContextEntries', () => {
  it('条目携带 localId/createTime/isSender/speaker 与完整长文本', () => {
    const long = `第一行\n第二行   ${'长'.repeat(320)}\n\n结尾`
    const flat = long.trim().replace(/\s+/g, ' ')
    const dir = makeFixture([
      { talker: PEER, localId: 1, text: long, fromSelf: false },
      { talker: PEER, localId: 2, text: '收到', fromSelf: true },
    ])
    const ctx = collectReplyContextEntries(dir, PEER, SELF)

    expect(ctx.entries).toHaveLength(2)
    expect(ctx.entries[0]).toMatchObject({
      localId: 1,
      createTime: 1700000001,
      isSender: false,
      speaker: '对方',
      text: flat,
    })
    expect(ctx.entries[0]?.text.length).toBeGreaterThan(300)
    expect(ctx.entries[0]?.text.endsWith('…')).toBe(false)
    expect(ctx.entries[1]).toMatchObject({
      localId: 2,
      createTime: 1700000002,
      isSender: true,
      speaker: '我',
      text: '收到',
    })
    expect(ctx.entries.every((entry) => entry.image === undefined)).toBe(true)
    expect(ctx.count).toBe(2)
    // 汇总字段仍沿用旧口径（截断），完整正文只在 entries 里。
    expect(ctx.latestPeer).toBe(truncateHead(flat))
  })

  it('collectReplyContext.lines 恰好等于 entries 经 300 字头部截断后的映射', () => {
    const long = '甲'.repeat(350)
    const dir = makeFixture([
      { talker: PEER, localId: 1, text: long, fromSelf: false },
      { talker: PEER, localId: 2, text: '好的\n我看看', fromSelf: true },
      { talker: PEER, localId: 3, text: '谢谢', fromSelf: false },
    ])
    const entries = collectReplyContextEntries(dir, PEER, SELF)
    const context = collectReplyContext(dir, PEER, SELF)

    expect(context.lines).toEqual(
      entries.entries.map((entry) => `${entry.speaker}：${truncateHead(entry.text)}`),
    )
    expect(context.lines[0]).toBe(`对方：${'甲'.repeat(300)}…`)
    expect(context.lines[1]).toBe('我：好的 我看看')
    expect(context.latestPeer).toBe(entries.latestPeer)
    expect(context.targetLine).toBe(entries.targetLine)
    expect(context.targetLine).toBe('对方：谢谢')
    expect(context.count).toBe(entries.count)
    expect(context.imageCandidates).toBeUndefined()
  })

  it('视觉消息的 entry.image 与 imageCandidates 同源且顺序不变', () => {
    const stickerMd5 = '0123456789abcdef0123456789abcdef'
    const dir = makeFixture([
      { talker: PEER, localId: 10, type: 3, text: '<msg><img md5="aabbccdd"/></msg>', fromSelf: false },
      {
        talker: PEER,
        localId: 11,
        type: 47,
        text: `<msg><emoji md5="${stickerMd5}" cdnurl="https://mmbiz.qpic.cn/example.gif"/></msg>`,
        fromSelf: false,
      },
      { talker: PEER, localId: 12, text: '这两张怎么样', fromSelf: true },
    ])
    const ctx = collectReplyContextEntries(dir, PEER, SELF)

    expect(ctx.entries.map((entry) => entry.text)).toEqual(['[图片]', '[表情]', '这两张怎么样'])
    expect(ctx.entries[0]?.image).toEqual({ localId: 10 })
    expect(ctx.entries[1]?.image).toEqual({
      localId: 11,
      kind: 'sticker',
      md5: stickerMd5,
      emojiUrl: 'https://mmbiz.qpic.cn/example.gif',
    })
    expect(ctx.entries[2]?.image).toBeUndefined()
    expect(ctx.imageCandidates).toEqual([
      { localId: 10 },
      { localId: 11, kind: 'sticker', md5: stickerMd5, emojiUrl: 'https://mmbiz.qpic.cn/example.gif' },
    ])
    expect(ctx.entries[0]?.image).toEqual(ctx.imageCandidates?.[0])
    expect(ctx.entries[1]?.image).toEqual(ctx.imageCandidates?.[1])
  })

  it('指定 targetLocalId 时只到该条为止，targetFound/targetLine 正确', () => {
    const dir = makeFixture([
      { talker: PEER, localId: 1, text: '早上好', fromSelf: false },
      { talker: PEER, localId: 2, text: '早，刚起', fromSelf: true },
      { talker: PEER, localId: 3, text: '我也起来了', fromSelf: false },
      { talker: PEER, localId: 4, text: '那中午一起吃饭', fromSelf: true },
      { talker: PEER, localId: 5, text: '好呀', fromSelf: false },
    ])
    const ctx = collectReplyContextEntries(dir, PEER, SELF, 20, 3)

    expect(ctx.entries.map((entry) => entry.localId)).toEqual([1, 2, 3])
    expect(ctx.targetFound).toBe(true)
    expect(ctx.targetSpeaker).toBe('对方')
    expect(ctx.targetLine).toBe('对方：我也起来了')
    expect(ctx.latestPeer).toBe('我也起来了')
    expect(ctx.count).toBe(3)
    // 旧接口在同一目标下仍是相同的行与目标行。
    const context = collectReplyContext(dir, PEER, SELF, 20, 3)
    expect(context.lines).toEqual(
      ctx.entries.map((entry) => `${entry.speaker}：${truncateHead(entry.text)}`),
    )
    expect(context.targetLine).toBe(ctx.targetLine)
    expect(context.targetFound).toBe(true)
  })

  it('目标消息不存在时返回空条目与 targetFound=false', () => {
    const dir = makeFixture([{ talker: PEER, localId: 1, text: '最新消息', fromSelf: false }])
    const ctx = collectReplyContextEntries(dir, PEER, SELF, 20, 99)

    expect(ctx).toEqual({ entries: [], latestPeer: '', count: 0, targetFound: false, targetLine: '' })
  })

  it('群聊条目保留成员身份与目标发言人', () => {
    const group = '123456@chatroom'
    const dir = makeFixture([
      { talker: group, localId: 1, text: '明天几点出发', fromSelf: false, sender: 'wxid_alice' },
      { talker: group, localId: 2, text: '八点吧', fromSelf: true },
      { talker: group, localId: 3, text: '我也起来了', fromSelf: false, sender: 'wxid_bob' },
    ])
    const ctx = collectReplyContextEntries(dir, group, SELF, 20, 3)

    expect(ctx.entries.map((entry) => entry.speaker)).toEqual(['wxid_alice', '我', 'wxid_bob'])
    expect(ctx.entries.map((entry) => entry.isSender)).toEqual([false, true, false])
    expect(ctx.targetSpeaker).toBe('wxid_bob')
    expect(ctx.targetLine).toBe('wxid_bob：我也起来了')
  })

  it('群聊未知成员名回退到「群成员」', () => {
    const group = '123456@chatroom'
    const dir = makeFixture([
      { talker: group, localId: 1, text: '有人吗', fromSelf: false },
    ])
    const ctx = collectReplyContextEntries(dir, group, SELF)

    expect(ctx.entries).toHaveLength(1)
    expect(ctx.entries[0]?.speaker).toBe('群成员')
    expect(ctx.entries[0]?.isSender).toBe(false)
  })

  it('上下文时间窗：窗口外的消息整条排除，窗口内照常保留', () => {
    // 夹具的 create_time = 1700000000 + localId ⇒ 起点 1700000050 只放过 localId ≥ 100。
    const dir = makeFixture([
      { talker: PEER, localId: 1, text: '几天前的旧话题', fromSelf: false },
      { talker: PEER, localId: 100, text: '刚刚的提问', fromSelf: false },
      { talker: PEER, localId: 101, text: '补充一句', fromSelf: true },
    ])
    const windowed = collectReplyContextEntries(dir, PEER, SELF, 60, undefined, 1700000050)
    expect(windowed.entries.map((entry) => entry.localId)).toEqual([100, 101])
    expect(windowed.count).toBe(2)

    // 起点为 0（未设置时间窗）时保持原行为，不做任何过滤。
    const unlimited = collectReplyContextEntries(dir, PEER, SELF, 60, undefined, 0)
    expect(unlimited.entries.map((entry) => entry.localId)).toEqual([1, 100, 101])
  })
})
