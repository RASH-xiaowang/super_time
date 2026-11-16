/**
 * 联系人类工具的判据（2026-11 补齐）。
 *
 * 重点不在「能搜到人」（旧用例已覆盖），而在**描述与实现一致**：
 *   · `search_contacts` 的 region/enterprise/kind 是真过滤，不是摆设；
 *   · `get_contact_detail` 的 include 真能关掉分区，共同群/资金往来真来自 360° 档案；
 *   · 缺库与查不到人分开。
 *
 * 夹具里的 extra_buffer 是真实 protobuf 形状（2=性别/企业 wording、5/6/7=国/省/市），
 * 与 `region.ts` / `openim.ts` 用的是同一套解码。
 *
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CONTACT_TOOLS,
  getContactDetailTool,
  searchContactsTool,
} from '../src/query/tools/contact-tools.ts'
import type { ToolContext } from '../src/query/tools/types.ts'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wx-contact-tool-'))
  scratch.push(dir)
  return dir
}

function makeDb(path: string, create: (db: DatabaseSync) => void): void {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  try { create(db) } finally { db.close() }
}

function ctx(decryptedDir: string): ToolContext {
  return { decryptedDir }
}

/** protobuf length-delimited field（字符串）。 */
function fieldString(field: number, text: string): Buffer {
  const data = Buffer.from(text, 'utf8')
  return Buffer.concat([Buffer.from([(field << 3) | 2, data.length]), data])
}

/** protobuf varint field（性别 = field 2）。 */
function fieldVarint(field: number, value: number): Buffer {
  return Buffer.from([(field << 3) | 0, value])
}

/** contact.extra_buffer：2=性别/企业 wording、5=国家、6=省、7=市。 */
function extraBuffer(opts: {
  country?: string
  province?: string
  city?: string
  gender?: number
  wordingId?: string
}): Buffer {
  return Buffer.concat([
    opts.gender === undefined ? Buffer.alloc(0) : fieldVarint(2, opts.gender),
    opts.wordingId === undefined ? Buffer.alloc(0) : fieldString(2, opts.wordingId),
    opts.country === undefined ? Buffer.alloc(0) : fieldString(5, opts.country),
    opts.province === undefined ? Buffer.alloc(0) : fieldString(6, opts.province),
    opts.city === undefined ? Buffer.alloc(0) : fieldString(7, opts.city),
  ])
}

const T0 = Math.floor(Date.UTC(2026, 8, 1, 10) / 1000)

/**
 * 最小通讯录夹具：
 *   · wxid_a「客户张三」/ 广东深圳 / 男 / 在 2 个共同群 / 索引里 2 条消息 / 1 转账 + 1 红包；
 *   · wxid_b「客户李四」/ 浙江杭州 / 女；
 *   · wxid_ent@openim「客户小深」/ 企业微信（深度求索）；
 *   · 两个群（123@chatroom、456@chatroom）与 gh_ 公众号（kind 过滤的反例）。
 * @returns 已解密数据根。
 */
function makeContactFixture(): string {
  const root = tempRoot()
  // 嵌套一层，让 searchIndexPath(decryptedDir) 落在临时根内。
  const dec = join(root, 'decrypted')
  makeDb(join(dec, 'contact', 'contact.db'), (db) => {
    db.exec(
      'CREATE TABLE contact (id INTEGER PRIMARY KEY, username TEXT, local_type INTEGER, alias TEXT, ' +
      'remark TEXT, nick_name TEXT, description TEXT, extra_buffer BLOB, delete_flag INTEGER DEFAULT 0)',
    )
    const ins = db.prepare(
      'INSERT INTO contact (id, username, local_type, alias, remark, nick_name, description, extra_buffer, delete_flag) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    ins.run(1, 'wxid_a', 1, 'chen123', '客户张三', '老陈', '签名A',
      extraBuffer({ country: 'cn', province: '广东省', city: '深圳市', gender: 1 }), 0)
    ins.run(2, 'wxid_b', 3, 'lisi_wx', '客户李四', '李四', '',
      extraBuffer({ country: 'cn', province: '浙江省', city: '杭州市', gender: 2 }), 0)
    ins.run(3, 'wxid_ent@openim', 1, '', '客户小深', '小深', '',
      extraBuffer({ wordingId: 'w1' }), 0)
    ins.run(4, 'gh_official', 3, '', '某公众号', '', '', null, 0)
    ins.run(10, '123@chatroom', 3, '', '项目群备注', '项目群', '', null, 0)
    ins.run(11, '456@chatroom', 3, '', '', '另一个群', '', null, 0)

    db.exec('CREATE TABLE chat_room (id INTEGER PRIMARY KEY, username TEXT, owner TEXT)')
    db.prepare('INSERT INTO chat_room VALUES (?, ?, ?)').run(10, '123@chatroom', '')
    db.prepare('INSERT INTO chat_room VALUES (?, ?, ?)').run(11, '456@chatroom', '')
    db.exec('CREATE TABLE chatroom_member (room_id INTEGER, member_id INTEGER)')
    const mem = db.prepare('INSERT INTO chatroom_member VALUES (?, ?)')
    mem.run(10, 1)
    mem.run(10, 2)
    mem.run(11, 1)

    db.exec('CREATE TABLE openim_wording (wording_id TEXT, wording TEXT)')
    db.prepare('INSERT INTO openim_wording VALUES (?, ?)').run('w1', '深度求索')
  })

  // `get_contact_detail` 的消息统计走检索索引（与实现路径一致）。
  makeDb(join(root, 'wechat_search.db'), (db) => {
    db.exec('CREATE TABLE message_meta (rowid INTEGER PRIMARY KEY, username TEXT, local_id INTEGER, create_time INTEGER)')
    const ins = db.prepare('INSERT INTO message_meta (username, local_id, create_time) VALUES (?, ?, ?)')
    ins.run('wxid_a', 1, T0)
    ins.run('wxid_a', 2, T0 + 60)
  })

  // 资金往来来自 general.db。
  makeDb(join(dec, 'general', 'general.db'), (db) => {
    db.exec('CREATE TABLE transferTable (session_name TEXT)')
    db.prepare('INSERT INTO transferTable VALUES (?)').run('wxid_a')
    db.exec('CREATE TABLE redEnvelopeTable (session_name TEXT)')
    db.prepare('INSERT INTO redEnvelopeTable VALUES (?)').run('wxid_a')
  })
  return dec
}

describe('联系人类工具：schema', () => {
  it('search_contacts 暴露 region/enterprise/kind 且仍要求 query', () => {
    const params = searchContactsTool.parameters as {
      required?: string[]
      properties?: Record<string, unknown>
    }
    expect(params.required).toEqual(['query'])
    for (const key of ['region', 'enterprise', 'kind']) {
      expect(params.properties?.[key], `缺少参数 ${key}`).toBeTruthy()
    }
    expect(CONTACT_TOOLS.map(tool => tool.name)).toEqual(['search_contacts', 'get_contact_detail'])
  })

  it('get_contact_detail 暴露 include，且描述不再承诺标签数据', () => {
    const params = getContactDetailTool.parameters as {
      properties?: Record<string, { items?: { enum?: string[] } }>
    }
    expect(params.properties?.['include']?.items?.enum).toEqual(['profile', 'stats', 'region', 'groups', 'funds'])
    // 本机 contact.db 没有标签表/列：描述必须说清楚，不能继续画饼。
    expect(getContactDetailTool.description).toContain('没有标签')
  })
})

describe('search_contacts：地区/企业/类别过滤', () => {
  it('region 过滤只返回地区匹配的联系人，snippet 带备注与地区', async () => {
    const dec = makeContactFixture()
    const r = await searchContactsTool.run({ query: '客户', region: '深圳' }, ctx(dec))
    expect(r.ok).toBe(true)
    expect(r.hits).toHaveLength(1)
    expect(r.hits[0]!.key).toBe('wxid_a')
    expect(r.hits[0]!.snippet).toContain('地区：')
    expect(r.hits[0]!.snippet).toContain('深圳市')
    expect(r.hits[0]!.snippet).toContain('备注：客户张三')
    expect(r.note).toContain('地区 深圳')
  })

  it('enterprise 过滤只返回企业名称匹配的企业微信联系人', async () => {
    const dec = makeContactFixture()
    const r = await searchContactsTool.run({ query: '客户', enterprise: '深度求索' }, ctx(dec))
    expect(r.ok).toBe(true)
    expect(r.hits).toHaveLength(1)
    expect(r.hits[0]!.key).toBe('wxid_ent@openim')
    expect(r.hits[0]!.enterpriseName).toBe('深度求索')
    expect(r.hits[0]!.snippet).toContain('企业名称：深度求索')
  })

  it('kind 过滤区分 person / enterprise / group', async () => {
    const dec = makeContactFixture()
    const people = await searchContactsTool.run({ query: '客户', kind: 'person' }, ctx(dec))
    expect(people.ok).toBe(true)
    expect(people.hits.map(hit => hit.key).sort()).toEqual(['wxid_a', 'wxid_b'])

    const enterprise = await searchContactsTool.run({ query: '客户', kind: 'enterprise' }, ctx(dec))
    expect(enterprise.hits.map(hit => hit.key)).toEqual(['wxid_ent@openim'])

    const groups = await searchContactsTool.run({ query: '项目', kind: 'group' }, ctx(dec))
    expect(groups.ok).toBe(true)
    expect(groups.hits.map(hit => hit.key)).toEqual(['123@chatroom'])
  })

  it('未知 kind 按 all 处理；缺库返回 not_configured', async () => {
    const dec = makeContactFixture()
    const all = await searchContactsTool.run({ query: '客户', kind: '不是枚举值' }, ctx(dec))
    expect(all.ok).toBe(true)
    expect(all.hits).toHaveLength(3)

    const missingRoot = tempRoot()
    const missing = join(missingRoot, 'decrypted')
    mkdirSync(missing, { recursive: true })
    const r = await searchContactsTool.run({ query: '任何人' }, ctx(missing))
    expect(r.ok).toBe(false)
    expect(r.errorCode).toBe('not_configured')
  })
})

describe('get_contact_detail：include 开关与共同群', () => {
  it('默认全开：备注/昵称/微信号/地区/性别/共同群/聊天统计/资金往来', async () => {
    const dec = makeContactFixture()
    const r = await getContactDetailTool.run({ username: 'wxid_a' }, ctx(dec))
    expect(r.ok).toBe(true)
    const snippet = r.hits[0]!.snippet
    expect(snippet).toContain('备注：客户张三')
    expect(snippet).toContain('昵称：老陈')
    expect(snippet).toContain('微信号：chen123')
    expect(snippet).toContain('地区：')
    expect(snippet).toContain('深圳市')
    expect(snippet).toContain('性别：男')
    expect(snippet).toContain('共同群（2）')
    expect(snippet).toContain('项目群')
    expect(snippet).toContain('另一个群')
    expect(snippet).toContain(`聊天记录：2 条，最近 ${new Date((T0 + 60) * 1000).toISOString().slice(0, 16).replace('T', ' ')}`)
    expect(snippet).toContain('资金往来：转账 1 笔、红包 1 笔')
  })

  it('include 只开 profile+region 时不返回共同群/统计/资金', async () => {
    const dec = makeContactFixture()
    const r = await getContactDetailTool.run({ username: 'wxid_a', include: ['profile', 'region'] }, ctx(dec))
    expect(r.ok).toBe(true)
    const snippet = r.hits[0]!.snippet
    expect(snippet).toContain('备注：客户张三')
    expect(snippet).toContain('性别：男')
    expect(snippet).not.toContain('共同群')
    expect(snippet).not.toContain('聊天记录')
    expect(snippet).not.toContain('资金往来')
  })

  it('include=groups 只返回共同群（不读统计/资金）', async () => {
    const dec = makeContactFixture()
    const r = await getContactDetailTool.run({ username: 'wxid_a', include: ['groups'] }, ctx(dec))
    expect(r.ok).toBe(true)
    const snippet = r.hits[0]!.snippet
    expect(snippet).toContain('共同群（2）')
    expect(snippet).not.toContain('微信号')
    expect(snippet).not.toContain('聊天记录')
    expect(snippet).not.toContain('资金往来')
  })

  it('include=stats / funds 各自只返回对应分区', async () => {
    const dec = makeContactFixture()
    const stats = await getContactDetailTool.run({ username: 'wxid_a', include: ['stats'] }, ctx(dec))
    expect(stats.hits[0]!.snippet).toContain('聊天记录：2 条')
    expect(stats.hits[0]!.snippet).not.toContain('共同群')
    expect(stats.hits[0]!.snippet).not.toContain('资金往来')

    const funds = await getContactDetailTool.run({ username: 'wxid_a', include: ['funds'] }, ctx(dec))
    expect(funds.hits[0]!.snippet).toContain('资金往来：转账 1 笔、红包 1 笔')
    expect(funds.hits[0]!.snippet).not.toContain('共同群')
    expect(funds.hits[0]!.snippet).not.toContain('聊天记录')
  })

  it('include 里的未知值被忽略（不会把其它分区带回来）', async () => {
    const dec = makeContactFixture()
    const r = await getContactDetailTool.run({ username: 'wxid_a', include: ['profile', '不存在'] }, ctx(dec))
    expect(r.ok).toBe(true)
    expect(r.hits[0]!.snippet).toContain('备注：客户张三')
    expect(r.hits[0]!.snippet).not.toContain('共同群')
    expect(r.hits[0]!.snippet).not.toContain('资金往来')
  })

  it('查不到人与缺库分开报错', async () => {
    const dec = makeContactFixture()
    const missingPerson = await getContactDetailTool.run({ username: 'wxid_nobody' }, ctx(dec))
    expect(missingPerson.ok).toBe(false)
    expect(missingPerson.error).toContain('没有这个人')

    const missingRoot = tempRoot()
    const missing = join(missingRoot, 'decrypted')
    mkdirSync(missing, { recursive: true })
    const missingDb = await getContactDetailTool.run({ username: 'wxid_a' }, ctx(missing))
    expect(missingDb.ok).toBe(false)
    expect(missingDb.errorCode).toBe('not_configured')
  })
})
