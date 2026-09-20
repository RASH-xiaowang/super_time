/**
 * 「推荐回复」的上下文收集与模型输出解析。
 *
 * 两条最要紧的性质：
 *   ① **范围恒为当前会话** —— 别处的聊天绝不出现在提示词里（这条就是用户报障
 *      「单聊里冒出多个用户的聊天记录」在数据层的反面）；
 *   ② 模型输出再野也要能解析成「可以直接发」的句子（小模型会给围栏、编号、开场白）。
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { buildReplyPrompt, collectReplyContext, parseReplyCandidates } from '../src/query/reply-suggest.ts'

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
}

/** 造一个最小可用的解密目录：会话表 + 每个 talker 一张 Msg_ 表。 */
function makeFixture(rows: Row[]): string {
  const root = mkdtempSync(join(tmpdir(), 'wx-rs-'))
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
  for (const talker of new Set(rows.map(r => r.talker))) {
    const t = 'Msg_' + createHash('md5').update(talker, 'utf8').digest('hex')
    mdb.exec(`CREATE TABLE "${t}" (local_id INTEGER, sort_seq INTEGER, local_type INTEGER, is_sender INTEGER, create_time INTEGER, real_sender_id INTEGER, message_content TEXT, server_id INTEGER, compress_content TEXT)`)
    const ins = mdb.prepare(`INSERT INTO "${t}" VALUES (?,?,?,?,?,?,?,?,?)`)
    mdb.exec('BEGIN')
    for (const r of rows.filter(x => x.talker === talker)) {
      ins.run(r.localId, r.localId, 1, r.fromSelf ? 1 : 0, 1700000000 + r.localId, r.fromSelf ? 3 : 9, r.text, r.localId, '')
    }
    mdb.exec('COMMIT')
  }
  mdb.close()
  return decrypted
}

const PEER = 'wxid_peer'
const OTHER = 'wxid_other'
const SELF = 'wxid_me'

describe('collectReplyContext', () => {
  it('按 is_sender 标注「我 / 对方」，并取对方最近一条作为 latestPeer', () => {
    const dir = makeFixture([
      { talker: PEER, localId: 1, text: '在吗', fromSelf: false },
      { talker: PEER, localId: 2, text: '在的', fromSelf: true },
      { talker: PEER, localId: 3, text: '报价多少', fromSelf: false },
    ])
    const ctx = collectReplyContext(dir, PEER, SELF)
    expect(ctx.lines).toEqual(['对方：在吗', '我：在的', '对方：报价多少'])
    expect(ctx.latestPeer).toBe('报价多少')
    expect(ctx.count).toBe(3)
  })

  it('范围恒为当前会话：别处的聊天一条都不能进上下文', () => {
    const dir = makeFixture([
      { talker: PEER, localId: 1, text: '我这个会话的问题', fromSelf: false },
      { talker: OTHER, localId: 1, text: '别的会话的转账 1500.00', fromSelf: false },
      { talker: OTHER, localId: 2, text: '别的会话的私事', fromSelf: true },
    ])
    const ctx = collectReplyContext(dir, PEER, SELF)
    expect(ctx.lines).toEqual(['对方：我这个会话的问题'])
    expect(ctx.lines.join('\n')).not.toContain('别的会话')
    expect(ctx.latestPeer).toBe('我这个会话的问题')
  })

  it('该会话没有可用文本时 count=0（调用方据此报「还没有可用的对话内容」）', () => {
    const dir = makeFixture([{ talker: OTHER, localId: 1, text: '别人的话', fromSelf: false }])
    const ctx = collectReplyContext(dir, PEER, SELF)
    expect(ctx.count).toBe(0)
    expect(ctx.latestPeer).toBe('')
  })
})

describe('buildReplyPrompt', () => {
  it('带上对话行、条数与 JSON 要求；没有知识库片段时如实说明', () => {
    const p = buildReplyPrompt(['对方：报价多少', '我：在的'], [], 3)
    expect(p).toContain('对方：报价多少')
    expect(p).toContain('我：在的')
    expect(p).toContain('3 条')
    expect(p).toContain('JSON')
    expect(p).toContain('没有可用的知识库片段')
  })

  it('有知识库片段时带文件名，且不再说「没有片段」', () => {
    const p = buildReplyPrompt(['对方：报价多少'], ['《报价单.md》单价 120 元'], 3)
    expect(p).toContain('《报价单.md》单价 120 元')
    expect(p).not.toContain('没有可用的知识库片段')
  })
})

describe('parseReplyCandidates', () => {
  it('JSON 字符串数组', () => {
    expect(parseReplyCandidates('["好的","稍等我看下","我问下再回你"]', 3))
      .toEqual(['好的', '稍等我看下', '我问下再回你'])
  })

  it('```json 围栏 + 对象数组（text 字段）也能解析', () => {
    const raw = '```json\n[{"text":"第一条"},{"text":"第二条"}]\n```'
    expect(parseReplyCandidates(raw, 3)).toEqual(['第一条', '第二条'])
  })

  it('退化为逐行：剥编号与项目符号，丢掉开场白', () => {
    const raw = '好的，以下是三条回复：\n1. 收到，我这就看\n2) 稍等，半小时内回你\n- 这个得问下经理'
    expect(parseReplyCandidates(raw, 3)).toEqual(['收到，我这就看', '稍等，半小时内回你', '这个得问下经理'])
  })

  it('去重并截到 want 条', () => {
    expect(parseReplyCandidates('["重复","重复","二","三","四"]', 3)).toEqual(['重复', '二', '三'])
  })

  it('彻底解析不出内容时返回空数组（调用方报「模型没给出可用的候选」）', () => {
    expect(parseReplyCandidates('', 3)).toEqual([])
    expect(parseReplyCandidates('   \n  \n', 3)).toEqual([])
  })
})
