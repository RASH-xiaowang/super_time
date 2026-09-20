/**
 * 备注「班级键」解析与名册（`query/graph.ts` 的 `remarkClassKey` / `queryGraph`）。
 *
 * 为什么值得单独锁：这两件事都**退化之后界面照样出图**，只是图上少一批边、
 * 详情里少一行名册 —— 肉眼分辨不出是「本机数据里就没这个班」还是「解析规则挂了」。
 * 而规则里的每个阈值都对应真机实测（280 条备注全量扫描，见 working/probe-remark-key.txt）：
 * 放宽一位编号只多出「一汽大众-7」这种门店序号偶合（+1 条边），收紧一位就丢掉「物联本201」；
 * 名册的 `total` 又必须**在好友过滤 / nodeLimit 之前**统计，否则「本班 43 人、视图只显示 12 人」
 * 这句话会变成「本班 12 人」，把「人被挡在图外」误报成「关系不存在」。
 * @vitest-environment node
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { queryGraph, remarkClassKey } from '../wechat-data/src/query/graph.ts'
import { withTempWorkspace, type TempWorkspace } from './helpers/temp-db.ts'

describe('remarkClassKey：只认「非数字前缀 + 2~6 位编号」', () => {
  it('真机里的班级型备注都能抠出「前缀+编号」', () => {
    expect(remarkClassKey('宜州一中404陈泳达')).toBe('宜州一中404')
    expect(remarkClassKey('物联本202杨凤君')).toBe('物联本202')
    expect(remarkClassKey('东兰民中1410韦利益')).toBe('东兰民中1410')
    expect(remarkClassKey('电信本204李欣恒')).toBe('电信本204')
    // 首尾空白不影响
    expect(remarkClassKey('  宜州一中404陈泳达  ')).toBe('宜州一中404')
  })

  it('编号 1 位 / 超 6 位 / 干脆没编号，都不成组', () => {
    // 门店序号偶合：真机里「一汽大众-7」只有一个 2 人组、多 1 条边，不值得为它放开 1 位编号
    expect(remarkClassKey('一汽大众-7鑫广达吴善钊19195897571')).toBe('')
    expect(remarkClassKey('贴膜中心～上班时间9:00-18:00')).toBe('')
    // 手机号/单号：11 位数字不能当班级序号
    expect(remarkClassKey('南宁_07712345678张')).toBe('')
    // 亲属 / 单位 + 姓名：本来就没有编号（未命中抽样的主体）
    expect(remarkClassKey('表弟_陈忠凯')).toBe('')
    expect(remarkClassKey('法院_梧州万秀_会计小郭——')).toBe('')
    expect(remarkClassKey('荣兴-玉恒瑞')).toBe('')
  })

  it('前缀去标点后不足 2 字、或编号写在最前面，都不认', () => {
    // 纯符号前缀
    expect(remarkClassKey('--202')).toBe('')
    expect(remarkClassKey('_12')).toBe('')
    // 单字前缀太泛（真机里「表弟_陈忠凯」这类都是亲属称谓）
    expect(remarkClassKey('组3')).toBe('')
    // 「编号在前」这种写法正则压根不匹配（前缀必须非数字开头）
    expect(remarkClassKey('12班张三')).toBe('')
  })

  it('空备注不抛错', () => {
    expect(remarkClassKey('')).toBe('')
    expect(remarkClassKey('   ')).toBe('')
    expect(remarkClassKey(undefined)).toBe('')
    expect(remarkClassKey(null)).toBe('')
  })
})

/** 造一个最小解密目录：contact.db（联系人 + 一个群） + session.db（会话表）。 */
function seed(
  ws: TempWorkspace,
  contacts: Array<{ username: string; remark: string; friend?: boolean }>,
  room?: { username: string; memberIndexes: number[] },
): void {
  mkdirSync(join(ws.dir, 'contact'), { recursive: true })
  mkdirSync(join(ws.dir, 'session'), { recursive: true })

  const cdb = ws.db('contact/contact.db')
  cdb.exec('CREATE TABLE contact (id INTEGER PRIMARY KEY, username TEXT, local_type INTEGER, delete_flag INTEGER, small_head_url TEXT, big_head_url TEXT, nick_name TEXT, remark TEXT)')
  cdb.exec('CREATE TABLE chat_room (id INTEGER PRIMARY KEY, username TEXT, ext_buffer BLOB)')
  cdb.exec('CREATE TABLE chatroom_member (room_id INTEGER, member_id INTEGER)')
  const insC = cdb.prepare("INSERT INTO contact (id, username, local_type, delete_flag, small_head_url, big_head_url, nick_name, remark) VALUES (?, ?, ?, 0, '', '', '', ?)")
  contacts.forEach((c, i) => { insC.run(i + 1, c.username, c.friend === false ? 3 : 1, c.remark) })

  const sdb = ws.db('session/session.db')
  sdb.exec('CREATE TABLE SessionTable (username TEXT)')
  if (!room) return
  cdb.prepare('INSERT INTO chat_room (id, username, ext_buffer) VALUES (1, ?, NULL)').run(room.username)
  const insM = cdb.prepare('INSERT INTO chatroom_member (room_id, member_id) VALUES (1, ?)')
  for (const idx of room.memberIndexes) insM.run(idx)
  sdb.prepare('INSERT INTO SessionTable (username) VALUES (?)').run(room.username)
}

describe('queryGraph：备注班级名册', () => {
  it('person 节点带 remark_group，且名册按人数降序、含被好友过滤挡掉的人', async () => {
    await withTempWorkspace('graph-remark', async (ws) => {
      seed(ws, [
        { username: 'wxid_a', remark: '宜州一中404陈泳达' },
        { username: 'wxid_b', remark: '宜州一中404付发科' },
        // 非好友也必须计入名册：名册是「全库盘点」，与「仅显示好友」这个视图开关无关
        { username: 'wxid_c', remark: '宜州一中404黄耀稳', friend: false },
        { username: 'wxid_d', remark: '物联本202杨凤君' },
        { username: 'wxid_e', remark: '物联本202冯咏卓' },
        // 单人班级：不构成任何关系，必须不出现在名册里
        { username: 'wxid_f', remark: '电信本204李欣恒' },
        // 无编号备注：不该被当班级
        { username: 'wxid_g', remark: '表弟_陈忠凯' },
      ])

      const snap = queryGraph(ws.dir, 'wxid_self')
      const byId = new Map(snap.nodes.map(n => [n.id, n]))

      expect(byId.get('wxid_a')?.remark_group).toBe('宜州一中404')
      expect(byId.get('wxid_d')?.remark_group).toBe('物联本202')
      expect(byId.get('wxid_f')?.remark_group).toBe('电信本204')
      expect(byId.get('wxid_g')?.remark_group).toBeUndefined()

      const groups = (snap.remark_groups ?? []).map(g => ({ key: g.key, total: g.total }))
      expect(groups).toEqual([
        { key: '宜州一中404', total: 3 },
        { key: '物联本202', total: 2 },
      ])
      // 只列 ≥2 人的键
      expect(groups.some(g => g.key === '电信本204')).toBe(false)

      // 成员排序：好友优先（非好友的 wxid_c 排最后）
      const first = snap.remark_groups?.find(g => g.key === '宜州一中404')
      expect(first?.members.map(m => m.username)).toEqual(['wxid_a', 'wxid_b', 'wxid_c'])
      expect(first?.members[2]?.is_friend).toBe(false)
      // 名册里的 name 就是图谱上的标签（备注优先，见 meta.ts）
      expect(first?.members[0]?.name).toBe('宜州一中404陈泳达')
    })
  })

  it('班级与共同群两层并存：同一个人既带 remark_group 也带 group_codes', async () => {
    await withTempWorkspace('graph-remark-group', async (ws) => {
      seed(
        ws,
        [
          { username: 'wxid_a', remark: '宜州一中404陈泳达' },
          { username: 'wxid_b', remark: '宜州一中404付发科' },
          { username: 'wxid_c', remark: '物联本202杨凤君' },
        ],
        { username: '111@chatroom', memberIndexes: [1, 3] },
      )

      const snap = queryGraph(ws.dir, 'wxid_self')
      const byId = new Map(snap.nodes.map(n => [n.id, n]))
      expect(byId.get('wxid_a')?.remark_group).toBe('宜州一中404')
      expect(byId.get('wxid_a')?.group_codes).toEqual(['111@chatroom'])
      // 班友未必同群：wxid_b 在班里但不在群里 —— 这正是「同备注却没连线」的真实成因之一
      expect(byId.get('wxid_b')?.group_codes).toEqual([])
      expect(byId.get('wxid_c')?.group_codes).toEqual(['111@chatroom'])
      expect(byId.get('wxid_c')?.remark_group).toBe('物联本202')
    })
  })

  it('共同成员上限放宽：群节点的 shared_count 与实际携带的成员条目一致（>8 的群不再被截断）', async () => {
    await withTempWorkspace('graph-member-cap', async (ws) => {
      const contacts = Array.from({ length: 12 }, (_, i) => ({ username: `wxid_m${String(i).padStart(2, '0')}`, remark: '' }))
      seed(ws, contacts, { username: '222@chatroom', memberIndexes: contacts.map((_, i) => i + 1) })

      const snap = queryGraph(ws.dir, 'wxid_self')
      const room = snap.nodes.find(n => n.id === '222@chatroom')
      expect(room?.shared_count).toBe(12)
      // 旧上限 8 会把这里砍成 8 —— 「群与群之间看不到共同成员」的直接来源
      expect(room?.shared_members?.length).toBe(12)
      // 成员按消息量降序（本夹具全为 0，退到 username 升序）
      expect(room?.shared_members?.map(m => m.username)).toEqual(contacts.map(c => c.username))
    })
  })
})
