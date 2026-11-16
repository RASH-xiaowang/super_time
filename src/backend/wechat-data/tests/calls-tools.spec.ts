/**
 * `get_call_history` 的判据（2026-10-16 新增）。
 *
 * 通话记录的特殊性：它**不在检索索引里**，而是消息分片里 `local_type=50` 的
 * zstd/XML 行。因此这里的夹具必须真的构造一份最小消息分片（含 `Name2Id`），
 * 否则测到的只是参数整形，而不是「解析 → 过滤 → 统计」这条真实链路。
 *
 * 夹具刻意覆盖三种方向/结果与一个边界时间：
 *   · 呼出、视频、21:08（本机有完整时长）；
 *   · 呼入、语音、00:45，发生在 23:59（验证 `to` 当天含端点）；
 *   · 呼入、视频、未应答（未接，且本机没有时长）。
 *
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getCallHistoryTool, CALLS_TOOLS } from '../src/query/tools/calls-tools.ts'
import { messageTableName } from '../src/query/message-identity.ts'
import type { ToolContext, ToolResult } from '../src/query/tools/types.ts'

const scratch: string[] = []
/** 模块加载时记下原值，避免测试把用户环境里的自账号覆盖掉。 */
const ORIGINAL_SELF = process.env['DSH_WECHAT_SELF_WXID']

beforeEach(() => {
  // 工具通过 `resolveSelfUsername` 解析登录账号；环境变量优先级最高，测试不依赖配置文件。
  process.env['DSH_WECHAT_SELF_WXID'] = 'wxid_self'
})

afterEach(() => {
  if (ORIGINAL_SELF === undefined) delete process.env['DSH_WECHAT_SELF_WXID']
  else process.env['DSH_WECHAT_SELF_WXID'] = ORIGINAL_SELF
  for (const dir of scratch.splice(0)) { try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } }
})

/** 本地时间 → epoch 秒（夹具里的日期都用本地时区构造，与工具的日期边界同口径）。 */
function at(year: number, month: number, day: number, hour: number, minute: number): number {
  return Math.floor(new Date(year, month - 1, day, hour, minute, 0).getTime() / 1000)
}

/** 构造一条 voip 消息的 XML（`<msg>` 里才是真实时长/结果）。 */
function voipXml(status: string, roomType: number): string {
  return `<voipmsg type="VoIPBubbleMsg"><msg><![CDATA[${status}]]></msg>`
    + `<room_type>${roomType}</room_type></voipmsg>`
}

/** 建一张 `Msg_<md5(username)>` 表并返回插入器。 */
function msgTable(
  db: DatabaseSync,
  username: string,
): ReturnType<DatabaseSync['prepare']> {
  const table = messageTableName(username)
  db.exec(`CREATE TABLE "${table}" (local_id INTEGER PRIMARY KEY, create_time INTEGER, local_type INTEGER, real_sender_id INTEGER, message_content TEXT)`)
  return db.prepare(`INSERT INTO "${table}" VALUES (?,?,?,?,?)`)
}

/**
 * 最小通话数据根：一个消息分片 + contact.db。
 * @returns 解密数据根。
 */
function makeCallsDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'calls-tools-'))
  scratch.push(root)
  const dec = join(root, 'decrypted')
  mkdirSync(join(dec, 'message'), { recursive: true })
  mkdirSync(join(dec, 'contact'), { recursive: true })

  const shard = new DatabaseSync(join(dec, 'message', 'message_0.db'))
  // Name2Id 是每个分片自己的 rowid → username 空间；rowid 1/2/3 = 我/李四/王五。
  shard.exec('CREATE TABLE Name2Id (user_name TEXT)')
  const insName = shard.prepare('INSERT INTO Name2Id (user_name) VALUES (?)')
  insName.run('wxid_self')
  insName.run('wxid_peer')
  insName.run('wxid_boss')

  const peerTable = msgTable(shard, 'wxid_peer')
  // 呼出：real_sender_id 指向「我」，对端从表名反解为 wxid_peer。
  peerTable.run(101, at(2026, 1, 10, 10, 0), 50, 1, voipXml('通话时长 21:08', 1))
  // 呼入：real_sender_id 指向对方；时间刻意放在 23:59，验证 to 当天含端点。
  peerTable.run(102, at(2026, 1, 11, 23, 59), 50, 2, voipXml('通话时长 00:45', 0))
  // 同表混入一条普通消息，证明只统计 local_type=50。
  peerTable.run(103, at(2026, 1, 11, 12, 0), 1, 2, '这不是通话')

  const bossTable = msgTable(shard, 'wxid_boss')
  // 未接：没有时长、状态为未应答。
  bossTable.run(201, at(2026, 1, 12, 18, 0), 50, 3, voipXml('未应答', 1))
  shard.close()

  const contacts = new DatabaseSync(join(dec, 'contact', 'contact.db'))
  contacts.exec('CREATE TABLE contact (username TEXT, remark TEXT, nick_name TEXT, flag INTEGER)')
  const insContact = contacts.prepare('INSERT INTO contact VALUES (?,?,?,?)')
  insContact.run('wxid_peer', '李四', '小李', 0)
  insContact.run('wxid_boss', '王五', '小王', 0)
  contacts.close()
  return dec
}

/** 造一个空数据根。 */
function makeEmptyDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'calls-tools-empty-'))
  scratch.push(root)
  const dec = join(root, 'decrypted')
  mkdirSync(join(dec, 'message'), { recursive: true })
  return dec
}

/** 跑一次工具，返回结果。 */
function run(decryptedDir: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const ctx: ToolContext = { decryptedDir }
  return getCallHistoryTool.run(args, ctx) as Promise<ToolResult>
}

/** 取唯一一条 fact 的正文（失败时给一条可读的断言信息）。 */
function factBody(r: ToolResult): string {
  const fact = r.facts?.[0]
  expect(fact, '应当返回一条通话总览 fact').toBeDefined()
  return fact?.body ?? ''
}

describe('get_call_history：清单与基础统计', () => {
  it('工具名/分类/参数形状符合契约', () => {
    expect(CALLS_TOOLS).toEqual([getCallHistoryTool])
    expect(getCallHistoryTool.name).toBe('get_call_history')
    expect(getCallHistoryTool.category).toBe('message')
    const props = getCallHistoryTool.parameters['properties'] as Record<string, unknown>
    expect(Object.keys(props).sort()).toEqual(['from', 'limit', 'order', 'peer', 'to'])
    expect(getCallHistoryTool.description).toContain('通话记录')
  })

  it('呼入/呼出/未接各一条：次数、接通、时长与方向统计正确', async () => {
    const dec = makeCallsDir()
    const r = await run(dec)
    expect(r.ok).toBe(true)
    expect(r.hits).toHaveLength(3)

    const body = factBody(r)
    expect(body).toContain('3 次')
    expect(body).toContain('接通 2')
    expect(body).toContain('未接/拒接 1')
    // 21:08 + 00:45 = 21 分 53 秒（未接那条没有时长）。
    expect(body).toContain('总时长 21 分 53 秒')
    expect(body).toContain('呼出 1 / 呼入 2')
    expect(body).toContain('TOP 对方 李四 2 次 / 21 分 53 秒')

    const outgoing = r.hits.find(h => h.key === 'wxid_peer:101')
    expect(outgoing?.snippet).toBe('视频通话 · 21分08秒 · 呼出 · 已接听')
    expect(outgoing?.name).toBe('李四')
    expect(outgoing?.source).toBe('msg')
    expect(outgoing?.trace).toEqual({ kind: 'msg', username: 'wxid_peer', localId: 101 })

    const incoming = r.hits.find(h => h.key === 'wxid_peer:102')
    expect(incoming?.snippet).toBe('语音通话 · 45秒 · 呼入 · 已接听')

    const missed = r.hits.find(h => h.key === 'wxid_boss:201')
    expect(missed?.snippet).toBe('视频通话 · 呼入 · 未接听')
    expect(missed?.name).toBe('王五')
    expect(missed?.trace).toEqual({ kind: 'msg', username: 'wxid_boss', localId: 201 })
  })
})

describe('get_call_history：过滤', () => {
  it('peer 支持显示名与 username', async () => {
    const dec = makeCallsDir()
    const byName = await run(dec, { peer: '李四' })
    expect(byName.ok).toBe(true)
    expect(byName.hits.map(h => h.key).sort()).toEqual(['wxid_peer:101', 'wxid_peer:102'])
    const body = factBody(byName)
    expect(body).toContain('2 次')
    expect(body).toContain('接通 2')
    expect(body).toContain('总时长 21 分 53 秒')
    expect(body).toContain('呼出 1 / 呼入 1')

    const byUsername = await run(dec, { peer: 'wxid_boss' })
    expect(byUsername.hits.map(h => h.key)).toEqual(['wxid_boss:201'])
    expect(factBody(byUsername)).toContain('1 次')
  })

  it('from/to 按本地日期过滤，且两端当天都包含（含 23:59 的边界）', async () => {
    const dec = makeCallsDir()
    const oneDay = await run(dec, { from: '2026-01-11', to: '2026-01-11' })
    expect(oneDay.hits.map(h => h.key)).toEqual(['wxid_peer:102'])
    expect(factBody(oneDay)).toContain('1 次')

    const fromOnly = await run(dec, { from: '2026-01-12' })
    expect(fromOnly.hits.map(h => h.key)).toEqual(['wxid_boss:201'])

    const toOnly = await run(dec, { to: '2026-01-10' })
    expect(toOnly.hits.map(h => h.key)).toEqual(['wxid_peer:101'])
  })

  it('非法日期如实报错，而不是退化成「不限日期」', async () => {
    const dec = makeCallsDir()
    const r = await run(dec, { from: '2026-02-30' })
    expect(r.ok).toBe(false)
    expect(r.errorCode).toBe('invalid_arguments')
    expect(r.hits).toEqual([])
  })
})

describe('get_call_history：空数据与排序', () => {
  it('没有消息分片时返回 ok:true 的空结果，note 写明没有找到', async () => {
    const dec = makeEmptyDir()
    const r = await run(dec)
    expect(r.ok).toBe(true)
    expect(r.hits).toEqual([])
    expect(r.facts).toEqual([])
    expect(r.note).toContain('没有找到通话记录')
  })

  it('order=recent 时最新在前；duration/count 也按各自口径排序', async () => {
    const dec = makeCallsDir()
    const recent = await run(dec, { order: 'recent' })
    expect(recent.hits.map(h => h.key)).toEqual([
      'wxid_boss:201', 'wxid_peer:102', 'wxid_peer:101',
    ])

    const duration = await run(dec, { order: 'duration' })
    expect(duration.hits.map(h => h.key)).toEqual([
      'wxid_peer:101', 'wxid_peer:102', 'wxid_boss:201',
    ])

    const count = await run(dec, { order: 'count' })
    expect(count.hits.map(h => h.key)).toEqual([
      'wxid_peer:102', 'wxid_peer:101', 'wxid_boss:201',
    ])
  })

  it('limit 生效，但 facts 仍统计整个过滤区间而不是前 N 条', async () => {
    const dec = makeCallsDir()
    const r = await run(dec, { limit: 2 })
    expect(r.hits).toHaveLength(2)
    expect(factBody(r)).toContain('3 次')
  })
})
