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
