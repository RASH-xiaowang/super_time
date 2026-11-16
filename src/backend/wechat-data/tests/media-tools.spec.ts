/**
 * `aggregate_media` 工具用例：最小消息分片、各类媒体摘要、方向/排序/预算。
 * @vitest-environment node
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { aggregateMediaTool } from '../src/query/tools/media-tools.ts'
import type { ToolContext } from '../src/query/tools/types.ts'

const scratch: string[] = []
const ORIGINAL_SELF = process.env['DSH_WECHAT_SELF_WXID']

beforeEach(() => {
  // resolveSelfUsername 优先读环境变量；测试里固定本人 wxid，方向判定才可复现。
  process.env['DSH_WECHAT_SELF_WXID'] = 'wxid_self'
})

afterEach(() => {
  if (ORIGINAL_SELF === undefined) delete process.env['DSH_WECHAT_SELF_WXID']
  else process.env['DSH_WECHAT_SELF_WXID'] = ORIGINAL_SELF
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
})

function makeRoot(): { root: string; ctx: ToolContext } {
  const root = mkdtempSync(join(tmpdir(), 'wx-media-tool-'))
  scratch.push(root)
  return { root, ctx: { decryptedDir: root } }
}

function epoch(y: number, mo: number, d: number, h = 12): number {
  return Math.floor(new Date(y, mo - 1, d, h, 0, 0).getTime() / 1000)
}

function makeContacts(root: string): void {
  mkdirSync(join(root, 'contact'), { recursive: true })
  const db = new DatabaseSync(join(root, 'contact', 'contact.db'))
  try {
    db.exec('CREATE TABLE contact (username TEXT, remark TEXT, nick_name TEXT)')
    const insert = db.prepare('INSERT INTO contact (username, remark, nick_name) VALUES (?, ?, ?)')
    insert.run('wxid_self', '我', '我')
    insert.run('wxid_peer', '张三', '张三')
  } finally {
    db.close()
  }
}

interface MsgSpec {
  localId: number
  createTime: number
  /** Name2Id 的 rowid：1 = 本人，2 = 对方。 */
  senderId: number
  localType: number
  content: string
}

function makeShard(root: string, talker: string, messages: readonly MsgSpec[]): void {
  mkdirSync(join(root, 'message'), { recursive: true })
  const db = new DatabaseSync(join(root, 'message', 'message_1.db'))
  try {
    db.exec('CREATE TABLE Name2Id (user_name TEXT)')
    db.prepare('INSERT INTO Name2Id (user_name) VALUES (?)').run('wxid_self')
    db.prepare('INSERT INTO Name2Id (user_name) VALUES (?)').run('wxid_peer')
    const table = 'Msg_' + createHash('md5').update(talker, 'utf8').digest('hex')
    db.exec(`CREATE TABLE "${table}" (
      local_id INTEGER, create_time INTEGER, real_sender_id INTEGER,
      local_type INTEGER, message_content TEXT
    )`)
    const insert = db.prepare(`INSERT INTO "${table}" VALUES (?, ?, ?, ?, ?)`)
    // 测试夹具一次插入上千行，事务能避免逐条自动提交的磁盘同步开销。
    db.exec('BEGIN')
    try {
      for (const m of messages) {
        insert.run(m.localId, m.createTime, m.senderId, m.localType, m.content)
      }
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  } finally {
    db.close()
  }
}

const PEER = 'wxid_peer'
const IMAGE_SENT = epoch(2026, 9, 5, 9)
const IMAGE_RECEIVED = epoch(2026, 9, 6, 12)

function fixture(root: string, extra: readonly MsgSpec[] = []): void {
  makeContacts(root)
  makeShard(root, PEER, [
    { localId: 1, createTime: IMAGE_RECEIVED, senderId: 2, localType: 3, content: '<img md5="aa"/>' },
    { localId: 8, createTime: IMAGE_SENT, senderId: 1, localType: 3, content: '<img md5="bb"/>' },
    { localId: 2, createTime: epoch(2026, 9, 7, 11), senderId: 1, localType: 43, content: '<videomsg playlength="12" md5="cc"/>' },
    { localId: 3, createTime: epoch(2026, 9, 8, 12), senderId: 2, localType: 34, content: '<voicemsg voicelength="8000" md5="dd"/>' },
    { localId: 4, createTime: epoch(2026, 9, 9, 13), senderId: 1, localType: 49, content: '<appmsg><type>6</type><title>报价单.pdf</title></appmsg>' },
    // 49 里的链接不是文件，不能计入「文件」统计。
    { localId: 5, createTime: epoch(2026, 9, 9, 14), senderId: 2, localType: 49, content: '<appmsg><type>5</type><title>一篇文章</title><url>https://example.com</url></appmsg>' },
    { localId: 6, createTime: epoch(2026, 9, 10, 14), senderId: 2, localType: 47, content: '<emoji md5="ee"/>' },
    { localId: 7, createTime: epoch(2026, 9, 11, 15), senderId: 1, localType: 48, content: '<location x="30.2" y="120.1" label="杭州" poiname="西湖"/>' },
    // 文本消息永远不参与媒体统计。
    { localId: 9, createTime: epoch(2026, 9, 11, 16), senderId: 2, localType: 1, content: '普通文本' },
    ...extra,
  ])
}

describe('aggregate_media', () => {
  it('图片统计：条数、收发方向与最近时间', async () => {
    const { root, ctx } = makeRoot()
    fixture(root)

    const result = await aggregateMediaTool.run({ kind: 'image' }, ctx)
    expect(result.ok).toBe(true)
    expect(result.hits).toHaveLength(2)
    expect(result.hits[0]?.key).toBe(`${PEER}:1`)
    expect(result.hits[0]?.snippet).toBe('[图片]')
    expect(result.hits[0]?.source).toBe('msg')
    expect(result.hits[0]?.trace?.kind).toBe('msg')
    expect(result.facts?.[0]?.title).toBe('图片：2 条（发 1 / 收 1）')
    expect(result.facts?.[0]?.body).toBe('最近 2026-09-06')
    expect(result.note).toContain('全量扫描')
  })

  it('各媒体种类的摘要格式符合约定', async () => {
    const { root, ctx } = makeRoot()
    fixture(root)

    const video = await aggregateMediaTool.run({ kind: 'video' }, ctx)
    expect(video.hits[0]?.snippet).toBe('[视频] 12秒')

    const voice = await aggregateMediaTool.run({ kind: 'voice' }, ctx)
    expect(voice.hits[0]?.snippet).toBe('[语音] 8秒')

    const file = await aggregateMediaTool.run({ kind: 'file' }, ctx)
    expect(file.hits).toHaveLength(1)
    expect(file.hits[0]?.snippet).toBe('[文件] 报价单.pdf')

    const emoji = await aggregateMediaTool.run({ kind: 'emoji' }, ctx)
    expect(emoji.hits[0]?.snippet).toBe('[表情]')

    const location = await aggregateMediaTool.run({ kind: 'location' }, ctx)
    expect(location.hits[0]?.snippet).toBe('[位置] 西湖 / 杭州')
  })

  it('direction 与 order 生效；非法枚举回退 all/recent', async () => {
    const { root, ctx } = makeRoot()
    fixture(root)

    const sent = await aggregateMediaTool.run({ kind: 'image', direction: 'sent' }, ctx)
    expect(sent.hits).toHaveLength(1)
    expect(sent.hits[0]?.key).toBe(`${PEER}:8`)
    expect(sent.facts?.[0]?.title).toBe('图片：1 条（发 1 / 收 0）')

    const received = await aggregateMediaTool.run({ kind: 'image', direction: 'received' }, ctx)
    expect(received.hits).toHaveLength(1)
    expect(received.hits[0]?.key).toBe(`${PEER}:1`)

    const oldest = await aggregateMediaTool.run({ kind: 'image', order: 'oldest' }, ctx)
    expect(oldest.hits[0]?.key).toBe(`${PEER}:8`)

    const fallback = await aggregateMediaTool.run({ kind: 'image', direction: 'up', order: 'weird' }, ctx)
    expect(fallback.hits).toHaveLength(2)
    expect(fallback.hits[0]?.key).toBe(`${PEER}:1`)
  })

  it('username/from/to/limit 都是硬过滤与钳制', async () => {
    const { root, ctx } = makeRoot()
    fixture(root)

    const scoped = await aggregateMediaTool.run({ kind: 'image', username: PEER, limit: 1 }, ctx)
    expect(scoped.hits).toHaveLength(1)
    // facts 统计的是全部匹配行，不受 hits 上限影响。
    expect(scoped.facts?.[0]?.title).toBe('图片：2 条（发 1 / 收 1）')

    const otherChat = await aggregateMediaTool.run({ kind: 'image', username: 'wxid_other' }, ctx)
    expect(otherChat.hits).toEqual([])
    expect(otherChat.facts).toEqual([])

    const ranged = await aggregateMediaTool.run({ kind: 'image', from: '2026-09-06', to: '2026-09-06' }, ctx)
    expect(ranged.hits).toHaveLength(1)
    expect(ranged.hits[0]?.key).toBe(`${PEER}:1`)
  })

  it('锁定会话无法解析（Msg_<hash>）时 fail closed，不扫描全库', async () => {
    const { root, ctx } = makeRoot()
    fixture(root)
    const unresolved = `Msg_${'0'.repeat(32)}`

    const locked = await aggregateMediaTool.run(
      { kind: 'image' },
      { ...ctx, scope: { username: unresolved } },
    )
    expect(locked.ok).toBe(false)
    expect(locked.errorCode).toBe('unsupported_scope')
    expect(locked.errorDetails).toMatchObject({ username: unresolved })
    expect(locked.hits).toEqual([])
    // 失败时绝不能给出「全库 N 条」的统计事实。
    expect(locked.facts ?? []).toEqual([])

    // 模型自己把未解析的 Msg_hash 当参数传入，同样不能退化成全库扫描。
    const viaArgs = await aggregateMediaTool.run(
      { kind: 'image', username: unresolved },
      ctx,
    )
    expect(viaArgs.ok).toBe(false)
    expect(viaArgs.errorCode).toBe('unsupported_scope')
    expect(viaArgs.hits).toEqual([])
    expect(viaArgs.facts ?? []).toEqual([])
  })

  it('缺少/非法 kind 明确报参数错误', async () => {
    const { root, ctx } = makeRoot()
    fixture(root)

    const missing = await aggregateMediaTool.run({}, ctx)
    expect(missing.ok).toBe(false)
    expect(missing.errorCode).toBe('invalid_arguments')

    const invalid = await aggregateMediaTool.run({ kind: 'audio' }, ctx)
    expect(invalid.ok).toBe(false)
    expect(invalid.errorCode).toBe('invalid_arguments')
  })

  it('没有媒体数据时返回空结果而不是报错', async () => {
    const { ctx } = makeRoot()
    const result = await aggregateMediaTool.run({ kind: 'image' }, ctx)
    expect(result.ok).toBe(true)
    expect(result.hits).toEqual([])
    expect(result.facts).toEqual([])
    expect(result.note).toContain('没有找到图片')
  })

  it('取消信号触发后只返回已扫描部分，并标记「本次扫描」', async () => {
    const { root, ctx } = makeRoot()
    // 2001 条图片足以到达第一次让出点；让出时 abort，下一行即可看到信号。
    const many: MsgSpec[] = []
    for (let i = 0; i < 2001; i += 1) {
      many.push({
        localId: 1000 + i,
        createTime: epoch(2026, 9, 1) + i,
        senderId: 2,
        localType: 3,
        content: `<img md5="img${String(i)}"/>`,
      })
    }
    fixture(root, many)

    const controller = new AbortController()
    setImmediate(() => controller.abort())
    const result = await aggregateMediaTool.run(
      { kind: 'image' },
      { decryptedDir: root, signal: controller.signal },
    )
    expect(result.ok).toBe(true)
    expect(result.hits.length).toBeGreaterThan(0)
    expect(result.facts?.[0]?.title.startsWith('本次扫描 · 图片：')).toBe(true)
    expect(result.note).toContain('已截断（已取消）')
  })
})
