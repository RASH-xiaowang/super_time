/**
 * `get_group_detail` 的判据（2026-11 新增）。
 *
 * 这个工具最容易出现的失效不是「抛错」，而是「悄悄返回 0」：
 *   · 群名解析不到时返回空 facts → 模型答「这个群没有资料」；
 *   · 同名群随便挑一个 → 模型拿另一群的数据回答，用户很难发现；
 *   · 把群资料塞进 hits → 引用卡片指向不存在的位置。
 * 所以这里逐条钉住：解析成功/歧义/不存在、facts 形状、成员上限、缺库。
 *
 * @vitest-environment node
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { GROUP_TOOLS, getGroupDetailTool } from '../src/query/tools/group-tools.ts'
import type { ToolContext } from '../src/query/tools/types.ts'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wx-group-tool-'))
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

/** 固定时间戳（2026-09-01 10:00 UTC），避免测试依赖当前日期。 */
const T0 = Math.floor(Date.UTC(2026, 8, 1, 10) / 1000)

/**
 * 最小群聊夹具：
 *   · 群 123@chatroom「项目群」，3 名成员（群主 + 张三 + 李四）；
 *   · 4 条群消息分布在 2 个自然日（活动统计可验）。
 * `extraGroup=true` 时再放一个同名「项目群」，用于歧义判据。
 * @param opts.extraGroup - 是否追加同名群。
 * @returns 已解密数据根（message/ 与 contact/ 同级）。
 */
function makeGroupFixture(opts: { extraGroup?: boolean } = {}): string {
  const root = tempRoot()
  // 嵌套一层：searchIndexPath(decryptedDir) 落在本次的临时根内，
  // 不会误读 %TEMP%/wechat_search.db 这个跨测试共享路径。
  const dec = join(root, 'decrypted')
  const room = '123@chatroom'
  makeDb(join(dec, 'contact', 'contact.db'), (db) => {
    db.exec(
      'CREATE TABLE contact (id INTEGER PRIMARY KEY, username TEXT, nick_name TEXT, remark TEXT, ' +
      'chat_room_notify INTEGER DEFAULT 1, flag INTEGER DEFAULT 0, ' +
      'small_head_url TEXT, big_head_url TEXT, extra_buffer BLOB)',
    )
    const ins = db.prepare('INSERT INTO contact (id, username, nick_name, remark) VALUES (?, ?, ?, ?)')
    ins.run(1, 'wxid_owner', '老王', '')
    ins.run(2, 'wxid_a', '张三', '')
    ins.run(3, 'wxid_b', '李四', '')
    ins.run(10, room, '项目群', '')
    if (opts.extraGroup) ins.run(20, '456@chatroom', '项目群', '')

    db.exec('CREATE TABLE chat_room (id INTEGER PRIMARY KEY, username TEXT, owner TEXT, ext_buffer BLOB)')
    db.prepare('INSERT INTO chat_room VALUES (?, ?, ?, ?)').run(10, room, 'wxid_owner', null)
    if (opts.extraGroup) db.prepare('INSERT INTO chat_room VALUES (?, ?, ?, ?)').run(20, '456@chatroom', 'wxid_a', null)

    db.exec('CREATE TABLE chatroom_member (room_id INTEGER, member_id INTEGER)')
    const mem = db.prepare('INSERT INTO chatroom_member VALUES (?, ?)')
    mem.run(10, 1)
    mem.run(10, 2)
    mem.run(10, 3)
    if (opts.extraGroup) mem.run(20, 1)

    db.exec(
      'CREATE TABLE chat_room_info_detail (room_id_ INTEGER, username_ TEXT, announcement_ TEXT, ' +
      'announcement_editor_ TEXT, announcement_publish_time_ INTEGER)',
    )
    db.prepare('INSERT INTO chat_room_info_detail VALUES (?, ?, ?, ?, ?)')
      .run(10, room, '明天用户评审', 'wxid_owner', T0)
    if (opts.extraGroup) {
      db.prepare('INSERT INTO chat_room_info_detail VALUES (?, ?, ?, ?, ?)')
        .run(20, '456@chatroom', '二群公告', 'wxid_a', T0)
    }
  })

  const table = 'Msg_' + createHash('md5').update(room, 'utf8').digest('hex')
  makeDb(join(dec, 'message', 'message_1.db'), (db) => {
    db.exec(`CREATE TABLE "${table}" (local_id INTEGER, create_time INTEGER, local_type INTEGER, message_content TEXT)`)
    const ins = db.prepare(`INSERT INTO "${table}" VALUES (?, ?, ?, ?)`)
    ins.run(1, T0, 1, 'wxid_a:\n你好')
    ins.run(2, T0 + 10, 1, 'wxid_b:\n收到')
    ins.run(3, T0 + 86400, 1, 'wxid_a:\n明天见')
    ins.run(4, T0 + 86410, 1, 'wxid_b:\n好的')
  })
  return dec
}

describe('get_group_detail：工具契约', () => {
  it('名字/分类/必填参数与工具集', () => {
    expect(getGroupDetailTool.name).toBe('get_group_detail')
    expect(getGroupDetailTool.category).toBe('contact')
    expect(GROUP_TOOLS.map(tool => tool.name)).toEqual(['get_group_detail'])
    const params = getGroupDetailTool.parameters as {
      required?: string[]
      properties?: Record<string, unknown>
    }
    expect(params.required).toEqual(['group'])
    for (const key of ['group', 'membersLimit', 'topMembers', 'includeActivity']) {
      expect(params.properties?.[key], `缺少参数 ${key}`).toBeTruthy()
    }
  })
})

describe('get_group_detail：群名解析', () => {
  it('完整 @chatroom 直接命中并给出群资料 + 活跃两条 facts', async () => {
    const dec = makeGroupFixture()
    const r = await getGroupDetailTool.run({ group: '123@chatroom' }, ctx(dec))
    expect(r.ok).toBe(true)
    // 群资料不是消息：不伪造 locator。
    expect(r.hits).toEqual([])
    expect(r.facts?.length).toBeGreaterThanOrEqual(2)

    const profile = r.facts![0]!
    expect(profile.title).toBe('群资料')
    expect(profile.body).toContain('群名：项目群')
    expect(profile.body).toContain('群主：老王')
    expect(profile.body).toContain('成员数：3 人')
    expect(profile.body).toContain('公告：明天用户评审')
    expect(profile.body).toContain('公告时间：')
    expect(profile.body).toContain('成员列表（3/3）：老王、张三、李四')

    const activity = r.facts![1]!
    expect(activity.title).toBe('群活跃')
    expect(activity.body).toContain('消息总量：4 条')
    expect(activity.body).toContain('活跃天数：2 天')
    expect(activity.body).toContain('TOP 成员：')
    expect(activity.body).toContain('张三 2 条')
    expect(activity.body).toContain('李四 2 条')
  })

  it('按群名（含部分名称）解析到同一个群', async () => {
    const dec = makeGroupFixture()
    for (const name of ['项目群', '项目']) {
      const r = await getGroupDetailTool.run({ group: name }, ctx(dec))
      expect(r.ok, `群名「${name}」解析失败：${r.error ?? ''}`).toBe(true)
      expect(r.note).toContain('123@chatroom')
      expect(r.facts![0]!.body).toContain('群名：项目群')
    }
  })

  it('同名群返回歧义（列出候选），不随便挑一个', async () => {
    const dec = makeGroupFixture({ extraGroup: true })
    const r = await getGroupDetailTool.run({ group: '项目群' }, ctx(dec))
    expect(r.ok).toBe(false)
    expect(r.errorCode).toBe('invalid_arguments')
    expect(r.error).toContain('123@chatroom')
    expect(r.error).toContain('456@chatroom')
    expect(r.error).toContain('2 个群')
    expect(r.hits).toEqual([])
  })

  it('解析不到时如实报错（不是静默 0）', async () => {
    const dec = makeGroupFixture()
    const r = await getGroupDetailTool.run({ group: '根本不存在的群' }, ctx(dec))
    expect(r.ok).toBe(false)
    expect(r.errorCode).toBe('invalid_arguments')
    expect(r.error).toContain('找不到群')
  })

  it('缺 contact.db 返回 not_configured（与「查不到群」区分）', async () => {
    const root = tempRoot()
    const dec = join(root, 'decrypted')
    mkdirSync(dec, { recursive: true })
    const r = await getGroupDetailTool.run({ group: '项目群' }, ctx(dec))
    expect(r.ok).toBe(false)
    expect(r.errorCode).toBe('not_configured')
    expect(r.hits).toEqual([])
  })
})

describe('get_group_detail：参数边界', () => {
  it('membersLimit 截断成员列表，但成员总数仍是全量', async () => {
    const dec = makeGroupFixture()
    const r = await getGroupDetailTool.run({ group: '123@chatroom', membersLimit: 2 }, ctx(dec))
    expect(r.ok).toBe(true)
    const profile = r.facts![0]!.body
    expect(profile).toContain('成员列表（2/3）')
    expect(profile).toContain('老王')
    expect(profile).toContain('张三')
    // 李四只可能出现在成员列表（消息发送者走另一条 fact），所以这里必须看不到。
    expect(profile).not.toContain('李四')
  })

  it('includeActivity=false 时跳过消息扫描，并在 facts 里如实写「未统计」', async () => {
    const dec = makeGroupFixture()
    const r = await getGroupDetailTool.run({ group: '123@chatroom', includeActivity: false }, ctx(dec))
    expect(r.ok).toBe(true)
    expect(r.facts).toHaveLength(2)
    expect(r.facts![1]!.title).toBe('群活跃')
    expect(r.facts![1]!.body).toContain('未统计')
    expect(r.note).not.toContain('消息')
  })

  it('membersLimit 超过上限时被钳制而不是抛错', async () => {
    const dec = makeGroupFixture()
    const r = await getGroupDetailTool.run({ group: '123@chatroom', membersLimit: 9999 }, ctx(dec))
    expect(r.ok).toBe(true)
    expect(r.facts![0]!.body).toContain('成员列表（3/3）')
  })
})
