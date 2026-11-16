/**
 * queryContacts pagination + cache: synthetic contact.db (no group tables).
 * @vitest-environment node
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { queryContacts } from '../src/query/contacts.ts'

const scratch: string[] = []
afterEach(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
  scratch.length = 0
})

/** Build `contact.extra_buffer` with protobuf field 2 = enterprise wording id. */
function enterpriseBuffer(wordingId: string): Buffer {
  const value = Buffer.from(wordingId, 'utf8')
  return Buffer.concat([Buffer.from([0x12, value.length]), value])
}

/** Build contact.extra_buffer: field 2 gender, field 4 signature, field 5 country. */
function profileBuffer(gender: number, signature: string, country: string): Buffer {
  const textField = (tag: number, value: string): Buffer => {
    const bytes = Buffer.from(value, 'utf8')
    return Buffer.concat([Buffer.from([tag, bytes.length]), bytes])
  }
  return Buffer.concat([
    Buffer.from([0x10, gender]),
    textField(0x22, signature),
    textField(0x2a, country),
  ])
}

/** Contact db at <root>/contact/contact.db; no chat_room/biz_info (skipped). */
function makeContactDb(): string {
  const root = mkdtempSync(join(tmpdir(), 'wx-contacts-'))
  scratch.push(root)
  const dir = join(root, 'contact')
  mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(join(dir, 'contact.db'))
  db.exec(`CREATE TABLE contact (
    id INTEGER, username TEXT, local_type INTEGER, alias TEXT, delete_flag INTEGER,
    remark TEXT, remark_pin_yin_initial TEXT, nick_name TEXT, pin_yin_initial TEXT, quan_pin TEXT,
    big_head_url TEXT, small_head_url TEXT, description TEXT, is_in_chat_room INTEGER
  )`)
  const ins = db.prepare('INSERT INTO contact (id, username, local_type, remark, quan_pin) VALUES (?, ?, ?, ?, ?)')
  ins.run(1, 'u_alice', 1, 'Alice', 'alice')
  ins.run(2, 'u_bob', 1, 'Bob', 'bob')
  ins.run(3, 'g@chatroom', 0, '小组', 'group')
  db.close()
  return root
}

describe('queryContacts', () => {
  it('returns all contacts with total and per-category stats when unpaged', () => {
    const root = makeContactDb()
    const env = queryContacts(root)
    expect(env.total).toBe(3)
    expect(env.contacts.length).toBe(3)
    expect(env.stats.friend).toBe(2)
    expect(env.stats.group).toBe(1)
  })

  it('slices a bounded page while keeping the full total', () => {
    const root = makeContactDb()
    const env = queryContacts(root, { limit: 2, offset: 0 })
    expect(env.total).toBe(3)
    expect(env.contacts.length).toBe(2)
    expect(env.contacts.every(c => c.username !== undefined)).toBe(true)
  })

  it('honours offset for the next page', () => {
    const root = makeContactDb()
    const env = queryContacts(root, { limit: 2, offset: 2 })
    expect(env.total).toBe(3)
    expect(env.contacts.length).toBe(1)
  })
})

describe('queryContacts 分类过滤发生在分页之前', () => {
  /**
   * 复现「页签有计数却空白」的根因。
   *
   * 真实数据里 friend=282 只占 contact 全量约 13%，而全局排序是按首字母/全拼，
   * 于是**第一页 200 条里可能一条 friend 都没有**。界面此前是把这个已分页的结果
   * 拿到渲染层再按 category filter —— 页签写着「联系人 (282)」，列表却是
   * 「暂无联系人」；只有不断向下滚、把前若干页都拉完才会陆续出现几条。
   *
   * 夹具刻意让 friend 排在字母 Q，前面 300 条是 A–P：分页口径若在过滤之前，
   * 第一页里 friend 数为 0。
   */
  function makeSkewedContactDb(): string {
    const root = mkdtempSync(join(tmpdir(), 'wx-contacts-skew-'))
    scratch.push(root)
    const dir = join(root, 'contact')
    mkdirSync(dir, { recursive: true })
    const db = new DatabaseSync(join(dir, 'contact.db'))
    db.exec(`CREATE TABLE contact (
      id INTEGER, username TEXT, local_type INTEGER, alias TEXT, delete_flag INTEGER,
      remark TEXT, remark_pin_yin_initial TEXT, nick_name TEXT, pin_yin_initial TEXT, quan_pin TEXT,
      big_head_url TEXT, small_head_url TEXT, description TEXT, is_in_chat_room INTEGER
    )`)
    const ins = db.prepare('INSERT INTO contact (id, username, local_type, remark, remark_pin_yin_initial, quan_pin) VALUES (?, ?, ?, ?, ?, ?)')
    // 300 行包一条事务：逐行提交是每行一次 fsync，在 CI runner 上会拉出十几秒的同步段
    // （实测本机 1ms/行），长到足以让 vitest 的内部 RPC 超时。
    db.exec('BEGIN')
    for (let i = 0; i < 300; i++) {
      ins.run(1000 + i, 'member_' + i, 0, 'm' + i, i % 2 === 0 ? 'A' : 'P', 'm' + String(i).padStart(4, '0'))
    }
    // 3 个好友（local_type=1），首字母 Q，排在最后
    for (let i = 0; i < 3; i++) {
      ins.run(2000 + i, 'friend_' + i, 1, 'f' + i, 'Q', 'f' + String(i).padStart(4, '0'))
    }
    db.exec('COMMIT')
    db.close()
    return root
  }

  it('第一页里没有该类目时也不能返回空（旧行为会返回 0 条）', () => {
    const root = makeSkewedContactDb()
    const env = queryContacts(root, { limit: 200, offset: 0, category: 'friend' })
    // 这是本用例的核心断言：过滤必须在切片之前，所以第一页就该有全部 3 个好友。
    expect(env.contacts.length).toBe(3)
    expect(env.contacts.every(c => c.category === 'friend')).toBe(true)
  })

  it('total 是当前分类的条数（分页口径与过滤口径一致）', () => {
    const root = makeSkewedContactDb()
    const env = queryContacts(root, { limit: 2, offset: 0, category: 'friend' })
    expect(env.total).toBe(3)
    expect(env.contacts.length).toBe(2)
  })

  it('分类偏移分页取到的是该类目的第 2 页，不串入其它类目', () => {
    const root = makeSkewedContactDb()
    const env = queryContacts(root, { limit: 2, offset: 2, category: 'friend' })
    expect(env.contacts.length).toBe(1)
    expect(env.total).toBe(3)
    expect(env.contacts.every(c => c.category === 'friend')).toBe(true)
  })

  it('stats 始终是全量口径，不随当前分类变化（页签数字要稳定）', () => {
    const root = makeSkewedContactDb()
    const all = queryContacts(root, { limit: 1, offset: 0 })
    const friends = queryContacts(root, { limit: 1, offset: 0, category: 'friend' })
    expect(friends.stats).toEqual(all.stats)
    expect(friends.stats.friend).toBe(3)
    expect(friends.stats.member).toBe(300)
  })

  it('stats.all 是稳定全量（页签「全部(N)」不能显示成当前类目数）', () => {
    const root = makeSkewedContactDb()
    const all = queryContacts(root, { limit: 1, offset: 0 })
    const friends = queryContacts(root, { limit: 1, offset: 0, category: 'friend' })
    expect(all.stats.all).toBe(303)
    expect(friends.stats.all).toBe(303)
    // 过滤后 total 是当前类目数，与 stats.all 不是一回事 —— 界面必须用 stats.all 显示「全部」。
    expect(friends.total).toBe(3)
    expect(friends.total).not.toBe(friends.stats.all)
  })

  it('category 为空串或 all 等价于不过滤（向后兼容）', () => {
    const root = makeSkewedContactDb()
    const base = queryContacts(root, { limit: 5, offset: 0 })
    for (const c of ['', 'all', '  ', undefined]) {
      const env = queryContacts(root, { limit: 5, offset: 0, ...(c === undefined ? {} : { category: c }) })
      expect(env.total).toBe(base.total)
      expect(env.contacts.map(x => x.username)).toEqual(base.contacts.map(x => x.username))
    }
  })

  it('未知分类返回空列表而不是全量（不能把拼错的类目当成不过滤）', () => {
    const root = makeSkewedContactDb()
    const env = queryContacts(root, { limit: 200, offset: 0, category: 'friendd' })
    expect(env.contacts.length).toBe(0)
    expect(env.total).toBe(0)
  })
})

describe('queryContacts 企业微信', () => {
  it('返回企业名称，并把 @kefu.openim 保持为客服账号', () => {
    const root = mkdtempSync(join(tmpdir(), 'wx-contacts-openim-'))
    scratch.push(root)
    const dir = join(root, 'contact')
    mkdirSync(dir, { recursive: true })
    const db = new DatabaseSync(join(dir, 'contact.db'))
    db.exec(`CREATE TABLE contact (
      id INTEGER, username TEXT, local_type INTEGER, delete_flag INTEGER,
      remark TEXT, nick_name TEXT, quan_pin TEXT, extra_buffer BLOB
    )`)
    db.exec('CREATE TABLE openim_wording (wording_id TEXT, wording TEXT)')
    db.prepare('INSERT INTO openim_wording VALUES (?, ?)').run('wording-a', '深度求索')
    const ins = db.prepare('INSERT INTO contact VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    ins.run(1, 'wxid_peer@openim', 0, 0, '小深', '', 'xiaoshen', enterpriseBuffer('wording-a'))
    ins.run(2, 'wxid_service@kefu.openim', 0, 0, '客服助手', '', '', enterpriseBuffer('wording-a'))
    db.close()

    const env = queryContacts(root)
    expect(env.stats.enterprise).toBe(1)
    expect(env.stats.service).toBe(1)
    expect(env.contacts.find(c => c.username === 'wxid_peer@openim')).toMatchObject({
      displayName: '小深',
      category: 'enterprise',
      enterpriseName: '深度求索',
    })
    expect(env.contacts.find(c => c.username === 'wxid_service@kefu.openim')).toMatchObject({
      displayName: '客服助手',
      category: 'service',
    })
    expect(env.contacts.find(c => c.username === 'wxid_service@kefu.openim')?.enterpriseName).toBeUndefined()
  })
})

describe('queryContacts 首字母：群成员也要能分到字母组', () => {
  /**
   * 复现「『全部』和『群成员』没有按字母分类」。
   *
   * 根因：微信只为**加过好友**的联系人写 `remark_pin_yin_initial` / `pin_yin_initial`，
   * 群成员（在群里见过但从没加过好友，`local_type=3`，真实数据 1500+ 条）这两列是空的
   * ——旧实现随即退到中文 `displayName`，`/[A-Z]/` 不匹配就统一返回 `#`，于是整屏没有
   * 字母分组。而 `remark_quan_pin` / `quan_pin`（全拼）对这些行**是有值的**。
   *
   * 实测形状（修复前 → 修复后）：
   *   member 桶： [["#",4]] → [["#",3],["C",1]]
   */
  function makeInitialDb(): string {
    const root = mkdtempSync(join(tmpdir(), 'wx-initial-'))
    scratch.push(root)
    const dir = join(root, 'contact')
    mkdirSync(dir, { recursive: true })
    const db = new DatabaseSync(join(dir, 'contact.db'))
    db.exec(`CREATE TABLE contact (
      id INTEGER, username TEXT, local_type INTEGER, alias TEXT, delete_flag INTEGER,
      remark TEXT, remark_pin_yin_initial TEXT, nick_name TEXT, pin_yin_initial TEXT, quan_pin TEXT,
      remark_quan_pin TEXT, big_head_url TEXT, small_head_url TEXT, description TEXT, is_in_chat_room INTEGER
    )`)
    const ins = db.prepare(`INSERT INTO contact
      (id, username, local_type, remark, remark_pin_yin_initial, nick_name, pin_yin_initial, quan_pin, remark_quan_pin)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    // 好友：微信已写好首字母列
    ins.run(1, 'wxid_f1', 1, '北部湾大学_莫明海', 'B', '', '', 'beibuwan', 'beibuwan')
    // 群成员：首字母列为空，但**备注全拼**有值 → 应归 B（与 displayName 备注口径一致）
    ins.run(2, 'wxid_m1', 3, '表哥_苏', '', '', '', 'biaogesu', 'biaogesu')
    // 群成员：首字母列为空，只有**昵称全拼** → 应归 C
    ins.run(3, 'wxid_m2', 3, '', '', '陈六', '', 'chenliu', '')
    // 群成员：首字母列与全拼列都为空、昵称中文 → 只能进 #
    ins.run(4, 'wxid_m3', 3, '', '', '张三', '', '', '')
    // 群成员：全拼列为空但显示名本身以拉丁字母开头 → 应归 A
    ins.run(5, 'wxid_m4', 3, 'ai 回复机器人', '', '', '', '', '')
    db.close()
    return root
  }

  it('群成员按全拼补推首字母（首字母列为空时不再一律落进 #）', () => {
    const root = makeInitialDb()
    const env = queryContacts(root, { category: 'member', limit: 100 })
    const byName = new Map(env.contacts.map(c => [c.displayName, c.initial]))
    expect(byName.get('表哥_苏')).toBe('B')      // 备注全拼优先
    expect(byName.get('陈六')).toBe('C')        // 昵称全拼兜底
    expect(byName.get('ai 回复机器人')).toBe('A') // 显示名本身是拉丁字母
    expect(byName.get('张三')).toBe('#')        // 真无拼音可依 → #（排在最后）
  })

  it('「群成员」不再整组塌进 #：字母桶多于一个', () => {
    const root = makeInitialDb()
    const env = queryContacts(root, { category: 'member', limit: 100 })
    const buckets = new Set(env.contacts.map(c => c.initial))
    // 修复前这里只有 {'#'} —— 整屏无字母分组
    expect(buckets.size).toBeGreaterThan(1)
    expect([...buckets].sort()).toEqual(['#', 'A', 'B', 'C'])
  })

  it('「全部」同样拿到字母分布（不是只有 #）', () => {
    const root = makeInitialDb()
    const env = queryContacts(root, { limit: 100 })
    const buckets = new Set(env.contacts.map(c => c.initial))
    expect(buckets.has('B')).toBe(true)
    expect(buckets.has('C')).toBe(true)
    expect(buckets.size).toBeGreaterThan(2)
  })

  it('首字母列有值时仍以它为准（不改变好友的既有分组）', () => {
    const root = makeInitialDb()
    const env = queryContacts(root, { limit: 100 })
    const friend = env.contacts.find(c => c.username === 'wxid_f1')
    expect(friend?.initial).toBe('B')
  })

  it('# 组排在最后（无拼音可依的人不插到字母中间，也不顶到最前）', () => {
    const root = makeInitialDb()
    const env = queryContacts(root, { limit: 100 })
    const initials = env.contacts.map(c => c.initial ?? '#')
    // 修复前 `'#'.localeCompare('A') === -1` 让 # 组排到了**最前**（实测 [#, A, B, B, C]）
    expect(initials[initials.length - 1]).toBe('#')
    expect(initials[0]).not.toBe('#')
    // 且字母组之间是有序的（用码点比较，不依赖 locale 对标点的排序）
    const letters = initials.filter(i => i !== '#')
    expect(letters).toEqual([...letters].sort())
  })
})

describe('queryContacts profile fields', () => {
  it('企业微信 custom_info JSON 不作为个性签名', () => {
    const root = mkdtempSync(join(tmpdir(), 'wx-contacts-enterprise-signature-'))
    scratch.push(root)
    const dir = join(root, 'contact')
    mkdirSync(dir, { recursive: true })
    const db = new DatabaseSync(join(dir, 'contact.db'))
    db.exec(`CREATE TABLE contact (
      id INTEGER, username TEXT, local_type INTEGER, delete_flag INTEGER,
      remark TEXT, nick_name TEXT, quan_pin TEXT, description TEXT, extra_buffer BLOB
    )`)
    const enterpriseProfile = JSON.stringify({
      custom_info: [
        { title: '来自', detail: [{ desc: '企业微信' }] },
        { title: '企业', detail: [{ desc: '70A3D965@im.wxwork' }] },
      ],
      title: '王国宁',
    })
    db.prepare('INSERT INTO contact VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      1,
      '25984981860470680@openim',
      0,
      0,
      '王国宁',
      '王国宁',
      'wangguoning',
      '',
      profileBuffer(0, '\u0008\u0001\u0012' + enterpriseProfile + '\u0000tail', ''),
    )
    db.close()

    const contact = queryContacts(root).contacts[0]
    expect(contact?.description).toBe('')
    expect(contact?.description).not.toContain('custom_info')
  })

  it('reads signature fallback, gender and region from extra_buffer', () => {
    const root = mkdtempSync(join(tmpdir(), 'wx-contacts-profile-'))
    scratch.push(root)
    const dir = join(root, 'contact')
    mkdirSync(dir, { recursive: true })
    const db = new DatabaseSync(join(dir, 'contact.db'))
    db.exec(`CREATE TABLE contact (
      id INTEGER, username TEXT, local_type INTEGER, alias TEXT, delete_flag INTEGER,
      remark TEXT, nick_name TEXT, description TEXT, extra_buffer BLOB
    )`)
    db.prepare(`INSERT INTO contact
      (id, username, local_type, alias, delete_flag, remark, nick_name, description, extra_buffer)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        1,
        'wxid_profile',
        1,
        'profile_wechat',
        0,
        'Alice',
        'Y.M',
        '',
        profileBuffer(2, '\u6211\u662f\u4e00\u53ea\u5927\u871c\u8702\u3002', 'BE'),
      )
    db.close()

    const contact = queryContacts(root).contacts.find(c => c.username === 'wxid_profile')
    expect(contact).toMatchObject({
      description: '\u6211\u662f\u4e00\u53ea\u5927\u871c\u8702\u3002',
      gender: 2,
      region: '\u6bd4\u5229\u65f6',
    })
  })
})

/**
 * P2\uff1acontact / chat_room / chatroom_member / biz_info \u5168\u91cf\u7269\u5316\u7684\u56de\u5f52\u5939\u5177\u3002
 *
 * \u8986\u76d6\u300c\u5206\u7c7b + \u641c\u7d22 + \u5206\u9875\u5728 SQL \u5185\u5b8c\u6210\u300d\u4e4b\u540e\u5fc5\u987b\u4fdd\u6301\u7684\u5916\u89c2\uff1a
 *   \u00b7 total / stats \u53e3\u5f84\uff08stats \u59cb\u7ec8\u5168\u91cf\uff09\uff1b
 *   \u00b7 \u9996\u5b57\u6bcd\u6392\u5e8f\uff08'#' \u6700\u540e\uff09\uff1b
 *   \u00b7 \u7fa4\u6210\u5458\u6570 / \u7fa4\u4e3b / \u6210\u5458\u6240\u5c5e\u7fa4\uff08\u542b\u91cd\u590d\u6210\u5458\u884c\u53bb\u91cd\uff09\uff1b
 *   \u00b7 biz_info \u628a gh_ \u670d\u52a1\u53f7\u4ece official \u6539\u5224 service\u3002
 */
function makePagedContactDb(): string {
  const root = mkdtempSync(join(tmpdir(), 'wx-contacts-paged-'))
  scratch.push(root)
  const dir = join(root, 'contact')
  mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(join(dir, 'contact.db'))
  db.exec(`CREATE TABLE contact (
    id INTEGER PRIMARY KEY, username TEXT, local_type INTEGER, alias TEXT, delete_flag INTEGER,
    remark TEXT, remark_pin_yin_initial TEXT, nick_name TEXT, pin_yin_initial TEXT, quan_pin TEXT,
    remark_quan_pin TEXT, big_head_url TEXT, small_head_url TEXT, description TEXT, is_in_chat_room INTEGER
  )`)
  db.exec('CREATE TABLE chat_room (id INTEGER PRIMARY KEY, username TEXT, owner TEXT)')
  db.exec('CREATE TABLE chatroom_member (room_id INTEGER, member_id INTEGER)')
  db.exec('CREATE TABLE biz_info (username TEXT, type INTEGER)')
  const ins = db.prepare(`INSERT INTO contact
    (id, username, local_type, alias, delete_flag, remark, remark_pin_yin_initial, nick_name,
     pin_yin_initial, quan_pin, remark_quan_pin)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  ins.run(1, 'wxid_alice', 1, '', 0, 'Alice', 'A', 'Alice', '', 'alice', 'alice')
  ins.run(2, 'wxid_bob', 1, '', 0, 'Bob', 'B', 'Bob', '', 'bob', 'bob')
  ins.run(3, 'wxid_carol', 3, '', 0, '', '', 'Carol', 'C', 'carol', '')
  ins.run(4, 'g1@chatroom', 0, '', 0, 'Alpha \u7fa4', '', '', '', 'alphaqun', '')
  ins.run(5, 'g2@chatroom', 0, '', 0, 'Zulu \u7fa4', '', '', '', 'zuluqun', '')
  ins.run(6, 'gh_news', 0, '', 0, '', '', 'News', '', '', '')
  ins.run(7, 'gh_service', 0, '', 0, '', '', 'Service', '', '', '')
  ins.run(8, 'wxid_dave', 1, '', 0, 'Dave \u5ba2\u670d', 'D', 'Dave', '', 'dave', 'dave')
  ins.run(9, 'wxid_eve', 1, 'eve_alias', 0, '', '', 'Eve', 'E', 'eve', '')
  db.prepare('INSERT INTO chat_room VALUES (?, ?, ?)').run(4, 'g1@chatroom', 'wxid_owner')
  db.prepare('INSERT INTO chat_room VALUES (?, ?, ?)').run(5, 'g2@chatroom', '')
  // \u540c\u4e00\u4e2a\u4eba\u5728\u540c\u4e00\u7fa4\u91cc\u51fa\u73b0\u4e24\u884c\uff1agroupUsernames \u4e0d\u5e94\u91cd\u590d\u3002
  const cm = db.prepare('INSERT INTO chatroom_member VALUES (?, ?)')
  cm.run(4, 8)
  cm.run(4, 8)
  cm.run(5, 8)
  db.prepare('INSERT INTO biz_info VALUES (?, ?)').run('gh_service', 1)
  db.prepare('INSERT INTO biz_info VALUES (?, ?)').run('gh_news', 0)
  db.close()
  return root
}

describe('queryContacts \u8fc7\u6ee4/\u5206\u9875\u4e0b\u63a8 SQL\uff08P2\uff09', () => {
  it('\u5206\u9875\u8fb9\u754c\uff1alimit/offset \u5728 SQL \u5185\u5207\u7247\uff0ctotal \u59cb\u7ec8\u662f\u5f53\u524d\u89c6\u56fe\u6761\u6570', () => {
    const root = makePagedContactDb()
    const all = queryContacts(root)
    expect(all.total).toBe(9)
    expect(all.contacts.length).toBe(9)

    const first = queryContacts(root, { limit: 2, offset: 0 })
    expect(first.total).toBe(9)
    expect(first.contacts.length).toBe(2)
    const second = queryContacts(root, { limit: 2, offset: 2 })
    expect(second.contacts.length).toBe(2)
    // \u7ffb\u9875\u4e0d\u91cd\u590d\u3001\u4e0d\u4e22\u884c\u3002
    expect(first.contacts.map(c => c.username)).not.toEqual(second.contacts.map(c => c.username))

    const last = queryContacts(root, { limit: 2, offset: 8 })
    expect(last.total).toBe(9)
    expect(last.contacts.length).toBe(1)
    const beyond = queryContacts(root, { limit: 2, offset: 9 })
    expect(beyond.total).toBe(9)
    expect(beyond.contacts).toEqual([])
  })

  it('\u5206\u7c7b\u8fc7\u6ee4\u5728\u5206\u9875\u4e4b\u524d\uff0c\u4e14 stats \u4fdd\u6301\u5168\u91cf\u53e3\u5f84', () => {
    const root = makePagedContactDb()
    const friends = queryContacts(root, { category: 'friend', limit: 2, offset: 0 })
    expect(friends.total).toBe(4)
    expect(friends.contacts.length).toBe(2)
    expect(friends.contacts.every(c => c.category === 'friend')).toBe(true)
    expect(friends.stats).toMatchObject({ friend: 4, group: 2, official: 1, service: 1, member: 1, all: 9 })

    const secondPage = queryContacts(root, { category: 'friend', limit: 2, offset: 2 })
    expect(secondPage.total).toBe(4)
    expect(secondPage.contacts.length).toBe(2)
    const usernames = [...friends.contacts, ...secondPage.contacts].map(c => c.username)
    expect(new Set(usernames).size).toBe(4)
  })

  it('\u641c\u7d22\u4e0b\u63a8\u5230 SQL\uff1a\u5907\u6ce8 / \u6635\u79f0 / \u522b\u540d / \u62fc\u97f3 / username \u90fd\u80fd\u547d\u4e2d\uff0c\u4e14\u5927\u5c0f\u5199\u4e0d\u654f\u611f', () => {
    const root = makePagedContactDb()
    const expectOne = (search: string, username: string): void => {
      const env = queryContacts(root, { search })
      expect(env.total, `\u641c\u7d22\u300c${search}\u300d\u7684\u603b\u6570`).toBe(1)
      expect(env.contacts.map(c => c.username)).toEqual([username])
    }
    expectOne('Alice', 'wxid_alice')       // \u5907\u6ce8
    expectOne('DAVE', 'wxid_dave')         // \u5907\u6ce8\uff08\u5927\u5c0f\u5199\uff09
    expectOne('eve_alias', 'wxid_eve')     // \u522b\u540d
    expectOne('carol', 'wxid_carol')       // username / \u6635\u79f0\u5168\u62fc
    expectOne('alphaqun', 'g1@chatroom')   // \u7fa4\u5907\u6ce8\u5168\u62fc
    expectOne('News', 'gh_news')           // \u6635\u79f0
  })

  it('\u641c\u7d22 + \u5206\u9875\uff1a\u5728\u5b8c\u6574\u7ed3\u679c\u96c6\u4e0a\u7ffb\u9875\uff0c\u4e0d\u4f1a\u53ea\u641c\u5f53\u524d\u9875', () => {
    const root = makePagedContactDb()
    const first = queryContacts(root, { search: 'wxid_', limit: 2, offset: 0 })
    const second = queryContacts(root, { search: 'wxid_', limit: 2, offset: 2 })
    const third = queryContacts(root, { search: 'wxid_', limit: 2, offset: 4 })
    expect(first.total).toBe(5)
    expect(first.contacts.length).toBe(2)
    expect(second.contacts.length).toBe(2)
    expect(third.contacts.length).toBe(1)
    const usernames = [...first.contacts, ...second.contacts, ...third.contacts].map(c => c.username)
    expect(new Set(usernames).size).toBe(5)
  })

  it('\u7a7a\u7ed3\u679c\uff1asearch / category \u4e0d\u547d\u4e2d\u65f6\u8fd4\u56de\u7a7a\u4e14 total=0\uff0cstats \u4e0d\u53d7\u5f71\u54cd', () => {
    const root = makePagedContactDb()
    const noMatch = queryContacts(root, { search: '\u4e0d\u5b58\u5728\u7684\u4eba' })
    expect(noMatch.contacts).toEqual([])
    expect(noMatch.total).toBe(0)
    expect(noMatch.stats.all).toBe(9)

    const badCategory = queryContacts(root, { category: 'friendd' })
    expect(badCategory.contacts).toEqual([])
    expect(badCategory.total).toBe(0)
    expect(badCategory.stats.friend).toBe(4)
  })

  it('biz_info \u670d\u52a1\u53f7\u4ecd\u5f52 service\uff0c\u666e\u901a gh_ \u5f52 official\uff08\u4e0e sessions.ts \u540c\u4e00\u5224\u636e\uff09', () => {
    const root = makePagedContactDb()
    const env = queryContacts(root)
    const byName = new Map(env.contacts.map(c => [c.username, c]))
    expect(byName.get('gh_service')?.category).toBe('service')
    expect(byName.get('gh_news')?.category).toBe('official')
    expect(env.stats.service).toBe(1)
    expect(env.stats.official).toBe(1)
  })

  it('\u7fa4\u4fe1\u606f\u53ea\u67e5\u5f53\u524d\u9875\uff1a\u6210\u5458\u6570\u53bb\u91cd\u3001\u7fa4\u4e3b\u3001\u6210\u5458\u6240\u5c5e\u591a\u7fa4\u90fd\u4fdd\u6301', () => {
    const root = makePagedContactDb()
    const all = queryContacts(root)
    const byName = new Map(all.contacts.map(c => [c.username, c]))
    expect(byName.get('g1@chatroom')?.memberCount, '\u540c\u4e00\u6210\u5458\u91cd\u590d\u884c\u4e0d\u5e94\u91cd\u590d\u8ba1\u6570').toBe(1)
    expect(byName.get('g1@chatroom')?.owner).toBe('wxid_owner')
    expect(byName.get('g2@chatroom')?.owner).toBeUndefined()

    const dave = byName.get('wxid_dave')
    expect(dave?.groupUsernames?.length, '\u540c\u4e00\u7fa4\u91cd\u590d\u6210\u5458\u884c\u4e0d\u5e94\u91cd\u590d\u7fa4\u540d').toBe(2)
    expect(new Set(dave?.groupUsernames ?? [])).toEqual(new Set(['g1@chatroom', 'g2@chatroom']))
    expect(dave?.groupUsername).toBe(dave?.groupUsernames?.[0])

    // \u53ea\u53d6\u597d\u53cb\u9875\uff08\u4e0d\u5305\u542b\u7fa4\u884c\uff09\u65f6\uff0c\u7fa4\u4fe1\u606f\u4ecd\u6309\u9875\u5185 id \u6b63\u786e\u5173\u8054\u3002
    const friends = queryContacts(root, { category: 'friend' })
    expect(friends.contacts.find(c => c.username === 'wxid_dave')?.groupUsernames?.length).toBe(2)
  })

  it('\u9996\u5b57\u6bcd\u6392\u5e8f\u4ecd\u628a # \u653e\u5728\u6700\u540e\uff0c\u4e14\u5b57\u6bcd\u7ec4\u6709\u5e8f', () => {
    const root = makePagedContactDb()
    const env = queryContacts(root)
    const initials = env.contacts.map(c => c.initial)
    expect(initials[initials.length - 1]).not.toBe('#')
    const letters = initials.filter((i): i is string => i !== undefined && i !== '#')
    expect(letters).toEqual([...letters].sort())
  })

  it('\u975e\u6cd5 limit/offset \u4e0d\u4f1a\u9000\u5316\u6210\u5168\u8868\u6216\u629b\u9519', () => {
    const root = makePagedContactDb()
    expect(queryContacts(root, { limit: -1 }).contacts).toEqual([])
    expect(queryContacts(root, { limit: Number.NaN }).contacts).toEqual([])
    expect(queryContacts(root, { limit: 1.5 }).contacts.length).toBe(1)
    expect(queryContacts(root, { limit: 2, offset: -3 }).contacts.length).toBe(2)
  })
})
